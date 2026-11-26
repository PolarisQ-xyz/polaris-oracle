import { AdminController } from './admin.controller';
import type { ConfigService } from '@nestjs/config';
import type { MarketRepository } from './market.repository';
import type { PerpetualRepository } from './perpetual.repository';
import type { EmailAuthRepository } from './email-auth.repository';
import type { AdminActivityRepository } from './admin-activity.repository';
import type { StellarService } from './stellar.service';

/**
 * Tests for oracle/deployer XLM balance inclusion in `GET /admin/network`
 * and low-balance warning logs (issue #163).
 *
 * When the oracle hot-wallet drains, everything fails (trades, settlement,
 * onboarding) with opaque RPC errors.  The dashboard now surfaces both
 * balances and the backend warns once per request when either is below
 * `ORACLE_MIN_BALANCE_STROOPS`.
 */
describe('AdminController.network — XLM balance fields and low-balance warnings (issue #163)', () => {
  function makeController(options: {
    oracleBalance: bigint | null;
    deployerBalance: bigint | null;
    minBalanceStroops?: string;
  }) {
    const config = {
      get: (key: string) => {
        if (key === 'oracleMinBalanceStroops') return options.minBalanceStroops ?? undefined;
        return undefined;
      },
    } as unknown as ConfigService;

    const markets = { getAll: jest.fn().mockReturnValue([]) } as unknown as MarketRepository;
    const perpetuals = { getAll: jest.fn().mockReturnValue([]) } as unknown as PerpetualRepository;
    const emailWallets = { getAllWallets: jest.fn().mockReturnValue([]) } as unknown as EmailAuthRepository;
    const activity = {
      countWalletActions: jest.fn().mockReturnValue(0),
      countSettlementChecksByOutcome: jest.fn().mockReturnValue({}),
      getWalletActionsByFunction: jest.fn().mockReturnValue([]),
      getRecentVaultFlows: jest.fn().mockReturnValue([]),
      getDistinctWalletAddresses: jest.fn().mockReturnValue([]),
      getRecentSettlementChecks: jest.fn().mockReturnValue([]),
    } as unknown as AdminActivityRepository;

    const getAccountXlmBalanceStroopsSpy = jest.fn()
      .mockImplementation((key: string) => {
        if (key === 'GORACLE') return Promise.resolve(options.oracleBalance);
        if (key === 'GDEPLOYER') return Promise.resolve(options.deployerBalance);
        return Promise.resolve(null);
      });

    const stellar = {
      oraclePublicKey: 'GORACLE',
      deployerPublicKey: 'GDEPLOYER',
      getNetworkHealth: jest.fn().mockResolvedValue({
        status: 'healthy',
        latestLedger: 100,
        oldestLedger: 1,
        ledgerRetentionWindow: 100,
      }),
      getAccountXlmBalanceStroops: getAccountXlmBalanceStroopsSpy,
    } as unknown as StellarService;

    const controller = new AdminController(config, markets, perpetuals, emailWallets, activity, stellar);
    // Spy on the logger that NestJS creates per-instance
    const loggerWarnSpy = jest.spyOn(
      (controller as unknown as { logger: { warn: jest.Mock } }).logger,
      'warn',
    ).mockImplementation(() => undefined);

    return { controller, loggerWarnSpy };
  }

  it('includes oracleBalanceStroops and deployerBalanceStroops in the response', async () => {
    const { controller } = makeController({
      oracleBalance: 500_000_000n,
      deployerBalance: 200_000_000n,
    });
    const result = await controller.network();
    expect(result.oracleBalanceStroops).toBe('500000000');
    expect(result.deployerBalanceStroops).toBe('200000000');
    expect(result.oraclePublicKey).toBe('GORACLE');
    expect(result.deployerPublicKey).toBe('GDEPLOYER');
  });

  it('returns null balances when accounts are not found on-chain', async () => {
    const { controller } = makeController({
      oracleBalance: null,
      deployerBalance: null,
    });
    const result = await controller.network();
    expect(result.oracleBalanceStroops).toBeNull();
    expect(result.deployerBalanceStroops).toBeNull();
  });

  it('logs a warning when oracle balance is below the default threshold (100_000_000 stroops = 10 XLM)', async () => {
    const { controller, loggerWarnSpy } = makeController({
      oracleBalance: 50_000_000n, // 5 XLM — below default 10 XLM threshold
      deployerBalance: 500_000_000n,
    });
    await controller.network();
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    const [, message] = loggerWarnSpy.mock.calls[0];
    expect(message).toMatch(/oracle/i);
  });

  it('logs a warning when deployer balance is below threshold', async () => {
    const { controller, loggerWarnSpy } = makeController({
      oracleBalance: 500_000_000n,
      deployerBalance: 10_000_000n, // 1 XLM — below default threshold
    });
    await controller.network();
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    const [, message] = loggerWarnSpy.mock.calls[0];
    expect(message).toMatch(/deployer/i);
  });

  it('logs two warnings when both balances are low', async () => {
    const { controller, loggerWarnSpy } = makeController({
      oracleBalance: 1_000_000n,
      deployerBalance: 2_000_000n,
    });
    await controller.network();
    expect(loggerWarnSpy).toHaveBeenCalledTimes(2);
  });

  it('does not warn when both balances are above threshold', async () => {
    const { controller, loggerWarnSpy } = makeController({
      oracleBalance: 1_000_000_000n,
      deployerBalance: 2_000_000_000n,
    });
    await controller.network();
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });

  it('respects a custom ORACLE_MIN_BALANCE_STROOPS configuration', async () => {
    const { controller, loggerWarnSpy } = makeController({
      oracleBalance: 500_000_000n, // 50 XLM — above default but below custom
      deployerBalance: 500_000_000n,
      minBalanceStroops: '1000000000', // 100 XLM custom threshold
    });
    await controller.network();
    // Both are 50 XLM, threshold is 100 XLM → both should warn
    expect(loggerWarnSpy).toHaveBeenCalledTimes(2);
  });

  it('does not warn when balance is null (account not yet funded)', async () => {
    const { controller, loggerWarnSpy } = makeController({
      oracleBalance: null,
      deployerBalance: null,
    });
    await controller.network();
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });
});
