import { RpcFailure } from './errors.js';
export class RequestMeter {
  private calls = 0;
  private retries = 0;
  private bytes = 0;
  private readonly methods: Record<string, number> = {};
  readonly startedAtMs = Date.now();
  private readonly buckets = new Uint32Array(1000);
  private lastMs = this.startedAtMs;
  private windowCalls = 0;
  private peak = 0;
  constructor(readonly maxCalls: number | null = 150) {
    if (maxCalls !== null && (!Number.isSafeInteger(maxCalls) || maxCalls < 0))
      throw new RangeError('Invalid RPC budget');
  }
  get remainingCalls(): number | null {
    return this.maxCalls === null ? null : this.maxCalls - this.calls;
  }
  assertAvailable(): void {
    if (this.remainingCalls === 0) throw new RpcFailure('budget');
  }
  begin(method: string, retry: boolean): void {
    this.assertAvailable();
    const now = Date.now();
    const elapsed = now - this.lastMs;
    if (elapsed >= 1000 || elapsed < 0) {
      this.buckets.fill(0);
      this.windowCalls = 0;
    } else
      for (let t = this.lastMs + 1; t <= now; t++) {
        const slot = t % 1000;
        this.windowCalls -= this.buckets[slot]!;
        this.buckets[slot] = 0;
      }
    this.lastMs = now;
    this.buckets[now % 1000]!++;
    this.windowCalls++;
    this.peak = Math.max(this.peak, this.windowCalls);
    this.calls++;
    this.retries += retry ? 1 : 0;
    this.methods[method] = (this.methods[method] ?? 0) + 1;
  }
  addBytes(bytes: number): void {
    this.bytes += bytes;
  }
  summary() {
    const elapsedMs = Math.max(0, Date.now() - this.startedAtMs);
    return {
      calls: this.calls,
      retries: this.retries,
      responseBytes: this.bytes,
      methods: { ...this.methods },
      elapsedMs,
      maxCalls: this.maxCalls,
      peakOneSecond: this.peak,
      averageRpcPerSecond: elapsedMs > 0 ? (this.calls * 1000) / elapsedMs : null,
      billingUnits: null,
    };
  }
}
