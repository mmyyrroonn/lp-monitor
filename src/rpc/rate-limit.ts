export class RateLimiter {
  private nextMs = 0;
  private tail: Promise<void> = Promise.resolve();
  private penaltyMs = 0;
  private successes = 0;
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(
    private readonly perSecond = 5,
    private readonly maxConcurrent = 2,
  ) {
    if (!Number.isFinite(perSecond) || perSecond <= 0)
      throw new RangeError('RPC rate must be positive');
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)
      throw new RangeError('RPC concurrency must be positive');
  }
  penalize(): void {
    this.successes = 0;
    this.penaltyMs = Math.min(30000, Math.max(1000, this.penaltyMs * 2));
    this.defer(this.penaltyMs);
  }
  defer(ms: number): void {
    this.nextMs = Math.max(this.nextMs, Date.now() + ms);
  }
  succeed(): void {
    if (++this.successes >= 3) {
      this.penaltyMs = Math.max(0, this.penaltyMs - 250);
      this.successes = 0;
    }
  }
  acquire(beforeWait?: () => void, onAcquired?: () => void): Promise<void> {
    const result = this.tail.then(async () => {
      beforeWait?.();
      while (this.nextMs > Date.now())
        await new Promise((resolve) => setTimeout(resolve, this.nextMs - Date.now()));
      // Commit the call only at the actual slot, before the next queued acquisition.
      onAcquired?.();
      this.nextMs = Date.now() + Math.max(this.penaltyMs, Math.ceil(1000 / this.perSecond));
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async enter(): Promise<() => void> {
    if (this.active >= this.maxConcurrent)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
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
}
