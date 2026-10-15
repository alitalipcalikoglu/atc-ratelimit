import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { CounterStore } from '../src/store/counter-store.js';
import { MemoryCounterBackend } from '../src/store/memory-counter-backend.js';
import { PolicyStore } from '../src/store/policy-store.js';

// The whole CounterBackend contract suite, against the memory backend.
process.env.CONTRACT_BACKEND = 'memory';
await import('./backend-contract.test.js');

const T = Date.parse('2026-09-17T10:00:00Z');
const limits = [{ window: 60, limit: 5 }];

function setup() {
  const db = new Database(':memory:');
  new PolicyStore(db).insert({ name: 'api', description: '', limits: '[]', created_by: 'test', created_at: 0, updated_at: 0 });
  const store = new CounterStore(db);
  return { db, store, backend: new MemoryCounterBackend(store, { flushMs: 1_000, now: () => T }) };
}

test('memory backend: checks touch no disk until a flush; flush writes absolute values and decision deltas', () => {
  const { store, backend } = setup();
  backend.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 2, limits }], T);
  backend.decide('api', T, true);
  backend.decide('api', T, false);
  assert.equal(store.total(), 0, 'nothing written yet');
  backend.flush();
  assert.equal(store.pair('api', 'u1', 60, Math.floor(T / 60_000) * 60_000).cur, 2);
  backend.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 1, limits }], T);
  backend.flush();
  assert.equal(store.pair('api', 'u1', 60, Math.floor(T / 60_000) * 60_000).cur, 3, 'absolute value, not added twice');
  assert.deepEqual(backend.series('api', 0).map((r) => [r.allowed, r.denied]), [[1, 1]]);
  backend.decide('api', T, true);
  assert.deepEqual(backend.totals(0).get('api'), { allowed: 2, denied: 1 }, 'statistics flush first');
  assert.equal(backend.flushes, 3);
});

test('memory backend: a failed flush keeps the data for the next try', () => {
  const { store, backend } = setup();
  const errors = /** @type {unknown[]} */ ([]);
  backend.onError = (e) => errors.push(e);
  const real = store.flush.bind(store);
  store.flush = () => { throw new Error('disk full'); };
  backend.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 1, limits }], T);
  backend.flush();
  assert.equal(errors.length, 1);
  assert.equal(backend.flushErrors, 1);
  store.flush = real;
  backend.flush();
  assert.equal(store.total(), 1);
});

test('memory backend: start-up loads live counters; a crash loses only what was not flushed', () => {
  const { db, store, backend } = setup();
  backend.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 2, limits }], T);
  backend.flush();
  backend.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 1, limits }], T); // never flushed: the "crash"
  const again = new MemoryCounterBackend(store, { flushMs: 1_000, now: () => T });
  assert.equal(again.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 0, limits }], T, { peek: true }).states[0][0].used, 2);
  assert.equal(new MemoryCounterBackend(store, { flushMs: 1_000, now: () => T + 3_600_000 }).total(), 0, 'dead windows are not loaded');
  db.close();
});

test('memory backend: top, active subjects and reset work from memory', () => {
  const { store, backend } = setup();
  for (const [s, n] of [['a', 3], ['b', 1], ['c', 2]]) backend.checkAndConsume([{ policy: 'api', subject: String(s), cost: Number(n), limits }], T);
  assert.deepEqual(backend.top('api', 60, Math.floor(T / 60_000) * 60_000, 0.5, 2), [{ subject: 'a', used: 3 }, { subject: 'c', used: 2 }]);
  assert.equal(backend.activeSubjects('api', T), 3);
  backend.flush();
  assert.equal(backend.reset('api', 'a'), 1);
  assert.equal(store.pair('api', 'a', 60, Math.floor(T / 60_000) * 60_000).cur, 0, 'reset also clears SQLite');
  assert.equal(backend.total(), 2);
});

test('config: COUNTER_BACKEND and COUNTER_FLUSH_MS', () => {
  const base = { RATELIMIT_API_KEYS: `k:${'k'.repeat(40)}`, DB_PATH: ':memory:' };
  assert.equal(Config.fromEnv(base).counterBackend, 'sqlite');
  const c = Config.fromEnv({ ...base, COUNTER_BACKEND: 'memory', COUNTER_FLUSH_MS: '250' });
  assert.deepEqual([c.counterBackend, c.counterFlushMs], ['memory', 250]);
  assert.throws(() => Config.fromEnv({ ...base, COUNTER_BACKEND: 'redis' }), /sqlite or memory/);
});
