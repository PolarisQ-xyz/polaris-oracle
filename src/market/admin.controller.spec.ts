import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminActivityRepository } from './admin-activity.repository';
import type { MarketRepository } from './market.repository';
import type { PerpetualRepository } from './perpetual.repository';
import type { EmailAuthRepository } from './email-auth.repository';
import type { StellarService } from './stellar.service';

/**
 * Same regression-shape as `market.controller.guard.spec.ts` — a
 * class-level `@UseGuards(AdminGuard)` silently dropped in a refactor
 * wouldn't show up as a failing request in dev, just an unauthenticated
 * dashboard API. Asserted on the class itself since the guard here is
 * applied once at the controller level, not per-method.
 */
describe('AdminController — every route stays admin-guarded', () => {
  it('carries AdminGuard at the controller level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminController) ?? [];
    expect(guards).toContain(AdminGuard);
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by the suites below

function makeInMemoryActivity(): AdminActivityRepository {
  return new AdminActivityRepository(':memory:', { get: () => undefined } as unknown as ConfigService);
}

function makeController(overrides: {
  activity?: AdminActivityRepository;
  stellar?: Partial<StellarService>;
  configValues?: Record<string, unknown>;
} = {}): AdminController {
  const configValues = overrides.configValues ?? {};
  const config = { get: jest.fn((key: string) => configValues[key] ?? undefined) } as unknown as ConfigService;
  const markets = { getAll: jest.fn().mockReturnValue([]) } as unknown as MarketRepository;
  const perpetuals = { getAll: jest.fn().mockReturnValue([]) } as unknown as PerpetualRepository;
  const emailWallets = { getAllWallets: jest.fn().mockReturnValue([]) } as unknown as EmailAuthRepository;
  const activity =
    overrides.activity ??
    ({
      countWalletActions: jest.fn().mockReturnValue(0),
      countSettlementChecksByOutcome: jest.fn().mockReturnValue({ ok: 0, skipped: 0, failed: 0 }),
      getWalletActionsByFunction: jest.fn().mockReturnValue([]),
      getRecentVaultFlows: jest.fn().mockReturnValue([]),
      getRecentSettlementChecks: jest.fn().mockReturnValue([]),
      getDistinctWalletAddresses: jest.fn().mockReturnValue([]),
    } as unknown as AdminActivityRepository);
  const stellar = {
    vaultBalance: jest.fn().mockResolvedValue(0n),
    vaultTotalDeposited: jest.fn().mockResolvedValue(0n),
    tokenBalance: jest.fn().mockResolvedValue(0n),
    getNetworkHealth: jest.fn().mockResolvedValue({ status: 'healthy', latestLedger: 1, oldestLedger: 0, ledgerRetentionWindow: 1 }),
    oraclePublicKey: 'GORACLE',
    deployerPublicKey: 'GDEPLOYER',
    ...(overrides.stellar ?? {}),
  } as unknown as StellarService;
  return new AdminController(config, markets, perpetuals, emailWallets, activity, stellar);
}

// ---------------------------------------------------------------------------
// Issue #170 — parseLimit bounds and vault-unconfigured branches

describe('AdminController.parseLimit — bounds and defaults', () => {
  it.each([
    ['0', 50],
    ['-1', 50],
    ['abc', 50],
    ['501', 50],
    ['1.5', 50],
    [undefined, 50],
    ['500', 500],
    ['1', 1],
  ])('parseLimit(%s) → %i', (input, expected) => {
    const getRecentSettlementChecks = jest.fn().mockReturnValue([]);
    const ctrl = makeController({
      activity: {
        countWalletActions: jest.fn().mockReturnValue(0),
        countSettlementChecksByOutcome: jest.fn().mockReturnValue({ ok: 0, skipped: 0, failed: 0 }),
        getWalletActionsByFunction: jest.fn().mockReturnValue([]),
        getRecentVaultFlows: jest.fn().mockReturnValue([]),
        getRecentSettlementChecks,
        getDistinctWalletAddresses: jest.fn().mockReturnValue([]),
      } as unknown as AdminActivityRepository,
    });
    ctrl.settlementChecks(input);
    expect(getRecentSettlementChecks).toHaveBeenCalledWith(expected);
  });
});

describe('AdminController.overview — vault-unconfigured', () => {
  it('returns vaultBalanceStroops: null and skips StellarService when VAULT_CONTRACT is unset', async () => {
    const stellar = { vaultBalance: jest.fn() } as unknown as StellarService;
    const ctrl = makeController({ stellar, configValues: {} });
    const result = await ctrl.overview();
    expect(result.vaultBalanceStroops).toBeNull();
    expect(stellar.vaultBalance).not.toHaveBeenCalled();
  });
});

describe('AdminController.treasury — vault-unconfigured', () => {
  it('returns { configured: false } and skips StellarService when VAULT_CONTRACT is unset', async () => {
    const stellar = { vaultBalance: jest.fn(), vaultTotalDeposited: jest.fn() } as unknown as StellarService;
    const ctrl = makeController({ stellar, configValues: {} });
    const result = await ctrl.treasury();
    expect(result).toEqual({ configured: false });
    expect(stellar.vaultBalance).not.toHaveBeenCalled();
    expect(stellar.vaultTotalDeposited).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Issue #169 — feeRevenue bigint math and null-row skipping

describe('AdminController.feeRevenue', () => {
  it('computes correct per-market and total stroops across two markets', () => {
    const activity = makeInMemoryActivity();
    // market 1: buy → 10000 * 100 / 10000 = 100 stroops
    activity.recordWalletAction({ contractId: 'CM1', walletAddress: 'G1', functionName: 'buy', collateralAmount: '10000', feeBps: 100, txHash: 'TX1', source: 'passkey' });
    // market 1: sell → 20000 * 200 / 10000 = 400 stroops
    activity.recordWalletAction({ contractId: 'CM1', walletAddress: 'G1', functionName: 'sell', collateralAmount: '20000', feeBps: 200, txHash: 'TX2', source: 'passkey' });
    // market 2: buy → 50000 * 50 / 10000 = 250 stroops
    activity.recordWalletAction({ contractId: 'CM2', walletAddress: 'G1', functionName: 'buy', collateralAmount: '50000', feeBps: 50, txHash: 'TX3', source: 'passkey' });

    const result = makeController({ activity }).feeRevenue();
    expect(result.totalStroops).toBe('750');
    expect(result.byMarket).toHaveLength(2);
    expect(result.byMarket.find((m) => m.contractId === 'CM1')?.stroops).toBe('500');
    expect(result.byMarket.find((m) => m.contractId === 'CM2')?.stroops).toBe('250');
  });

  it('skips rows with null fee_bps from totals', () => {
    const activity = makeInMemoryActivity();
    activity.recordWalletAction({ contractId: 'CM1', walletAddress: 'G1', functionName: 'buy', collateralAmount: '10000', feeBps: 100, txHash: 'TX1', source: 'passkey' });
    // null fee_bps — skipped from revenue, but counted in sampleSize
    activity.recordWalletAction({ contractId: 'CM1', walletAddress: 'G1', functionName: 'buy', collateralAmount: '5000', feeBps: undefined, txHash: 'TX2', source: 'passkey' });

    const result = makeController({ activity }).feeRevenue();
    expect(result.totalStroops).toBe('100');
    // sampleSize counts ALL buy/sell rows including those without fee data
    expect(result.sampleSize).toBe(2);
  });

  it('floor-rounds fractional fees to zero', () => {
    const activity = makeInMemoryActivity();
    // 1 stroop * 15 bps / 10_000 = 0.0015 → floor = 0
    activity.recordWalletAction({ contractId: 'CM1', walletAddress: 'G1', functionName: 'buy', collateralAmount: '1', feeBps: 15, txHash: 'TX1', source: 'passkey' });

    const result = makeController({ activity }).feeRevenue();
    expect(result.totalStroops).toBe('0');
  });
});
