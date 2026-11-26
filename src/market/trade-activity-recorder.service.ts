import { Injectable, Logger } from '@nestjs/common';
import { StellarService } from './stellar.service';
import { AdminActivityRepository, type WalletActionFunction, type WalletActionSource } from './admin-activity.repository';
import { feeBearingAmount, type WireArgs } from './wire-args';

/**
 * Best-effort admin-dashboard logging for a confirmed wallet trade, shared by
 * the passkey and email-login paths. Fire-and-forget: the fee read (an RPC
 * round trip) and the row insert run off the request path, and a failure is
 * only logged — see AdminActivityRepository: a read-side cache, not a second
 * source of truth.
 */
@Injectable()
export class TradeActivityRecorder {
  private readonly logger = new Logger(TradeActivityRecorder.name);

  constructor(
    private readonly stellar: StellarService,
    private readonly activity: AdminActivityRepository,
  ) {}

  /** Does not wait: returns immediately, errors are logged and swallowed. */
  recordTrade(trade: {
    contractId: string;
    function: string;
    args: WireArgs;
    contractKind?: string;
    walletAddress: string;
    txHash: string;
    source: WalletActionSource;
  }): void {
    void this.record(trade).catch((err) => {
      this.logger.warn(`failed to record admin-activity row for tx ${trade.txHash}: ${(err as Error).message}`);
    });
  }

  private async record(trade: Parameters<TradeActivityRecorder['recordTrade']>[0]): Promise<void> {
    const feeBps = ['buy', 'sell'].includes(trade.function)
      ? await (trade.contractKind === 'perpetual'
          ? this.stellar.getPerpetualFee(trade.contractId)
          : this.stellar.getFee(trade.contractId))
      : undefined;
    this.activity.recordWalletAction({
      contractId: trade.contractId,
      walletAddress: trade.walletAddress,
      functionName: trade.function as WalletActionFunction,
      collateralAmount: feeBearingAmount(trade.function, trade.args),
      feeBps,
      txHash: trade.txHash,
      source: trade.source,
    });
  }
}
