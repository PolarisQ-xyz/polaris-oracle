import type { WatchedMarket } from './market.types';
import type { WatchedPerpetual } from './perpetual.types';

/** Column-for-column shape of the `markets` table (see MarketRepository's CREATE TABLE). */
export interface MarketRow {
  contract_id: string;
  strike_price_cents: string;
  expiry: number;
  grace_period_secs: number;
  feed_id: number;
  status: WatchedMarket['status'];
  last_error: string | null;
  settle_tx_hash: string | null;
  created_at: number;
  updated_at: number;
}

/** Column-for-column shape of the `perpetuals` table (see PerpetualRepository's CREATE TABLE). */
export interface PerpetualRow {
  contract_id: string;
  status: WatchedPerpetual['status'];
  last_error: string | null;
  terminate_tx_hash: string | null;
  created_at: number;
  updated_at: number;
}
