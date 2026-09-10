import { expect, it } from 'vitest';
import { initialSignalConfig, parseSignalConfig } from '../../src/signals/config.js';
import { evaluateSignal, initialSignalSnapshot } from '../../src/signals/engine.js';
import type { SignalInput } from '../../src/signals/types.js';
import type { AggregateMetric } from '../../src/metrics/windows.js';

const pool = { chainId: 4663, protocol: 'v3', address: `0x${'1'.repeat(40)}` } as const;
function input(starts: number[]): SignalInput {
  const five: AggregateMetric[] = starts.map((startSec) => ({
    startSec,
    endSec: startSec + 300,
    status: 'closed',
    usdMicros: 50_000_000_000n,
    usdgNotionalRaw: null,
    rawNotional: null,
    swapCount: 1,
    txCount: 1,
    addCount: 0,
    removeCount: 0,
    zeroDeltaCount: 0,
    activeMinutes: 1,
    baselineSampleCount: 0,
    baselineMedian: null,
    baselineMedianNumerator: null,
    baselineMedianDenominator: null,
    baselineUnit: null,
    volumeMultiplier: null,
  }));
  return {
    pool,
    batchId: 'b',
    observedAtMs: 600000,
    watermarkSec: 600,
    coverage: 'complete',
    endAnchor: { number: 600n, hash: `0x${'2'.repeat(64)}`, timestampSec: 600 },
    metrics: {
      pool,
      poolId: 'p',
      minutes: [],
      natural5mBuckets: five,
      partialCurrent: null,
      recentClosed1m: null,
      recentClosed5x1m: null,
      naturalClosed5m: five.at(-1) ?? null,
      unknownTimeBlockCounts: [],
    },
  };
}
function config(buckets?: number) {
  return parseSignalConfig({
    ...initialSignalConfig,
    confirmRelative: { ...initialSignalConfig.confirmRelative, enabled: false },
    confirmConsecutive: {
      ...initialSignalConfig.confirmConsecutive,
      ...(buckets === undefined ? {} : { buckets }),
    },
  });
}
it('P5 can confirm one completed natural 5m bar with the shared signal core', () => {
  const d = evaluateSignal(initialSignalSnapshot(), input([300]), config(1));
  expect(d.alertDraft?.kind).toBe('hot');
});
it('default and two-bar confirmation preserve the existing adjacent-bar requirement', () => {
  expect(evaluateSignal(initialSignalSnapshot(), input([300]), config()).alertDraft).toBeNull();
  expect(evaluateSignal(initialSignalSnapshot(), input([300]), config(2)).alertDraft).toBeNull();
  expect(evaluateSignal(initialSignalSnapshot(), input([0, 300]), config(2)).alertDraft?.kind).toBe(
    'hot',
  );
  expect(
    evaluateSignal(initialSignalSnapshot(), input([-300, 300]), config(2)).alertDraft,
  ).toBeNull();
});
it('rejects unsupported confirmation counts', () => {
  for (const n of [0, 3, 1.5]) expect(() => config(n)).toThrow();
});
it('one-bar failure reason describes the configured one-bar rule', () => {
  const x = input([300]);
  x.metrics = {
    ...x.metrics,
    natural5mBuckets: x.metrics.natural5mBuckets.map((b) => ({ ...b, usdMicros: 1n })),
  };
  const d = evaluateSignal(initialSignalSnapshot(), x, config(1));
  expect(d.matches.find((m) => m.ruleId === 'confirmConsecutive')!.reason).toBe(
    'no-complete-above-threshold',
  );
});
