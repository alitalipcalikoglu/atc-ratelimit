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
    this.policySeeds = Object.freeze(v.policySeeds.map((p) => Object.freeze({ name: p.name, limits: Object.freeze([...p.limits]) })));
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
      policySeeds: Config.#parseSeeds(r.optional('POLICY_SEEDS')),
      maxLimits: r.integer('MAX_LIMITS', 5, { min: 1, max: 20 }),
      maxWindowSec: r.integer('MAX_WINDOW_SEC', 2_592_000, { min: 1 }),
      maxCost: r.integer('MAX_COST', 1_000_000, { min: 1 }),
      maxBatch: r.integer('MAX_BATCH', 20, { min: 1, max: 100 }),
      cleanupIntervalSec: r.integer('CLEANUP_INTERVAL_SEC', 60, { min: 1 }),
      statsRetentionDays: r.integer('STATS_RETENTION_DAYS', 30, { min: 1 }),
    });
  }

  /**
   * `name=limit/window[+limit/window],…` (window in seconds): policies created at start when
   * missing, so a fresh stack has the policies its gateway routes name. Existing policies are never
   * touched, so changes made through the API survive restarts.
   * @param {string} raw @returns {{ name: string, limits: { limit: number, window: number }[] }[]}
   */
  static #parseSeeds(raw) {
    /** @type {{ name: string, limits: { limit: number, window: number }[] }[]} */
    const out = [];
    for (const entry of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
      const at = entry.indexOf('=');
      const name = at > 0 ? entry.slice(0, at) : '';
      if (!Config.POLICY_PATTERN.test(name)) throw new ConfigError(`POLICY_SEEDS entry "${entry}" needs a policy name before "="`);
      if (out.some((p) => p.name === name)) throw new ConfigError(`POLICY_SEEDS lists "${name}" twice`);
      const limits = entry.slice(at + 1).split('+').map((part) => {
        const m = /^(\d{1,9})\/(\d{1,9})$/.exec(part.trim());
        if (!m) throw new ConfigError(`POLICY_SEEDS "${name}": "${part}" must be limit/window, e.g. 20/60`);
        return { limit: Number(m[1]), window: Number(m[2]) };
      });
      out.push({ name, limits });
    }
    return out;
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
