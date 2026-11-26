/**
 * Serializes async critical sections that touch a shared Stellar source
 * account's sequence number. `StellarService` and `AuthRelayService` both
 * sign and submit transactions from the same `ORACLE_SECRET_KEY` account —
 * without this, two concurrent callers (e.g. an admin-triggered settle
 * racing a scheduled retry, or a sponsored-auth submit racing a settle) can
 * each fetch the account's current sequence number before either submits,
 * then both build a transaction with the same sequence number. One submit
 * then fails with `tx_bad_seq` (or worse, silently clobbers the other).
 *
 * A simple promise-chain mutex: every `run()` call is queued behind whatever
 * is currently running, so the fetch-sequence -> build -> sign -> submit
 * sequence for one caller always completes (success or failure) before the
 * next caller's fetch-sequence step begins.
 */
export class AsyncLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Swallow rejections in the chain itself so one failed call doesn't
    // permanently wedge the queue for everyone after it.
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** One lock per source-account secret key, shared across services that sign with the same account. */
const locksBySecret = new Map<string, AsyncLock>();

export function getAccountLock(secretKey: string): AsyncLock {
  let lock = locksBySecret.get(secretKey);
  if (!lock) {
    lock = new AsyncLock();
    locksBySecret.set(secretKey, lock);
  }
  return lock;
}
