import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SlidingWindowLimiter } from './sliding-window-limiter';

const HOUR_MS = 60 * 60 * 1000;

/**
 * In-memory sliding window, keyed by address (not IP — a faucet abuser can
 * trivially rotate IPs but funding a fresh keypair costs them nothing
 * either way; capping by the address actually receiving funds is the
 * meaningful limit). Resets on process restart, which is fine for a
 * testnet convenience faucet.
 */
@Injectable()
export class FaucetService {
  private readonly limiter = new SlidingWindowLimiter(
    () => this.config.get<number>('faucetMaxPerHour')!,
    HOUR_MS,
  );

  constructor(private readonly config: ConfigService) {}

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
