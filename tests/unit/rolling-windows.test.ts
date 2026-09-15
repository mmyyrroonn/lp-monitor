import { expect, test } from 'vitest';
import {
  buildRollingMetrics,
  prepareRollingCoverage,
  rollingCoverage,
} from '../../src/metrics/rolling.js';
import type { MetricEvent, MinuteCoverage } from '../../src/metrics/windows.js';
import type { PoolRef } from '../../src/domain/types.js';
const pool: PoolRef = { chainId: 4663, protocol: 'v3', address: `0x${'1'.repeat(40)}` };
const end = { number: 10000n, hash: `0x${'f'.repeat(64)}` as const, timestampSec: 7240 };
const coverage: MinuteCoverage[] = Array.from({ length: 122 }, (_, i) => ({
  scopeId: 's',
  minuteStartSec: i * 60,
  fromBlock: BigInt(i),
  toBlock: BigInt(i + 1),
  complete: i < 120,
  reasons: i < 120 ? [] : ['watermark-partial'],
}));
function event(t: number, id: number, exact = true): MetricEvent {
  return {
    usdMicros: 10n,
    usdgNotionalRaw: 10n,
    event: {
      kind: 'swap',
      pool,
      time: {
        minuteStartSec: Math.floor(t / 60) * 60,
        exactTimestampSec: exact ? t : null,
        source: exact ? 'log-verified' : 'minute-boundary',
      },
      ref: {
        blockNumber: BigInt(id),
        blockHash: end.hash,
        transactionHash: `0x${id.toString(16).padStart(64, '0')}`,
        transactionIndex: 0,
        logIndex: id,
      },
      rawAmount0: 1n,
      rawAmount1: -1n,
      tokenIn: `0x${'2'.repeat(40)}`,
      tokenOut: `0x${'3'.repeat(40)}`,
      amountIn: 1n,
      amountOut: 1n,
      sqrtPriceX96After: 1n,
      liquidityAfter: 1n,
      tickAfter: 0,
      effectiveSwapFeePips: null,
    },
  };
}
const build = (events: MetricEvent[], c = coverage) =>
  buildRollingMetrics(events, c, end, {
    pools: [{ pool, discoveredAtBlock: null, rawToken: null }],
  })[0]!;
test('four windows end at the watermark, expire the left edge and include the latest second', () => {
  const w = build([
    event(7180, 1),
    event(7181, 2),
    event(7240, 3),
    event(6941, 4),
    event(6341, 5),
    event(3641, 6),
    event(7241, 7),
  ]);
  expect(Object.keys(w.rolling!)).toEqual(['1m', '5m', '15m', '1h']);
  expect(w.rolling!['1m']).toMatchObject({
    startSec: 7180,
    endSec: 7240,
    swapCount: 2,
    usdMicros: 20n,
  });
  expect(w.rolling!['5m'].swapCount).toBe(4);
  expect(w.rolling!['15m'].swapCount).toBe(5);
  expect(w.rolling!['1h'].swapCount).toBe(6);
  expect(w.natural5mBuckets).toEqual([]);
});
test('missing edge timestamps and missing coverage remain unavailable, not zero', () => {
  expect(build([event(7181, 1, false)]).rolling!['1m']).toMatchObject({
    status: 'gap',
    swapCount: null,
    usdMicros: null,
  });
  expect(
    build(
      [],
      coverage.filter((c) => c.minuteStartSec !== 6900),
    ).rolling!['15m'].status,
  ).toBe('gap');
  expect(build([]).rolling!['1m']).toMatchObject({ status: 'closed', swapCount: 0, usdMicros: 0n });
});
test('an unpriced swap preserves counts but invalidates total valuation', () => {
  expect(build([{ ...event(7220, 1), usdMicros: null }]).rolling!['1m']).toMatchObject({
    swapCount: 1,
    usdMicros: null,
  });
});

import { evaluateSignal, initialSignalSnapshot } from '../../src/signals/engine.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { formatAlert } from '../../src/notify/format.js';
import { rankPools } from '../../src/metrics/ranking.js';
test('non-aligned rolling confirmation deduplicates polls and renders only four windows', () => {
  const config = {
    ...initialSignalConfig,
    candidate: { ...initialSignalConfig.candidate, enabled: false },
    confirmRelative: { ...initialSignalConfig.confirmRelative, enabled: false },
    confirmConsecutive: {
      ...initialSignalConfig.confirmConsecutive,
      threshold: '1',
      buckets: 1 as const,
    },
  };
  const es = [event(7220, 1)];
  const input = {
    pool,
    batchId: 'a',
    observedAtMs: 7240000,
    endAnchor: end,
    watermarkSec: end.timestampSec,
    metrics: build(es),
    coverage: 'complete' as const,
  };
  const first = evaluateSignal(initialSignalSnapshot(), input, config);
  expect(first.alertDraft?.kind).toBe('hot');
  const later = { ...end, timestampSec: 7242 };
  const second = evaluateSignal(
    first.nextSnapshot,
    {
      ...input,
      batchId: 'b',
      watermarkSec: 7242,
      endAnchor: later,
      metrics: buildRollingMetrics(es, coverage, later, {
        pools: [{ pool, discoveredAtBlock: null, rawToken: null }],
      })[0]!,
    },
    config,
  );
  expect(second.alertDrafts).toEqual([]);
  expect(second.nextSnapshot.lowBuckets).toBe(0);
  const message = formatAlert(first.alertDraft!);
  for (const name of ['1m', '5m', '15m', '1h']) expect(message).toContain('过去' + name);
  expect(message).not.toMatch(/自然|本分钟/);
  expect(message).toContain('关联代币');
  expect(rankPools([input.metrics], 'volume5m')).toHaveLength(1);
});
test('multiple swaps in one transaction count once and minutes never exceed the window length', () => {
  const e = event(7220, 1);
  const w = build([e, { ...e, event: { ...e.event, ref: { ...e.event.ref, logIndex: 99 } } }]);
  expect(w.rolling!['1m']).toMatchObject({ swapCount: 2, txCount: 1, activeMinutes: 1 });
});
test('the shared minute index answers exactly like the public per-call coverage query', () => {
  // Public callers (dashboard snapshot, metric store) keep the old entry point; it must agree with
  // the index a build prepares once.
  for (const [start, end] of [
    [7180, 7240],
    [6940, 7240],
    [3640, 7240],
    [100, 200],
  ] as const) {
    const expected = rollingCoverage(coverage, start, end, end);
    expect(prepareRollingCoverage(coverage).reasons(start, end, end, null)).toEqual(expected);
  }
  // The window ending on the watermark tolerates the trailing partial minute.
  expect(rollingCoverage(coverage, 7180, 7240, 7240)).toEqual([]);
  expect(prepareRollingCoverage(coverage).reasons(7180, 7240, 7240, null)).toEqual([]);
  // A birth inside the covered minutes still shortens the window through both entry points.
  expect(rollingCoverage(coverage, 6940, 7240, 7240, 118n)).toEqual(['pool-lifetime-incomplete']);
  expect(prepareRollingCoverage(coverage).reasons(6940, 7240, 7240, 118n)).toEqual([
    'pool-lifetime-incomplete',
  ]);
  // A birth at or before the first covered minute changes nothing.
  expect(rollingCoverage(coverage, 6940, 7240, 7240, 0n)).toEqual([]);
  // A hole in the coverage is still reported.
  expect(
    rollingCoverage(
      coverage.filter((c) => c.minuteStartSec !== 6900),
      6940,
      7240,
      7240,
    ),
  ).toEqual(['coverage-missing']);
});
