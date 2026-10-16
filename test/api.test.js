import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { CHECK_KEY, READ_KEY, RW_KEY, SHOP_KEY, WRITE_KEY, bearer, buildApp } from './helpers.js';

const json = (/** @type {import('light-my-request').Response} */ r) => JSON.parse(r.body);
const API = [{ window: 60, limit: 3 }, { window: 3600, limit: 5 }];
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('API: probes, auth, roles and policy scoping', async (t) => {
  const { app } = await buildApp(undefined, { version: readServiceVersion(import.meta.url) });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/ready' })).statusCode, 200);
  const spec = await app.inject({ url: '/openapi.yaml' });
  assert.equal(spec.body, readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
  assert.match(String(spec.headers['content-type']), /^text\/yaml/);
  const info = await app.inject({ url: '/v1/info' });
  assert.equal(info.statusCode, 200);
  const infoBody = json(info);
  assert.deepEqual(
    [infoBody.service, infoBody.version, infoBody.apiVersion, infoBody.capabilities],
    ['atc-ratelimit', PACKAGE_VERSION, 'v1', ['policy-windows', 'overrides', 'usage-stats', 'counters-sqlite']],
  );
  assert.equal(typeof infoBody.schemaVersion, 'number');
  assert.equal(typeof infoBody.serviceCore, 'string');
  assert.equal((await app.inject({ url: '/v1/policies' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/policies', headers: bearer(CHECK_KEY) })).statusCode, 403, 'check role cannot read');
  assert.equal((await app.inject({ url: '/v1/policies', headers: bearer(WRITE_KEY) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/policies', headers: bearer(READ_KEY), payload: { name: 'a', limits: API } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/check', headers: bearer(READ_KEY), payload: { policy: 'a', subject: 'x' } })).statusCode, 403, 'read role cannot check');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/policies', headers: bearer(WRITE_KEY), payload: { name: 'api', limits: API } })).statusCode, 201);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/policies', headers: bearer(WRITE_KEY), payload: { name: 'internal', limits: API } })).statusCode, 201);
  let res = await app.inject({ url: '/v1/policies', headers: bearer(SHOP_KEY) });
  assert.deepEqual(json(res).items.map((/** @type {any} */ p) => p.name), ['api'], 'scoped key sees only its policies');
  res = await app.inject({ method: 'POST', url: '/v1/check', headers: bearer(SHOP_KEY), payload: { policy: 'internal', subject: 'x' } });
  assert.equal(res.statusCode, 403);
  assert.match(json(res).error.message, /no access to policy "internal"/);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/check/batch', headers: bearer(SHOP_KEY), payload: { checks: [{ policy: 'api', subject: 'x' }, { policy: 'internal', subject: 'x' }] } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/policies', headers: bearer(SHOP_KEY), payload: { name: 'other', limits: API } })).statusCode, 403, 'scoped key cannot create outside its scope');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/check', headers: bearer(CHECK_KEY), payload: { policy: 'api', subject: 'x' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/metrics', headers: bearer(CHECK_KEY) })).statusCode, 403);
});

