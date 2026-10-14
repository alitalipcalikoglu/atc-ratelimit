# `atc-ratelimit` readiness contract

## Purpose
`atc-ratelimit` lets the rest of the platform enforce shared rate limits and quotas without each
service reinventing counters: named policies with several sliding-time windows, per-subject
overrides (larger quotas or hard blocks), one atomic check-and-consume per request or per batch of
policies, a release for work that failed after the check succeeded, usage lookups, top-consumer
listings and hourly allow/deny statistics. It decides; enforcement (answering `429`) is left to the
caller or the gateway.

## Dependencies
- `atc-audit` (`AUDIT_URL` + `AUDIT_API_KEY`): optional, both-or-neither. Same mechanism as `atc-flags` and
  `atc-shortlink` — `src/net/audit-client.js` is byte-identical across all three (verified with `diff`).
  Unset: writes still succeed. Set: write events (policy/override create, update, delete, subject
  reset) are buffered in memory and flushed on a background 2s timer, never on the request path —
  an unreachable or slow audit service never slows down or fails a check, release, or management
  call. Buffered-and-unflushed events are lost on an ungraceful restart.

No other service or external system is called by `atc-ratelimit`.

## Persistence
Engine: SQLite via `node:sqlite`'s `DatabaseSync` (`src/db.js`), WAL journal mode, `synchronous =
NORMAL`, `busy_timeout = 5000`, foreign keys on. File location: `DB_PATH`, default
`./data/ratelimit.db` (Docker: `/data/ratelimit.db`).

Schema (one migration block, `Database.MIGRATIONS[0]`):
- `policies` — `name` (PK), `description`, `limits` (JSON array of `{window, limit}`),
  `created_by`, `created_at`, `updated_at`.
- `overrides` — per-(policy, subject) replacement limits: `policy` (FK, `ON DELETE CASCADE`),
  `subject`, `limits` (JSON), `note`, `expires_at` (nullable), `created_by`, `created_at`,
  `updated_at`; PK `(policy, subject)`. A `limits` entry with `limit: 0` blocks the subject
  entirely.
- `counters` — fixed-window counts (`WITHOUT ROWID`): `policy`, `subject`, `window` (seconds),
  `window_start` (ms), `count`; PK `(policy, subject, window, window_start)`; index
  `counters_top(policy, window, window_start, count DESC)`. The sliding-window estimate is derived
  from exactly two rows per (policy, subject, window): the current fixed window and the one before
  it, weighted by overlap (`SlidingWindow`, see below) — there is no per-request log.
- `decisions` — hourly allow/deny totals per policy (`WITHOUT ROWID`): `policy`, `hour_start`,
  `allowed`, `denied`; PK `(policy, hour_start)`. This is the durable source for
  `GET /v1/policies/:name/stats` and `GET /v1/stats`.

Migration mechanism: identical pattern to `atc-flags`/`atc-shortlink` — `Database.MIGRATIONS` array gated by
`PRAGMA user_version`, each block in its own transaction. Fresh install and "upgrade from nothing"
are the same today (one migration). No down-migration mechanism.

## Health endpoint
`GET /health` returns `{ status: 'ok' }` unconditionally, no I/O, cannot be slow or fail while the
process event loop is otherwise alive. Logged at `warn`.

## Readiness endpoint
`GET /ready` calls `this.db.ping()` (`SELECT 1`), cached for `RateLimitApi.READY_CACHE_MS =
10_000`ms — same mechanism as `atc-flags`/`atc-shortlink`. Read-only, no mutation, no discarded work, safe
to poll at any interval.

## Graceful shutdown
`SIGTERM`/`SIGINT` → `Application.shutdown(reason)` (idempotent guard). Order: stop the
`CleanupWorker` (`this.worker.stop()`) → `await this.app.close()` (drain in-flight HTTP requests,
including in-progress checks) → `await this.audit.close()` (stop timer, final flush) →
`this.db.close()`. A `30_000`ms unref'd force-exit timer runs in parallel. `unhandledRejection`
routes through the same graceful path; `uncaughtException` calls `process.exit(1)` immediately,
skipping drain and final audit flush. PM2 `kill_timeout: 35000`ms — 5s above the internal 30s
force-exit, same numbers and comment as `atc-flags`/`atc-shortlink`.

## Resource limits
- `BODY_LIMIT` (env, default `65_536` bytes).
- `MAX_LIMITS` (env, default `5`, range 1–20) — windows per policy.
- `MAX_WINDOW_SEC` (env, default `2_592_000` = 30 days) — longest allowed window.
- `MAX_COST` (env, default `1_000_000`) — largest `cost` one check/release may use.
- `MAX_BATCH` (env, default `20`, range 1–100) — checks per `/v1/check/batch` call.
- `RATE_LIMIT_MAX` (env, default `6_000`) — requests per API key per minute against this service's
  own `/v1/*` (the service rate-limits itself the same way `atc-flags`/`atc-shortlink` do).
- `max_memory_restart: '300M'` in `ecosystem.config.cjs`.
- No explicit page-size cap is enforced server-side for `/v1/policies/:name/overrides` beyond the
  caller-supplied `limit`/`offset` (default `limit=50`, `offset=0`, no documented server-side max).

## Timeouts
- Audit outbound call: `timeoutMs = 5_000` default, unchanged by `Application`.
- Shutdown force-exit: `30_000`ms, hard-coded.
- PM2 `listen_timeout: 10000`ms.
- No outward per-request timeout beyond the audit client's — `atc-ratelimit` never calls another
  service synchronously in the request path; every check/release/usage/stats operation is a local
  SQLite transaction.

## Retry policy
Only the audit forwarding path retries, off the request path, on a background timer. Identical
numbers to `atc-flags`/`atc-shortlink` (byte-identical `AuditClient`): `MAX_ATTEMPTS = 6`, backoff `min(30_000,
500 * 2 ** attempt)`ms, no jitter; non-429 4xx drops the batch permanently; 429/5xx/network
error/timeout keeps it buffered for the next `flushMs = 2_000`ms tick once all attempts in the
current call are exhausted. There is no retry logic anywhere else in this service — `checkMany` and
`release` are single-shot SQLite transactions with no internal retry (SQLite's own `busy_timeout =
5000` is the only built-in wait-and-retry, handled inside `node:sqlite` itself, not application
code).

## Idempotency
- `POST /v1/policies` (create) is **not** idempotent: repeating it with the same `name` fails `409
  POLICY_EXISTS`.
- `PATCH /v1/policies/:name` is idempotent in result for a fixed patch.
- `DELETE /v1/policies/:name` is **not** safe to repeat: `removePolicy` calls `this.policies.require(name)`
  first, which throws `404 POLICY_NOT_FOUND` once the policy is already gone.
- `PUT /v1/policies/:name/overrides/:subject` (`setOverride`) **is** idempotent: it's an upsert
  (`ON CONFLICT (policy, subject) DO UPDATE`) keyed on the natural `(policy, subject)` pair, so
  repeating the same body yields the same end state with no error.
- `DELETE .../overrides/:subject` is **not** safe to repeat: `removeOverride` throws `404
  OVERRIDE_NOT_FOUND` if nothing was deleted.
- `DELETE .../subjects/:subject/usage` (`resetUsage`) **is** safe to repeat: it's a `DELETE FROM
  counters WHERE policy = ? AND subject = ?`, and a repeat simply deletes zero rows (`removed: 0`)
  rather than erroring.
- **`POST /v1/check` and `/v1/check/batch` are never idempotent by design** — each successful check
  consumes quota; retrying a check that already succeeded consumes it again. A caller must not blindly
  retry a check whose response was lost in transit, since it cannot tell from the retry alone whether
  the original attempt was already charged.
- **`POST /v1/release` is idempotent only in the narrow sense that repeating it keeps subtracting**
  — it is not idempotent in the "safe to retry" sense: `CounterBackend.release` clamps at zero, so
  calling `release` twice for the same original check will not go negative, but it also does not
  detect that it has already been applied — see "release() and the window-boundary fix" below.

**`release()` and the window-boundary fix (Stage 5).** Before Stage 5, `release(input)` computed
`now` **at release time** and decremented whichever fixed window `now` fell in — not the window the
original `check()`/`checkMany()` call had actually incremented. Inside the same window as the
original check this happened to be the same bucket, so it worked by coincidence; once a window
boundary passed between check and release, the refund silently landed on the wrong bucket (an
empty one, a harmless no-op) or on an unrelated one (decrementing someone else's legitimate usage).
Every `Decision` (from `check`/`checkMany`) now carries `consumedAt` — the instant it was evaluated,
and, when it consumed, the instant it consumed at. `release()` takes an optional `consumedAt`
(`src/domain/rate-limit-service.js`, `CounterBackend.release`,
`src/store/sqlite-counter-backend.js`) and decrements the window `consumedAt` falls in, not
whichever window `now` is in — deterministic regardless of how long the release is delayed. A
caller that omits `consumedAt` gets the pre-fix behavior by construction (targets the current
window), which remains correct exactly when the release happens inside the same window it
consumed; nothing about the fix requires every caller to be updated at once. A counter is clamped
at zero on every release regardless of `consumedAt`, cost, or how many times it is called — see
`test/backend-contract.test.js` ("release restores the same window…", "release after a window
rollover…", "duplicate and excess release…") and `test/service.test.js` for the regression proof.

## Backup
State that must survive a disk loss: the SQLite file at `DB_PATH` (default `./data/ratelimit.db`)
plus WAL/SHM sidecars while running. Policy definitions and overrides matter most (they are hand
configured); counters and decision statistics are comparatively disposable (losing them only resets
in-progress windows and historical charts, not correctness going forward). No backup script exists
in this repository; capture today via a stopped-process file copy or SQLite's own online-backup
mechanism (not wired up here).

## Restore
Stop the service, replace `DB_PATH` (and stale `-wal`/`-shm` files) with the backup, start —
`#migrate()` applies any newer migrations automatically. No ordering constraint with other
services' data: policy names and subjects are opaque strings chosen by callers, not foreign keys
into another service's database. Restoring an old backup means any policy/override changes made
after that backup are lost and callers checking against a policy created after the backup would see
`404 POLICY_NOT_FOUND` until it's recreated.

## Metrics
`GET /metrics` (Prometheus text, `read`-role key required):
- `ratelimit_policies` — durable, count of rows in `policies`.
- `ratelimit_decisions_total{policy,decision}` — **process-local**: read from
  `RateLimitService.tally`, an in-memory `Map` incremented by `#count()` on every `checkMany` call;
  resets to 0 on every restart. This is a different number from the *durable* `decisions` table
  (used by `GET /v1/policies/:name/stats` and `GET /v1/stats`, which read `counters.series`/
  `counters.totals` from the database) — **the `/metrics` total and the `/v1/stats` total can
  disagree after any restart**, since one is process-local and the other is durable.
- `ratelimit_counters` — durable, `SELECT COUNT(*) FROM counters` (live window-counter row count).
- `ratelimit_db_bytes` — durable, `Database.sizeBytes()` (`page_count * page_size`).
- `ratelimit_process_uptime_seconds` — process-local, resets on restart.

## Logging
Same as `atc-flags`/`atc-shortlink`: Fastify default request logger, `requestIdHeader: 'x-request-id'`,
`genReqId: randomUUID`, `reqId` on every log line per
[OBSERVABILITY.md](../../atc-stack/docs/OBSERVABILITY.md), `req.headers.authorization` redacted. Not
emitted: `traceId`, `spanId`, `route`/`op`, `durationMs` (Fastify's `responseTime` field, different
name), `upstream`/`upstreamMs` (no proxied calls), `service`, `version`. `code` is in every JSON
error body but only additionally logged for 500s via `request.log.error({ err }, 'unhandled error')`.

## Tracing
Accepts whatever `X-Request-Id` the caller sends (no trust gate — internal service reached only via
gateway, console or peers) and generates one when absent. Also parses an inbound `traceparent` via
`@atc-web/atc-service-core`'s `registerRequestContext`, trust-gated on `TRUST_PROXY` (same boundary as
`X-Forwarded-*`): trusted, the caller's trace-id is continued with a fresh span-id; untrusted or
malformed, a fresh trace is started. Both `traceId`/`spanId` are logged on every request line.
`atc-gateway`'s own `rate-limit-client.js` explicitly sends its own `traceparent`/`X-Request-Id` on
every policy check (post-production Phase 5), so this is a real inbound trace, not just a parser
capability. No outbound calls happen in the request path (audit is async, off-path, and doesn't
forward request-scoped headers), so there is nothing to propagate onward regardless.

## Security model
Bearer API keys (`RATELIMIT_API_KEYS=id:secret[:role[:policies]]`), compared via SHA-256 +
`timingSafeEqual` (same `ApiKeyAuth` pattern as `atc-flags`/`atc-shortlink`). Roles: `check` (only
`/v1/check`, `/v1/check/batch`, `/v1/release`), `read`, `write`, `readwrite` (default) — `check` is
unique to this service among the four reviewed (`atc-flags`/`atc-shortlink` only have `read`/`write`/
`readwrite`), reflecting that most callers (the gateway, other backends) should only be able to
spend quota, never redefine it. Policy scoping: a key's `policies` list (or `null` for all) is
enforced on every route naming a policy (`ApiKeyAuth.assertPolicy`), including hiding scoped-out
policies from `GET /v1/policies` and `/v1/stats`. No secret rotation support: edit
`RATELIMIT_API_KEYS` and restart. At the boundary: request bodies are schema-validated with a
custom JSON content-type parser that returns a clean `400 INVALID_JSON` instead of Fastify's default
error on malformed JSON (`removeContentTypeParser`/`addContentTypeParser` in `rate-limit-api.js`);
limits are validated against `MAX_LIMITS`/`MAX_WINDOW_SEC`/`MAX_COST` at policy-create/update and
override-set time, not just at check time. Out of scope: authenticating whoever the `subject` string
represents (it's an opaque string the caller vouches for — `atc-ratelimit` does not verify a subject is
a real user/IP/key), enforcement itself (this service only decides `allowed`; a `429` response to
the *original* caller of whatever service is being protected is the caller's job).

## Scaling model
**B — single-node stateful**: one process owns one SQLite file, `instances: 1` pinned in
`ecosystem.config.cjs` ("one process per SQLite file"), and the README's own "Out of scope" section
already states this explicitly ("Distributed counters across several instances of this service: one
process owns one database").

**The check/consume path specifically is safe under two processes sharing one file**, which is a
materially different answer from `atc-shortlink`'s redirect path. `RateLimitService` never touches
SQLite directly (Stage 5: it depends on the `CounterBackend` interface,
`src/domain/counter-backend.js`, only). `SqliteCounterBackend.checkAndConsume`
(`src/store/sqlite-counter-backend.js`) wraps the *entire* read-decide-write sequence — reading the
current and previous window counters for every limit of every check in the batch (`counters.pair`),
evaluating every one of them, and (only if every check's every limit allows its cost) writing the
new counts (`counters.add`) — in one call to `db.transaction()`, which issues `BEGIN IMMEDIATE`
*before* any of those reads happen; policy/override resolution stays in `RateLimitService` and reads
`policies`/`overrides` outside this transaction (those rows change far less often than counters and
were never part of this atomicity requirement). `BEGIN IMMEDIATE` acquires SQLite's RESERVED lock
immediately, at the start of the transaction, not deferred until the first write; only one such
transaction can hold that lock at a time, across the whole database file, including across separate
OS processes connected to the same file. This means a second process's `checkAndConsume` cannot
begin *its* `BEGIN IMMEDIATE` transaction — and therefore cannot read the counters — until the first
process's transaction has fully committed or rolled back. There is no window, within or across
processes, where two `checkAndConsume` calls for the same (or different) subjects can interleave
their read and write halves — unlike `atc-shortlink`'s `follow()`, where the `maxClicks` read happens
*outside* the transaction that performs the write. This is exercised with REAL cross-connection
concurrency (separate `node:worker_threads`, each with its own `DatabaseSync` against the same
file, not same-process `Promise.all`) in `test/concurrency.test.js`.

Where two processes *would* cause a real problem: the **cleanup worker running in two processes**
is not itself unsafe in the sense of corrupting data. `RateLimitService.cleanup()` (Stage 5) no
longer wraps its three deletions (`backend.cleanup` for counters, `overrides.deleteExpired`,
`backend.cleanupDecisions`) in one shared transaction — a swappable `CounterBackend` cannot share a
SQL transaction with the separate `OverrideStore`, so this atomicity is a casualty of the backend
abstraction itself, documented in `RateLimitService.cleanup`'s own JSDoc. Each of the three remains
its own atomic single-SQL-statement operation, and each is naturally idempotent (deleting rows
already deleted — by this process or another — just matches zero rows), so two processes' cleanup
workers running concurrently, or one process's cleanup crashing partway through, never corrupts
data or double-deletes; the only consequence is that a run can leave one of the three steps until
the next interval. The real problem with two instances is entirely the **process-local state**, not
the database: `RateLimitService.tally` (the source of `ratelimit_decisions_total` in `/metrics`) and
the readiness cache would each be independent per process, so `/metrics` and `/ready` would report
different, incomplete pictures depending on which instance answered a given request — exactly the
same class of issue `atc-flags` has with its own per-process evaluation cache and counters, not a
data-correctness issue.

**Redis-readiness (reviewed, not implemented — Stage 5 explicitly stops here).** A Redis-backed
`CounterBackend` would need exactly one atomic server-side operation in place of
`checkAndConsume`'s SQLite transaction: a Lua script (or Redis Function) that, given every check in
the batch, reads `prev`/`cur` for every limit, evaluates all of them, and issues every limit's
`INCRBY` only if every one of them allows its cost — anything short of one atomic operation across
the whole batch reintroduces the exact partial-consumption bug the SQLite transaction exists to
prevent. `release()` needs a second, simpler atomic operation: a bounded `DECRBY` (clamped at zero)
against the window `consumedAt` selects. `domain/counter-backend.js` documents the atomicity
contract in backend-agnostic terms (no Redis-specific concepts leak into the interface); a Redis
implementation is expected to satisfy `test/backend-contract.test.js` unchanged.

## Single-node / multi-node guarantees
Running two `atc-ratelimit` instances against the same `DB_PATH` is not a topology this repository ships
or tests (`instances: 1` is pinned, and the README says so), but unlike `atc-shortlink`, the specific
concern that motivated this question — whether the check/consume path itself could let two processes
jointly over-spend a policy's quota — **does not apply here**: `BEGIN IMMEDIATE` around the full
read-then-write sequence serializes it globally, so quota enforcement itself would remain correct
under two processes. What would *not* be correct is anything reading `RateLimitService.tally`
(`/metrics`'s `ratelimit_decisions_total`) or each process's own 10s readiness cache, since those are
per-process and not coordinated. `release()`'s window-boundary behavior (above) is unrelated to
instance count either way — with `consumedAt` supplied it is correct under any instance count for
the same reason `checkAndConsume` is; without it, it targets the current window regardless of how
many processes are involved.

## Known failure modes
- **Disk full**: a write inside `db.transaction()` (check, release, policy/override write) throws,
  rolls back, and the request fails `500`; no partial charge is possible because the whole
  check-and-consume sequence is one transaction. `cleanup()` (Stage 5: three separate atomic
  statements, not one shared transaction — see Scaling model) can fail partway through; the next
  interval's run picks up whatever step didn't complete, since every step is idempotent.
- **Audit service times out or is unreachable mid-request**: no effect on the ratelimit request —
  `record()` is a synchronous in-memory push; network I/O is deferred to the background timer. Long
  enough downtime drops events once `MAX_BUFFER = 5_000` is hit.
- **Process killed without graceful shutdown**: buffered-but-unflushed audit events are lost; the
  SQLite file itself should stay consistent (WAL, atomic commits per `BEGIN IMMEDIATE`/`COMMIT`),
  but the in-flight check being served at the moment of the kill gets no response — a caller cannot
  tell whether that check's cost was actually consumed, and retrying it risks double-charging.
- **Two instances run against one file**: the check/consume path itself stays correct (see Scaling
  model above — this is the one respect in which `atc-ratelimit` is *more* robust to this scenario than
  `atc-shortlink`), but `/metrics`' `ratelimit_decisions_total` and each instance's own readiness cache
  would diverge between the two processes, giving an operator an incomplete picture depending on
  which instance answers a given `/metrics` or `/ready` poll.
- **`release()` called after a window boundary has passed since the original check, with
  `consumedAt` supplied**: correctly credits the window that was actually over-consumed (Stage 5
  fix) — see "release() and the window-boundary fix" above.
- **`release()` called without `consumedAt`, after a window boundary has passed**: targets the
  *current* window, same as every release before Stage 5 — either a no-op (nothing to decrement
  there yet) or, if unrelated requests already used that new window, an erroneous decrement against
  their legitimate usage. Callers that care about a release outliving its window must pass back the
  `consumedAt` their check returned; this is a caller-must-opt-in behavior, not a hidden trap, since
  omitting the field is exactly the pre-Stage-5 default.
