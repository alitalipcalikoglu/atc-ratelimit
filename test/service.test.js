import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimitError } from '../src/domain/errors.js';
import { testService } from './helpers.js';

const T = Date.parse('2026-09-17T10:00:00Z');
const API = [{ window: 60, limit: 3 }, { window: 3600, limit: 5 }];

test('Service: check consumes across windows, denies with the most restrictive window, peek and release', () => {
  const { service, clock, counters } = testService();
  service.createPolicy({ name: 'api', limits: API }, 'admin');
  const c = () => service.check({ policy: 'api', subject: 'u1' });
  assert.deepEqual([c().remaining, c().remaining, c().remaining], [2, 1, 0]);
  let d = c();
  assert.deepEqual([d.allowed, d.limit, d.remaining, d.retryAfter, d.source, d.blocked], [false, 3, 0, 60, 'policy', false]);
  clock.t = T + 60_000;
  d = c();
  assert.deepEqual([d.allowed, d.retryAfter], [false, 20], 'previous window still weighs fully');
  clock.t = T + 80_000;
  assert.equal(c().allowed, true, 'allowed exactly when the hint says');
  clock.t = T + 120_000;
  assert.equal(c().allowed, true);
  d = c();
  assert.deepEqual([d.allowed, d.limit, d.remaining, d.retryAfter, d.limits.map((l) => l.allowed)], [false, 5, 0, 3480, [true, false]], 'hourly window denies');
  assert.equal(service.check({ policy: 'api', subject: 'u2' }, { peek: true }).remaining, 2);
  assert.equal(service.check({ policy: 'api', subject: 'u2' }, { peek: true }).remaining, 2, 'peek does not consume');
  assert.equal(service.tally.get('api')?.allowed, 5);
  assert.equal(service.tally.get('api')?.denied, 3);
  assert.equal(counters.pair('api', 'u2', 60, T + 120_000).cur, 0);

  d = service.release({ policy: 'api', subject: 'u1', cost: 1 });
  assert.deepEqual([d.limits[1].used, d.limits[1].remaining, d.allowed], [4, 1, true]);
  assert.equal(c().allowed, true, 'released unit is available again');
  assert.throws(() => service.check({ policy: 'api', subject: 'u1', cost: 4 }), (e) => e instanceof RateLimitError && e.code === 'COST_TOO_HIGH');
  assert.throws(() => service.check({ policy: 'none', subject: 'u1' }), (e) => e instanceof RateLimitError && e.code === 'POLICY_NOT_FOUND');
});

test('Service: overrides replace limits, block, and expire', () => {
  const { service, clock, overrides } = testService();
  service.createPolicy({ name: 'api', limits: API }, 'admin');
  service.setOverride('api', 'vip', { limits: [{ window: 60, limit: 100 }], note: 'partner' }, 'admin');
  for (let i = 0; i < 4; i++) assert.equal(service.check({ policy: 'api', subject: 'vip' }).allowed, true);
  let d = service.check({ policy: 'api', subject: 'vip' });
  assert.deepEqual([d.source, d.limit, d.remaining], ['override', 100, 95]);
  service.setOverride('api', 'bad', { limits: [{ window: 60, limit: 0 }] }, 'admin');
  d = service.check({ policy: 'api', subject: 'bad' });
  assert.deepEqual([d.allowed, d.blocked, d.retryAfter, d.remaining], [false, true, null, 0]);
  service.setOverride('api', 'tmp', { limits: [{ window: 60, limit: 1 }], expiresAt: new Date(T + 1000).toISOString() }, 'admin');
  assert.equal(service.check({ policy: 'api', subject: 'tmp' }).source, 'override');
  clock.t = T + 1000;
  assert.equal(service.check({ policy: 'api', subject: 'tmp' }).source, 'policy', 'expired override is ignored');
  assert.equal(service.usage('api', 'tmp').override?.expires_at, T + 1000, 'but still listed until cleanup');
  assert.throws(() => service.setOverride('api', 'x', { limits: [{ window: 60, limit: 1 }], expiresAt: new Date(T).toISOString() }, 'admin'), /in the future/);
  assert.throws(() => service.setOverride('api', 'x', { limits: [{ window: 60, limit: 1 }], expiresAt: 'soon' }, 'admin'), /ISO 8601/);
  service.removeOverride('api', 'vip');
  assert.throws(() => service.removeOverride('api', 'vip'), (e) => e instanceof RateLimitError && e.code === 'OVERRIDE_NOT_FOUND');
  assert.equal(overrides.count('api'), 2);
  assert.equal(service.check({ policy: 'api', subject: 'vip' }).source, 'policy');
});

