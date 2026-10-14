import { CounterBackend } from '../domain/counter-backend.js';
import { SlidingWindow } from '../domain/sliding-window.js';

/** @typedef {import('../domain/counter-backend.js').ResolvedCheck} ResolvedCheck */
/** @typedef {import('../types.js').Limit} Limit */
/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('./counter-store.js').CounterStore} CounterStore */

/**
 * `CounterBackend` over SQLite: today's only implementation, moved unchanged out of
 * `RateLimitService` behind the interface.
 *
 * Transaction model: `checkAndConsume` and `release` each run inside one
 * `db.transaction()` — `BEGIN IMMEDIATE` (service-core `Database`), so the write lock is taken
 * up front rather than deferred to the first write; two overlapping calls from different
 * connections serialize instead of one discovering a write conflict after already reading. SQLite
 * has exactly one writer at a time regardless of how many readers/writers attempt a transaction
 * concurrently, so the batch's read-evaluate-write is genuinely all-or-nothing for the whole
 * process. A second connection attempting `BEGIN IMMEDIATE` while this one holds the lock blocks
 * for up to `PRAGMA busy_timeout` (5000 ms, set once per connection in `atc-service-core`'s
 * `Database`) before SQLite raises `SQLITE_BUSY` — this is real cross-connection concurrency
 * control, not a same-process convenience.
 *
 * Persistence and restart: counters are ordinary rows in the same SQLite file as policies and
 * overrides (`counters` table, `WITHOUT ROWID`, composite primary key `(policy, subject, window,
 * window_start)`); WAL mode means a clean restart sees every committed counter exactly as it was,
 * with no separate warm-up or rebuild step.
 *
 * Multi-process limitation (do not read as distributed-safe): this backend serializes writers at
 * the SQLite file level, which is correct for several processes on ONE HOST sharing one file (the
 * documented class-B topology — see `docs/READINESS.md`'s "Scaling model"), but it is not a
 * distributed counter. Two processes pointed at two different files (or the same file over a
 * network filesystem) do not share a rate limit at all; nothing in this class detects that
 * misconfiguration.
 */
export class SqliteCounterBackend extends CounterBackend {
  /**
   * @param {Database} db
   * @param {CounterStore} counters
   */
  constructor(db, counters) {
    super();
    this.db = db;
    this.counters = counters;
  }

  /** @param {ResolvedCheck[]} checks @param {number} now @param {{ peek?: boolean }} [opts] */
  checkAndConsume(checks, now, { peek = false } = {}) {
    return this.db.transaction(() => {
      const states = checks.map((c) => c.limits.map((l) => {
        const { prev, cur } = this.counters.pair(c.policy, c.subject, l.window, SlidingWindow.start(l, now));
        return SlidingWindow.state(l, prev, cur, now, c.cost);
      }));
      const allowed = states.every((row) => row.every((s) => s.allowed));
      if (allowed && !peek) {
        for (let i = 0; i < checks.length; i++) {
          const c = checks[i];
          for (const l of c.limits) this.counters.add(c.policy, c.subject, l.window, SlidingWindow.start(l, now), c.cost);
        }
      }
      return { allowed, states };
    });
  }

  /** @param {string} policy @param {string} subject @param {Limit[]} limits @param {number} consumedAt @param {number} cost @param {number} now */
  release(policy, subject, limits, consumedAt, cost, now) {
    return this.db.transaction(() => {
      for (const l of limits) this.counters.release(policy, subject, l.window, SlidingWindow.start(l, consumedAt), cost);
      return limits.map((l) => {
        const { prev, cur } = this.counters.pair(policy, subject, l.window, SlidingWindow.start(l, now));
        return SlidingWindow.state(l, prev, cur, now, 0);
      });
    });
  }

  /** @param {string} policy @param {string} subject */
  reset(policy, subject) {
    return this.counters.reset(policy, subject);
  }

  /** @param {string} policy @param {number} window @param {number} curStart @param {number} weight @param {number} limit */
  top(policy, window, curStart, weight, limit) {
    return this.counters.top(policy, window, curStart, weight, limit);
  }

  /** @param {string} policy @param {number} now */
  activeSubjects(policy, now) {
    return this.counters.activeSubjects(policy, now);
  }

  /** @param {number} now */
  cleanup(now) {
    return this.counters.cleanup(now);
  }

  /** @param {string} policy @param {number} now @param {boolean} allowed */
  decide(policy, now, allowed) {
    this.counters.decide(policy, now, allowed);
  }

  /** @param {string} policy @param {number} since */
  series(policy, since) {
    return this.counters.series(policy, since);
  }

  /** @param {number} since */
  totals(since) {
    return this.counters.totals(since);
  }

  /** @param {number} before */
  cleanupDecisions(before) {
    return this.counters.cleanupDecisions(before);
  }

  total() {
    return this.counters.total();
  }
}
