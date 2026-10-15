import { RateLimitError } from './errors.js';
import { Limits } from './limits.js';
import { SlidingWindow } from './sliding-window.js';

/** @typedef {import('../types.js').CheckInput} CheckInput */
/** @typedef {import('../types.js').ReleaseInput} ReleaseInput */
/** @typedef {import('../types.js').Decision} Decision */
/** @typedef {import('../types.js').Limit} Limit */
/** @typedef {import('../types.js').LimitState} LimitState */
/** @typedef {import('../types.js').PolicyRow} PolicyRow */
/** @typedef {import('../types.js').OverrideRow} OverrideRow */
/** @typedef {import('./counter-backend.js').CounterBackend} CounterBackend */

/**
 * Policies, overrides and the check itself. Every check is one atomic call into the
 * `CounterBackend`: the states of all windows are read, and counters are incremented only when
 * every window allows the cost, so a denied request never consumes anything (see
 * `counter-backend.js` for the exact atomicity contract this depends on).
 *
 * This service knows nothing about SQLite, transactions, or SQL: policy/override lookup and cost
 * validation are pure domain logic, and every counter read/write goes through the injected
 * `backend`: `SqliteCounterBackend` (default) or `MemoryCounterBackend` (`COUNTER_BACKEND=memory`).
 *
 * Clock model: every instant this service reasons about — `now()`, override expiry, window
 * selection — comes from the injected `now` function (real wall clock in production, an
 * injectable point in tests). There is no monotonic clock here: window boundaries are computed
 * from `floor(now / windowMs) * windowMs`, so they must stay anchored to wall-clock epoch
 * multiples that a Redis or a second instance would compute the same way; a monotonic clock (which
 * has no fixed relationship to epoch time and can restart from an arbitrary offset on process
 * restart) would make that anchoring meaningless. Consequences of an unreliable wall clock are the
 * same ones any epoch-window rate limiter has: if the clock jumps backward, a check can land in an
 * already-used window and read stale prev/cur counts (never negative, never denies more than the
 * limit allows — cleanup simply treats the "future" rows it already wrote as not yet expired); if
 * it jumps forward, in-flight windows are skipped over and their counts age out via `cleanup()`
 * like any other expired window. No special-casing is done for either case — see `docs/READINESS.md`
 * for the operational recommendation (NTP-synced hosts; clock skew between callers is irrelevant,
 * only the ratelimit process's own clock matters, since it alone decides window membership).
 */
export class RateLimitService {
  /**
   * @param {object} deps
   * @param {CounterBackend} deps.backend
   * @param {import('../store/policy-store.js').PolicyStore} deps.policies
   * @param {import('../store/override-store.js').OverrideStore} deps.overrides
   * @param {{ maxLimits: number, maxWindowSec: number, maxCost: number, maxBatch: number, statsRetentionDays: number }} deps.options
   * @param {() => number} [deps.now]
   */
  constructor({ backend, policies, overrides, options, now = Date.now }) {
    this.backend = backend;
    this.policies = policies;
    this.overrides = overrides;
    this.options = options;
    this.now = now;
    /** Decisions since process start, per policy. @type {Map<string, { allowed: number, denied: number }>} */
    this.tally = new Map();
  }

  // ---- policies

  /**
   * @param {{ name: string, description?: string, limits: unknown }} input
   * @param {string} by
   */
  createPolicy(input, by) {
    if (this.policies.get(input.name)) throw new RateLimitError('POLICY_EXISTS', `policy "${input.name}" already exists`);
    const t = this.now();
    return this.policies.insert({ name: input.name, description: input.description ?? '', limits: JSON.stringify(Limits.normalize(input.limits, this.options)), created_by: by, created_at: t, updated_at: t });
  }

  /**
   * Create the seeded policies that do not exist yet (never changes an existing one).
   * @param {readonly { name: string, limits: unknown }[]} seeds
   * @returns {string[]} names created
   */
  seedPolicies(seeds) {
    const created = [];
    for (const seed of seeds) {
      if (this.policies.get(seed.name)) continue;
      this.createPolicy({ name: seed.name, description: 'created from POLICY_SEEDS', limits: seed.limits }, 'POLICY_SEEDS');
      created.push(seed.name);
    }
    return created;
  }

