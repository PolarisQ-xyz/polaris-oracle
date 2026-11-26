import { PerpetualController } from './perpetual.controller';
import type { PerpetualService } from './perpetual.service';
import type { StellarService } from './stellar.service';
import type { OracleService } from './oracle.service';
import type { ConfigService } from '@nestjs/config';
import type { AdminActivityRepository } from './admin-activity.repository';

/**
 * Regression for `buildPriceOracleParams`'s all-or-nothing rule: the
 * method returns `undefined` unless LAZER_CONTRACT, REFLECTOR_CONTRACT, and
 * MOCK_REDSTONE_CONTRACT are all set.  A refactor to "pass whatever is
 * configured" would deploy perpetuals whose `initialize` fails on-chain, or
 * silently deploy oracle-less perpetuals when the operator expected a full
 * bundle.
 */
describe('PerpetualController.create — buildPriceOracleParams all-or-nothing rule', () => {
  const BASE_CONFIG: Record<string, unknown> = {
    nativeXlmSac: 'CNATIVE',
    lazerContract: 'CLAZER',
    reflectorContract: 'CREFLECTOR',
    mockRedstoneContract: 'CMOCKREDSTONE',
    xlmUsdFeedId: 100,
    reflectorAsset: 'XLM',
    reflectorMaxStalenessSecs: '600',
    reflectorToleranceBps: 150,
    redstoneMaxStalenessSecs: '300',
    redstoneToleranceBps: 200,
  };

  function makeController(configOverrides: Record<string, unknown>) {
    const configValues = { ...BASE_CONFIG, ...configOverrides };
    const config = {
      get: jest.fn((key: string) => configValues[key] ?? undefined),
    } as unknown as ConfigService;

    let capturedPriceOracle: unknown;
    const stellar = {
      oraclePublicKey: 'GORACLE',
      deployerPublicKey: 'GDEPLOYER',
      deployPerpetual: jest.fn(async (params: { priceOracle: unknown }) => {
        capturedPriceOracle = params.priceOracle;
        return { contractId: 'CPERP', initTxHash: 'TXINIT' };
      }),
    } as unknown as StellarService;

    const oracle = { isAvailable: false } as unknown as OracleService;
    const perpetuals = {
      watch: jest.fn((id: string) => ({ contractId: id, status: 'watching' })),
    } as unknown as PerpetualService;
    const activity = {} as AdminActivityRepository;

    const controller = new PerpetualController(perpetuals, stellar, oracle, config, activity);
    return { controller, stellar, getPriceOracle: () => capturedPriceOracle };
  }

  it('passes priceOracle: undefined when LAZER_CONTRACT is missing', async () => {
    const { controller, getPriceOracle } = makeController({ lazerContract: undefined });
    await controller.create({ baseFeeBps: 50, minFeeBps: 10, initialLiquidityStroops: '1000000' });
    expect(getPriceOracle()).toBeUndefined();
  });

  it('passes priceOracle: undefined when REFLECTOR_CONTRACT is missing', async () => {
    const { controller, getPriceOracle } = makeController({ reflectorContract: undefined });
    await controller.create({ baseFeeBps: 50, minFeeBps: 10, initialLiquidityStroops: '1000000' });
    expect(getPriceOracle()).toBeUndefined();
  });

  it('passes priceOracle: undefined when MOCK_REDSTONE_CONTRACT is missing', async () => {
    const { controller, getPriceOracle } = makeController({ mockRedstoneContract: undefined });
    await controller.create({ baseFeeBps: 50, minFeeBps: 10, initialLiquidityStroops: '1000000' });
    expect(getPriceOracle()).toBeUndefined();
  });

  it('passes full priceOracle params when all three contracts are configured', async () => {
    const { controller, getPriceOracle } = makeController({});
    await controller.create({ baseFeeBps: 50, minFeeBps: 10, initialLiquidityStroops: '1000000' });
    expect(getPriceOracle()).toEqual({
      lazerContract: 'CLAZER',
      feedId: 100,
      reflectorContract: 'CREFLECTOR',
      reflectorAsset: 'XLM',
      reflectorMaxStalenessSecs: 600n,
      reflectorToleranceBps: 150,
      redstoneContract: 'CMOCKREDSTONE',
      nativeXlmSac: 'CNATIVE',
      redstoneMaxStalenessSecs: 300n,
      redstoneToleranceBps: 200,
    });
  });
});
