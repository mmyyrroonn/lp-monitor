import { expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import type { BlockAnchor, PoolRef } from '../../src/domain/types.js';
import { poolRegistrationId } from '../../src/registry/pools.js';
import {
  buildMinuteMetrics,
  type BuildMinuteMetricOptions,
  type MetricEvent,
  type MinuteCoverage,
} from '../../src/metrics/windows.js';

const pool = (id: number): PoolRef => ({
  chainId: 4663,
  protocol: 'v3',
  address: ('0x' + id.toString(16).padStart(40, '0')) as Address,
});
const hash = ('0x' + '1'.repeat(64)) as Hex;
const watermark = (minute = 144): BlockAnchor => ({
  number: 3000n,
  hash,
  timestampSec: minute * 60 + 30,
});
const coverage = (): MinuteCoverage[] =>
  Array.from({ length: 145 }, (_, i) => ({
    scopeId: 'a',
    minuteStartSec: i * 60,
    fromBlock: 1000n + BigInt(i * 10),
    toBlock: 1009n + BigInt(i * 10),
    complete: i !== 7,
    reasons: i === 7 ? ['missing-shard'] : [],
  }));
const event = (p: PoolRef, minute: number | null, id: number, scopeId = 'a'): MetricEvent => ({
  scopeId,
  usdMicros: BigInt(id),
  usdgNotionalRaw: BigInt(id),
  rawNotional: { token: '0xabc', raw: BigInt(id) },
  event: {
    kind: 'swap',
    pool: p,
    ref: {
      blockNumber: BigInt(2000 + id),
      blockHash: hash,
      transactionHash: hash,
      transactionIndex: 0,
      logIndex: id,
    },
    time: {
      minuteStartSec: minute,
      exactTimestampSec: null,
      source: minute === null ? 'unresolved' : 'minute-boundary',
    },
    rawAmount0: 1n,
    rawAmount1: -1n,
    tokenIn: ('0x' + 'a'.repeat(40)) as Address,
    amountIn: 1n,
    tokenOut: ('0x' + 'b'.repeat(40)) as Address,
    amountOut: 1n,
    sqrtPriceX96After: 1n,
    liquidityAfter: 1n,
    tickAfter: 0,
    effectiveSwapFeePips: null,
  },
});
function independent(
  events: readonly MetricEvent[],
  ranges: readonly MinuteCoverage[],
  head: BlockAnchor,
  options: BuildMinuteMetricOptions,
) {
  return options
    .pools!.flatMap((p) =>
      buildMinuteMetrics(
        events.filter(
          (x) =>
            x.event.pool !== null &&
            poolRegistrationId({ pool: x.event.pool }) === poolRegistrationId(p),
        ),
        ranges,
        head,
        { ...options, pools: [p] },
      ),
    )
    .sort((a, b) => a.poolId.localeCompare(b.poolId));
}

test('equivalent dormant pools share readonly window work but retain separate pool and unknown-count outputs', () => {
  const pools = [null, 999n, 1000n].map((birth, i) => ({
    pool: pool(i + 1),
    discoveredAtBlock: birth,
    rawToken: '0xabc',
  }));
  const values = buildMinuteMetrics([event(pools[1]!.pool, null, 1)], coverage(), watermark(), {
    pools,
  });
  expect(values).toEqual(
    independent([event(pools[1]!.pool, null, 1)], coverage(), watermark(), { pools }),
  );
  expect(values).toHaveLength(3);
  expect(values[0]!.minutes).toBe(values[1]!.minutes);
  expect(values[0]!.natural5mBuckets).toBe(values[2]!.natural5mBuckets);
  expect(values[0]!.poolId).not.toBe(values[1]!.poolId);
  expect(values[0]!.unknownTimeBlockCounts).toEqual([]);
  expect(values[1]!.unknownTimeBlockCounts[0]).toMatchObject({ eventCount: 1, swapCount: 1 });
});

test.each(['single', 'multi', 'missing', 'unknown-bounds'] as const)(
  'combined %s coverage output equals independent per-pool builds for every field',
  (kind) => {
    const births = [null, 900n, 1000n, 1001n, 1505n, 2445n, 999999n];
    const tokens = [null, '0xabc', '0xAbC', '0xdef'];
    const pools = Array.from({ length: 84 }, (_, i) => ({
      pool: pool(i + 1),
      discoveredAtBlock: births[i % births.length]!,
      rawToken: tokens[i % tokens.length]!,
    }));
    let ranges = coverage();
    if (kind === 'multi')
      ranges = [
        ...ranges,
        ...ranges.map((x) => ({
          ...x,
          scopeId: 'b',
          complete: false,
          reasons: ['other-scope-gap'],
        })),
      ];
    if (kind === 'missing') ranges = ranges.filter((_, i) => i % 9 !== 0);
    if (kind === 'unknown-bounds')
      ranges = ranges.map((x) => ({ ...x, fromBlock: null, toBlock: null }));
    const events = [
      event(pools[0]!.pool, 120, 1),
      event(pools[3]!.pool, 144 * 60, 2, 'b'),
      event(pools[4]!.pool, null, 3),
      event(pools[4]!.pool, null, 4),
      event(pools[7]!.pool, 60, 5),
      event(pools[7]!.pool, 120, 6, 'b'),
    ];
    const options = {
      pools,
      minimumOneMinuteSamples: 3,
      minimumFiveMinuteSamples: 2,
      oneMinuteBaselineLimit: 12,
      fiveMinuteBaselineLimit: 5,
    };
    expect(buildMinuteMetrics(events, ranges, watermark(), options)).toEqual(
      independent(events, ranges, watermark(), options),
    );
  },
);

test('exact raw token casing and in-range birth remain separate cache keys', () => {
  const pools = ['0xabc', '0xAbC', null, '0xabc'].map((rawToken, i) => ({
    pool: pool(i + 1),
    rawToken,
    discoveredAtBlock: i === 3 ? 1001n : null,
  }));
  const values = buildMinuteMetrics([], coverage(), watermark(), { pools });
  expect(values[0]!.minutes).not.toBe(values[1]!.minutes);
  expect(values[0]!.minutes).not.toBe(values[2]!.minutes);
  expect(values[0]!.minutes).not.toBe(values[3]!.minutes);
  expect(values[3]!.minutes[0]!.status).toBe('warming');
});

test('new calls do not reuse prior coverage, watermark, event or option results', () => {
  const pools = Array.from({ length: 10 }, (_, i) => ({
    pool: pool(i + 1),
    discoveredAtBlock: null,
    rawToken: '0xabc',
  }));
  const options = { pools };
  const first = buildMinuteMetrics([], coverage(), watermark(), options);
  const changedCoverage = coverage().filter((x) => x.minuteStartSec !== 120);
  const events = [event(pools[0]!.pool, 60, 7), event(pools[2]!.pool, null, 8)];
  const changedOptions = { pools, minimumOneMinuteSamples: 1, oneMinuteBaselineLimit: 2 };
  const second = buildMinuteMetrics(events, changedCoverage, watermark(145), changedOptions);
  expect(second).toEqual(independent(events, changedCoverage, watermark(145), changedOptions));
  expect(second[1]!.minutes).not.toBe(first[1]!.minutes);
  expect(first).toEqual(independent([], coverage(), watermark(), options));
});
