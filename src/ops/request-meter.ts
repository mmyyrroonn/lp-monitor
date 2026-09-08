import { RpcFailure } from '../rpc/errors.js';
export class RequestMeter {
  private calls = 0; private retries = 0; private bytes = 0;
  private readonly methods: Record<string, number> = {};
  readonly startedAtMs = Date.now();
  readonly callTimes: number[] = [];
  constructor(readonly maxCalls = 150) {}
  begin(method: string, retry: boolean): void {
    if (this.calls >= this.maxCalls) throw new RpcFailure('budget');
    this.calls++; this.retries += retry ? 1 : 0;
    this.methods[method] = (this.methods[method] ?? 0) + 1; this.callTimes.push(Date.now());
  }
  addBytes(bytes: number): void { this.bytes += bytes; }
  summary() {
    const elapsedMs = Date.now() - this.startedAtMs;
    const peakOneSecond = this.callTimes.reduce((peak, time, i) => Math.max(peak, this.callTimes.slice(i).filter(t => t < time + 1000).length), 0);
    return { calls: this.calls, retries: this.retries, responseBytes: this.bytes, methods: { ...this.methods }, elapsedMs, maxCalls: this.maxCalls, peakOneSecond, averageRpcPerSecond: this.calls / Math.max(1, elapsedMs / 1000), billingUnits: null };
  }
}
