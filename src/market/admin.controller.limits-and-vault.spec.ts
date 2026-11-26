import { AdminController } from './admin.controller';
import type { ConfigService } from '@nestjs/config';
import type { MarketRepository } from './market.repository';
import type { PerpetualRepository } from './perpetual.repository';
import type { EmailAuthRepository } from './email-auth.repository';
import type { AdminActivityRepository } from './admin-activity.repository';
import type { StellarService } from './stellar.service';

/**
 * Tests for `parseLimit` bounds and the vault-unconfigured branches on
 * `overview()` and `treasury()` (issue #170).
 *
 * The frontend admin dashboard branches on these exact shapes — the
 * `configured: false` discriminant and a null vault balance.  A refactor
 * that throws instead, or lets `limit=100000` through to SQLite, would be
 * invisible in dev and only found in production.
 */
describe('AdminController — parseLimit bounds and vault-unconfigured branches (issue #170)', () => {
  function makeController(vaultContract: string | undefined) {
    const config = {
      get: (key: string) => {
        if (key === 'vaultContract') return vaultContract;
        return undefined;
      },
    } as unknown as ConfigService;

    const markets = {
      getAll: jest.fn().mockReturnValue([]),
    } as unknown as MarketRepository;

    const perpetuals = {
      getAll: jest.fn().mockReturnValue([]),
    } as unknown as PerpetualRepository;

    const emailWallets = {
      getAllWallets: jest.fn().mockReturnValue([]),
    } as unknown as EmailAuthRepository;

    const activity = {
      countWalletActions: jest.fn().mockReturnValue(0),
      countSettlementChecksByOutcome: jest.fn().mockReturnValue({}),
      getWalletActionsByFunction: jest.fn().mockReturnValue([]),
      getRecentVaultFlows: jest.fn().mockReturnValue([]),
      getDistinctWalletAddresses: jest.fn().mockReturnValue([]),
      getRecentSettlementChecks: jest.fn().mockReturnValue([]),
    } as unknown as AdminActivityRepository;

    const vaultBalanceSpy = jest.fn().mockResolvedValue(99_000_000_000n);
    const stellar = {
      vaultBalance: vaultBalanceSpy,
      vaultTotalDeposited: jest.fn().mockResolvedValue(100_000_000_000n),
      oraclePublicKey: 'GORACLE',
      deployerPublicKey: 'GDEPLOYER',
      getNetworkHealth: jest.fn().mockResolvedValue({ status: 'healthy', latestLedger: 1, oldestLedger: 1, ledgerRetentionWindow: 100 }),
    } as unknown as StellarService;

    return { controller: new AdminController(config, markets, perpetuals, emailWallets, activity, stellar), vaultBalanceSpy };
  }

  // ── overview() ──────────────────────────────────────────────────────────────

  it('overview() returns vaultBalanceStroops: null when VAULT_CONTRACT is unset', async () => {
    const { controller } = makeController(undefined);
    const result = await controller.overview();
    expect(result.vaultBalanceStroops).toBeNull();
  });

  it('overview() does not call stellar.vaultBalance when VAULT_CONTRACT is unset', async () => {
    const { controller, vaultBalanceSpy } = makeController(undefined);
    await controller.overview();
    expect(vaultBalanceSpy).not.toHaveBeenCalled();
  });

  it('overview() returns the balance string when VAULT_CONTRACT is set', async () => {
    const { controller } = makeController('CVAULT');
    const result = await controller.overview();
    expect(result.vaultBalanceStroops).toBe('99000000000');
  });

  // ── treasury() ──────────────────────────────────────────────────────────────

  it('treasury() returns { configured: false } when VAULT_CONTRACT is unset', async () => {
    const { controller } = makeController(undefined);
    const result = await controller.treasury();
    expect(result).toEqual({ configured: false });
  });

  it('treasury() does not call stellar.vaultBalance when VAULT_CONTRACT is unset', async () => {
    const { controller, vaultBalanceSpy } = makeController(undefined);
    await controller.treasury();
    expect(vaultBalanceSpy).not.toHaveBeenCalled();
  });

  it('treasury() returns configured: true with balances when VAULT_CONTRACT is set', async () => {
    const { controller } = makeController('CVAULT');
    const result = await controller.treasury();
    expect(result).toMatchObject({ configured: true, vaultContract: 'CVAULT' });
  });

  // ── parseLimit (via settlement-checks query param) ───────────────────────────

  it.each([
    ['undefined', undefined, 50],
    ['"0"', '0', 50],
    ['"-1"', '-1', 50],
    ['"abc"', 'abc', 50],
    ['"501"', '501', 50],
    ['"1.5"', '1.5', 50],
    ['"500"', '500', 500],
    ['"1"', '1', 1],
    ['"250"', '250', 250],
  ])('parseLimit(%s) → %i', async (_label, raw, expectedLimit) => {
    const { controller } = makeController(undefined);
    const activity = (controller as unknown as { activity: AdminActivityRepository }).activity;
    const spy = activity.getRecentSettlementChecks as jest.Mock;
    await controller.settlementChecks(raw);
    expect(spy).toHaveBeenCalledWith(expectedLimit);
  });

  it.each([
    ['undefined', undefined, 50],
    ['"0"', '0', 50],
    ['"501"', '501', 50],
    ['"500"', '500', 500],
  ])('treasury parseLimit(%s) → %i', async (_label, raw, expectedLimit) => {
    const { controller } = makeController('CVAULT');
    const activity = (controller as unknown as { activity: AdminActivityRepository }).activity;
    const spy = activity.getRecentVaultFlows as jest.Mock;
    await controller.treasury(raw);
    expect(spy).toHaveBeenCalledWith(expectedLimit);
  });
});
