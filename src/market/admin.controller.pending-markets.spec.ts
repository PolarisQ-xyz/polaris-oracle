import { AdminController } from './admin.controller';
import { MarketRepository } from './market.repository';
import type { WatchedMarket } from './market.types';

function makeMarket(overrides: Partial<WatchedMarket> = {}): WatchedMarket {
  return {
    contractId: 'CCONTRACT',
    strikePriceCents: '10000',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    gracePeriodSecs: 300,
    feedId: 1,
    status: 'pending',
    createdAt: Math.floor(Date.now() / 1000) - 600,
    updatedAt: Math.floor(Date.now() / 1000) - 600,
    ...overrides,
  };
}

function makeController(markets: WatchedMarket[]): AdminController {
  const repo = { getAll: () => markets } as unknown as MarketRepository;
  return new AdminController(
    {} as never,
    repo,
    { getAll: () => [] } as never,
    { countWalletActions: () => 0, countSettlementChecksByOutcome: () => ({}) } as never,
    { getRecentSettlementChecks: () => [] } as never,
    {} as never,
  );
}

describe('AdminController.pendingMarkets (issue #166)', () => {
  it('returns only pending markets sorted oldest-first', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const markets: WatchedMarket[] = [
      makeMarket({ contractId: 'C1', status: 'pending', updatedAt: nowSec - 200 }),
      makeMarket({ contractId: 'C2', status: 'watching', updatedAt: nowSec - 100 }),
      makeMarket({ contractId: 'C3', status: 'pending', updatedAt: nowSec - 400 }),
    ];
    const result = makeController(markets).pendingMarkets();
    expect(result.count).toBe(2);
    expect(result.markets[0].contractId).toBe('C3'); // oldest first
    expect(result.markets[1].contractId).toBe('C1');
  });

  it('marks markets older than threshold as stuck', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const markets: WatchedMarket[] = [
      makeMarket({ contractId: 'COLD', status: 'pending', updatedAt: nowSec - 400 }), // >300s → stuck
      makeMarket({ contractId: 'CNEW', status: 'pending', updatedAt: nowSec - 100 }), // <300s → not stuck
    ];
    const result = makeController(markets).pendingMarkets();
    const cold = result.markets.find((m) => m.contractId === 'COLD')!;
    const cnew = result.markets.find((m) => m.contractId === 'CNEW')!;
    expect(cold.isStuck).toBe(true);
    expect(cnew.isStuck).toBe(false);
  });

  it('respects custom ageThresholdSecs query param', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const markets: WatchedMarket[] = [
      makeMarket({ contractId: 'C1', status: 'pending', updatedAt: nowSec - 60 }),
    ];
    const result = makeController(markets).pendingMarkets('30'); // 30 s threshold
    expect(result.markets[0].isStuck).toBe(true);
  });

  it('returns empty list when no markets are pending', () => {
    const markets: WatchedMarket[] = [
      makeMarket({ status: 'watching' }),
      makeMarket({ status: 'settled' }),
    ];
    const result = makeController(markets).pendingMarkets();
    expect(result.count).toBe(0);
    expect(result.markets).toHaveLength(0);
  });

  it('includes lastError in the response', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const markets: WatchedMarket[] = [
      makeMarket({ contractId: 'C1', status: 'pending', updatedAt: nowSec - 10, lastError: 'rpc timeout' }),
    ];
    const result = makeController(markets).pendingMarkets();
    expect(result.markets[0].lastError).toBe('rpc timeout');
  });
});
