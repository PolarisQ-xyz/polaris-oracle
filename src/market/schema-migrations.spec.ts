import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from './schema-migrations';

describe('runMigrations', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migr-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const steps = ['', 'ALTER TABLE t ADD COLUMN extra TEXT'];

  it('fresh and pre-migration on-disk DBs end at the same version and schema', () => {
    const fresh = new Database(join(dir, 'a.db'));
    fresh.exec('CREATE TABLE t (id INTEGER)');
    const old = new Database(join(dir, 'b.db'));
    old.exec('CREATE TABLE t (id INTEGER)'); // user_version 0, as before migrations existed
    expect(runMigrations(fresh, steps)).toBe(2);
    expect(runMigrations(old, steps)).toBe(2);
    expect(runMigrations(old, steps)).toBe(2); // idempotent
    for (const db of [fresh, old]) {
      expect(db.pragma('user_version', { simple: true })).toBe(2);
      expect((db.pragma('table_info(t)') as { name: string }[]).map((c) => c.name)).toEqual(['id', 'extra']);
    }
  });

  it('a failing step throws and leaves no partial application', () => {
    const db = new Database(join(dir, 'c.db'));
    db.exec('CREATE TABLE t (id INTEGER)');
    expect(() => runMigrations(db, ['', 'ALTER TABLE t ADD COLUMN a TEXT; SELECT * FROM nope'])).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect((db.pragma('table_info(t)') as { name: string }[]).map((c) => c.name)).toEqual(['id']);
  });
});