  /** @param {string} name */
  getPolicy(name) {
    return this.policies.require(name);
  }

  /**
   * @param {string} name
   * @param {{ description?: string, limits?: unknown }} patch
   */
  updatePolicy(name, patch) {
    const row = this.policies.require(name);
    return this.policies.update({
      ...row,
      description: patch.description ?? row.description,
      limits: patch.limits === undefined ? row.limits : JSON.stringify(Limits.normalize(patch.limits, this.options)),
      updated_at: this.now(),
    });
  }

  /** Delete a policy with its overrides, counters and statistics. @param {string} name */
  removePolicy(name) {
    this.policies.require(name);
    this.policies.delete(name);
    this.tally.delete(name);
  }

  // ---- overrides

  /**
   * @param {string} policy
   * @param {string} subject
   * @param {{ limits: unknown, note?: string, expiresAt?: string|null }} input
   * @param {string} by
   */
  setOverride(policy, subject, input, by) {
    this.policies.require(policy);
    const t = this.now();
    let expires = null;
    if (input.expiresAt) {
      expires = Date.parse(input.expiresAt);
      if (Number.isNaN(expires)) throw new RateLimitError('INVALID_LIMITS', 'expiresAt must be an ISO 8601 date');
      if (expires <= t) throw new RateLimitError('INVALID_LIMITS', 'expiresAt must be in the future');
    }
    return this.overrides.upsert({ policy, subject, limits: JSON.stringify(Limits.normalize(input.limits, this.options)), note: input.note ?? '', expires_at: expires, created_by: by, created_at: t, updated_at: t });
  }

  /** @param {string} policy @param {string} subject */
  removeOverride(policy, subject) {
    this.policies.require(policy);
    if (!this.overrides.delete(policy, subject)) throw new RateLimitError('OVERRIDE_NOT_FOUND', `no override for "${subject}" in policy "${policy}"`);
  }

  // ---- checks

  /**
   * Check and, unless `peek`, consume `cost` units for one subject.
   * @param {CheckInput} input
   * @param {{ peek?: boolean }} [opts]
   * @returns {Decision}
   */
  check(input, opts = {}) {
    return this.checkMany([input], opts).results[0];
  }