test('Service: batch checks are all-or-nothing', () => {
  const { service } = testService();
  service.createPolicy({ name: 'api', limits: API }, 'admin');
  service.createPolicy({ name: 'login', limits: [{ window: 60, limit: 1 }] }, 'admin');
  const checks = [{ policy: 'api', subject: 'u1' }, { policy: 'login', subject: 'u1' }];
  assert.equal(service.checkMany(checks).allowed, true);
  const r = service.checkMany(checks);
  assert.deepEqual([r.allowed, r.results.map((d) => d.allowed)], [false, [false, false]]);
  assert.equal(service.usage('api', 'u1').decision.limits[0].used, 1, 'denied batch consumed nothing');
  assert.equal(service.tally.get('api')?.denied, 1, 'but counts as a denied decision');
  assert.throws(() => service.checkMany([...checks, { policy: 'api', subject: 'u1' }]), (e) => e instanceof RateLimitError && e.code === 'DUPLICATE_CHECK');
  assert.throws(() => service.checkMany([{ policy: 'api', subject: 'a' }, { policy: 'api', subject: 'b' }, { policy: 'api', subject: 'c' }, { policy: 'api', subject: 'd' }]), /at most 3/);
});

test('Service: usage, reset, top, stats, cleanup and policy removal', () => {
  const { service, clock, counters, overrides } = testService();
  service.createPolicy({ name: 'api', limits: API }, 'admin');
  for (const [s, n] of [['a', 3], ['b', 2], ['c', 1]]) for (let i = 0; i < Number(n); i++) service.check({ policy: 'api', subject: String(s) });
  service.check({ policy: 'api', subject: 'a' });
  assert.deepEqual(service.top('api', undefined, 10), { window: 60, limit: 3, items: [{ subject: 'a', used: 3 }, { subject: 'b', used: 2 }, { subject: 'c', used: 1 }] });
  assert.throws(() => service.top('api', 7, 10), (e) => e instanceof RateLimitError && e.code === 'UNKNOWN_WINDOW');
  assert.equal(service.resetUsage('api', 'a'), 2);
  assert.equal(service.usage('api', 'a').decision.remaining, 3);
  clock.t = T + 3_600_000;
  service.check({ policy: 'api', subject: 'a' });
  const st = service.stats('api', 3);
  assert.deepEqual([st.series.length, st.allowed, st.denied, st.series.map((x) => x.allowed)], [3, 7, 1, [0, 6, 1]]);
  assert.deepEqual(service.totals24h().get('api'), { allowed: 7, denied: 1 });
  service.setOverride('api', 'tmp', { limits: [{ window: 60, limit: 1 }], expiresAt: new Date(clock.t + 1000).toISOString() }, 'admin');
  clock.t += 2 * 86_400_000;
  assert.deepEqual(service.cleanup(), { counters: 6, overrides: 1, decisions: 0 });
  clock.t += 29 * 86_400_000;
  assert.equal(service.cleanup().decisions, 2);
  service.updatePolicy('api', { limits: [{ window: 10, limit: 1 }] });
  assert.equal(service.getPolicy('api').limits, '[{"window":10,"limit":1}]');
  service.check({ policy: 'api', subject: 'z' });
  service.setOverride('api', 'z', { limits: [{ window: 10, limit: 9 }] }, 'admin');
  service.removePolicy('api');
  assert.deepEqual([counters.total(), overrides.count('api'), service.tally.has('api')], [0, 0, false]);
  assert.throws(() => service.createPolicy({ name: 'x', limits: [] }, 'admin'), (e) => e instanceof RateLimitError && e.code === 'INVALID_LIMITS');
  service.createPolicy({ name: 'x', limits: [{ window: 1, limit: 1 }] }, 'admin');
  assert.throws(() => service.createPolicy({ name: 'x', limits: [{ window: 1, limit: 1 }] }, 'admin'), (e) => e instanceof RateLimitError && e.code === 'POLICY_EXISTS');
});

