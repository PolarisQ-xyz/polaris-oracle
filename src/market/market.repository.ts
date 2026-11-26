import { Inject, Injectable } from '@nestjs/common';
import Database from 'better-sqlite3';
import { DATABASE } from './database.provider';
import type { MarketRow } from './market-row.types';
import type { WatchedMarket } from './market.types';
import { runMigrations } from './schema-migrations';

export { MARKETS_DB_PATH } from './database.provider';

@Injectable()
export class MarketRepository {
  constructor(@Inject(DATABASE) private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS markets (
        contract_id TEXT PRIMARY KEY,
        strike_price_cents TEXT NOT NULL,
        expiry INTEGER NOT NULL,
        grace_period_secs INTEGER NOT NULL,
        feed_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT,
        settle_tx_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS factory_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feed_id INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        contract_id TEXT,
        error TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS factory_runs_feed_id ON factory_runs (feed_id, at DESC);
    `);
    runMigrations(this.db);
  }

  upsert(m: WatchedMarket): void {
    this.db
      .prepare(
        `INSERT INTO markets (contract_id, strike_price_cents, expiry, grace_period_secs, feed_id, status, last_error, settle_tx_hash, created_at, updated_at)
         VALUES (@contractId, @strikePriceCents, @expiry, @gracePeriodSecs, @feedId, @status, @lastError, @settleTxHash, @createdAt, @updatedAt)
         ON CONFLICT(contract_id) DO UPDATE SET
           strike_price_cents = excluded.strike_price_cents,
           expiry = excluded.expiry,
           grace_period_secs = excluded.grace_period_secs,
           feed_id = excluded.feed_id,
           status = excluded.status,
           last_error = excluded.last_error,
           settle_tx_hash = excluded.settle_tx_hash,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...m,
        lastError: m.lastError ?? null,
        settleTxHash: m.settleTxHash ?? null,
      });
  }

  getAll(): WatchedMarket[] {
    const rows = this.db.prepare(`SELECT * FROM markets ORDER BY created_at DESC`).all() as MarketRow[];
    return rows.map(rowToMarket);
  }

  list(opts: { status?: string[]; limit?: number; before?: string }): WatchedMarket[] {
    const { status, limit = 50, before } = opts;
    const cap = Math.min(limit, 500);
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status && status.length > 0) {
      conditions.push(`status IN (${status.map(() => '?').join(',')})`);
      params.push(...status);
    }
    if (before) {
      conditions.push(`created_at < ?`);
      params.push(before);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM markets ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, cap) as any[];
    return rows.map(rowToMarket);
  }

  getById(contractId: string): WatchedMarket | undefined {
    const row = this.db
      .prepare(`SELECT * FROM markets WHERE contract_id = ?`)
      .get(contractId) as MarketRow | undefined;
    return row ? rowToMarket(row) : undefined;
  }

  getByFeedId(feedId: number): WatchedMarket[] {
    const rows = this.db
      .prepare(`SELECT * FROM markets WHERE feed_id = ? ORDER BY created_at DESC`)
      .all(feedId) as MarketRow[];
    return rows.map(rowToMarket);
  }

  recordFactoryRun(run: {
    feedId: number;
    outcome: 'created' | 'skipped' | 'failed';
    contractId?: string;
    error?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO factory_runs (feed_id, outcome, contract_id, error, at)
         VALUES (@feedId, @outcome, @contractId, @error, @at)`,
      )
      .run({
        feedId: run.feedId,
        outcome: run.outcome,
        contractId: run.contractId ?? null,
        error: run.error ?? null,
        at: Date.now(),
      });
  }

  getRecentFactoryRuns(limit = 100): {
    id: number;
    feedId: number;
    outcome: string;
    contractId: string | null;
    error: string | null;
    at: number;
  }[] {
    return this.db
      .prepare(`SELECT * FROM factory_runs ORDER BY at DESC LIMIT ?`)
      .all(limit) as any[];
  }

  getLastSuccessPerFeed(): { feedId: number; contractId: string; at: number }[] {
    return this.db
      .prepare(
        `SELECT feed_id AS feedId, contract_id AS contractId, MAX(at) AS at
         FROM factory_runs WHERE outcome = 'created' GROUP BY feed_id`,
      )
      .all() as any[];
  }

  onModuleDestroy(): void {
    this.db.close();
  }
}

function rowToMarket(row: MarketRow): WatchedMarket {
  return {
    contractId: row.contract_id,
    strikePriceCents: row.strike_price_cents,
    expiry: row.expiry,
    gracePeriodSecs: row.grace_period_secs,
    feedId: row.feed_id,
    status: row.status,
    lastError: row.last_error ?? undefined,
    settleTxHash: row.settle_tx_hash ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
