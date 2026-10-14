import { Config } from './config.js';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Lifecycle } from '@atc-web/atc-service-core/lifecycle';
import { Database } from './db.js';
import { RateLimitService } from './domain/rate-limit-service.js';
import { RateLimitApi } from './http/rate-limit-api.js';
import { CounterStore } from './store/counter-store.js';
import { OverrideStore } from './store/override-store.js';
import { PolicyStore } from './store/policy-store.js';
import { SqliteCounterBackend } from './store/sqlite-counter-backend.js';
import { CleanupWorker } from './worker.js';

/** Composition root: wires configuration, storage, domain, HTTP and the cleanup worker; owns the process lifecycle. */
export class Application {
  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.version = readServiceVersion(import.meta.url);
    this.audit = new AuditClient({ target: config.audit });
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
    this.policies = new PolicyStore(this.db);
    this.overrides = new OverrideStore(this.db);
    this.backend = new SqliteCounterBackend(this.db, new CounterStore(this.db));
    this.service = new RateLimitService({ backend: this.backend, policies: this.policies, overrides: this.overrides, options: config });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {CleanupWorker|null} */
    this.worker = null;
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
  }

  /** Build from `process.env`; exits with a readable message on bad configuration. */
  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config } = this;
    const seeded = this.service.seedPolicies(config.policySeeds);
    const api = new RateLimitApi({ config, audit: this.audit, service: this.service, policies: this.policies, overrides: this.overrides, db: this.db, version: this.version });
    const app = await api.build();
    this.app = app;
    if (seeded.length) app.log.info({ policies: seeded }, 'policies created from POLICY_SEEDS');
    const { shutdown } = Lifecycle.install({
      forceExitMs: 30_000,
      log: app.log,
      steps: [
        () => this.worker?.stop(),
        () => this.app?.close(),
        () => this.audit.close(),
        () => this.db.close(),
      ],
    });
    this.shutdown = shutdown;
    this.audit.logger = app.log;
    this.audit.start();
    await app.listen({ port: config.port, host: config.host });
    this.worker = new CleanupWorker({ service: this.service, intervalMs: config.cleanupIntervalSec * 1000, logger: app.log });
    this.worker.runOnce();
    this.worker.start();
    app.log.info({ tls: config.tls !== null, policies: this.policies.all().length }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    if (process.send) process.send('ready'); // PM2 wait_ready
  }
}
