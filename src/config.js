import { ConfigError, EnvReader, parseApiKeys, parseAudit } from '@atc-web/atc-service-core/config';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export { ConfigError };

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;
  static POLICY_PATTERN = /^[a-z0-9]+([.\-_][a-z0-9]+)*$/;
  static ROLES = ['check', 'read', 'write', 'readwrite'];

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.audit = v.audit;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.dbBackupDir = v.dbBackupDir;
    this.apiKeys = v.apiKeys;
    this.rateLimitMax = v.rateLimitMax;
    this.maxLimits = v.maxLimits;
    this.maxWindowSec = v.maxWindowSec;
    this.maxCost = v.maxCost;
    this.maxBatch = v.maxBatch;
    this.cleanupIntervalSec = v.cleanupIntervalSec;
    this.statsRetentionDays = v.statsRetentionDays;
    Object.freeze(this);
  }

  /**
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Config}
   */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);

    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');

    return new Config({
      port: r.integer('PORT', 3011, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: parseAudit(r),
      bodyLimit: r.integer('BODY_LIMIT', 65_536, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/ratelimit.db',
      dbBackupDir: r.optional('DB_BACKUP_DIR') || undefined,
      apiKeys: Config.#parseApiKeys(r.required('RATELIMIT_API_KEYS')),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 6_000, { min: 1 }),
      maxLimits: r.integer('MAX_LIMITS', 5, { min: 1, max: 20 }),
      maxWindowSec: r.integer('MAX_WINDOW_SEC', 2_592_000, { min: 1 }),
      maxCost: r.integer('MAX_COST', 1_000_000, { min: 1 }),
      maxBatch: r.integer('MAX_BATCH', 20, { min: 1, max: 100 }),
      cleanupIntervalSec: r.integer('CLEANUP_INTERVAL_SEC', 60, { min: 1 }),
      statsRetentionDays: r.integer('STATS_RETENTION_DAYS', 30, { min: 1 }),
    });
  }

  /**
   * Parse `id:secret[:role[:policy+policy]]`. Role defaults to `readwrite`, policies to all.
   * Policy names are not checked against existing policies: keys may be issued first. Delegates to
   * service-core's generic parser; only the field rename (`scopes` -> `policies`, this service's
   * own name for the concept) and the env-var name in error messages are local.
   * @param {string} raw
   * @returns {ApiKey[]}
   */
  static #parseApiKeys(raw) {
    return parseApiKeys(raw, 'RATELIMIT_API_KEYS', { roles: Config.ROLES, scopePattern: Config.POLICY_PATTERN, scopeNoun: 'policy', minSecretLength: Config.MIN_SECRET_LENGTH })
      .map(({ id, secret, role, scopes }) => ({ id, secret, role: /** @type {KeyRole} */ (role), policies: scopes }));
  }
}
