import { AdminController } from './admin.controller';
import { AdminActivityRepository } from './admin-activity.repository';
import type { ConfigService } from '@nestjs/config';
import type { MarketRepository } from './market.repository';
import type { PerpetualRepository } from './perpetual.repository';
import type { EmailAuthRepository } from './email-auth.repository';
import type { StellarService } from './stellar.service';
import type { WalletActionRow } from './admin-activity.repository';

/**
 * Tests for `AdminController.feeRevenue()` bigint fee math, per-market
 * grouping, null-row skipping, and `sampleSize` counting (issue #169).
 *
 * This is the dashboard's revenue number.  The sell-fee undercount bug lived
 * precisely in this pipeline; nothing else catches a regression in rounding,
 * grouping, or null handling.
 */
describe('AdminController.feeRevenue — bigint math, grouping, null-row skipping (issue #169)', () => {
  function makeController(rows: Partial<WalletActionRow>[]) {
    const config = {
      get: () => undefined,
    } as unknown as ConfigService;

    const markets = { getAll: jest.fn().mockReturnValue([]) } as unknown as MarketRepository;
    const perpetuals = { getAll: jest.fn().mockReturnValue([]) } as unknown as PerpetualRepository;
    const emailWallets = { getAllWallets: jest.fn().mockReturnValue([]) } as unknown as EmailAuthRepository;
    const stellar = {} as unknown as StellarService;

    const activity = {
      countWalletActions: jest.fn().mockReturnValue(0),
      countSettlementChecksByOutcome: jest.fn().mockReturnValue({}),
      getWalletActionsByFunction: jest.fn().mockReturnValue(rows),
      getRecentVaultFlows: jest.fn().mockReturnValue([]),
      getDistinctWalletAddresses: jest.fn().mockReturnValue([]),
      getRecentSettlementChecks: jest.fn().mockReturnValue([]),
    } as unknown as AdminActivityRepository;

    return new AdminController(config, markets, perpetuals, emailWallets, activity, stellar);
  }

  it('computes correct per-market and total stroops for buy+sell across two markets', () => {
    // Market A: buy 1_000_000 stroops @ 50 bps → 5_000; sell 2_000_000 @ 30 bps → 6_000
    // Market B: buy 500_000 stroops @ 100 bps → 5_000
    const rows: Partial<WalletActionRow>[] = [
      { contract_id: 'CA', collateral_amount: '1000000', fee_bps: 50 },
      { contract_id: 'CA', collateral_amount: '2000000', fee_bps: 30 },
      { contract_id: 'CB', collateral_amount: '500000', fee_bps: 100 },
    ];
    const controller = makeController(rows);
    const result = controller.feeRevenue();

    expect(result.totalStroops).toBe('16000');
    const byMarket = Object.fromEntries(result.byMarket.map((m) => [m.contractId, m.stroops]));
    expect(byMarket['CA']).toBe('11000');
    expect(byMarket['CB']).toBe('5000');
    expect(result.sampleSize).toBe(3);
  });

  it('skips rows where collateral_amount is null', () => {
    const rows: Partial<WalletActionRow>[] = [
      { contract_id: 'CA', collateral_amount: null, fee_bps: 50 },
      { contract_id: 'CA', collateral_amount: '1000000', fee_bps: 100 },
    ];
    const controller = makeController(rows);
    const result = controller.feeRevenue();

    expect(result.totalStroops).toBe('10000');
    // sampleSize counts ALL rows (including skipped ones) — it's the raw
    // dataset size, not the number of rows that contributed to the total.
    expect(result.sampleSize).toBe(2);
  });

  it('skips rows where fee_bps is null', () => {
    const rows: Partial<WalletActionRow>[] = [
      { contract_id: 'CA', collateral_amount: '1000000', fee_bps: null },
      { contract_id: 'CA', collateral_amount: '1000000', fee_bps: 50 },
    ];
    const controller = makeController(rows);
    const result = controller.feeRevenue();

    expect(result.totalStroops).toBe('5000');
    expect(result.sampleSize).toBe(2);
  });

  it('applies bigint floor division (not floating-point) so 1 stroop @ 1 bps → 0', () => {
    // 1 * 1 / 10_000 = 0 (floor, not 0.0001)
    const rows: Partial<WalletActionRow>[] = [
      { contract_id: 'CA', collateral_amount: '1', fee_bps: 1 },
    ];
    const controller = makeController(rows);
    const result = controller.feeRevenue();
    expect(result.totalStroops).toBe('0');
  });

  it('returns empty totals when there are no rows', () => {
    const controller = makeController([]);
    const result = controller.feeRevenue();
    expect(result.totalStroops).toBe('0');
    expect(result.byMarket).toHaveLength(0);
    expect(result.sampleSize).toBe(0);
  });

  it('only queries buy+sell functions', () => {
    const rows: Partial<WalletActionRow>[] = [];
    const controller = makeController(rows);
    controller.feeRevenue();
    const activity = (controller as unknown as { activity: AdminActivityRepository }).activity;
    const spy = activity.getWalletActionsByFunction as jest.Mock;
    expect(spy).toHaveBeenCalledWith(['buy', 'sell']);
  });
});
