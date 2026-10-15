import { CounterBackend } from '../domain/counter-backend.js';
import { SlidingWindow } from '../domain/sliding-window.js';
import { CounterStore } from './counter-store.js';

/** @typedef {import('../domain/counter-backend.js').ResolvedCheck} ResolvedCheck */
/** @typedef {import('../types.js').Limit} Limit */

/**
 * `CounterBackend` that keeps window counters and decision totals in process memory and writes
 * them to SQLite every `flushMs` (one transaction). A check is a few Map operations, no disk
 * write, so one process takes far more checks per second than the SQLite backend.
 *
 * Atomicity: `checkAndConsume` and `release` are synchronous, and JavaScript runs them to the end
 * before any other request is handled, so the whole-batch all-or-nothing contract holds inside
 * this process.
 *
 * Trade-offs (why it is opt-in, `COUNTER_BACKEND=memory`):
 *   - One process only. Counters live in this process; a second process on the same database
 *     keeps its own counts and the effective limit doubles. Run `instances: 1`.
 *   - A crash loses at most the last `flushMs` of consumption (clients get that much extra
 *     allowance once); a clean shutdown flushes. Start-up loads the live counters back.
 */
export class MemoryCounterBackend extends CounterBackend {
  /**
   * @param {CounterStore} counters  The SQLite store used for persistence, statistics and start-up load.
   * @param {{ flushMs: number, now?: () => number, onError?: (err: unknown) => void }} o
   */
  constructor(counters, { flushMs, now = Date.now, onError = () => {} }) {
    super();
    this.counters = counters;
    this.flushMs = flushMs;
    this.now = now;
    this.onError = onError;
    /** @type {Map<string, { policy: string, subject: string, window: number, windowStart: number, count: number }>} */
    this.map = new Map();
    /** @type {Set<string>} */
    this.dirty = new Set();
    /** @type {Map<string, { policy: string, hourStart: number, allowed: number, denied: number }>} */
    this.decisions = new Map();
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    this.flushes = 0;
    this.flushErrors = 0;
    for (const r of counters.live(now())) this.map.set(MemoryCounterBackend.#key(r.policy, r.subject, r.window, r.windowStart), r);
  }

  /** @param {string} policy @param {string} subject @param {number} window @param {number} start */
  static #key(policy, subject, window, start) {
    return `${policy}\u0000${subject}\u0000${window}\u0000${start}`;
  }

  start() {
    this.timer = setInterval(() => this.flush(), this.flushMs);
    this.timer.unref();
    return this;
  }

  /** Stop the timer and write what is left. */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  /** Write dirty counters and pending decision deltas to SQLite; on failure they are kept for the next try. */
  flush() {
    if (!this.dirty.size && !this.decisions.size) return;
    const keys = [...this.dirty];
    const rows = keys.map((k) => this.map.get(k)).filter((r) => r !== undefined);
    const decisions = [...this.decisions.values()];
    try {
      this.counters.flush(/** @type {any} */ (rows), decisions);
      for (const k of keys) this.dirty.delete(k);
      this.decisions.clear();
      this.flushes++;
    } catch (err) {
      this.flushErrors++;
      this.onError(err);
    }
  }

  /** @param {string} policy @param {string} subject @param {number} window @param {number} start */
  #get(policy, subject, window, start) {
    return this.map.get(MemoryCounterBackend.#key(policy, subject, window, start))?.count ?? 0;
  }

