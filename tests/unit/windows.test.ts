import { volumeBaseline } from '../../src/metrics/baseline.js';
import { describe, expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import type { BlockAnchor, PoolEvent, PoolRef } from '../../src/domain/types.js';
import {
  buildMinuteMetrics,
  type MetricEvent,
  type MinuteCoverage,
} from '../../src/metrics/windows.js';
import { rankPools } from '../../src/metrics/ranking.js';

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const pool = (digit: string): PoolRef => ({
  chainId: 4663,
  protocol: 'v3',
  address: address(digit),
});
const watermark = (timestampSec: number): BlockAnchor => ({
  number: 999n,
  hash: hash('f'),
  timestampSec,
});

function swap(p: PoolRef, minuteStartSec: number | null, id: number): PoolEvent {
  return {
    kind: 'swap',
    ref: {
      blockHash: hash(String((id % 8) + 1)),
      blockNumber: BigInt(id),
      transactionHash: hash(String((id % 7) + 1)),
      transactionIndex: 0,
      logIndex: id,
    },
    time: {
      minuteStartSec,
      exactTimestampSec: minuteStartSec,
      source: minuteStartSec === null ? 'unresolved' : 'minute-boundary',
    },
    pool: p,
    rawAmount0: 1n,
    rawAmount1: -1n,
    tokenIn: address('a'),
    amountIn: 1n,
    tokenOut: address('b'),
    amountOut: 1n,
    sqrtPriceX96After: 1n,
    liquidityAfter: 1n,
    tickAfter: 0,
    effectiveSwapFeePips: null,
  };
}

function liquidity(p: PoolRef, minuteStartSec: number, id: number, delta: bigint): PoolEvent {
  return {
    kind: 'liquidity',
    ref: {
      blockHash: hash(String((id % 8) + 1)),
      blockNumber: BigInt(id),
      transactionHash: hash(String((id % 7) + 1)),
      transactionIndex: 0,
      logIndex: id,
    },
    time: { minuteStartSec, exactTimestampSec: minuteStartSec, source: 'minute-boundary' },
    pool: p,
    tickLower: -1,
    tickUpper: 1,
    delta,
    actor: address('c'),
    salt: null,
  };
}

const valued = (event: PoolEvent, usdMicros: bigint | null = 1_000_000n): MetricEvent => ({
  event,
  usdMicros,
  usdgNotionalRaw: usdMicros,
});

const covered = (
  minuteStartSec: number,
  complete = true,
  reasons: readonly string[] = [],
): MinuteCoverage => ({
  scopeId: 'scope',
  minuteStartSec,
  fromBlock: BigInt(minuteStartSec),
  toBlock: BigInt(minuteStartSec + 59),
  complete,
  reasons,
});

describe('buildMinuteMetrics', () => {
  test('keeps the current minute partial and uses the 60-second boundary as the next minute', () => {
    const p = pool('1');
    const result = buildMinuteMetrics(
      [valued(swap(p, 0, 1)), valued(swap(p, 60, 2)), valued(swap(p, 60, 3))],
      [covered(0), covered(60)],
      watermark(119),
    )[0]!;

    expect(result.partialCurrent).toMatchObject({
      minuteStartSec: 60,
      status: 'partial',
      swapCount: 2,
    });
    expect(result.recentClosed1m).toMatchObject({
      minuteStartSec: 0,
      status: 'closed',
      swapCount: 1,
    });
  });

  test('represents a fully covered empty minute as zero but a failed minute as a gap with null values', () => {
    const p = pool('2');
    const result = buildMinuteMetrics(
      [valued(swap(p, 0, 1))],
      [covered(0), covered(60), covered(120, false, ['missing-shard'])],
      watermark(180),
    )[0]!;

    expect(result.minutes.find((m) => m.minuteStartSec === 60)).toMatchObject({
      status: 'closed',
      usdMicros: 0n,
      swapCount: 0,
    });
    expect(result.minutes.find((m) => m.minuteStartSec === 120)).toMatchObject({
      status: 'gap',
      usdMicros: null,
      swapCount: null,
      reasons: ['missing-shard'],
    });
  });

  test('does not skip a gap when forming the most recent five-minute aggregate', () => {
    const p = pool('3');
    const coverage = [0, 60, 120, 180, 240].map((m) =>
      covered(m, m !== 120, m === 120 ? ['short-range'] : []),
    );
    const result = buildMinuteMetrics([valued(swap(p, 0, 1))], coverage, watermark(300))[0]!;

    expect(result.recentClosed5x1m).toBeNull();
    expect(result.naturalClosed5m).toBeNull();
  });

  test('aggregates five consecutive closed minutes with tx union and liquidity action counts', () => {
    const p = pool('4');
    const events = [
      valued(swap(p, 0, 1), 2n),
      valued(swap(p, 60, 1), 3n),
      valued(swap(p, 120, 2), null),
      valued(liquidity(p, 180, 3, 5n), null),
      valued(liquidity(p, 180, 4, -2n), null),
      valued(liquidity(p, 240, 5, 0n), null),
    ];
    // Force the first two swaps to share a transaction across minute buckets.
    (events[1]!.event.ref as { transactionHash: Hex }).transactionHash =
      events[0]!.event.ref.transactionHash;
    const result = buildMinuteMetrics(
      events,
      [0, 60, 120, 180, 240].map((m) => covered(m)),
      watermark(300),
    )[0]!;

    expect(result.recentClosed5x1m).toMatchObject({
      startSec: 0,
      endSec: 300,
      usdMicros: null,
      swapCount: 3,
      txCount: 2,
      addCount: 1,
      removeCount: 1,
      zeroDeltaCount: 1,
      activeMinutes: 3,
    });
    expect(result.naturalClosed5m).toMatchObject({ startSec: 0, endSec: 300, status: 'closed' });
  });

  test('keeps unpriced volume null while retaining counts and unresolved-time block counts', () => {
    const p = pool('5');
    const result = buildMinuteMetrics(
      [valued(swap(p, 0, 1), null), valued(swap(p, null, 2), null)],
      [covered(0)],
      watermark(60),
    )[0]!;

    expect(result.recentClosed1m).toMatchObject({ usdMicros: null, swapCount: 1 });
    expect(result.unknownTimeBlockCounts).toEqual([
      {
        blockNumber: 2n,
        eventCount: 1,
        swapCount: 1,
        txCount: 1,
        addCount: 0,
        removeCount: 0,
        zeroDeltaCount: 0,
      },
    ]);
  });

  test('uses only preceding same-scale closed buckets for a median baseline and returns null for zero or insufficient baselines', () => {
    const p = pool('6');
    const coverage = Array.from({ length: 9 }, (_, i) => covered(i * 60));
    const events = [1n, 3n, 100n, 9n].map((value, i) => valued(swap(p, i * 60, i + 1), value));
    const result = buildMinuteMetrics(events, coverage, watermark(540), {
      minimumOneMinuteSamples: 3,
    })[0]!;
    const at180 = result.minutes.find((m) => m.minuteStartSec === 180)!;

    expect(at180.baselineSampleCount).toBe(3);
    expect(at180.volumeMultiplier).toBe(3);
    expect(result.minutes[0]!.volumeMultiplier).toBeNull();

    const zero = buildMinuteMetrics(
      [valued(swap(p, 180, 9), 9n)],
      coverage.slice(0, 4),
      watermark(240),
      {
        minimumOneMinuteSamples: 3,
      },
    )[0]!;
    expect(zero.minutes.find((m) => m.minuteStartSec === 180)).toMatchObject({
      baselineSampleCount: 3,
      volumeMultiplier: null,
    });
  });
});

test('rankPools excludes unpriced volume, breaks ties by tx count then stable pool id, and offers a multiplier ranking', () => {
  const a = pool('7');
  const b = pool('8');
  const events = [valued(swap(a, 0, 1), 5n), valued(swap(b, 0, 2), 5n), valued(swap(b, 60, 3), 5n)];
  const windows = buildMinuteMetrics(
    events,
    [covered(0), covered(60), covered(120), covered(180), covered(240)],
    watermark(300),
    {
      minimumOneMinuteSamples: 1,
    },
  );

  expect(rankPools(windows, 'volume5mClosed').map((x) => x.poolId)).toEqual([
    '4663:v3:0x8888888888888888888888888888888888888888',
    '4663:v3:0x7777777777777777777777777777777777777777',
  ]);
  expect(rankPools(windows, 'volumeMultiplier')[0]?.poolId).toBe(
    '4663:v3:0x8888888888888888888888888888888888888888',
  );
});

test('unpriced native-unit baseline includes quiet zeros and earlier priced raw amounts', () => {
  const p = pool('1'),
    rawToken = address('a');
  const result = buildMinuteMetrics(
    [
      { ...valued(swap(p, 0, 1), 1000n), rawNotional: { token: rawToken, raw: 100n } },
      { ...valued(swap(p, 120, 2), null), rawNotional: { token: rawToken, raw: 100n } },
    ],
    [covered(0), covered(60), covered(120)],
    watermark(180),
    { minimumOneMinuteSamples: 1, pools: [{ pool: p, discoveredAtBlock: null, rawToken }] },
  )[0]!;
  expect(result.minutes[1]?.rawNotional).toEqual({ token: rawToken, raw: 0n });
  expect(result.recentClosed1m).toMatchObject({
    baselineSampleCount: 2,
    baselineMedian: 50n,
    volumeMultiplier: 2,
    baselineUnit: rawToken,
  });
});
test('pool roster keeps zero-event pools without manufacturing pre-birth baseline minutes', () => {
  const p = pool('2');
  const result = buildMinuteMetrics([], [covered(0), covered(60), covered(120)], watermark(180), {
    pools: [{ pool: p, discoveredAtBlock: 60n, rawToken: address('a') }],
  })[0]!;
  expect(result.minutes[0]?.status).toBe('warming');
  expect(result.minutes[1]).toMatchObject({ status: 'closed', swapCount: 0 });
});
test('current prefix gaps preserve unknown values and reasons, and stale multipliers cannot rank', () => {
  const p = pool('3');
  const result = buildMinuteMetrics(
    [valued(swap(p, 0, 1))],
    [covered(0), covered(60, false, ['range-gap'])],
    watermark(90),
    { minimumOneMinuteSamples: 1 },
  )[0]!;
  expect(result.partialCurrent).toMatchObject({
    status: 'gap',
    usdMicros: null,
    reasons: ['range-gap'],
  });
  const stale = {
    ...result,
    recentClosed1m: { ...result.recentClosed1m!, minuteStartSec: -60, volumeMultiplier: 9 },
  };
  expect(rankPools([stale], 'volumeMultiplier')).toEqual([]);
});
test('fractional median keeps exact multiplier and oversized result never becomes Infinity', () => {
  expect(volumeBaseline(3n, [1n, 2n], 2).multiplier).toBe(2);
  expect(volumeBaseline(10n ** 400n, [1n], 1).multiplier).toBeNull();
});
test('uses independent one-minute and five-minute minimum sample thresholds', () => {
  const p = pool('9');
  const starts = Array.from({ length: 65 }, (_, i) => i * 60);
  const events = starts.map((start, i) => valued(swap(p, start, i + 1), start >= 3600 ? 2n : 1n));
  const enough = buildMinuteMetrics(
    events,
    starts.map((start) => covered(start)),
    watermark(3900),
    {
      minimumOneMinuteSamples: 1,
    },
  )[0]!;
  expect(enough.recentClosed5x1m).toMatchObject({ baselineSampleCount: 12, volumeMultiplier: 2 });
  expect(enough.naturalClosed5m).toMatchObject({ baselineSampleCount: 12, volumeMultiplier: 2 });
  const insufficient = buildMinuteMetrics(
    events,
    starts.map((start) => covered(start)),
    watermark(3900),
    {
      minimumOneMinuteSamples: 1,
      minimumFiveMinuteSamples: 13,
    },
  )[0]!;
  expect(insufficient.recentClosed5x1m).toMatchObject({
    baselineSampleCount: 12,
    volumeMultiplier: null,
  });
  expect(insufficient.naturalClosed5m).toMatchObject({
    baselineSampleCount: 12,
    volumeMultiplier: null,
  });
});

test('canonicalizes raw token casing so quiet minutes remain baseline samples', () => {
  const p = pool('a');
  const rawToken = `0x${'Aa'.repeat(20)}`;
  const canonicalToken = rawToken.toLowerCase();
  const result = buildMinuteMetrics(
    [
      { ...valued(swap(p, 60, 1), null), rawNotional: { token: canonicalToken, raw: 100n } },
      { ...valued(swap(p, 120, 2), null), rawNotional: { token: canonicalToken, raw: 200n } },
    ],
    [covered(0), covered(60), covered(120)],
    watermark(180),
    { minimumOneMinuteSamples: 2, pools: [{ pool: p, discoveredAtBlock: null, rawToken }] },
  )[0]!;
  expect(result.minutes[0]?.rawNotional).toEqual({ token: canonicalToken, raw: 0n });
  expect(result.recentClosed1m).toMatchObject({
    baselineSampleCount: 2,
    baselineMedianNumerator: 100n,
    baselineMedianDenominator: 2n,
    volumeMultiplier: 4,
    baselineUnit: canonicalToken,
  });
});

test('normalizes transaction hashes in minute, aggregate, and unresolved block counts', () => {
  const p = pool('b');
  const events = [
    valued(swap(p, 0, 1), 1n),
    valued(swap(p, 0, 2), 1n),
    valued(swap(p, null, 3), null),
    valued(swap(p, null, 4), null),
  ];
  const shared = hash('a');
  for (const [index, item] of events.entries()) {
    (item.event.ref as { transactionHash: Hex; blockNumber: bigint }).transactionHash = (
      index % 2 === 0 ? shared : shared.toUpperCase()
    ) as Hex;
    if (index >= 2)
      (item.event.ref as { transactionHash: Hex; blockNumber: bigint }).blockNumber = 77n;
  }
  const result = buildMinuteMetrics(
    events,
    [0, 60, 120, 180, 240].map((start) => covered(start)),
    watermark(300),
  )[0]!;
  expect(result.minutes[0]?.txCount).toBe(1);
  expect(result.recentClosed5x1m?.txCount).toBe(1);
  expect(result.unknownTimeBlockCounts[0]?.txCount).toBe(1);
});

test('volume rank excludes empty pools but retains real swaps rounded to zero', () => {
  const active = pool('c');
  const quiet = pool('d');
  const windows = buildMinuteMetrics(
    [valued(swap(active, 0, 1), 0n)],
    [0, 60, 120, 180, 240].map((start) => covered(start)),
    watermark(300),
    {
      pools: [
        { pool: active, discoveredAtBlock: null, rawToken: null },
        { pool: quiet, discoveredAtBlock: null, rawToken: null },
      ],
    },
  );
  expect(rankPools(windows, 'volume5mClosed').map((item) => item.poolId)).toEqual([
    '4663:v3:0xcccccccccccccccccccccccccccccccccccccccc',
  ]);
});

test('does not emit a natural five-minute bucket when its fifth minute is current partial', () => {
  const p = pool('e');
  const result = buildMinuteMetrics(
    [valued(swap(p, 0, 1), 1n)],
    [0, 60, 120, 180, 240].map((start) => covered(start)),
    watermark(299),
  )[0]!;
  expect(result.natural5mBuckets).toEqual([]);
  expect(result.naturalClosed5m).toBeNull();
});

test('keeps a pool warming when coverage has multiple scopes and no scope can be selected', () => {
  const p = pool('f');
  const result = buildMinuteMetrics(
    [],
    [
      { ...covered(0), scopeId: 'a' },
      { ...covered(0), scopeId: 'b' },
    ],
    watermark(60),
    {
      pools: [{ pool: p, discoveredAtBlock: null, rawToken: null }],
    },
  )[0]!;
  expect(result.minutes.every((minute) => minute.status === 'warming')).toBe(true);
});

test('default five-minute threshold stays twelve even when one-minute threshold is one', () => {
  const p = pool('9');
  const starts = Array.from({ length: 60 }, (_, i) => i * 60);
  const events = starts.map((start, i) => valued(swap(p, start, i + 1), 1n));
  const result = buildMinuteMetrics(
    events,
    starts.map((start) => covered(start)),
    watermark(3600),
    { minimumOneMinuteSamples: 1 },
  )[0]!;
  expect(result.minutes[1]!.volumeMultiplier).toBe(1);
  expect(result.recentClosed5x1m).toMatchObject({
    baselineSampleCount: 11,
    volumeMultiplier: null,
  });
  expect(result.naturalClosed5m).toMatchObject({ baselineSampleCount: 11, volumeMultiplier: null });
  const fiveOnly = buildMinuteMetrics(
    events.slice(0, 10),
    starts.slice(0, 10).map((start) => covered(start)),
    watermark(600),
    { minimumFiveMinuteSamples: 1 },
  )[0]!;
  expect(fiveOnly.recentClosed5x1m!.volumeMultiplier).toBe(1);
  expect(fiveOnly.naturalClosed5m!.volumeMultiplier).toBe(1);
  expect(fiveOnly.recentClosed1m!.volumeMultiplier).toBeNull();
});

test('volume ties use transaction count then stable pool ID', () => {
  const a = pool('a'),
    b = pool('b'),
    c = pool('c');
  const events = [
    valued(swap(c, 0, 1), 10n),
    valued(swap(b, 0, 2), 5n),
    valued(swap(b, 60, 3), 5n),
    valued(swap(a, 0, 4), 5n),
    valued(swap(a, 60, 5), 5n),
  ];
  const windows = buildMinuteMetrics(
    events,
    [0, 60, 120, 180, 240].map((start) => covered(start)),
    watermark(300),
  );
  expect(rankPools(windows, 'volume5mClosed').map((w) => w.pool)).toEqual([a, b, c]);
});
