import { AsyncLocalStorage } from 'node:async_hooks';
import { RpcFailure } from './errors.js';
export type RpcPurpose =
  'logs' | 'endpoint-anchor' | 'minute-boundary' | 'metadata' | 'backfill' | 'warmup-anchor';
type C = { purpose: RpcPurpose; method?: string };
type M = { calls: number; retries: number; responseBytes: number; rpcMs: number };
const fresh = (): M => ({ calls: 0, retries: 0, responseBytes: 0, rpcMs: 0 });
const fallback = (m: string): RpcPurpose =>
  m === 'eth_getLogs' ? 'logs' : m === 'eth_getBlockByNumber' ? 'endpoint-anchor' : 'metadata';
export class RequestMeter {
  private calls = 0;
  private retries = 0;
  private bytes = 0;
  private methods: Record<string, number> = {};
  private methodMetrics: Record<string, M> = {};
  private purposes: Partial<Record<RpcPurpose, M>> = {};
  private pc = new AsyncLocalStorage<C>();
  private ac = new AsyncLocalStorage<C>();
  private historical = new AsyncLocalStorage<boolean>();
  private elementsTotal = 0;
  private elementsByPurpose: Partial<Record<RpcPurpose, number>> = {};
  private queueWaitMs = 0;
  private rpcMs = 0;
  private processingMs = 0;
  private queueDepth = 0;
  private peakQueueDepth = 0;
  private activeRpc = 0;
  private peakConcurrentRpc = 0;
  readonly startedAtMs = Date.now();
  private buckets = new Uint32Array(1000);
  private lastMs = this.startedAtMs;
  private windowCalls = 0;
  private peak = 0;
  private backfillBuckets = new Uint32Array(1000);
  private backfillLastMs = this.startedAtMs;
  private backfillWindowCalls = 0;
  private backfillPeak = 0;
  constructor(readonly maxCalls: number | null = 150) {
    if (maxCalls !== null && (!Number.isSafeInteger(maxCalls) || maxCalls < 0))
      throw new RangeError('Invalid RPC budget');
  }
  get currentPurpose() {
    return this.pc.getStore()?.purpose;
  }
  withPurpose<T>(purpose: RpcPurpose, work: () => T): T {
    return purpose === 'backfill'
      ? this.withBackfill(() => this.pc.run({ purpose }, work))
      : this.pc.run({ purpose }, work);
  }
  get isBackfill() {
    return this.historical.getStore() === true;
  }
  withBackfill<T>(work: () => T): T {
    return this.historical.run(true, work);
  }
  trackAttempt<T>(method: string, _retry: boolean, work: () => Promise<T>): Promise<T> {
    const purpose = this.currentPurpose ?? fallback(method);
    return this.ac.run({ purpose, method }, async () => {
      const at = Date.now();
      try {
        return await work();
      } finally {
        const ms = Math.max(0, Date.now() - at);
        this.rpcMs += ms;
        (this.methodMetrics[method] ??= fresh()).rpcMs += ms;
        (this.purposes[purpose] ??= fresh()).rpcMs += ms;
      }
    });
  }
  get remainingCalls() {
    return this.maxCalls === null ? null : this.maxCalls - this.calls;
  }
  assertAvailable() {
    if (this.remainingCalls === 0) throw new RpcFailure('budget');
  }
  begin(method: string, retry: boolean) {
    this.assertAvailable();
    const now = Date.now(),
      elapsed = now - this.lastMs;
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
    const mm = (this.methodMetrics[method] ??= fresh());
    mm.calls++;
    mm.retries += retry ? 1 : 0;
    const purpose = this.ac.getStore()?.purpose ?? this.currentPurpose ?? fallback(method),
      pm = (this.purposes[purpose] ??= fresh());
    pm.calls++;
    pm.retries += retry ? 1 : 0;
    this.elementsTotal++;
    this.elementsByPurpose[purpose] = (this.elementsByPurpose[purpose] ?? 0) + 1;
    if (this.isBackfill || purpose === 'backfill') {
      const backfillElapsed = now - this.backfillLastMs;
      if (backfillElapsed >= 1000 || backfillElapsed < 0) {
        this.backfillBuckets.fill(0);
        this.backfillWindowCalls = 0;
      } else
        for (let t = this.backfillLastMs + 1; t <= now; t++) {
          const slot = t % 1000;
          this.backfillWindowCalls -= this.backfillBuckets[slot]!;
          this.backfillBuckets[slot] = 0;
        }
      this.backfillLastMs = now;
      this.backfillBuckets[now % 1000]!++;
      this.backfillWindowCalls++;
      this.backfillPeak = Math.max(this.backfillPeak, this.backfillWindowCalls);
    }
  }

  addBytes(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid RPC byte count');
    this.bytes += bytes;
    const c = this.ac.getStore();
    if (c?.method) {
      (this.methodMetrics[c.method] ??= fresh()).responseBytes += bytes;
      (this.purposes[c.purpose] ??= fresh()).responseBytes += bytes;
    }
  }
  addElements(count: number) {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new RangeError('Invalid RPC element count');
    const purpose = this.ac.getStore()?.purpose ?? this.currentPurpose;
    if (!purpose) throw new Error('RPC elements require a purpose context');
    this.elementsTotal += count;
    this.elementsByPurpose[purpose] = (this.elementsByPurpose[purpose] ?? 0) + count;
  }
  recordQueueWait(ms: number, depth: number) {
    this.queueWaitMs += Math.max(0, ms);
    this.queueDepth = Math.max(0, depth);
    this.peakQueueDepth = Math.max(this.peakQueueDepth, this.queueDepth);
  }
  recordConcurrency(active: number) {
    this.activeRpc = Math.max(0, active);
    this.peakConcurrentRpc = Math.max(this.peakConcurrentRpc, this.activeRpc);
  }
  recordProcessing(ms: number) {
    this.processingMs += Math.max(0, ms);
  }
  summary() {
    const elapsedMs = Math.max(0, Date.now() - this.startedAtMs);
    return {
      calls: this.calls,
      retries: this.retries,
      responseBytes: this.bytes,
      methods: { ...this.methods },
      methodMetrics: structuredClone(this.methodMetrics),
      purposes: structuredClone(this.purposes),
      elements: { total: this.elementsTotal, byPurpose: { ...this.elementsByPurpose } },
      queueDepth: this.queueDepth,
      peakQueueDepth: this.peakQueueDepth,
      activeRpc: this.activeRpc,
      peakConcurrentRpc: this.peakConcurrentRpc,
      timings: {
        queueWaitMs: this.queueWaitMs,
        rpcMs: this.rpcMs,
        processingMs: this.processingMs,
      },
      elapsedMs,
      maxCalls: this.maxCalls,
      peakOneSecond: this.peak,
      backfillPeakOneSecond: this.backfillPeak,
      averageRpcPerSecond: elapsedMs > 0 ? (this.calls * 1000) / elapsedMs : null,
      billingUnits: null,
    };
  }
}