  /** @param {string} policy @param {string} subject @param {number} window @param {number} start @param {number} delta */
  #add(policy, subject, window, start, delta) {
    const k = MemoryCounterBackend.#key(policy, subject, window, start);
    const row = this.map.get(k);
    if (row) row.count = Math.max(0, row.count + delta);
    else if (delta > 0) this.map.set(k, { policy, subject, window, windowStart: start, count: delta });
    else return;
    this.dirty.add(k);
  }

  /** @param {string} policy @param {string} subject @param {Limit} l @param {number} now */
  #pair(policy, subject, l, now) {
    const cur = SlidingWindow.start(l, now);
    return { prev: this.#get(policy, subject, l.window, cur - l.window * 1000), cur: this.#get(policy, subject, l.window, cur) };
  }

  /** @param {ResolvedCheck[]} checks @param {number} now @param {{ peek?: boolean }} [opts] */
  checkAndConsume(checks, now, { peek = false } = {}) {
    const states = checks.map((c) => c.limits.map((l) => {
      const { prev, cur } = this.#pair(c.policy, c.subject, l, now);
      return SlidingWindow.state(l, prev, cur, now, c.cost);
    }));
    const allowed = states.every((row) => row.every((s) => s.allowed));
    if (allowed && !peek) for (const c of checks) for (const l of c.limits) this.#add(c.policy, c.subject, l.window, SlidingWindow.start(l, now), c.cost);
    return { allowed, states };
  }

  /** @param {string} policy @param {string} subject @param {Limit[]} limits @param {number} consumedAt @param {number} cost @param {number} now */
  release(policy, subject, limits, consumedAt, cost, now) {
    for (const l of limits) this.#add(policy, subject, l.window, SlidingWindow.start(l, consumedAt), -cost);
    return limits.map((l) => {
      const { prev, cur } = this.#pair(policy, subject, l, now);
      return SlidingWindow.state(l, prev, cur, now, 0);
    });
  }

  /** @param {string} policy @param {string} subject */
  reset(policy, subject) {
    let n = 0;
    for (const [k, r] of this.map) if (r.policy === policy && r.subject === subject) { this.map.delete(k); this.dirty.delete(k); n++; }
    this.counters.reset(policy, subject);
    return n;
  }

  /** @param {string} policy @param {number} window @param {number} curStart @param {number} weight @param {number} limit */
  top(policy, window, curStart, weight, limit) {
    /** @type {Map<string, number>} */
    const used = new Map();
    const prevStart = curStart - window * 1000;
    for (const r of this.map.values()) {
      if (r.policy !== policy || r.window !== window || (r.windowStart !== curStart && r.windowStart !== prevStart)) continue;
      used.set(r.subject, (used.get(r.subject) ?? 0) + (r.windowStart === curStart ? r.count : r.count * weight));
    }
    return [...used].filter(([, u]) => u > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit)
      .map(([subject, u]) => ({ subject, used: Math.round(u * 100) / 100 }));
  }

  /** @param {string} policy @param {number} now */
  activeSubjects(policy, now) {
    const s = new Set();
    for (const r of this.map.values()) if (r.policy === policy && r.windowStart + r.window * 1000 > now) s.add(r.subject);
    return s.size;
  }

  /** @param {number} now */
  cleanup(now) {
    let n = 0;
    for (const [k, r] of this.map) if (r.windowStart + r.window * 2000 <= now) { this.map.delete(k); this.dirty.delete(k); n++; }
    this.counters.cleanup(now);
    return n;
  }

  /** @param {string} policy @param {number} now @param {boolean} allowed */
  decide(policy, now, allowed) {
    const hourStart = Math.floor(now / CounterStore.HOUR_MS) * CounterStore.HOUR_MS;
    const k = `${policy}\u0000${hourStart}`;
    const d = this.decisions.get(k) ?? { policy, hourStart, allowed: 0, denied: 0 };
    if (allowed) d.allowed++; else d.denied++;
    this.decisions.set(k, d);
  }

  /** Statistics read SQLite after a flush, so they include the latest decisions. @param {string} policy @param {number} since */
  series(policy, since) {
    this.flush();
    return this.counters.series(policy, since);
  }

  /** @param {number} since */
  totals(since) {
    this.flush();
    return this.counters.totals(since);
  }

  /** @param {number} before */
  cleanupDecisions(before) {
    this.flush();
    return this.counters.cleanupDecisions(before);
  }

  total() {
    return this.map.size;
  }
}
