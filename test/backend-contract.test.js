import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Database } from '../src/db.js';
import { CounterStore } from '../src/store/counter-store.js';
import { PolicyStore } from '../src/store/policy-store.js';
import { MemoryCounterBackend } from '../src/store/memory-counter-backend.js';
import { SqliteCounterBackend } from '../src/store/sqlite-counter-backend.js';

// test/backend-contract-memory.test.js runs this same file against MemoryCounterBackend.
const KIND = process.env.CONTRACT_BACKEND === 'memory' ? 'memory' : 'sqlite';
/** @param {Database} db @returns {import('../src/domain/counter-backend.js').CounterBackend & { stop?: () => void }} */
const make = (db) => (KIND === 'memory' ? new MemoryCounterBackend(new CounterStore(db), { flushMs: 1_000, now: () => T }) : new SqliteCounterBackend(db, new CounterStore(db)));

/**
 * Contract suite for any `CounterBackend` implementation. Runs against `SqliteCounterBackend`
 * today; a future Redis backend must pass this file unchanged (only `factory` below would need a
 * Redis-backed counterpart) — see `src/domain/counter-backend.js` for the atomicity each method
 * documents and this suite exercises.
 *
 * What this suite does NOT prove: real OS-level concurrency (two separate connections/processes
 * racing for the same counter). SQLite calls here are synchronous, so a `Promise.all` of them
 * never actually overlaps — it only proves the invariant holds across interleaved sequential
 * calls, which any correct backend must also satisfy, but it is not the same guarantee as real
 * concurrent writers. That is verified separately, for `SqliteCounterBackend` specifically, in
 * `test/concurrency.test.js` using `node:worker_threads` (independent connections, independent OS
 * threads, the real file lock).
 */

/**
 * One fresh, isolated backend per call — independent in-memory database. `counters.policy` has a
 * foreign key onto `policies.name` (see `src/db.js`), so the contract suite — which talks to the
 * backend directly, bypassing `RateLimitService`'s own `policies.require()` — seeds a bare policy
 * row per name under test; the backend interface itself takes only a policy NAME, never a row.
 * @param {string[]} policyNames
 */
function makeBackend(policyNames = ['api']) {
  const db = new Database(':memory:');
  const policies = new PolicyStore(db);
  for (const name of policyNames) policies.insert({ name, description: '', limits: '[]', created_by: 'test', created_at: 0, updated_at: 0 });
  return { backend: make(db), close: () => {} };
}

const T = Date.parse('2026-09-17T10:00:00Z');
const windowStart = (/** @type {number} */ w, /** @type {number} */ now) => Math.floor(now / (w * 1000)) * (w * 1000);

test(`[${KIND}] Backend contract: first consume is allowed and decrements remaining`, () => {
  const { backend } = makeBackend();
  const checks = [{ policy: 'api', subject: 'u1', cost: 1, limits: [{ window: 60, limit: 3 }] }];
  const r = backend.checkAndConsume(checks, T);
  assert.deepEqual([r.allowed, r.states[0][0].allowed, r.states[0][0].used, r.states[0][0].remaining], [true, true, 0, 2], 'used is the count BEFORE this request; remaining already accounts for it');
  const after = backend.checkAndConsume(checks, T, { peek: true });
  assert.equal(after.states[0][0].used, 1, 'the consumed unit is now reflected');
});

test(`[${KIND}] Backend contract: limit reached denies and does not over-consume`, () => {
  const { backend } = makeBackend();
  const checks = [{ policy: 'api', subject: 'u1', cost: 1, limits: [{ window: 60, limit: 2 }] }];
  backend.checkAndConsume(checks, T);
  backend.checkAndConsume(checks, T);
  const denied = backend.checkAndConsume(checks, T);
  assert.deepEqual([denied.allowed, denied.states[0][0].used], [false, 2], 'the denied attempt did not itself consume');
  const after = backend.checkAndConsume(checks, T, { peek: true });
  assert.equal(after.states[0][0].used, 2, 'still exactly 2, not 3');
});

