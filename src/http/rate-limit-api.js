import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { createErrorHandler, jsonParser, registerInfo, registerOpenApi, registerProbes, registerRequestContext, requestOptions } from '@atc-web/atc-service-core/fastify';
import { RateLimitError } from '../domain/errors.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Schemas } from './schemas.js';
import { Views } from './views.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */

/** HTTP surface: checks (check role), policy and override management (write), usage and statistics (read). */
export class RateLimitApi {
  static READY_CACHE_MS = 10_000;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {import('../domain/rate-limit-service.js').RateLimitService} deps.service
   * @param {import('../store/policy-store.js').PolicyStore} deps.policies
   * @param {import('../store/override-store.js').OverrideStore} deps.overrides
   * @param {import('../db.js').Database} deps.db
   * @param {string} deps.version
   * @param {import('../types.js').Logger} [deps.logger]
   * @param {import('@atc-web/atc-service-core/audit').AuditClient} [deps.audit]
   */
  constructor({ config, audit, service, policies, overrides, db, version, logger }) {
    this.config = config;
    this.audit = audit;
    this.service = service;
    this.policies = policies;
    this.overrides = overrides;
    this.db = db;
    this.version = version;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      ...requestOptions({ logger: this.logger, logLevel: config.logLevel }),
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    registerRequestContext(app, { trustProxy: config.trustProxy });
    app.decorateRequest('apiKey', /** @type {any} */ (null));
    jsonParser(app);
    app.setErrorHandler(createErrorHandler(RateLimitError));
    app.addHook('onSend', AuditClient.hook(this.audit));
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', 'no-store');
    });
    registerProbes(app, () => this.db.ping(), { cacheMs: RateLimitApi.READY_CACHE_MS });
    registerOpenApi(app, new URL('../../openapi.yaml', import.meta.url));
    registerInfo(app, {
      service: 'atc-ratelimit',
      version: this.version,
      capabilities: ['policy-windows', 'overrides', 'usage-stats'],
      schemaVersion: this.db.schemaVersion,
    });
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }


  /** @param {FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKey.id,
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    const s = this.service;
    const check = { preValidation: ApiKeyAuth.require('check') };
    const read = { preValidation: ApiKeyAuth.require('read') };
    const write = { preValidation: ApiKeyAuth.require('write') };
    const name = (/** @type {FastifyRequest} */ r) => { const n = /** @type {{ name: string }} */ (r.params).name; ApiKeyAuth.assertPolicy(r.apiKey, n); return n; };
    const subject = (/** @type {FastifyRequest} */ r) => /** @type {{ subject: string }} */ (r.params).subject;
    const query = (/** @type {FastifyRequest} */ r) => /** @type {Record<string, string|undefined>} */ (r.query);
    const visible = (/** @type {FastifyRequest} */ r) => { const scope = r.apiKey.policies; return this.policies.all().filter((p) => !scope || scope.includes(p.name)); };
    const view = (/** @type {import('../types.js').PolicyRow} */ p) => {
      const t = s.totals24h().get(p.name);
      return Views.policy(p, { overrides: this.overrides.count(p.name), subjects: s.activeSubjects(p.name), allowed: t?.allowed, denied: t?.denied });
    };

    // ---- checks
    api.post('/check', { ...check, schema: { body: Schemas.check } }, async (request) => {
      const b = /** @type {{ policy: string, subject: string, cost?: number, peek?: boolean }} */ (request.body);
      ApiKeyAuth.assertPolicy(request.apiKey, b.policy);
      return Views.decision(s.check(b, { peek: b.peek }));
    });
    api.post('/check/batch', { ...check, schema: { body: Schemas.checkBatch } }, async (request) => {
      const b = /** @type {{ checks: import('../types.js').CheckInput[], peek?: boolean }} */ (request.body);
      for (const c of b.checks) ApiKeyAuth.assertPolicy(request.apiKey, c.policy);
      const r = s.checkMany(b.checks, { peek: b.peek });
      return { allowed: r.allowed, results: r.results.map(Views.decision) };
    });
    api.post('/release', { ...check, schema: { body: Schemas.release } }, async (request) => {
      const b = /** @type {{ policy: string, subject: string, cost?: number, consumedAt?: string }} */ (request.body);
      ApiKeyAuth.assertPolicy(request.apiKey, b.policy);
      return Views.decision(s.release(b));
    });

    // ---- policies
    api.post('/policies', { config: { audit: AuditClient.route('atc-ratelimit.policy.create', (_r, b) => ({ type: 'policy', id: b.policy.name })) }, ...write, schema: { body: Schemas.createPolicy } }, async (request, reply) => {
      const b = /** @type {{ name: string, limits: unknown, description?: string }} */ (request.body);
      ApiKeyAuth.assertPolicy(request.apiKey, b.name);
      const row = s.createPolicy(b, request.apiKey.id);
      reply.header('location', `/v1/policies/${row.name}`);
      return reply.code(201).send({ policy: view(row) });
    });
    api.get('/policies', read, async (request) => ({ items: visible(request).map(view) }));
    api.get('/policies/:name', { ...read, schema: { params: Schemas.nameParams } }, async (request) => ({ policy: view(s.getPolicy(name(request))) }));
    api.patch('/policies/:name', { config: { audit: AuditClient.route('atc-ratelimit.policy.update', (r) => ({ type: 'policy', id: /** @type {any} */ (r.params).name }), (r) => ({ patch: r.body })) }, ...write, schema: { params: Schemas.nameParams, body: Schemas.patchPolicy } }, async (request) => ({ policy: view(s.updatePolicy(name(request), /** @type {any} */ (request.body))) }));
    api.delete('/policies/:name', { config: { audit: AuditClient.route('atc-ratelimit.policy.delete', (r) => ({ type: 'policy', id: /** @type {any} */ (r.params).name })) }, ...write, schema: { params: Schemas.nameParams } }, async (request, reply) => { s.removePolicy(name(request)); return reply.code(204).send(); });
    api.get('/policies/:name/stats', { ...read, schema: { params: Schemas.nameParams, querystring: Schemas.statsQuery } }, async (request) => {
      const r = s.stats(name(request), Number(query(request).hours ?? 24));
      return { ...r, series: r.series.map((x) => ({ hour: Views.iso(x.hourStart), allowed: x.allowed, denied: x.denied })) };
    });
    api.get('/policies/:name/top', { ...read, schema: { params: Schemas.nameParams, querystring: Schemas.topQuery } }, async (request) => {
      const q = query(request);
      return s.top(name(request), q.window ? Number(q.window) : undefined, Number(q.limit ?? 20));
    });

    // ---- overrides
    api.get('/policies/:name/overrides', { ...read, schema: { params: Schemas.nameParams, querystring: Schemas.listQuery } }, async (request) => {
      const q = query(request);
      const n = name(request);
      s.getPolicy(n);
      const limit = Number(q.limit ?? 50);
      const offset = Number(q.offset ?? 0);
      return { items: this.overrides.list(n, limit, offset).map((o) => Views.override(o, s.now())), total: this.overrides.count(n), limit, offset };
    });
    api.put('/policies/:name/overrides/:subject', { config: { audit: AuditClient.route('atc-ratelimit.override.set', (r) => ({ type: 'subject', id: /** @type {any} */ (r.params).subject }), (r) => ({ policy: /** @type {any} */ (r.params).name, ...(/** @type {object} */ (r.body ?? {})) })) }, ...write, schema: { params: Schemas.subjectParams, body: Schemas.override } }, async (request) => ({ override: Views.override(s.setOverride(name(request), subject(request), /** @type {any} */ (request.body), request.apiKey.id), s.now()) }));
    api.delete('/policies/:name/overrides/:subject', { config: { audit: AuditClient.route('atc-ratelimit.override.delete', (r) => ({ type: 'subject', id: /** @type {any} */ (r.params).subject }), (r) => ({ policy: /** @type {any} */ (r.params).name })) }, ...write, schema: { params: Schemas.subjectParams } }, async (request, reply) => { s.removeOverride(name(request), subject(request)); return reply.code(204).send(); });

    // ---- subjects
    api.get('/policies/:name/subjects/:subject', { ...read, schema: { params: Schemas.subjectParams } }, async (request) => {
      const r = s.usage(name(request), subject(request));
      return { usage: Views.decision(r.decision), override: r.override ? Views.override(r.override, s.now()) : null };
    });
    api.delete('/policies/:name/subjects/:subject/usage', { config: { audit: AuditClient.route('atc-ratelimit.subject.reset', (r) => ({ type: 'subject', id: /** @type {any} */ (r.params).subject }), (r, b) => ({ policy: /** @type {any} */ (r.params).name, removed: b?.removed })) }, ...write, schema: { params: Schemas.subjectParams } }, async (request) => ({ removed: s.resetUsage(name(request), subject(request)) }));

    api.get('/stats', read, async (request) => {
      const items = visible(request).map(view);
      return { policies: items.length, last24h: { allowed: items.reduce((a, p) => a + p.last24h.allowed, 0), denied: items.reduce((a, p) => a + p.last24h.denied, 0) }, counters: s.counterTotal(), dbBytes: this.db.sizeBytes(), items: items.map((p) => ({ name: p.name, limits: p.limits, overrides: p.overrides, activeSubjects: p.activeSubjects, last24h: p.last24h })) };
    });
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn', preValidation: ApiKeyAuth.require('read') }, async (_request, reply) => {
      const all = this.policies.all();
      const tally = this.service.tally;
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP ratelimit_policies Policies.',
        '# TYPE ratelimit_policies gauge',
        `ratelimit_policies ${all.length}`,
        '# HELP ratelimit_decisions_total Checks since process start, per policy and decision.',
        '# TYPE ratelimit_decisions_total counter',
        ...all.flatMap((p) => [`ratelimit_decisions_total{policy="${p.name}",decision="allowed"} ${tally.get(p.name)?.allowed ?? 0}`, `ratelimit_decisions_total{policy="${p.name}",decision="denied"} ${tally.get(p.name)?.denied ?? 0}`]),
        '# HELP ratelimit_counters Live window counters.',
        '# TYPE ratelimit_counters gauge',
        `ratelimit_counters ${this.service.counterTotal()}`,
        '# HELP ratelimit_db_bytes Database size.',
        '# TYPE ratelimit_db_bytes gauge',
        `ratelimit_db_bytes ${this.db.sizeBytes()}`,
        '# HELP ratelimit_process_uptime_seconds Process uptime.',
        '# TYPE ratelimit_process_uptime_seconds gauge',
        `ratelimit_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
