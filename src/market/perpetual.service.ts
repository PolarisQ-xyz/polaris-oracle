import { Injectable, Logger } from '@nestjs/common';
import { PerpetualRepository } from './perpetual.repository';
import { StellarService } from './stellar.service';
import type { WatchedPerpetual } from './perpetual.types';

const RECONCILE_READ_ATTEMPTS = 3;
const RECONCILE_READ_RETRY_DELAY_MS = 750;

/**
 * Deliberately a fraction of `MarketService`'s size — no settle-timers, no
 * cancel-fallback, no oracle-driven scheduling, because none of that has a
 * perpetual-shaped equivalent: there is no expiry to arm a timer against,
 * and `terminate()` is a pure admin-initiated action with no natural
 * liveness deadline (see `polaris-contracts/README.md`'s "The perpetual
 * contract" — `terminate`'s own doc comment states this as a v1 scope
 * choice, not an oversight). So this is just `list`/`get`/`watch`
 * bookkeeping plus a direct `triggerTerminate`, no `onModuleInit` re-arming
 * needed either.
 */
@Injectable()
export class PerpetualService {
  private readonly logger = new Logger(PerpetualService.name);

  constructor(
    private readonly repo: PerpetualRepository,
    private readonly stellar: StellarService,
  ) {}

  list(): WatchedPerpetual[] {
    return this.repo.getAll();
  }

  get(contractId: string): WatchedPerpetual | undefined {
    return this.repo.getById(contractId);
  }

  watch(contractId: string): WatchedPerpetual {
    const now = Date.now();
    const watched: WatchedPerpetual = { contractId, status: 'watching', createdAt: now, updatedAt: now };
    this.repo.upsert(watched);
    return watched;
  }

  async triggerTerminate(contractId: string): Promise<void> {
    const p = this.repo.getById(contractId);
    if (!p) throw new Error(`unknown perpetual ${contractId}`);
    try {
      const txHash = await this.stellar.terminatePerpetual(contractId);
      this.repo.upsert({ ...p, status: 'terminated', terminateTxHash: txHash, lastError: undefined, updatedAt: Date.now() });
      this.logger.log(`terminated ${contractId} in tx ${txHash}`);
    } catch (err) {
      const message = (err as Error).message;
      if (await this.reconcileWithChain(p)) return;
      this.repo.upsert({ ...p, lastError: message, updatedAt: Date.now() });
      this.logger.error(`terminate failed for ${contractId}: ${message}`);
      throw err;
    }
  }

  /**
   * Same "tx landed but the client saw a failure" shape MarketService
   * handles via `reconcileWithChain` — a `terminate` call can fail locally
   * (polling hiccup, network blip) after the on-chain transaction already
   * succeeded. Without this, the perpetual stays `watching` forever and
   * every retry fails with the contract's already-terminated error. Returns
   * true if it reconciled (caller should stop, not persist a failure).
   */
  private async reconcileWithChain(p: WatchedPerpetual): Promise<boolean> {
    let state;
    let lastReadError: unknown;
    for (let attempt = 1; attempt <= RECONCILE_READ_ATTEMPTS; attempt++) {
      try {
        state = await this.stellar.getPerpetualState(p.contractId);
        break;
      } catch (err) {
        lastReadError = err;
        if (attempt < RECONCILE_READ_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RECONCILE_READ_RETRY_DELAY_MS));
        }
      }
    }
    if (!state) {
      this.logger.warn(
        `reconcileWithChain: couldn't read ${p.contractId}'s on-chain state after ${RECONCILE_READ_ATTEMPTS} attempts (${(lastReadError as Error)?.message}) — can't tell if it's already finalized`,
      );
      return false;
    }
    if (state.status === 'Terminated') {
      this.repo.upsert({ ...p, status: 'terminated', terminateTxHash: undefined, lastError: undefined, updatedAt: Date.now() });
      this.logger.warn(`${p.contractId} was already terminated on-chain — reconciled local status`);
      return true;
    }
    return false;
  }
}
