import type Database from 'better-sqlite3';

/**
 * Ordered schema steps, tracked with `PRAGMA user_version`. Step N brings the
 * schema from version N-1 to N. Never edit or reorder a shipped step — append.
 * Step 1 is the baseline: the tables themselves are still created by each
 * repository's `CREATE TABLE IF NOT EXISTS`, so it only stamps existing DBs.
 */
export const MIGRATIONS: readonly string[] = [
  '', // 1: baseline (current schema)
];

/**
 * Applies pending migrations to `db`. Each step and its version bump run in
 * one transaction, so a failing step rolls back and the error propagates
 * (aborting boot) with no partial application.
 */
export function runMigrations(db: Database.Database, migrations: readonly string[] = MIGRATIONS): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    const sql = migrations[v];
    db.transaction(() => {
      if (sql.trim()) db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return Math.max(current, migrations.length);
}
