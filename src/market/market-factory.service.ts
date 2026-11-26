import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketRepository } from './market.repository';
import { MarketService } from './market.service';
import { MarketEvents } from './market-events';
import { StellarService } from './stellar.service';
import { AdminActivityRepository } from './admin-activity.repository';
import { fetchHermesPriceCents } from './pyth-price';
import type { WatchedMarket } from './market.types';

export interface FeedCatalogEntry {
  feedId: number;
  hermesFeedId: string;
  symbol: string;
}

export interface MarketFactoryRunResult {
  created: { symbol: string; contractId: string; strikePriceCents: string }[];
  skipped: string[];
  failed: { symbol: string; error: string }[];
}

/**
 * "No human clicks a button" market creation, wired to the capital-
 * efficiency vault (see `polaris-contracts/README.md`) so a fresh market's
 * seed liquidity comes from shared custody rather than a manual admin
 * transfer per market. Same structural pattern as `MarketService`
 * (`Injectable`, `Logger`, a timer armed in `onModuleInit`) rather than a
 * new scheduling dependency.
 *
 * Trust model is unchanged from the existing `POST /markets/create`: this
 * service acts as the oracle's own admin-authorized identity, the same key
 * that already deploys and settles markets today — not a new permission
 * surface.
 */
@Injectable()
export class MarketFactoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketFactoryService.name);
  private timer: NodeJS.Timeout | undefined;
  // Guards against the periodic sweep and the 'finalized' event both seeing
  // "no open market" for the same feed around the same moment and both
  // starting a create — checked+added synchronously with hasOpenMarket in
  // rollFeed, so there's no await between the check and the reservation.
  private readonly rolling = new Set<number>();
  private paused = false;

  constructor(
    private readonly repo: MarketRepository,
    private readonly markets: MarketService,
    private readonly stellar: StellarService,
    private readonly config: ConfigService,
    private readonly events: MarketEvents,
    private readonly activity: AdminActivityRepository,
  ) {}

  // ---- factory pause/resume (issue #179) -----------------------------------
  // In-memory flag backed by SQLite so the paused state survives restarts.
  // The flag is loaded eagerly in onModuleInit before the timer starts, so
  // a restart after a pause keeps the factory stopped without operator
  // intervention.
  private paused = false;

  /** Pause the factory; persists across restarts. Returns the new state. */
  pause(): { paused: true } {
    this.paused = true;
    this.activity.setFlag('factory_paused', '1');
    this.logger.warn('Market factory PAUSED by admin');
    return { paused: true };
  }

  /** Resume the factory. Returns the new state. */
  resume(): { paused: false } {
    this.paused = false;
    this.activity.setFlag('factory_paused', '0');
    this.logger.log('Market factory RESUMED by admin');
    return { paused: false };
  }

  /** Current pause state (for the admin overview). */
  isPaused(): boolean {
    return this.paused;
  }

  onModuleInit(): void {
    // Restore persisted pause state before arming the timer (issue #179).
    this.paused = this.activity.getFlag('factory_paused') === '1';
    if (this.paused) this.logger.warn('Market factory starting in PAUSED state (persisted from prior run)');

    // Relies on MarketService.onModuleInit() never emitting 'finalized'
    // *synchronously* during Nest's provider-init tick — true today, since
    // its fire-and-forget trySettle/tryCancel calls are gated on real I/O
    // (oracle wait, RPC), so they can't resolve before this listener is
    // registered a few lines below in the same synchronous tick.
    this.events.on('finalized', (m: WatchedMarket) => {
      try {
        const entry = this.catalogEntry(m.feedId);
        if (entry) void this.rollFeed(entry);
      } catch (err) {
        // EventEmitter doesn't catch listener exceptions itself — an
        // unhandled one here would become an unhandled rejection, not a
        // logged, contained failure like everywhere else in this class.
        this.logger.error(`'finalized' handler failed for ${m.contractId}: ${(err as Error).message}`);
      }
    });

    const intervalSecs = this.config.get<number>('marketFactoryIntervalSecs')!;
    this.timer = setInterval(() => void this.run(), intervalSecs * 1000);
    this.timer.unref?.();

    // Boot-time reconciliation pass, distinct from the interval above and
    // from the 'finalized' event: covers the narrow gap neither handles —
    // a crash strictly between a market's terminal persist() completing and
    // its successor being created, where the event that would have
    // triggered it already fired and was lost. (A market that was still
    // open pre-crash and resolves *during* this boot is covered once
    // MarketService re-arms it and the event fires, not by this.)
    void this.run();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass over the catalog. Every entry is independent — a failure on
   * one (bad Hermes lookup, an underfunded vault, a deploy hiccup) is
   * logged and skipped rather than aborting the rest, same "isolate the
   * blast radius per unit of work" shape as `MarketService`'s per-market
   * timers.
   */
  async run(): Promise<MarketFactoryRunResult> {
    await this.checkHotWalletBalances();
    const catalog = this.config.get<FeedCatalogEntry[]>('feedCatalog') ?? [];
    const result: MarketFactoryRunResult = { created: [], skipped: [], failed: [] };

    for (const entry of catalog) {
      const outcome = await this.rollFeed(entry);
      if (outcome.status === 'skipped') result.skipped.push(entry.symbol);
      else if (outcome.status === 'failed') result.failed.push({ symbol: entry.symbol, error: outcome.error });
      else result.created.push({ symbol: entry.symbol, contractId: outcome.contractId, strikePriceCents: outcome.strikePriceCents });
    }
    return result;
  }

  /**
   * Creates a successor for one catalog entry if (and only if) it doesn't
   * already have an open/pending market and nothing else is already rolling
   * it — the single entry point both the periodic sweep and the
   * 'finalized' event call, so there's exactly one place that can start a
   * creation, not two independently-maintained ones.
   */
  pause(): void {
    this.paused = true;
    this.logger.warn('market factory paused');
  }

  resume(): void {
    this.paused = false;
    this.logger.log('market factory resumed');
  }

  isPaused(): boolean {
    return this.paused;
  }

  private async rollFeed(
    entry: FeedCatalogEntry,
  ): Promise<
    | { status: 'skipped' }
    | { status: 'failed'; error: string }
    | { status: 'created'; contractId: string; strikePriceCents: string }
  > {
    // Return 'skipped' while paused so the caller's result list reflects the
    // factory is intentionally not creating markets (issue #179).
    if (this.paused || this.hasOpenMarket(entry.feedId) || this.rolling.has(entry.feedId)) {
      return { status: 'skipped' };
    }
    this.rolling.add(entry.feedId);
    try {
      const orphan = this.orphans.get(entry.feedId);
      if (orphan) {
        this.markets.watch(orphan);
        this.orphans.delete(entry.feedId);
        this.logger.warn(`re-tracked orphaned market ${orphan.contractId} for ${entry.symbol}`);
        return { status: 'created', contractId: orphan.contractId, strikePriceCents: orphan.strikePriceCents };
      }
      const { contractId, strikePriceCents } = await this.createMarketFor(entry);
      this.repo.recordFactoryRun({ feedId: entry.feedId, outcome: 'created', contractId });
      return { status: 'created', contractId, strikePriceCents: strikePriceCents.toString() };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`market factory failed for ${entry.symbol}: ${message}`);
      this.repo.recordFactoryRun({ feedId: entry.feedId, outcome: 'failed', error: message });
      return { status: 'failed', error: message };
    } finally {
      this.rolling.delete(entry.feedId);
    }
  }

  /** Looks up the catalog entry for a feed by its numeric ID; returns undefined if the feed is not in the configured catalog. */
  private catalogEntry(feedId: number): FeedCatalogEntry | undefined {
    const catalog = this.config.get<FeedCatalogEntry[]>('feedCatalog') ?? [];
    return catalog.find((e) => e.feedId === feedId);
  }

  /** Returns true if any market for this feed is in a non-terminal state (watching or pending), preventing duplicate creation. */
  private hasOpenMarket(feedId: number): boolean {
    return this.repo.getByFeedId(feedId).some((m) => m.status === 'watching' || m.status === 'pending');
  }

  /** Withdraws seed liquidity from the vault and deploys a new market contract for the given feed catalog entry. */
  private async createMarketFor(entry: FeedCatalogEntry): Promise<{ contractId: string; strikePriceCents: bigint }> {
    const vaultContract = this.config.get<string>('vaultContract');
    const lazerContract = this.config.get<string>('lazerContract');
    const nativeXlmSac = this.config.get<string>('nativeXlmSac');
    const reflectorContract = this.config.get<string>('reflectorContract');
    if (!vaultContract || !lazerContract || !nativeXlmSac || !reflectorContract) {
      throw new Error(
        'VAULT_CONTRACT, LAZER_CONTRACT, NATIVE_XLM_SAC, and REFLECTOR_CONTRACT must be configured for the market factory',
      );
    }

    const gracePeriodSecs = this.config.get<number>('marketFactoryGracePeriodSecs')!;
    const initialLiquidityStroops = BigInt(this.config.get<string>('marketFactoryInitialLiquidityStroops')!);

    // Withdraw before deploy: a failed withdrawal (vault underfunded, admin
    // mismatch, ...) throws here and this feed is skipped for this run —
    // deployMarket never runs, so there's no partially-funded market left
    // behind. See the module doc: every entry fails independently.
    const withdrawTxHash = await this.stellar.vaultWithdraw(vaultContract, initialLiquidityStroops);

    // Strike and expiry are taken right before deploy, after the withdraw
    // round trip, so neither is stale by the time the market opens.
    const strikePriceCents = await this.fetchStrikePriceCents(entry, reflectorContract);
    const expiry = Math.floor(Date.now() / 1000) + this.config.get<number>('marketFactoryExpirySecs')!;

    const { contractId } = await this.stellar.deployMarket({
      strikePriceCents,
      expiry: BigInt(expiry),
      gracePeriodSecs: BigInt(gracePeriodSecs),
      lazerContract,
      feedId: entry.feedId,
      baseFeeBps: this.config.get<number>('marketFactoryBaseFeeBps')!,
      minFeeBps: this.config.get<number>('marketFactoryMinFeeBps')!,
      // The vault, not this process's own address — its own redeem_from_market
      // is how it later collects the payout back into shared custody. See
      // polaris-contracts/README.md's "The capital-efficiency vault".
      treasury: vaultContract,
      initialLiquidityStroops,
      collateralAsset: nativeXlmSac,
      reflectorContract,
      reflectorAsset: this.config.get<string>('reflectorAsset')!,
      reflectorMaxStalenessSecs: BigInt(this.config.get<string>('reflectorMaxStalenessSecs')!),
      reflectorToleranceBps: this.config.get<number>('reflectorToleranceBps')!,
    });

    const watched = {
      contractId,
      strikePriceCents: strikePriceCents.toString(),
      expiry,
      gracePeriodSecs,
      feedId: entry.feedId,
    };
    try {
      this.markets.watch(watched);
    } catch (err) {
      this.orphans.set(entry.feedId, watched);
      this.logger.error(
        `deployed market ${contractId} for feed ${entry.feedId} but watch() failed; will retry next sweep: ${(err as Error).message}`,
      );
      throw err;
    }

    // Best-effort admin-dashboard logging, once the market that withdrawal
    // actually funded is known — see AdminActivityRepository's doc comment:
    // a read-side cache, a dropped row here is not worth failing a
    // successful factory run over.
    try {
      this.activity.recordVaultFlow({
        vaultContractId: vaultContract,
        amountStroops: initialLiquidityStroops.toString(),
        marketContractId: contractId,
        txHash: withdrawTxHash,
      });
    } catch (err) {
      this.logger.warn(`failed to record admin-activity vault_flow for ${contractId}: ${(err as Error).message}`);
    }

    this.logger.log(`factory created market ${contractId} for ${entry.symbol} (strike ${strikePriceCents}c)`);
    return { contractId, strikePriceCents };
  }

  /**
   * A real bug found live: Pyth's public `hermes.pyth.network` started
   * rejecting every price request with a bare 401 (confirmed global, not
   * feed- or endpoint-specific, and not specific to this deployment's
   * network egress — see `StellarService.getReflectorPriceCents`'s doc
   * comment). Since Hermes is only ever used here to *pick* a fresh
   * market's strike price (an estimate, not something settlement
   * correctness depends on — settlement verifies a signed Lazer payload
   * against the contract's own on-chain Reflector check, never Hermes),
   * this now tries Hermes first and falls back to reading Reflector's
   * price directly on-chain if it fails, instead of letting the whole
   * factory run for that feed fail. Reflector needs no API key and is
   * already a trusted dependency for settlement corroboration, so it adds
   * no new trust assumption. Every previous failure mode of Hermes itself
   * (timeout, malformed response, missing catalog entry) still falls
   * through to this same path unchanged.
   */
  /** Logs a warning when the oracle or deployer hot-wallet XLM balance is below the configured threshold. Called once per factory interval. Requires `nativeXlmSac` to be configured; silently skips otherwise. */
  private async checkHotWalletBalances(): Promise<void> {
    const nativeXlmSac = this.config.get<string>('nativeXlmSac');
    if (!nativeXlmSac) return;
    const minStroops = BigInt(this.config.get<string>('oracleMinBalanceStroops') ?? '50000000');
    const wallets: { label: string; address: string }[] = [
      { label: 'oracle', address: this.stellar.oraclePublicKey },
      { label: 'deployer', address: this.stellar.deployerPublicKey },
    ];
    await Promise.allSettled(
      wallets.map(async ({ label, address }) => {
        try {
          const balance = await this.stellar.tokenBalance(nativeXlmSac, address);
          if (balance < minStroops) {
            this.logger.warn(
              `${label} hot-wallet XLM balance low: ${balance} stroops (threshold: ${minStroops}) — trades, settlement, and wallet deploys may fail`,
            );
          }
        } catch (err) {
          this.logger.warn(`failed to read ${label} hot-wallet XLM balance: ${(err as Error).message}`);
        }
      }),
    );
  }

  private async fetchStrikePriceCents(entry: FeedCatalogEntry, reflectorContract: string): Promise<bigint> {
    const hermesUrl = this.config.get<string>('pythHermesUrl')!;
    try {
      return await fetchHermesPriceCents(hermesUrl, entry.hermesFeedId);
    } catch (err) {
      this.logger.warn(
        `Hermes price lookup failed for ${entry.symbol}, falling back to Reflector: ${(err as Error).message}`,
      );
      return this.stellar.getReflectorPriceCents(reflectorContract, this.config.get<string>('reflectorAsset')!);
    }
  }
}
