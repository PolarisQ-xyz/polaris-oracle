import { PerpetualController } from './perpetual.controller';
import type { PerpetualService } from './perpetual.service';
import type { StellarService } from './stellar.service';
import type { OracleService } from './oracle.service';
import type { ConfigService } from '@nestjs/config';
import type { AdminActivityRepository } from './admin-activity.repository';

/**
 * Regression suite for `buildPriceOracleParams`'s all-or-nothing rule
 * (issue #171).  Every one of the three required env-vars can go missing
 * independently; in each case the oracle bundle must be `undefined` so the
 * contract `initialize` call never receives a half-configured params object.
 */
describe('PerpetualController.create — buildPriceOracleParams all-or-nothing rule (issue #171)', () => {
  const BASE_ENV: Record<string, string | number | bigint | undefined> = {
    nativeXlmSac: 'CXLMSAC',
    treasuryAddress: 'GTREASURY',
    lazerContract: 'CLAZER',
    reflectorContract: 'CREFLECTOR',
    mockRedstoneContract: 'CMOCKREDSTONE',
    xlmUsdFeedId: 1,
    reflectorAsset: 'native',
    reflectorMaxStalenessSecs: '300',
    reflectorToleranceBps: 100,
    redstoneMaxStalenessSecs: '600',
    redstoneToleranceBps: 200,
  };

  function makeController(envOverrides: Record<string, string | number | bigint | undefined> = {}) {
    const env = { ...BASE_ENV, ...envOverrides };

    const deployPerpetualSpy = jest.fn().mockResolvedValue({
      contractId: 'CPERP01',
      initTxHash: 'TX_HASH',
    });

    const stellar = {
      deployPerpetual: deployPerpetualSpy,
      oraclePublicKey: 'GORACLE',
    } as unknown as StellarService;

    const perpetuals = {
      watch: jest.fn().mockReturnValue({ contractId: 'CPERP01', status: 'watching' }),
    } as unknown as PerpetualService;

    const oracle = {} as OracleService;
    const activity = {} as AdminActivityRepository;

    const config = {
      get: (key: string) => env[key],
    } as unknown as ConfigService;

    return { controller: new PerpetualController(perpetuals, stellar, oracle, config, activity), deployPerpetualSpy };
  }

  const CREATE_DTO = {
    baseFeeBps: 50,
    minFeeBps: 10,
    initialLiquidityStroops: '1000000000',
  };

  it('passes full priceOracle params when all three contracts are configured', async () => {
    const { controller, deployPerpetualSpy } = makeController();
    await controller.create(CREATE_DTO);

    const call = deployPerpetualSpy.mock.calls[0][0];
    expect(call.priceOracle).toBeDefined();
    expect(call.priceOracle).toMatchObject({
      lazerContract: 'CLAZER',
      reflectorContract: 'CREFLECTOR',
      redstoneContract: 'CMOCKREDSTONE',
    });
  });

  it('passes priceOracle: undefined when LAZER_CONTRACT is missing', async () => {
    const { controller, deployPerpetualSpy } = makeController({ lazerContract: undefined });
    await controller.create(CREATE_DTO);

    const call = deployPerpetualSpy.mock.calls[0][0];
    expect(call.priceOracle).toBeUndefined();
  });

  it('passes priceOracle: undefined when REFLECTOR_CONTRACT is missing', async () => {
    const { controller, deployPerpetualSpy } = makeController({ reflectorContract: undefined });
    await controller.create(CREATE_DTO);

    const call = deployPerpetualSpy.mock.calls[0][0];
    expect(call.priceOracle).toBeUndefined();
  });

  it('passes priceOracle: undefined when MOCK_REDSTONE_CONTRACT is missing', async () => {
    const { controller, deployPerpetualSpy } = makeController({ mockRedstoneContract: undefined });
    await controller.create(CREATE_DTO);

    const call = deployPerpetualSpy.mock.calls[0][0];
    expect(call.priceOracle).toBeUndefined();
  });
});