test(`[${KIND}] Backend contract: independent policy/subject/window keys never interfere`, () => {
  const { backend } = makeBackend(['api', 'other']);
  backend.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 1, limits: [{ window: 60, limit: 1 }] }], T);
  const other = [
    backend.checkAndConsume([{ policy: 'other', subject: 'u1', cost: 1, limits: [{ window: 60, limit: 1 }] }], T),
    backend.checkAndConsume([{ policy: 'api', subject: 'u2', cost: 1, limits: [{ window: 60, limit: 1 }] }], T),
    backend.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 1, limits: [{ window: 3600, limit: 1 }] }], T),
  ];
  assert.deepEqual(other.map((r) => r.allowed), [true, true, true], 'a different policy, subject or window is a wholly separate counter');
});

test(`[${KIND}] Backend contract: one check with several limits evaluates and reports every one`, () => {
  const { backend } = makeBackend();
  const checks = [{ policy: 'api', subject: 'u1', cost: 1, limits: [{ window: 60, limit: 5 }, { window: 3600, limit: 2 }] }];
  backend.checkAndConsume(checks, T);
  backend.checkAndConsume(checks, T);
  const r = backend.checkAndConsume(checks, T);
  assert.deepEqual([r.allowed, r.states[0][0].allowed, r.states[0][1].allowed], [false, true, false], 'the hourly limit blocks even though the minute limit still has room');
});

test(`[${KIND}] Backend contract: checkMany consumes every check only when all pass`, () => {
  const { backend } = makeBackend(['api', 'login']);
  const checks = [
    { policy: 'api', subject: 'u1', cost: 1, limits: [{ window: 60, limit: 5 }] },
    { policy: 'login', subject: 'u1', cost: 1, limits: [{ window: 60, limit: 5 }] },
  ];
  const r = backend.checkAndConsume(checks, T);
  assert.equal(r.allowed, true);
  const peek = backend.checkAndConsume(checks, T, { peek: true });
  assert.deepEqual([peek.states[0][0].used, peek.states[1][0].used], [1, 1], 'both checks were consumed');
});

test(`[${KIND}] Backend contract: checkMany — one denied check consumes nothing for the whole batch`, () => {
  const { backend } = makeBackend(['api', 'login']);
  backend.checkAndConsume([{ policy: 'login', subject: 'u1', cost: 1, limits: [{ window: 60, limit: 1 }] }], T); // exhaust login first
  const checks = [
    { policy: 'api', subject: 'u1', cost: 1, limits: [{ window: 60, limit: 5 }] }, // would pass on its own
    { policy: 'login', subject: 'u1', cost: 1, limits: [{ window: 60, limit: 1 }] }, // already exhausted
  ];
  const r = backend.checkAndConsume(checks, T);
  assert.equal(r.allowed, false);
  const peek = backend.checkAndConsume(checks, T, { peek: true });
  assert.equal(peek.states[0][0].used, 0, 'the check that would have passed on its own consumed nothing');
});

test(`[${KIND}] Backend contract: peek never consumes, allowed or not`, () => {
  const { backend } = makeBackend();
  const checks = [{ policy: 'api', subject: 'u1', cost: 1, limits: [{ window: 60, limit: 1 }] }];
  backend.checkAndConsume(checks, T, { peek: true });
  backend.checkAndConsume(checks, T, { peek: true });
  const r = backend.checkAndConsume(checks, T, { peek: true });
  assert.deepEqual([r.allowed, r.states[0][0].used], [true, 0], 'three peeks, still nothing consumed');
});

test(`[${KIND}] Backend contract: concurrent consume at the boundary (interleaved calls, one connection)`, () => {
  const { backend } = makeBackend();
  const checks = [{ policy: 'api', subject: 'u1', cost: 1, limits: [{ window: 60, limit: 1 }] }];
  // Two "racing" attempts for the single remaining unit. Node's sync SQLite bindings make this
  // strictly sequential (see the module doc above), but the invariant under test — exactly one of
  // the two ever wins — is the same invariant a real race must satisfy.
  const results = [backend.checkAndConsume(checks, T), backend.checkAndConsume(checks, T)];
  assert.deepEqual(results.map((r) => r.allowed).sort(), [false, true], 'exactly one of the two consumed the single unit');
});

