import { TradeActivityRecorder } from './trade-activity-recorder.service';
import type { StellarService } from './stellar.service';
import type { AdminActivityRepository } from './admin-activity.repository';

function setup() {
  const stellar = {
    getFee: jest.fn().mockResolvedValue(30),
    getPerpetualFee: jest.fn().mockResolvedValue(50),
  };
  const activity = { recordWalletAction: jest.fn() };
  const recorder = new TradeActivityRecorder(
    stellar as unknown as StellarService,
    activity as unknown as AdminActivityRepository,
  );
  return { stellar, activity, recorder };
}
const flush = () => new Promise((r) => setImmediate(r));
const base = { contractId: 'C1', walletAddress: 'W1', txHash: 'tx1', source: 'email' as const };

describe('TradeActivityRecorder', () => {
  it('records a buy with the market fee', async () => {
    const { stellar, activity, recorder } = setup();
    recorder.recordTrade({ ...base, function: 'buy', args: { collateral_amount: '100' } });
    await flush();
    expect(stellar.getFee).toHaveBeenCalledWith('C1');
    expect(activity.recordWalletAction).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'buy', feeBps: 30, txHash: 'tx1', source: 'email' }),
    );
  });

  it('uses the perpetual fee for perpetual sells', async () => {
    const { stellar, activity, recorder } = setup();
    recorder.recordTrade({ ...base, function: 'sell', args: {}, contractKind: 'perpetual', source: 'passkey' });
    await flush();
    expect(stellar.getPerpetualFee).toHaveBeenCalledWith('C1');
    expect(activity.recordWalletAction).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'sell', feeBps: 50, source: 'passkey' }),
    );
  });

  it('skips the fee read for transfer', async () => {
    const { stellar, activity, recorder } = setup();
    recorder.recordTrade({ ...base, function: 'transfer', args: {} });
    await flush();
    expect(stellar.getFee).not.toHaveBeenCalled();
    expect(activity.recordWalletAction).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'transfer', feeBps: undefined }),
    );
  });

  it('returns synchronously and swallows errors', async () => {
    const { stellar, activity, recorder } = setup();
    stellar.getFee.mockRejectedValue(new Error('rpc down'));
    expect(() => recorder.recordTrade({ ...base, function: 'buy', args: {} })).not.toThrow();
    await flush();
    expect(activity.recordWalletAction).not.toHaveBeenCalled();
  });
});
