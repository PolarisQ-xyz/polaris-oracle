/**
 * In-memory sliding-window limiter shared by the faucet and the wallet-deploy
 * limiter. `maxPerWindow` is a thunk so config is read at call time. Keys whose
 * window has fully expired are evicted so the map can't grow without bound.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxPerWindow: () => number,
    private readonly windowMs: number,
  ) {}

  /** Returns true (and records the hit) if `key` is under the limit. */
  tryConsume(key: string): boolean {
    const max = this.maxPerWindow();
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (!(recent.length < max)) {
      if (recent.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, recent);
      }
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
