import { setTimeout as delay } from 'node:timers/promises';
export class RateLimiter {
  private nextMs = 0;
  private tail: Promise<void> = Promise.resolve();
  private penaltyMs = 0;
  constructor(private readonly perSecond = 5) {
    if (!(perSecond > 0 && perSecond <= 5)) throw new RangeError('RPC rate must be in (0,5]');
  }
  penalize(): void {
    this.penaltyMs = Math.max(1000, this.penaltyMs);
    this.nextMs = Math.max(this.nextMs, Date.now() + this.penaltyMs);
  }
  acquire(): Promise<void> {
    const result = this.tail.then(async () => {
      await delay(Math.max(0, this.nextMs - Date.now()));
      this.nextMs = Date.now() + Math.max(this.penaltyMs, Math.ceil(1000 / this.perSecond));
    });
    this.tail = result.catch(() => {}); return result;
  }
}
