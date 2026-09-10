import { expect, test, vi } from 'vitest';
import { RequestMeter } from '../../src/rpc/request-meter.js';

test('isolates nested RPC purposes across concurrent async work', async () => {
  const meter = new RequestMeter(null);
  const seen: Array<string | undefined> = [];
  await Promise.all([
    meter.withPurpose('logs', async () => {
      await Promise.resolve();
      seen.push(meter.currentPurpose);
      meter.begin('eth_getLogs', false);
    }),
    meter.withPurpose('minute-boundary', async () => {
      seen.push(meter.currentPurpose);
      meter.begin('eth_getBlockByNumber', false);
    }),
  ]);
  expect(seen.sort()).toEqual(['logs', 'minute-boundary']);
  expect(meter.currentPurpose).toBeUndefined();
  expect(meter.summary().elements).toEqual({
    total: 2,
    byPurpose: { logs: 1, 'minute-boundary': 1 },
  });
});

test('defaults method purposes and attributes retries bytes and RPC duration per method', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const meter = new RequestMeter(null);
  await meter.trackAttempt('eth_getLogs', true, async () => {
    meter.begin('eth_getLogs', true);
    meter.addBytes(12);
    vi.setSystemTime(1025);
  });
  expect(meter.summary()).toMatchObject({
    calls: 1,
    retries: 1,
    responseBytes: 12,
    methods: { eth_getLogs: 1 },
    methodMetrics: {
      eth_getLogs: { calls: 1, retries: 1, responseBytes: 12, rpcMs: 25 },
    },
    purposes: { logs: { calls: 1, retries: 1, responseBytes: 12, rpcMs: 25 } },
  });
  vi.useRealTimers();
});

test('records queue depth, concurrency and processing timings', () => {
  const meter = new RequestMeter(null);
  meter.recordQueueWait(17, 4);
  meter.recordQueueWait(0, 0);
  meter.recordConcurrency(2);
  meter.recordConcurrency(0);
  meter.recordProcessing(9);
  expect(meter.summary()).toMatchObject({
    queueDepth: 0,
    peakQueueDepth: 4,
    activeRpc: 0,
    peakConcurrentRpc: 2,
    timings: { queueWaitMs: 17, rpcMs: 0, processingMs: 9 },
  });
});

test('backfill peak counts only historical attempts in the rolling one-second window', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(10_000);
    const meter = new RequestMeter(null);
    meter.withBackfill(() => meter.begin('eth_getLogs', false));
    vi.setSystemTime(10_500);
    meter.withPurpose('backfill', () => meter.begin('eth_getLogs', true));
    meter.begin('eth_getLogs', false);
    vi.setSystemTime(11_501);
    meter.withBackfill(() => meter.begin('eth_getLogs', false));
    expect(meter.summary().backfillPeakOneSecond).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
