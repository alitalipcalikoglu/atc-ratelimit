import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { WRITE_KEY, READ_KEY, bearer, buildApp } from './helpers.js';

const json = (/** @type {import('light-my-request').Response} */ r) => JSON.parse(r.body);
const silent = { warn() {}, error() {} };

test('AuditClient: buffers, batches with idempotent ids, retries, drops rejected batches, no-op when off', async () => {
  /** @type {{ url: string, body: any, auth: string|undefined }[]} */ const calls = [];
  let fail = 2;
  const fetchImpl = /** @type {typeof fetch} */ (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: /** @type {any} */ (init?.headers).authorization });
    if (fail-- > 0) return new Response('down', { status: 503 });
    return new Response('{}', { status: 200 });
  });
  const c = new AuditClient({ target: { url: 'http://audit.test/', apiKey: 'a'.repeat(40) }, batchSize: 2, logger: silent, fetch: fetchImpl, sleep: async () => {} });
  assert.equal(c.record({ action: 'x.one' }), true);
  c.record({ action: 'x.two', outcome: 'denied' });
  c.record({ action: 'x.three' });
  await c.flush();
  assert.deepEqual([calls.length, calls[0].url, calls[0].auth, calls[0].body.events.length, calls[2].body.events.length], [4, 'http://audit.test/v1/events/batch', `Bearer ${'a'.repeat(40)}`, 2, 2]);
  assert.equal(calls[0].body.events[0].id, calls[2].body.events[0].id, 'retries resend the same ids');
  assert.deepEqual([c.stats.sent, c.buffer.length, calls[3].body.events[0].action], [3, 0, 'x.three']);
  const rejecting = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: silent, fetch: async () => new Response('bad', { status: 400 }) });
  rejecting.record({ action: 'x.bad' });
  await rejecting.flush();
  assert.deepEqual([rejecting.stats.dropped, rejecting.buffer.length], [1, 0]);
  const dead = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: silent, fetch: async () => { throw new Error('ECONNREFUSED'); }, sleep: async () => {} });
  dead.record({ action: 'x.kept' });
  await dead.flush();
  assert.deepEqual([dead.stats.failed, dead.buffer.length], [1, 1], 'unreachable service keeps the event for the next flush');
  const off = new AuditClient({ target: null });
  assert.equal(off.record({ action: 'x' }), false);
  assert.equal(off.enabled, false);
});

test('API: write routes record audit events with actor, target and request context; denials too', async (t) => {
  const audit = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: silent, fetch: async () => new Response('{}', { status: 200 }) });
  const { app } = await buildApp(undefined, { audit });
  t.after(() => app.close());

  const res = await app.inject({ method: 'POST', url: '/v1/policies', headers: { ...bearer(WRITE_KEY), 'user-agent': 'test-agent' }, payload: { name: 'api', limits: [{ window: 60, limit: 3 }] } });
  assert.ok(res.statusCode < 300, res.body);
  assert.equal(audit.buffer.length, 1);
  const e = audit.buffer[0];
  assert.deepEqual([e.action, e.outcome, e.actor, e.target, e.userAgent, typeof e.requestId, typeof e.id, e.ip], ['atc-ratelimit.policy.create', 'success', { type: 'apikey', id: e.actor?.id }, { type: 'policy', id: 'api' }, 'test-agent', 'string', 'string', '127.0.0.1']);
  assert.ok(e.actor?.id);
  const denied = await app.inject({ method: 'POST', url: '/v1/policies', headers: bearer(READ_KEY), payload: { name: 'x', limits: [{ window: 60, limit: 3 }] } });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual([audit.buffer.length, audit.buffer[1].action, audit.buffer[1].outcome], [2, 'atc-ratelimit.policy.create', 'denied']);
  await app.inject({ url: '/v1/nope', headers: bearer(WRITE_KEY) });
  assert.equal(audit.buffer.length, 2, 'reads and 404s are not audit events');
});