test(`[${KIND}] Backend contract: release restores the same window when no boundary was crossed`, () => {
  const { backend } = makeBackend();
  const limits = [{ window: 60, limit: 3 }];
  backend.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 1, limits }], T);
  const [state] = backend.release('api', 'u1', limits, T, 1, T);
  assert.deepEqual([state.used, state.remaining], [0, 3]);
});

test(`[${KIND}] Backend contract: release after a window rollover still targets the consumed window`, () => {
  const { backend } = makeBackend();
  const limits = [{ window: 60, limit: 3 }];
  const w0 = windowStart(60, T);
  const w1 = w0 + 60_000;
  backend.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 1, limits }], T); // consumed in w0
  // Released at w1, but consumedAt still names the original instant in w0.
  const [state] = backend.release('api', 'u1', limits, T, 1, w1);
  assert.equal(state.remaining, 3, 'w0 is credited back, visible immediately via the sliding read at w1');
  const [ifReleasedAtNow] = backend.release('api', 'u1', limits, w1, 0, w1); // no-op release just to read current state at w1 with consumedAt=w1
  assert.equal(ifReleasedAtNow.remaining, 3, 'still 3 — releasing "at w1" targets the (empty) w1 window and changes nothing further');
});

test(`[${KIND}] Backend contract: duplicate and excess release never takes a counter negative`, () => {
  const { backend } = makeBackend();
  const limits = [{ window: 60, limit: 3 }];
  backend.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 1, limits }], T);
  /** @type {import('../src/types.js').LimitState} */
  let state = /** @type {any} */ (undefined);
  for (let i = 0; i < 5; i++) [state] = backend.release('api', 'u1', limits, T, 2, T);
  assert.deepEqual([state.used, state.remaining], [0, 3], 'never negative, never over-credited past the limit');
});

test(`[${KIND}] Backend contract: counters survive a restart (reopen against the same file)`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ratelimit-backend-contract-'));
  const path = join(dir, 'counters.db');
  try {
    const db1 = new Database(path);
    new PolicyStore(db1).insert({ name: 'api', description: '', limits: '[]', created_by: 'test', created_at: 0, updated_at: 0 });
    const backend1 = make(db1);
    backend1.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 2, limits: [{ window: 60, limit: 5 }] }], T);
    backend1.stop?.(); // the memory backend writes its counters on a clean shutdown
    db1.close();

    const db2 = new Database(path); // simulates the process restarting against the same DB_PATH
    const backend2 = make(db2);
    const r = backend2.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 0, limits: [{ window: 60, limit: 5 }] }], T, { peek: true });
    assert.equal(r.states[0][0].used, 2, 'the count from before the restart is still there');
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`[${KIND}] Backend contract: cleanup removes windows two spans old, and only those`, () => {
  const { backend } = makeBackend();
  const limits = [{ window: 60, limit: 5 }];
  backend.checkAndConsume([{ policy: 'api', subject: 'old', cost: 1, limits }], T);
  backend.checkAndConsume([{ policy: 'api', subject: 'fresh', cost: 1, limits }], T + 130_000);
  const removed = backend.cleanup(T + 130_000);
  assert.equal(removed, 1, 'only the window from T, now more than two spans in the past, is removed');
  const old = backend.checkAndConsume([{ policy: 'api', subject: 'old', cost: 0, limits }], T + 130_000, { peek: true });
  const fresh = backend.checkAndConsume([{ policy: 'api', subject: 'fresh', cost: 0, limits }], T + 130_000, { peek: true });
  assert.deepEqual([old.states[0][0].used, fresh.states[0][0].used], [0, 1]);
});
