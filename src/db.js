import { Database as CoreDatabase } from '@atc-web/atc-service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
  /** @type {readonly string[]} */
  static MIGRATIONS = [
    `
    CREATE TABLE policies (
      name        TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      limits      TEXT NOT NULL,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- Per-subject limits that replace the policy's limits; a limit of 0 blocks the subject.
    CREATE TABLE overrides (
      policy     TEXT NOT NULL REFERENCES policies(name) ON DELETE CASCADE,
      subject    TEXT NOT NULL,
      limits     TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      expires_at INTEGER,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (policy, subject)
    );

    -- Fixed-window counters; the sliding estimate reads the current and the previous window.
    -- Rows older than two windows are removed by the cleanup worker.
    CREATE TABLE counters (
      policy       TEXT NOT NULL REFERENCES policies(name) ON DELETE CASCADE,
      subject      TEXT NOT NULL,
      window       INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      count        INTEGER NOT NULL,
      PRIMARY KEY (policy, subject, window, window_start)
    ) WITHOUT ROWID;
    CREATE INDEX counters_top ON counters (policy, window, window_start, count DESC);

    -- Hourly allowed/denied totals per policy for statistics.
    CREATE TABLE decisions (
      policy     TEXT NOT NULL REFERENCES policies(name) ON DELETE CASCADE,
      hour_start INTEGER NOT NULL,
      allowed    INTEGER NOT NULL DEFAULT 0,
      denied     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (policy, hour_start)
    ) WITHOUT ROWID;
    `,
  ];
}
