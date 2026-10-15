/** @typedef {import('../db.js').Database} Database */

/** Window counters and hourly decision totals. */
export class CounterStore {
  static HOUR_MS = 3_600_000;

  /** @param {Database} db */
  constructor(db) {
    this.stmt = {
      pair: db.prepare(`SELECT window_start, count FROM counters WHERE policy = ? AND subject = ? AND window = ? AND window_start IN (?, ?)`),
      add: db.prepare(`INSERT INTO counters (policy, subject, window, window_start, count) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (policy, subject, window, window_start) DO UPDATE SET count = count + excluded.count`),
      release: db.prepare(`UPDATE counters SET count = MAX(0, count - ?) WHERE policy = ? AND subject = ? AND window = ? AND window_start = ?`),
      reset: db.prepare(`DELETE FROM counters WHERE policy = ? AND subject = ?`),
      top: db.prepare(`SELECT subject, SUM(CASE WHEN window_start = ? THEN count ELSE count * ? END) AS used FROM counters
        WHERE policy = ? AND window = ? AND window_start IN (?, ?) GROUP BY subject HAVING used > 0 ORDER BY used DESC, subject LIMIT ?`),
      total: db.prepare(`SELECT COUNT(*) AS n FROM counters`),
      subjects: db.prepare(`SELECT COUNT(DISTINCT subject) AS n FROM counters WHERE policy = ? AND window_start + window * 1000 > ?`),
      cleanup: db.prepare(`DELETE FROM counters WHERE window_start + window * 2000 <= ?`),
      decide: db.prepare(`INSERT INTO decisions (policy, hour_start, allowed, denied) VALUES (?, ?, ?, ?)
        ON CONFLICT (policy, hour_start) DO UPDATE SET allowed = allowed + excluded.allowed, denied = denied + excluded.denied`),
      series: db.prepare(`SELECT hour_start, allowed, denied FROM decisions WHERE policy = ? AND hour_start >= ? ORDER BY hour_start`),
      totals: db.prepare(`SELECT policy, SUM(allowed) AS allowed, SUM(denied) AS denied FROM decisions WHERE hour_start >= ? GROUP BY policy`),
      cleanupDecisions: db.prepare(`DELETE FROM decisions WHERE hour_start < ?`),
      all: db.prepare(`SELECT policy, subject, window, window_start, count FROM counters WHERE window_start + window * 2000 > ?`),
      set: db.prepare(`INSERT INTO counters (policy, subject, window, window_start, count) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (policy, subject, window, window_start) DO UPDATE SET count = excluded.count`),
      decideMany: db.prepare(`INSERT INTO decisions (policy, hour_start, allowed, denied) VALUES (?, ?, ?, ?)
        ON CONFLICT (policy, hour_start) DO UPDATE SET allowed = allowed + excluded.allowed, denied = denied + excluded.denied`),
    };
    this.db = db;
  }

  /** Live counter rows, for loading the memory backend at start. @param {number} now */
  live(now) {
    return /** @type {{ policy: string, subject: string, window: number, window_start: number, count: number }[]} */ (this.stmt.all.all(now))
      .map((r) => ({ policy: r.policy, subject: r.subject, window: Number(r.window), windowStart: Number(r.window_start), count: Number(r.count) }));
  }

  /**
   * Write absolute counter values and add decision deltas in one transaction (memory backend flush).
   * @param {{ policy: string, subject: string, window: number, windowStart: number, count: number }[]} counters
   * @param {{ policy: string, hourStart: number, allowed: number, denied: number }[]} decisions
   */
  flush(counters, decisions) {
    this.db.transaction(() => {
      for (const c of counters) this.stmt.set.run(c.policy, c.subject, c.window, c.windowStart, c.count);
      for (const d of decisions) this.stmt.decideMany.run(d.policy, d.hourStart, d.allowed, d.denied);
    });
  }

  /**
   * Counts of the previous and the current fixed window.
   * @param {string} policy @param {string} subject @param {number} window @param {number} curStart
   * @returns {{ prev: number, cur: number }}
   */
  pair(policy, subject, window, curStart) {
    const prevStart = curStart - window * 1000;
    const rows = /** @type {{ window_start: number, count: number }[]} */ (this.stmt.pair.all(policy, subject, window, prevStart, curStart));
    let prev = 0;
    let cur = 0;
    for (const r of rows) {
      if (Number(r.window_start) === curStart) cur = Number(r.count);
      else prev = Number(r.count);
    }
    return { prev, cur };
  }

  /** @param {string} policy @param {string} subject @param {number} window @param {number} curStart @param {number} cost */
  add(policy, subject, window, curStart, cost) {
    this.stmt.add.run(policy, subject, window, curStart, cost);
  }

  /** @param {string} policy @param {string} subject @param {number} window @param {number} curStart @param {number} cost */
  release(policy, subject, window, curStart, cost) {
    this.stmt.release.run(cost, policy, subject, window, curStart);
  }

  /** @param {string} policy @param {string} subject */
  reset(policy, subject) {
    return Number(this.stmt.reset.run(policy, subject).changes);
  }

  /**
   * Subjects with the highest sliding-window usage right now.
   * @param {string} policy @param {number} window @param {number} curStart @param {number} weight @param {number} limit
   */
  top(policy, window, curStart, weight, limit) {
    return /** @type {{ subject: string, used: number }[]} */ (this.stmt.top.all(curStart, weight, policy, window, curStart - window * 1000, curStart, limit)).map((r) => ({ subject: r.subject, used: Math.round(Number(r.used) * 100) / 100 }));
  }

  total() {
    return Number(/** @type {{ n: number }} */ (this.stmt.total.get()).n);
  }

  /** Distinct subjects with a live window. @param {string} policy @param {number} now */
  activeSubjects(policy, now) {
    return Number(/** @type {{ n: number }} */ (this.stmt.subjects.get(policy, now)).n);
  }

  /** Remove counters older than two windows. @param {number} now */
  cleanup(now) {
    return Number(this.stmt.cleanup.run(now).changes);
  }

  /** @param {string} policy @param {number} now @param {boolean} allowed */
  decide(policy, now, allowed) {
    this.stmt.decide.run(policy, Math.floor(now / CounterStore.HOUR_MS) * CounterStore.HOUR_MS, allowed ? 1 : 0, allowed ? 0 : 1);
  }

  /** Hourly series from `since` (ms). @param {string} policy @param {number} since */
  series(policy, since) {
    return /** @type {{ hour_start: number, allowed: number, denied: number }[]} */ (this.stmt.series.all(policy, since)).map((r) => ({ hourStart: Number(r.hour_start), allowed: Number(r.allowed), denied: Number(r.denied) }));
  }

  /** Allowed/denied totals per policy since `since`. @param {number} since */
  totals(since) {
    return new Map(/** @type {{ policy: string, allowed: number, denied: number }[]} */ (this.stmt.totals.all(since)).map((r) => [r.policy, { allowed: Number(r.allowed), denied: Number(r.denied) }]));
  }

  /** @param {number} before */
  cleanupDecisions(before) {
    return Number(this.stmt.cleanupDecisions.run(before).changes);
  }
}
