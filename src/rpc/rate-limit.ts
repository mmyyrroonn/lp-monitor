/** Read-only view of the curve a limiter is currently pacing on. */
export interface RateLimiterState {
  /** Spacing between committed slots, never below the configured ceiling. */
  effectiveIntervalMs: number;
  /** Instant the last penalty holds the next slot back to. */
  cooldownUntilMs: number;
  /** Successes accumulated towards the next step of the recovery curve. */
  consecutiveSuccesses: number;
}

/** Widest spacing the curve may reach, whatever the configured rate. */
const MAX_INTERVAL_MS = 2000;
/** Longest single penalty delay, and the floor of the doubling. */
const MAX_COOLDOWN_MS = 30000;
const MIN_COOLDOWN_MS = 1000;
/** Quiet stretch after a penalty that lets the curve fall back to the configured rate. */
const IDLE_RESET_MS = 60000;
/** Successes between two recovery steps. */
const RECOVERY_STEPS = 3;

/**
 * Client-side pacing for one provider.
 *
 * A rate limit is an instruction to slow down for a while, not forever: `penalize()` doubles a
 * bounded cooldown delay and doubles the slot spacing up to `MAX_INTERVAL_MS`, and every
 * `RECOVERY_STEPS` successes halve both back towards the configured rate. The spacing is always
 * floored at the configured interval, so a slow `perSecond` is never accelerated by the cap.
 */
export class RateLimiter {
  private nextMs = 0;
  private tail: Promise<void> = Promise.resolve();
  private cooldownDelayMs = 0;
  private cooldownUntilMs = 0;
  private effectiveIntervalMs: number;
  private successes = 0;
  /** -Infinity means "never penalized", so a fresh limiter is always at its configured rate. */
  private lastPenaltyAtMs = -Infinity;
  private active = 0;
  private waiters: Array<() => void> = [];
  private readonly baseIntervalMs: number;
  constructor(
    private readonly perSecond = 5,
    private readonly maxConcurrent = 2,
  ) {
    if (!Number.isFinite(perSecond) || perSecond <= 0)
      throw new RangeError('RPC rate must be positive');
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)
      throw new RangeError('RPC concurrency must be positive');
    this.baseIntervalMs = Math.ceil(1000 / perSecond);
    this.effectiveIntervalMs = this.baseIntervalMs;
  }
  state(): RateLimiterState {
    return {
      effectiveIntervalMs: this.effectiveIntervalMs,
      cooldownUntilMs: this.cooldownUntilMs,
      consecutiveSuccesses: this.successes,
    };
  }
  penalize(): void {
    const now = Date.now();
    this.relaxIfIdle(now);
    this.successes = 0;
    this.cooldownDelayMs = Math.min(
      MAX_COOLDOWN_MS,
      Math.max(MIN_COOLDOWN_MS, this.cooldownDelayMs * 2),
    );
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, now + this.cooldownDelayMs);
    this.effectiveIntervalMs = Math.max(
      this.baseIntervalMs,
      Math.min(MAX_INTERVAL_MS, this.effectiveIntervalMs * 2),
    );
    this.lastPenaltyAtMs = now;
  }
  /** Hold the next slot until `ms` from now. Never brings an existing wait forward. */
  defer(ms: number): void {
    this.nextMs = Math.max(this.nextMs, Date.now() + ms);
  }
  succeed(): void {
    if (++this.successes < RECOVERY_STEPS) return;
    this.successes = 0;
    this.effectiveIntervalMs = Math.max(
      this.baseIntervalMs,
      Math.floor(this.effectiveIntervalMs / 2),
    );
    this.cooldownDelayMs = Math.floor(this.cooldownDelayMs / 2);
  }
  acquire(
    beforeWait?: () => void,
    onAcquired?: () => void,
    additional?: RateLimiter,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = this.tail.then(async () => {
      signal?.throwIfAborted();
      this.relaxIfIdle(Date.now());
      additional?.relaxIfIdle(Date.now());
      beforeWait?.();
      // Re-read the bounds after every sleep: a penalty landing during the wait has to be obeyed,
      // and an unrelated limiter still has to be satisfied at the same time.
      for (;;) {
        const until = Math.max(
          this.nextMs,
          this.cooldownUntilMs,
          additional?.nextMs ?? 0,
          additional?.cooldownUntilMs ?? 0,
        );
        const remaining = until - Date.now();
        if (remaining <= 0) break;
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
          };
          const cancel = () => {
            cleanup();
            reject(signal?.reason);
          };
          const timer = setTimeout(() => {
            cleanup();
            resolve();
          }, remaining);
          signal?.addEventListener('abort', cancel, { once: true });
          if (signal?.aborted) cancel();
        });
        signal?.throwIfAborted();
      }
      // Commit the call only at the actual slot, before the next queued acquisition.
      onAcquired?.();
      const slot = Date.now();
      this.nextMs = slot + this.effectiveIntervalMs;
      if (additional) additional.nextMs = slot + additional.effectiveIntervalMs;
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async enter(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active >= this.maxConcurrent)
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal?.removeEventListener('abort', cancel);
          resolve();
        };
        const cancel = () => {
          const index = this.waiters.indexOf(ready);
          if (index !== -1) this.waiters.splice(index, 1);
          signal?.removeEventListener('abort', cancel);
          reject(signal?.reason);
        };
        this.waiters.push(ready);
        signal?.addEventListener('abort', cancel, { once: true });
      });
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
  /**
   * After a long quiet stretch the penalty has served its purpose, so drop back to the configured
   * rate. Only the recovery curve is reset: `nextMs` may hold an explicit `defer()` that has not
   * come due yet, and pulling it forward would ignore a caller that asked for the wait.
   */
  private relaxIfIdle(now: number): void {
    if (now - this.lastPenaltyAtMs < IDLE_RESET_MS) return;
    this.effectiveIntervalMs = this.baseIntervalMs;
    this.cooldownDelayMs = 0;
  }
}
