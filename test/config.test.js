import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { testEnv } from './helpers.js';

test('Config: defaults, key roles and policy scopes', () => {
  const c = Config.fromEnv(testEnv());
  assert.deepEqual(c.apiKeys.map((k) => [k.id, k.role, k.policies]), [['console', 'readwrite', null], ['viewer', 'read', null], ['admin', 'write', null], ['gateway', 'check', null], ['shop', 'readwrite', ['api', 'login']]]);
  assert.deepEqual([c.port, c.maxLimits, c.maxWindowSec, c.maxCost, c.maxBatch, c.cleanupIntervalSec, c.statsRetentionDays], [0, 5, 2_592_000, 1_000_000, 3, 60, 30]);
  assert.ok(Object.isFrozen(c));
});

test('Config: rejects bad input', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => Config.fromEnv(testEnv(o)), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ RATELIMIT_API_KEYS: '' }, /RATELIMIT_API_KEYS is required/);
  bad({ RATELIMIT_API_KEYS: 'a:short' }, /at least 32/);
  bad({ RATELIMIT_API_KEYS: `a:${'a'.repeat(40)}:owner` }, /one of check, read, write, readwrite/);
  bad({ RATELIMIT_API_KEYS: `a:${'a'.repeat(40)}:read:Bad Policy` }, /invalid policy/);
  bad({ RATELIMIT_API_KEYS: `a:${'a'.repeat(40)},b:${'a'.repeat(40)}` }, /secrets must be unique/);
  bad({ MAX_BATCH: '0' }, />= 1/);
  bad({ TLS_CERT_PATH: '/x.pem' }, /must be set together/);
});

test('Config: POLICY_SEEDS parses name=limit/window[+…] and rejects bad entries', () => {
  const c = Config.fromEnv(testEnv({ POLICY_SEEDS: 'auth-public=20/60, api=100/60+1000/3600' }));
  assert.deepEqual(c.policySeeds.map((p) => [p.name, p.limits.map((l) => `${l.limit}/${l.window}`)]), [['auth-public', ['20/60']], ['api', ['100/60', '1000/3600']]]);
  for (const bad of ['x', '=5/60', 'a=5', 'a=5/60,a=1/60', 'A B=5/60']) assert.throws(() => Config.fromEnv(testEnv({ POLICY_SEEDS: bad })), ConfigError, bad);
});
