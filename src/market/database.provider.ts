import { Inject, Injectable, OnModuleDestroy, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Nest can't inject a bare `string` (or number/boolean) as a provider token
 * — DI tokens need identity, and primitives don't have any of their own, so
 * two `string`-typed bindings would collide. A dedicated Symbol gives the
 * DB path its own identity; tests bind it to `':memory:'`.
 */
export const MARKETS_DB_PATH = Symbol('MARKETS_DB_PATH');

/** DI token for the one shared better-sqlite3 handle every repository uses. */
export const DATABASE = Symbol('DATABASE');

/**
 * The single place a SQLite connection is opened: resolves the path,
 * creates the directory, and applies the pragmas. better-sqlite3 is
 * synchronous, so one connection serves every repository.
 */
export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Closes the shared handle once at shutdown (repositories no longer own it). */
@Injectable()
export class DatabaseCloser implements OnModuleDestroy {
  constructor(@Inject(DATABASE) private readonly db: Database.Database) {}

  onModuleDestroy(): void {
    if (this.db.open) this.db.close();
  }
}

export const databaseProviders: Provider[] = [
  {
    provide: DATABASE,
    useFactory: (dbPath: string | undefined, config: ConfigService) =>
      openDatabase(dbPath ?? config.get<string>('marketsDbFile') ?? './data/markets.db'),
    inject: [MARKETS_DB_PATH, ConfigService],
  },
  DatabaseCloser,
];
