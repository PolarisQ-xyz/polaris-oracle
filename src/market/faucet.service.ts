import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SlidingWindowLimiter } from './sliding-window-limiter';

const HOUR_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * In-memory sliding window, keyed by address (not IP — a faucet abuser can
 * trivially rotate IPs but funding a fresh keypair costs them nothing
 * either way; capping by the address actually receiving funds is the
 * meaningful limit). Resets on process restart, which is fine for a
 * testnet convenience faucet.
 *
 * Keys are deleted once their window empties, and a periodic sweep clears
 * any key whose last hit has aged out even if it's never touched again —
 * otherwise an attacker submitting one distinct address per request could
 * grow this map unbounded (see #113).
 */
@Injectable()
export class FaucetService implements OnModuleDestroy {
  private readonly hits = new Map<string, number[]>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, hits] of this.hits) {
      const recent = hits.filter((t) => now - t < HOUR_MS);
      if (recent.length === 0) {
        this.hits.delete(key);
      } else if (recent.length !== hits.length) {
        this.hits.set(key, recent);
      }
    }
  }

  /** Returns true (and records the hit) if `address` is under the limit. */
  tryConsume(address: string): boolean {
    return this.limiter.tryConsume(address);
  }

  /**
   * Funds `address` via Stellar Friendbot. Must be called only after `tryConsume`
   * succeeds; callers that skip the rate-limit check risk hammering Friendbot on
   * every request. Returns `{ funded: true }` on success, `{ alreadyExists: true }`
   * when the account already exists on testnet (Friendbot only creates new accounts),
   * and throws on any other non-2xx response.
   *
   * Rate-limit design is tracked in issue #12.
   */
  async fund(address: string): Promise<{ funded: boolean; alreadyExists: boolean }> {
    const friendbotUrl = this.config.get<string>('friendbotUrl')!;
    const res = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(address)}`);
    if (res.ok) {
      return { funded: true, alreadyExists: false };
    }
    const body = await res.text().catch(() => '');
    if (res.status === 400 && body.includes('createAccountAlreadyExist')) {
      // Account already exists on testnet — Friendbot only creates new
      // accounts, it won't top up an existing one. Not an error from the
      // caller's point of view.
      return { funded: false, alreadyExists: true };
    }
    throw new Error(`friendbot funding failed: ${res.status} ${body}`);
  }
}
