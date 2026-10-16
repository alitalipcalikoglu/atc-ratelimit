# atc-ratelimit

Central rate limits and quotas for every service: named policies with several windows (100 per minute and 20 000 per day), per-subject overrides and blocks, one atomic check per request or per group of policies, a release for work that failed, usage lookups, top consumers and hourly statistics. Sliding-window counters in SQLite, no external store. HTTP only.

Runtime dependencies: `fastify`, `@fastify/rate-limit`. Storage is SQLite via `node:sqlite` (built into Node 22.13+). The folder is self-contained: copy it to any host with Node 22 and run.

## Run

```bash
cp .env.example .env        # set RATELIMIT_API_KEYS
npm ci
npm run dev
```

Production with PM2 (reads `./.env` through Node's `--env-file`):

```bash
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Production with Docker (mount the database directory):

```bash
docker build -t atc-ratelimit .
docker run -p 3011:3011 -v atc-ratelimit-data:/data --env-file .env atc-ratelimit
```

Tests and type check:

```bash
npm test
npm run typecheck
```

## Model

- **A policy** (`api`, `login`, `sms`) is a list of windows: at most `limit` units per `window` seconds. A check passes only when every window has room for the cost; then every window is charged, in one transaction. Denied checks consume nothing.
- **A subject** is any string the caller chooses: an API key id, a user id, an IP, a hashed phone number. The service stores it as given.
- **A check** answers `allowed`, plus `limit`, `remaining`, `resetAt`, `retryAfter` and `consumedAt` for the most restrictive window and the state of every window. `cost` charges more than one unit; `peek` answers without charging. A **batch** checks several policies all-or-nothing. A **release** gives units back after work that failed — pass the check's `consumedAt` back as `release`'s `consumedAt` so the release credits the window that was actually charged, even after it has rolled over; omitting it releases against the *current* window, same as calling it right away.
- **An override** replaces the policy's windows for one subject (a partner's larger quota, a smaller plan) and can expire; a limit of `0` blocks the subject.
- **Sliding window**: two counters per subject and window, current and previous fixed window, weighted by overlap. No request log, no double burst at window boundaries; `retryAfter` accounts for the decay.
- **Statistics**: allowed and denied per policy per hour, kept `STATS_RETENTION_DAYS`; top consumers per window; one subject's usage.
- **Keys** are `id:secret[:role[:policies]]` with roles `check` (checks only), `read`, `write`, `readwrite`; a policy scope hides and protects every other policy.

## Boundaries

**Purpose:** shared rate-limit decisions for the platform, primarily consumed by gateway.

**Responsibilities:** policy-based window checks; per-subject overrides/blocks; usage and decision stats.

**Non-responsibilities:** ratelimit ≠ distributed counter backend today — `CounterBackend` is an interface with exactly one implementation (`SqliteCounterBackend`, single SQLite-backed node); it is a seam for a future distributed backend, not a claim that one exists. It does not decide which routes get limited or by which policy — that's gateway's route configuration.

## API

Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready`, `/v1/info` | none | Liveness; readiness (database, cached 10 s); service identity (version, API version, capabilities, schema version, service-core version). |
| POST | `/v1/check` | check | `{ policy, subject, cost?, peek? }` → decision. |
| POST | `/v1/check/batch` | check | `{ checks: [{ policy, subject, cost? }], peek? }` → `{ allowed, results }`, all-or-nothing. |
| POST | `/v1/release` | check | `{ policy, subject, cost?, consumedAt? }` gives units back → state. |
| POST | `/v1/policies` | write | `{ name, description?, limits }` → `201 { policy }`. |
| GET | `/v1/policies`, `/v1/policies/:name` | read | Visible policies with overrides, active subjects and 24 h totals; one policy. |
| PATCH / DELETE | `/v1/policies/:name` | write | `{ description?, limits? }`; delete with overrides, counters and statistics. |
| GET | `/v1/policies/:name/stats` | read | `hours` (default 24, up to 720) → hourly `{ allowed, denied }` series. |
| GET | `/v1/policies/:name/top` | read | `window` (default shortest), `limit` → subjects by current usage. |
| GET | `/v1/policies/:name/overrides` | read | Overrides by subject (`limit`, `cursor`). |
| PUT / DELETE | `/v1/policies/:name/overrides/:subject` | write | `{ limits, note?, expiresAt? }` replaces; delete. |
| GET | `/v1/policies/:name/subjects/:subject` | read | `{ usage, override }` without charging. |
| DELETE | `/v1/policies/:name/subjects/:subject/usage` | write | Forget the subject's counters → `{ removed }`. |
| GET | `/v1/stats` | read | Totals, the active counter `backend` and per-policy 24 h numbers. |
| GET | `/metrics` | read | Prometheus text: policies, decisions since start, counters, database size, uptime. |

## Conventions

- Lists answer `{ items, nextCursor }`; pass `nextCursor` back as `cursor`. Policies and the top list are complete (`nextCursor: null`); overrides page by subject. Policy names and subjects are natural keys.
- Policy creation honours `Idempotency-Key`: a repeat with the same key (per API key and caller — the console's `X-Actor` counts — for 24 h) replays the first 2xx answer with `Idempotent-Replayed: true`; another body is `409 IDEMPOTENCY_MISMATCH`. Checks are not idempotent by design: each call consumes.

## Examples

Scenario walkthroughs for every feature live in [examples/](examples/README.md).

## Configuration

Environment only; see [.env.example](.env.example). Required: `RATELIMIT_API_KEYS`. Notable: `POLICY_SEEDS` (`name=limit/window[+…]`, policies created at start when missing, never changed afterwards; the stack seeds the ones its gateway routes use), `MAX_LIMITS` (windows per policy), `MAX_WINDOW_SEC`, `MAX_COST`, `MAX_BATCH`, `CLEANUP_INTERVAL_SEC`, `STATS_RETENTION_DAYS`, `COUNTER_BACKEND` (`sqlite` default, or `memory`: counters in memory, flushed every `COUNTER_FLUSH_MS`, one process only; see "Scaling model"), `RATE_LIMIT_MAX` (the service's own per-key limit), `TRUST_PROXY`, `TLS_CERT_PATH` / `TLS_KEY_PATH`.

## Security notes

- API keys: compared in constant time against every configured key (SHA-256 digest + `timingSafeEqual`, no early exit), so timing never reveals whether, or which, key matched (`@atc-web/atc-service-core/auth`, `ApiKeyAuth`).
- Roles: `check`/`read`/`write`/`readwrite`, enforced per route (`ApiKeyAuth.require`). A policy scope on a key (`id:secret:role:policy+policy`) additionally restricts it to those policies — `ApiKeyAuth.assertPolicy` runs on every route that names a policy and returns `403 FORBIDDEN` for one outside the key's scope; an unscoped key can see and touch every policy.
- The service rate-limits itself per key (`RATE_LIMIT_MAX` per minute, `@fastify/rate-limit`, keyed on the caller's API key id) in addition to the limits it hands out to callers.
- Request bodies capped at `BODY_LIMIT` (default 64 KiB); `Cache-Control: no-store` on every response.
- Container runs as the unprivileged `node` user.

## Code layout

```
src/
  config.js                 Config.fromEnv, key parsing (roles, policy scopes)
  db.js                     SQLite connection, migrations, transactions
  application.js            composition root, lifecycle, cleanup worker
  worker.js                 CleanupWorker: stale counters, expired overrides, old statistics
  domain/limits.js          limit list validation
  domain/sliding-window.js  the estimate, remaining and retry hints; shared by every counter backend
  domain/counter-backend.js the CounterBackend contract; no SQLite in this file
  domain/rate-limit-service.js  policies, overrides, checks, batches, releases, usage, top, stats
  store/                    PolicyStore, OverrideStore, CounterStore (raw SQL), SqliteCounterBackend
  http/rate-limit-api.js    Fastify routes, error mapping, probes, metrics
  http/api-key-auth.js      constant-time bearer auth, roles, policy scope
test/                       node:test suites (config, domain, service, API, TLS)
examples/                   one walkthrough per feature
```

## Out of scope by design

- Distributed counters across several instances of this service: one process owns one database. Split policies across instances instead.
- Token-bucket or leaky-bucket shaping. The sliding window covers limits and quotas; smoothing at sub-second granularity belongs in the caller.
- Enforcement. The service decides; callers (or the gateway) answer 429. See [examples/middleware.md](examples/middleware.md).

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every completed write request is forwarded to the audit service as one event (`success`, or `denied` on 403) with the calling key as actor, the affected entity as target, client IP, user agent and request id. Events are buffered and sent in batches; the audit service being down never fails a request. Actions: see [examples/audit-events.md](examples/audit-events.md).

## Scaling model

One process owns one SQLite file (`instances: 1`). `RateLimitService` (the domain layer: policies,
overrides, the "most restrictive window" logic) depends only on a `CounterBackend` interface
(`domain/counter-backend.js`) — it holds no SQL, no transaction object, nothing SQLite-specific.
Two implementations exist, chosen with `COUNTER_BACKEND`: `SqliteCounterBackend`
(`store/sqlite-counter-backend.js`, the default) wraps `CounterStore` (raw SQL) and owns the
transaction the domain layer used to hold directly; `MemoryCounterBackend`
(`store/memory-counter-backend.js`) keeps counters in process memory and flushes them to SQLite every
`COUNTER_FLUSH_MS` (see "Memory backend" below).

**Memory backend (`COUNTER_BACKEND=memory`).** Every check with the SQLite backend is one write
transaction, and SQLite has one writer: on very busy routes that is the ceiling. The memory backend
answers a check with a few in-memory lookups and writes the changed counters and the hourly decision
totals to SQLite in one transaction every `COUNTER_FLUSH_MS` (default 1000 ms). The batch
all-or-nothing contract holds because a check runs synchronously to the end inside the one process.
Limits of the memory backend, so choose it knowingly: it is strictly one process per database (a
second process, a `--split-workers` layout or PM2 `instances` above 1 keeps separate counts and the
effective limit multiplies); a crash or a `SIGKILL` loses the increments since the last flush, so the
windows restart that much short and clients get up to one `COUNTER_FLUSH_MS` of extra allowance
once (keep the flush interval short, and let PM2's `wait_ready` plus `kill_timeout` cover the final
flush on a clean stop); it suits short-window, high-rate policies, not long quotas (a daily quota
can lose one second of counting on every restart). The SQLite backend has none of these limits and
stays the default. Statistics (`/stats`, hourly series)
flush first, so they stay exact. `/metrics` adds `ratelimit_counter_flushes_total{result}` and
`ratelimit_counter_unflushed`.

The check/consume path (`checkAndConsume`) wraps the whole read-decide-write sequence, across every
limit of every check in a batch, in one `BEGIN IMMEDIATE` transaction — SQLite's single writer makes
this genuinely all-or-nothing even across several processes sharing the file, not just within one
process (`PRAGMA busy_timeout = 5000` absorbs a second writer's wait; past that it fails loudly with
`SQLITE_BUSY` rather than silently interleaving). What would still diverge across several instances
sharing one file is process-local state (`/metrics`' decision tally, each instance's readiness cache),
never the counters themselves.

**`release()` — the window-boundary fix.** Before this stage, `release()` always decremented the
*current* window at release time, not the window the original check had consumed; a release arriving
after a window boundary either hit the wrong bucket or a fresh one that was never incremented, so the
refund was silently lost. `release()` now accepts an optional `consumedAt` (every check's `Decision`
returns one), and decrements the window that instant falls in — deterministic regardless of how much
time passed before the release arrives. Omitting `consumedAt` targets the current window, same as the
old behavior; that is only correct when the release happens inside the same window it consumed. A
counter is clamped at zero on every release, however many times or with however large a cost it is
called — never negative, never more than a limit's own window can hold.

**Multi-process, one host: yes (SQLite backend only). Distributed: no.** `SqliteCounterBackend` serializes writers at the
SQLite *file* level — correct for several processes on one host sharing one `DB_PATH`, which is the
supported topology (class B, see [docs/READINESS.md](docs/READINESS.md)). It is not a distributed
counter: two processes pointed at two different files, or the same file over a network filesystem
(where SQLite's locking is unreliable), do not share a rate limit, and nothing here detects that
misconfiguration.

**Clock model.** Every window boundary is `floor(now / windowMs) * windowMs` against the service's
own wall clock (`Date.now`, injectable for tests) — not a monotonic clock, since window membership
has to be anchored to fixed epoch multiples that stay meaningful across a restart and (for a future
Redis backend) across instances; a monotonic clock has no such fixed relationship to wall time. Clock
skew *between callers* (gateway instances, other services) is irrelevant: only the ratelimit
process's own clock decides which window a request lands in. If that clock jumps backward, a check
can land in an already-used window and read stale counts — never denies more than the limit allows,
never goes negative; if it jumps forward, in-flight windows are skipped and age out via `cleanup()`
like any other expired window. Keep the host's clock NTP-synced; nothing here corrects for skew on
its own.

**A future Redis backend** would need exactly one atomic server-side operation in place of
`checkAndConsume`'s SQLite transaction: a Lua script (or Redis Function) that, for every check in the
batch, reads `prev`/`cur` for every limit, evaluates all of them, and — only if every one of them
allows its cost — issues the `INCRBY`s; anything less than one atomic operation across the *whole
batch* reintroduces the same partial-consumption bug the SQLite transaction exists to prevent.
`release()` needs a second, simpler atomic operation: a bounded `DECRBY` (clamped at zero) against the
window `consumedAt` selects. Neither is implemented; see `domain/counter-backend.js` for the
atomicity every method requires from any backend, SQLite or not, and
`test/backend-contract.test.js` for the suite a Redis backend would need to pass unchanged.

See [docs/READINESS.md](docs/READINESS.md) for the full contract.

## Observability

Requests are logged with `reqId` (accepts or generates `X-Request-Id`) and `traceId`/`spanId` (a
trusted inbound `traceparent`, gated on `TRUST_PROXY`, continues the caller's trace with a fresh
span-id for this hop — `atc-gateway`'s own `rate-limit-client.js` explicitly propagates its trace on
every policy check; see [OBSERVABILITY.md](../atc-stack/docs/OBSERVABILITY.md)). `/health` is a static check; `/ready` pings the database, cached for 10s. Note
that `/metrics`' `ratelimit_decisions_total` is a process-local counter that resets on restart and
can disagree with the durable totals `/v1/stats` reports from the `decisions` table. See
[docs/READINESS.md](docs/READINESS.md) for the full contract.

Audit forwarding is observable too: `audit_forward_enabled`, `audit_forward_events_total{result="recorded|sent|dropped|failed"}` and `audit_forward_pending`. A rising `dropped`, or a `pending` that does not drain, means audit events are being lost or delayed; alert on it.

## Backup / restore

The state to protect is the SQLite file at `DB_PATH` (default `./data/ratelimit.db`, plus WAL
sidecars while running) — policy and override definitions matter most; counters and hourly
statistics are comparatively disposable. Use `stack backup`/`stack restore` from the workspace root
(see `atc-stack/docs/UPGRADE.md`) to snapshot and restore this service's database consistently alongside
the rest of the stack. On every start, before applying a pending migration to an existing database,
the service itself also snapshots the file to `DB_PATH.pre-v<N>-<timestamp>` (directory overridable
with `DB_BACKUP_DIR`) — a manual last resort if `stack restore` is unavailable. See
[docs/READINESS.md](docs/READINESS.md) for the full contract.

**Rollback limitations:** none of the migrations are reversible; to roll back, restore the
pre-migration copy (or a `stack backup` snapshot taken before the upgrade) and run the previous
version of this service against it.

## License

MIT, Ali Talip CALIKOGLU.