  /**
   * Several checks as one unit: counters move only when every check allows its cost. The
   * all-or-nothing guarantee is the backend's, not this method's — see
   * `CounterBackend.checkAndConsume`'s atomicity contract.
   * @param {CheckInput[]} inputs
   * @param {{ peek?: boolean }} [opts]
   * @returns {{ allowed: boolean, results: Decision[] }}
   */
  checkMany(inputs, { peek = false } = {}) {
    if (inputs.length > this.options.maxBatch) throw new RateLimitError('DUPLICATE_CHECK', `at most ${this.options.maxBatch} checks per request`);
    const seen = new Set();
    for (const c of inputs) {
      const key = `${c.policy}\n${c.subject}`;
      if (seen.has(key)) throw new RateLimitError('DUPLICATE_CHECK', `subject "${c.subject}" appears twice for policy "${c.policy}"`);
      seen.add(key);
      const cost = c.cost ?? 1;
      if (!Number.isInteger(cost) || cost < 0 || cost > this.options.maxCost) throw new RateLimitError('COST_TOO_HIGH', `cost must be an integer between 0 and ${this.options.maxCost}`);
    }
    const now = this.now();
    // Policy/override resolution and cost-vs-limit validation are pure domain logic: they need no
    // counter read, so they run before the one call into the backend, not inside its atomic unit.
    const resolved = inputs.map((c) => {
      const row = this.policies.require(c.policy);
      const cost = c.cost ?? 1;
      const { limits, source } = this.#effective(row, c.subject, now);
      for (const l of limits) if (l.limit > 0 && cost > l.limit) throw new RateLimitError('COST_TOO_HIGH', `cost ${cost} can never fit the ${Limits.label(l)} window of policy "${row.name}"`);
      return { policy: row.name, subject: c.subject, cost, limits, source };
    });
    const { allowed, states } = this.backend.checkAndConsume(resolved.map(({ policy, subject, cost, limits }) => ({ policy, subject, cost, limits })), now, { peek });
    const decisions = resolved.map((r, i) => this.#toDecision(r.policy, r.subject, r.cost, r.limits, r.source, states[i], now));
    if (!peek) {
      for (const r of resolved) {
        this.backend.decide(r.policy, now, allowed);
        this.#count(r.policy, allowed);
      }
    }
    return { allowed, results: decisions.map((d) => (allowed || peek ? d : { ...d, allowed: false })) };
  }

  /**
   * Give back units consumed by an earlier check (an operation that failed after the check).
   *
   * `consumedAt` (default `now`) is the window-selection fix from Stage 5: the release decrements
   * the window that was actually consumed, not whichever window `now` happens to be in — pass back
   * the `consumedAt` a check's `Decision` returned to release the right window even after it has
   * rolled over. A caller that omits it keeps the pre-fix behavior (targets the current window),
   * which is correct by construction when the release happens inside the same window it consumed.
   * @param {ReleaseInput} input
   * @returns {Decision} State after the release, evaluated at `now`.
   */
  release(input) {
    const cost = input.cost ?? 1;
    if (!Number.isInteger(cost) || cost < 1 || cost > this.options.maxCost) throw new RateLimitError('COST_TOO_HIGH', `cost must be an integer between 1 and ${this.options.maxCost}`);
    const now = this.now();
    let consumedAt = now;
    if (input.consumedAt !== undefined) {
      consumedAt = Date.parse(input.consumedAt);
      if (Number.isNaN(consumedAt)) throw new RateLimitError('INVALID_CONSUMED_AT', 'consumedAt must be an ISO 8601 date');
    }
    const row = this.policies.require(input.policy);
    const { limits, source } = this.#effective(row, input.subject, now);
    const states = this.backend.release(row.name, input.subject, limits, consumedAt, cost, now);
    return this.#toDecision(row.name, input.subject, 0, limits, source, states, now);
  }

  /**
   * Current state of a subject without consuming: `remaining` is what is left right now.
   * @param {string} policy
   * @param {string} subject
   */
  usage(policy, subject) {
    const row = this.policies.require(policy);
    const now = this.now();
    const { limits, source } = this.#effective(row, subject, now);
    const { states } = this.backend.checkAndConsume([{ policy: row.name, subject, cost: 0, limits }], now, { peek: true });
    return { decision: this.#toDecision(row.name, subject, 0, limits, source, states[0], now), override: this.overrides.get(policy, subject) ?? null };
  }

  /** Forget every counter of a subject. @param {string} policy @param {string} subject */
  resetUsage(policy, subject) {
    this.policies.require(policy);
    return this.backend.reset(policy, subject);
  }

  /**
   * Subjects with the highest usage in one window of the policy.
   * @param {string} policy
   * @param {number|undefined} window   Defaults to the policy's first (shortest) window.
   * @param {number} limit
   */
  top(policy, window, limit) {
    const row = this.policies.require(policy);
    const limits = Limits.parse(row.limits);
    const l = window === undefined ? limits[0] : limits.find((x) => x.window === window);
    if (!l) throw new RateLimitError('UNKNOWN_WINDOW', `policy "${policy}" has no ${window} s window`);
    const now = this.now();
    return { window: l.window, limit: l.limit, items: this.backend.top(policy, l.window, SlidingWindow.start(l, now), SlidingWindow.weight(l, now), limit) };
  }

  /**
   * Hourly allowed/denied series for the last `hours` hours, gaps filled with zeros.
   * @param {string} policy
   * @param {number} hours
   */
  stats(policy, hours) {
    this.policies.require(policy);
    const H = 3_600_000;
    const end = Math.floor(this.now() / H) * H;
    const since = end - (hours - 1) * H;
    const byHour = new Map(this.backend.series(policy, since).map((r) => [r.hourStart, r]));
    const series = [];
    let allowed = 0;
    let denied = 0;
    for (let t = since; t <= end; t += H) {
      const r = byHour.get(t) ?? { hourStart: t, allowed: 0, denied: 0 };
      allowed += r.allowed;
      denied += r.denied;
      series.push({ hourStart: t, allowed: r.allowed, denied: r.denied });
    }
    return { hours, allowed, denied, series };
  }

  /** Totals per policy over the last 24 hours. */
  totals24h() {
    return this.backend.totals(Math.floor(this.now() / 3_600_000) * 3_600_000 - 23 * 3_600_000);
  }

  /** Distinct subjects with a live window. @param {string} policy @param {number} [now] */
  activeSubjects(policy, now = this.now()) {
    return this.backend.activeSubjects(policy, now);
  }

  /** Live counter rows across every policy — a cheap size signal for `/stats` and `/metrics`. */
  counterTotal() {
    return this.backend.total();
  }

  /**
   * Remove stale counters, expired overrides and old statistics.
   *
   * Each of the three is its own atomic operation (a single SQL statement in
   * `SqliteCounterBackend`/`OverrideStore`), but — unlike before Stage 5 — the three no longer run
   * inside one shared transaction: overrides live in a different store than the counter backend,
   * and a swappable `CounterBackend` (a future Redis one, say) cannot share a transaction with a
   * SQL store it knows nothing about. If one step throws after another has committed, cleanup is
   * partial for this run; `CleanupWorker` catches and logs the error and tries again next interval,
   * and every step here is naturally idempotent (re-running a cleanup that already ran removes
   * nothing new), so a partial run only delays removing already-expired rows — it never loses live
   * data or affects enforcement.
   * @param {number} [now]
   */
  cleanup(now = this.now()) {
    return {
      counters: this.backend.cleanup(now),
      overrides: this.overrides.deleteExpired(now),
      decisions: this.backend.cleanupDecisions(now - this.options.statsRetentionDays * 86_400_000),
    };
  }

  // ---- internals

  /**
   * @param {PolicyRow} row
   * @param {string} subject
   * @param {number} now
   * @returns {{ limits: Limit[], source: 'policy'|'override' }}
   */
  #effective(row, subject, now) {
    const ov = this.overrides.active(row.name, subject, now);
    return ov ? { limits: Limits.parse(ov.limits), source: 'override' } : { limits: Limits.parse(row.limits), source: 'policy' };
  }

  /**
   * Combine one check's backend-evaluated window states into its top-level `Decision` summary.
   * Pure: no counter access, just picking the most restrictive window.
   * @param {string} policy
   * @param {string} subject
   * @param {number} cost
   * @param {Limit[]} limits
   * @param {'policy'|'override'} source
   * @param {LimitState[]} states
   * @param {number} now
   * @returns {Decision}
   */
  #toDecision(policy, subject, cost, limits, source, states, now) {
    const allowed = states.every((s) => s.allowed);
    // Most restrictive window: least remaining when allowed; when denied, the blocked one or the longest wait.
    const key = allowed
      ? states.reduce((a, s) => (s.remaining < a.remaining ? s : a))
      : states.filter((s) => !s.allowed).reduce((a, s) => (a.retryAfter === null ? a : s.retryAfter === null || s.retryAfter > a.retryAfter ? s : a));
    return { policy, subject, allowed, cost, source, blocked: limits.some((l) => l.limit === 0), limit: key.limit, remaining: key.remaining, resetAt: key.resetAt, retryAfter: allowed ? 0 : key.retryAfter, limits: states, consumedAt: now };
  }

  /** @param {string} policy @param {boolean} allowed */
  #count(policy, allowed) {
    const t = this.tally.get(policy) ?? { allowed: 0, denied: 0 };
    if (allowed) t.allowed++; else t.denied++;
    this.tally.set(policy, t);
  }
}
