/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').OverrideRow} OverrideRow */

/** Persistence for per-subject overrides. Expired rows stay until the cleanup worker removes them. */
export class OverrideStore {
  static COLUMNS = 'policy, subject, limits, note, expires_at, created_by, created_at, updated_at';

  /** @param {Database} db */
  constructor(db) {
    const C = OverrideStore.COLUMNS;
    this.stmt = {
      upsert: db.prepare(`INSERT INTO overrides (${C}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (policy, subject) DO UPDATE SET limits = excluded.limits, note = excluded.note, expires_at = excluded.expires_at, updated_at = excluded.updated_at`),
      get: db.prepare(`SELECT ${C} FROM overrides WHERE policy = ? AND subject = ?`),
      list: db.prepare(`SELECT ${C} FROM overrides WHERE policy = ? AND subject > ? ORDER BY subject LIMIT ?`),
      count: db.prepare(`SELECT COUNT(*) AS n FROM overrides WHERE policy = ?`),
      counts: db.prepare(`SELECT policy, COUNT(*) AS n FROM overrides GROUP BY policy`),
      delete: db.prepare(`DELETE FROM overrides WHERE policy = ? AND subject = ?`),
      deleteExpired: db.prepare(`DELETE FROM overrides WHERE expires_at IS NOT NULL AND expires_at <= ?`),
    };
  }

  /** @param {OverrideRow} r */
  upsert(r) {
    this.stmt.upsert.run(r.policy, r.subject, r.limits, r.note, r.expires_at, r.created_by, r.created_at, r.updated_at);
    return /** @type {OverrideRow} */ (this.get(r.policy, r.subject));
  }

  /** @param {string} policy @param {string} subject */
  get(policy, subject) {
    return /** @type {OverrideRow|undefined} */ (this.stmt.get.get(policy, subject));
  }

  /** Override in force at `now`, if any. @param {string} policy @param {string} subject @param {number} now */
  active(policy, subject, now) {
    const row = this.get(policy, subject);
    return row && (row.expires_at === null || row.expires_at > now) ? row : undefined;
  }

  /** Subject order, so the last subject of a page is the cursor of the next. @param {string} policy @param {number} limit @param {string} [after] */
  list(policy, limit, after = '') {
    return /** @type {OverrideRow[]} */ (this.stmt.list.all(policy, after, limit));
  }

  /** @param {string} policy */
  count(policy) {
    return Number(/** @type {{ n: number }} */ (this.stmt.count.get(policy)).n);
  }

  counts() {
    return new Map(/** @type {{ policy: string, n: number }[]} */ (this.stmt.counts.all()).map((r) => [r.policy, Number(r.n)]));
  }

  /** @param {string} policy @param {string} subject */
  delete(policy, subject) {
    return Number(this.stmt.delete.run(policy, subject).changes) > 0;
  }

  /** @param {number} now */
  deleteExpired(now) {
    return Number(this.stmt.deleteExpired.run(now).changes);
  }
}