// Stage 5: release() must decrement the window that was actually consumed, not whichever window
// `now` happens to be in at release time.
test('Service: release() targets the consumed window, not the release-time window', () => {
  const { service, clock, counters } = testService();
  service.createPolicy({ name: 'api', limits: [{ window: 60, limit: 3 }] }, 'admin');
  const windowStart0 = Math.floor(T / 60_000) * 60_000;
  const windowStart1 = windowStart0 + 60_000;

  const consumed = service.check({ policy: 'api', subject: 'u1' });
  assert.equal(consumed.allowed, true);
  assert.equal(counters.pair('api', 'u1', 60, windowStart0).cur, 1, 'consumed in window 0');

  // Clock crosses the window boundary before the release arrives.
  clock.t = windowStart1;
  assert.equal(service.usage('api', 'u1').decision.remaining, 2, 'window 0 still weighs fully at the exact boundary');

  const released = service.release({ policy: 'api', subject: 'u1', consumedAt: new Date(consumed.consumedAt).toISOString() });
  assert.equal(counters.pair('api', 'u1', 60, windowStart0).cur, 0, 'window 0 is credited back, not window 1');
  assert.equal(counters.pair('api', 'u1', 60, windowStart1).cur, 0, 'window 1 was never touched');
  assert.equal(released.remaining, 3, 'full limit available again');
  assert.equal(service.usage('api', 'u1').decision.remaining, 3);
});

test('Service: release() without consumedAt keeps the pre-Stage-5 current-window behavior', () => {
  const { service, clock, counters } = testService();
  service.createPolicy({ name: 'api', limits: [{ window: 60, limit: 3 }] }, 'admin');
  const windowStart0 = Math.floor(T / 60_000) * 60_000;
  const windowStart1 = windowStart0 + 60_000;

  service.check({ policy: 'api', subject: 'u1' });
  clock.t = windowStart1;
  service.release({ policy: 'api', subject: 'u1' }); // no consumedAt: targets "now"'s window, same as before Stage 5
  assert.equal(counters.pair('api', 'u1', 60, windowStart0).cur, 1, 'window 0 is untouched: the refund is effectively lost, same as pre-fix behavior');
  assert.equal(counters.pair('api', 'u1', 60, windowStart1).cur, 0, 'window 1 has nothing to release, clamped at 0');
});

test('Service: release() never takes a counter negative, however many times it is called', () => {
  const { service, counters } = testService();
  service.createPolicy({ name: 'api', limits: [{ window: 60, limit: 3 }] }, 'admin');
  service.check({ policy: 'api', subject: 'u1' });
  for (let i = 0; i < 5; i++) service.release({ policy: 'api', subject: 'u1', cost: 2 });
  const windowStart0 = Math.floor(T / 60_000) * 60_000;
  assert.equal(counters.pair('api', 'u1', 60, windowStart0).cur, 0);
  assert.equal(service.usage('api', 'u1').decision.remaining, 3);
  assert.throws(() => service.release({ policy: 'api', subject: 'u1', consumedAt: 'not a date' }), (e) => e instanceof RateLimitError && e.code === 'INVALID_CONSUMED_AT');
});

test('Service: release() interacts correctly with the sliding estimate across a boundary', () => {
  const { service, clock } = testService();
  service.createPolicy({ name: 'api', limits: [{ window: 60, limit: 10 }] }, 'admin');
  const windowStart0 = Math.floor(T / 60_000) * 60_000;
  for (let i = 0; i < 4; i++) service.check({ policy: 'api', subject: 'u1' });
  const last = service.check({ policy: 'api', subject: 'u1' });
  // 30s into window 1: window 0 still weighs 50%.
  clock.t = windowStart0 + 90_000;
  assert.equal(service.usage('api', 'u1').decision.limits[0].used, 2.5);
  service.release({ policy: 'api', subject: 'u1', consumedAt: new Date(last.consumedAt).toISOString() });
  assert.equal(service.usage('api', 'u1').decision.limits[0].used, 2, '4 left in window 0, weighted at 50%');
});