test('API: policy lifecycle, checks, batch, release, overrides, usage, top, stats, metrics', async (t) => {
  const { app, clock } = await buildApp();
  t.after(() => app.close());
  let res = await app.inject({ method: 'POST', url: '/v1/policies', headers: bearer(WRITE_KEY), payload: { name: 'api', description: 'Public API', limits: [{ window: 3600, limit: 5 }, { window: 60, limit: 3 }] } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.headers.location, '/v1/policies/api');
  assert.deepEqual([json(res).policy.limits, json(res).policy.createdBy, json(res).policy.last24h], [API, 'admin', { allowed: 0, denied: 0 }]);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/policies', headers: bearer(WRITE_KEY), payload: { name: 'Bad Name', limits: API } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/policies', headers: bearer(WRITE_KEY), payload: { name: 'api', limits: API } })).statusCode, 409);
  res = await app.inject({ method: 'POST', url: '/v1/policies', headers: bearer(WRITE_KEY), payload: { name: 'dup', limits: [{ window: 60, limit: 1 }, { window: 60, limit: 2 }] } });
  assert.deepEqual([res.statusCode, json(res).error.code], [400, 'INVALID_LIMITS']);

  const check = (/** @type {object} */ payload, key = CHECK_KEY) => app.inject({ method: 'POST', url: '/v1/check', headers: bearer(key), payload });
  res = await check({ policy: 'api', subject: '203.0.113.7' });
  assert.equal(res.statusCode, 200, res.body);
  let d = json(res);
  assert.deepEqual([d.allowed, d.limit, d.remaining, d.retryAfter, d.resetAt, d.limits.length, d.source], [true, 3, 2, 0, '2026-09-17T10:01:00.000Z', 2, 'policy']);
  await check({ policy: 'api', subject: '203.0.113.7', cost: 2 });
  d = json(await check({ policy: 'api', subject: '203.0.113.7' }));
  assert.deepEqual([d.allowed, d.remaining, d.retryAfter], [false, 0, 60]);
  assert.equal(json(await check({ policy: 'api', subject: '203.0.113.7', peek: true })).allowed, false);
  assert.equal(json(await check({ policy: 'api', subject: 'other', peek: true })).remaining, 2);
  assert.equal(json(await check({ policy: 'api', subject: 'other', peek: true })).remaining, 2, 'peek does not consume');
  assert.deepEqual([(await check({ policy: 'api', subject: 'x', cost: 9 })).statusCode, json(await check({ policy: 'api', subject: 'x', cost: 9 })).error.code], [400, 'COST_TOO_HIGH']);
  assert.equal((await check({ policy: 'missing', subject: 'x' })).statusCode, 404);
  assert.equal((await check({ policy: 'api', subject: 'bad\u0000' })).statusCode, 400, 'control characters in subject');

  res = await app.inject({ method: 'POST', url: '/v1/release', headers: bearer(CHECK_KEY), payload: { policy: 'api', subject: '203.0.113.7' } });
  assert.deepEqual([res.statusCode, json(res).remaining], [200, 1]);
  assert.ok(json(res).consumedAt, 'a release response also carries a consumedAt (the instant it was evaluated at)');

  assert.equal((await app.inject({ method: 'POST', url: '/v1/policies', headers: bearer(WRITE_KEY), payload: { name: 'login', limits: [{ window: 60, limit: 1 }] } })).statusCode, 201);
  const batch = { checks: [{ policy: 'api', subject: 'u9' }, { policy: 'login', subject: 'u9' }] };
  res = await app.inject({ method: 'POST', url: '/v1/check/batch', headers: bearer(CHECK_KEY), payload: batch });
  assert.deepEqual([res.statusCode, json(res).allowed, json(res).results.map((/** @type {any} */ r) => r.remaining)], [200, true, [2, 0]]);
  res = await app.inject({ method: 'POST', url: '/v1/check/batch', headers: bearer(CHECK_KEY), payload: batch });
  assert.deepEqual([json(res).allowed, json(res).results.map((/** @type {any} */ r) => r.allowed)], [false, [false, false]]);
  res = await app.inject({ url: '/v1/policies/api/subjects/u9', headers: bearer(READ_KEY) });
  assert.deepEqual([json(res).usage.remaining, json(res).usage.limits[0].used, json(res).override], [2, 1, null], 'denied batch consumed nothing');

  res = await app.inject({ method: 'PUT', url: '/v1/policies/api/overrides/partner-1', headers: bearer(WRITE_KEY), payload: { limits: [{ window: 60, limit: 100 }], note: 'Partner', expiresAt: '2026-09-18T00:00:00Z' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual([json(res).override.limits, json(res).override.blocked, json(res).override.expiresAt, json(res).override.expired], [[{ window: 60, limit: 100 }], false, '2026-09-18T00:00:00.000Z', false]);
  assert.deepEqual([json(await check({ policy: 'api', subject: 'partner-1' })).source, json(await check({ policy: 'api', subject: 'partner-1' })).remaining], ['override', 98]);
  res = await app.inject({ method: 'PUT', url: '/v1/policies/api/overrides/abuser', headers: bearer(WRITE_KEY), payload: { limits: [{ window: 3600, limit: 0 }] } });
  assert.equal(json(res).override.blocked, true);
  d = json(await check({ policy: 'api', subject: 'abuser' }));
  assert.deepEqual([d.allowed, d.blocked, d.retryAfter], [false, true, null]);
  res = await app.inject({ url: '/v1/policies/api/overrides?limit=10', headers: bearer(READ_KEY) });
  assert.deepEqual([json(res).total, json(res).items.map((/** @type {any} */ o) => o.subject)], [2, ['abuser', 'partner-1']]);
  res = await app.inject({ url: '/v1/policies/api/overrides?limit=1', headers: bearer(READ_KEY) });
  assert.deepEqual([json(res).items[0].subject, json(res).nextCursor], ['abuser', 'abuser']);
  res = await app.inject({ url: '/v1/policies/api/overrides?limit=1&cursor=abuser', headers: bearer(READ_KEY) });
  assert.deepEqual([json(res).items[0].subject, json(res).nextCursor], ['partner-1', null], 'the last page has no cursor');
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/policies/api/overrides/x', headers: bearer(WRITE_KEY), payload: { limits: [{ window: 60, limit: 1 }], expiresAt: '2020-01-01T00:00:00Z' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/policies/api/overrides/abuser', headers: bearer(WRITE_KEY) })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/policies/api/overrides/abuser', headers: bearer(WRITE_KEY) })).statusCode, 404);

  res = await app.inject({ url: '/v1/policies/api/top?limit=2', headers: bearer(READ_KEY) });
  assert.deepEqual(json(res), { window: 60, limit: 3, items: [{ subject: '203.0.113.7', used: 2 }, { subject: 'partner-1', used: 2 }], nextCursor: null });
  assert.equal((await app.inject({ url: '/v1/policies/api/top?window=7', headers: bearer(READ_KEY) })).statusCode, 400);
  res = await app.inject({ url: '/v1/policies/api', headers: bearer(READ_KEY) });
  assert.deepEqual([json(res).policy.overrides, json(res).policy.activeSubjects, json(res).policy.last24h], [1, 3, { allowed: 5, denied: 3 }]);
  clock.t += 3_600_000;
  res = await app.inject({ url: '/v1/policies/api/stats?hours=2', headers: bearer(READ_KEY) });
  assert.deepEqual(json(res), { hours: 2, allowed: 5, denied: 3, series: [{ hour: '2026-09-17T10:00:00.000Z', allowed: 5, denied: 3 }, { hour: '2026-09-17T11:00:00.000Z', allowed: 0, denied: 0 }] });
  assert.equal((await app.inject({ url: '/v1/policies/api/stats?hours=0', headers: bearer(READ_KEY) })).statusCode, 400);

  res = await app.inject({ method: 'DELETE', url: '/v1/policies/api/subjects/203.0.113.7/usage', headers: bearer(WRITE_KEY) });
  assert.deepEqual([res.statusCode, json(res).removed], [200, 2]);
  res = await app.inject({ method: 'PATCH', url: '/v1/policies/api', headers: bearer(WRITE_KEY), payload: { description: 'Public API v2', limits: [{ window: 1, limit: 1 }] } });
  assert.deepEqual([json(res).policy.description, json(res).policy.limits], ['Public API v2', [{ window: 1, limit: 1 }]]);
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/policies/api', headers: bearer(WRITE_KEY), payload: {} })).statusCode, 400);

  res = await app.inject({ url: '/v1/stats', headers: bearer(READ_KEY) });
  assert.equal(json(res).backend, 'sqlite', 'the stats say which counter backend runs');
  assert.deepEqual([json(res).policies, json(res).last24h, json(res).items.map((/** @type {any} */ p) => p.name)], [2, { allowed: 6, denied: 4 }, ['api', 'login']]);
  const metrics = await app.inject({ url: '/metrics', headers: bearer(READ_KEY) });
  assert.match(metrics.body, /ratelimit_decisions_total\{policy="api",decision="denied"\} 3\n/);
  assert.match(metrics.body, /ratelimit_policies 2\n/);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/policies/api', headers: bearer(WRITE_KEY) })).statusCode, 204);
  assert.equal((await app.inject({ url: '/v1/policies/api', headers: bearer(READ_KEY) })).statusCode, 404);
  assert.equal((await check({ policy: 'api', subject: 'x' }, RW_KEY)).statusCode, 404);
});

test('API: release consumedAt round-trip across a window boundary', async (t) => {
  const { app, clock } = await buildApp();
  t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/v1/policies', headers: bearer(WRITE_KEY), payload: { name: 'api', limits: [{ window: 60, limit: 3 }] } });
  const res = await app.inject({ method: 'POST', url: '/v1/check', headers: bearer(CHECK_KEY), payload: { policy: 'api', subject: 'u1' } });
  const consumedAt = json(res).consumedAt;
  assert.ok(consumedAt, 'check() response carries consumedAt');
  clock.t += 60_000; // cross the window boundary before releasing
  const released = await app.inject({ method: 'POST', url: '/v1/release', headers: bearer(CHECK_KEY), payload: { policy: 'api', subject: 'u1', consumedAt } });
  assert.equal(json(released).remaining, 3, 'passing back consumedAt credits the window that was actually consumed');

  const bad = await app.inject({ method: 'POST', url: '/v1/release', headers: bearer(CHECK_KEY), payload: { policy: 'api', subject: 'u1', consumedAt: 'not a date' } });
  assert.deepEqual([bad.statusCode, json(bad).error.code], [400, 'INVALID_CONSUMED_AT']);
});
