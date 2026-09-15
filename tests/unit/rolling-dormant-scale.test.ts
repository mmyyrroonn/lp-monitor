import { expect, test } from 'vitest';
import { buildRollingMetrics } from '../../src/metrics/rolling.js';
import type { MetricEvent, PoolMetricWindows } from '../../src/metrics/windows.js';
import { poolRegistrationId } from '../../src/registry/pools.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';
import { makeScaleData, SCALE_SCOPE_ID } from '../helpers/live-scale-fixture.js';
import { referenceRollingWindows } from '../helpers/rolling-reference.js';
import type { PoolRef } from '../../src/domain/types.js';

const DORMANT_POOLS = 300;
const HISTORY_MINUTES = 181;
/** The fixture gives the last five pools a birth inside the covered window. */
const BORN_IN_WINDOW = 5;
const SHARED_RAW_TOKEN = `0x${'ab'.repeat(20)}`;
const OTHER_RAW_TOKEN = `0x${'cd'.repeat(20)}`;

function poolRef(tail: string): PoolRef {
  return {
    chainId: 4663,
    protocol: 'v3',
    address: `0x${tail.slice(2).padStart(40, '0')}` as `0x${string}`,
  };
}

const scale = makeScaleData({
  poolCount: DORMANT_POOLS,
  activePoolCount: 0,
  assetCount: 194,
  historyMinutes: HISTORY_MINUTES,
});
const earliest = scale.coverage[0]!.fromBlock!;
const pools = scale.registrations.map((r) => ({
  pool: r.pool,
  discoveredAtBlock: r.discoveredAt.blockNumber,
  rawToken: SHARED_RAW_TOKEN,
}));
const birthOf = new Map(pools.map((p) => [poolRegistrationId(p), p.discoveredAtBlock]));

function build(options: Parameters<typeof buildRollingMetrics>[3] = {}) {
  return buildRollingMetrics(scale.events, scale.coverage, scale.watermark, {
    pools,
    ...options,
  });
}
const byPool = (rows: readonly PoolMetricWindows[]) =>
  new Map(rows.map((row) => [row.poolId, row]));

/** Group rows by the identity of the rolling object they got, i.e. by which cache entry they hit. */
function groupsOf(rows: readonly PoolMetricWindows[]) {
  const groups = new Map<object, string[]>();
  for (const row of rows)
    groups.set(row.rolling!, [...(groups.get(row.rolling!) ?? []), row.poolId]);
  return [...groups.values()];
}
const referenceFor = (poolId: string, coverage = scale.coverage, rawToken = SHARED_RAW_TOKEN) =>
  referenceRollingWindows(
    scale.events,
    coverage,
    scale.watermark,
    rawToken,
    birthOf.get(poolId) ?? null,
  );

test('an empty pool born before the covered window cannot move the rolling cache key', () => {
  const rows = build();
  expect(rows).toHaveLength(DORMANT_POOLS);
  const groups = groupsOf(rows);
  const shared = groups.find((g) => g.length > 1) ?? [];
  // Every pool born before the earliest verifiable coverage boundary produces the same windows, so
  // the key must treat their birth as unknown and let them share a single computation.
  expect(shared).toHaveLength(DORMANT_POOLS - BORN_IN_WINDOW);
  expect(groups).toHaveLength(BORN_IN_WINDOW + 1);
});

test('every shared group still matches an independent per-pool computation', () => {
  const rows = build();
  const byId = byPool(rows);
  const groups = groupsOf(rows);
  expect(groups).toHaveLength(BORN_IN_WINDOW + 1);
  for (const group of groups) {
    for (const poolId of group) {
      const expected = referenceFor(poolId);
      const row = byId.get(poolId)!;
      // Field-by-field equality against a second implementation of the same contract: a pool that
      // was served another pool's cached windows would fail here even if the cache key looked fine.
      expect(row.rolling, poolId).toEqual(expected.rolling);
      expect(row.rollingHistory1m, poolId).toEqual(expected.rollingHistory1m);
      expect(row.rollingHistory5m, poolId).toEqual(expected.rollingHistory5m);
    }
  }
});

test('pools born inside the covered window keep their own result', () => {
  const rows = build();
  const byId = byPool(rows);
  const inWindow = pools
    .filter((p) => p.discoveredAtBlock! >= earliest)
    .map((p) => poolRegistrationId(p));
  expect(inWindow).toHaveLength(BORN_IN_WINDOW);
  const seen = new Set<object>();
  for (const poolId of inWindow) {
    const row = byId.get(poolId)!;
    expect(row.rolling, poolId).toEqual(referenceFor(poolId).rolling);
    expect(seen.has(row.rolling!), poolId).toBe(false);
    seen.add(row.rolling!);
  }
});

test('a birth exactly on the earliest boundary shares, because it cannot shorten a window', () => {
  const rows = buildRollingMetrics(scale.events, scale.coverage, scale.watermark, {
    pools: [
      { pool: poolRef('0x01'), discoveredAtBlock: earliest, rawToken: SHARED_RAW_TOKEN },
      { pool: poolRef('0x02'), discoveredAtBlock: earliest, rawToken: SHARED_RAW_TOKEN },
      { pool: poolRef('0x03'), discoveredAtBlock: earliest - 1n, rawToken: SHARED_RAW_TOKEN },
    ],
  });
  expect(rows[0]!.rolling).toBe(rows[1]!.rolling);
  expect(rows[0]!.rolling).toBe(rows[2]!.rolling);
  expect(rows[0]!.rolling).toEqual(
    referenceRollingWindows(
      scale.events,
      scale.coverage,
      scale.watermark,
      SHARED_RAW_TOKEN,
      earliest,
    ).rolling,
  );
  expect(rows[0]!.rolling!['1m']).toMatchObject({ status: 'closed' });
});

test('an untimed event never gets served the all-empty dormant entry', () => {
  const withEvent = poolRef('0x11');
  const stillEmpty = poolRef('0x12');
  const unknownEvent: MetricEvent = {
    event: {
      kind: 'swap',
      pool: withEvent,
      time: { minuteStartSec: null, exactTimestampSec: null, source: 'minute-boundary' },
      ref: {
        blockNumber: scale.watermark.number,
        blockHash: scale.watermark.hash,
        transactionHash: `0x${'0'.repeat(64)}`,
        transactionIndex: 0,
        logIndex: 0,
      },
      rawAmount0: 1n,
      rawAmount1: -1n,
      tokenIn: scale.registrations[0]!.token0,
      tokenOut: scale.registrations[0]!.token1,
      amountIn: 1n,
      amountOut: 1n,
      sqrtPriceX96After: 2n ** 96n,
      liquidityAfter: 1_000_000n,
      tickAfter: 0,
      effectiveSwapFeePips: 3000,
    },
    usdMicros: 5n,
    usdgNotionalRaw: 5n,
    rawNotional: { token: SHARED_RAW_TOKEN, raw: 5n },
    scopeId: SCALE_SCOPE_ID,
  };
  const birth = earliest - 1n;
  const rows = buildRollingMetrics([unknownEvent], scale.coverage, scale.watermark, {
    pools: [
      { pool: withEvent, discoveredAtBlock: birth, rawToken: SHARED_RAW_TOKEN },
      { pool: stillEmpty, discoveredAtBlock: birth, rawToken: SHARED_RAW_TOKEN },
      { pool: poolRef('0x13'), discoveredAtBlock: birth, rawToken: OTHER_RAW_TOKEN },
    ],
  });
  const [held, empty, otherToken] = rows;
  expect(held!.rolling!['1m']).toMatchObject({ status: 'gap', swapCount: null });
  expect(held!.rolling!['1m'].reasons).toContain('boundary-time-unknown');
  expect(held!.rolling).not.toBe(empty!.rolling);
  expect(empty!.rolling!['1m']).toMatchObject({ status: 'closed', swapCount: 0 });
  // A different token must not reuse another token's raw valuation window.
  expect(otherToken!.rolling).not.toBe(empty!.rolling);
  expect(empty!.rolling!['1h']).toEqual(
    referenceRollingWindows([], scale.coverage, scale.watermark, SHARED_RAW_TOKEN, birth).rolling[
      '1h'
    ],
  );
});

test('a coverage set is indexed once per build instead of once per window query', () => {
  const scope = openWorkCounts();
  try {
    build();
  } finally {
    scope.close();
  }
  expect(scope.counts.evaluatedPools).toBe(DORMANT_POOLS);
  // The count must come from the real path first, otherwise "0 <= 2" would pass vacuously.
  expect(scope.counts.coverageIndexBuilds).toBeGreaterThan(0);
  // One coverage set is in play for every dormant pool here, so the minute index is built once
  // rather than once per window query (222 queries per pool before the pools start sharing).
  expect(scope.counts.coverageIndexBuilds).toBeLessThanOrEqual(2);
});

test('the dormant cache does not survive into the next build', () => {
  const first = build();
  const second = build();
  expect(first[0]!.rolling).not.toBe(second[0]!.rolling);
  expect(first[0]!.rolling).toEqual(second[0]!.rolling);
});

test('a gapped coverage set is still compared against the independent reference', () => {
  const partial = scale.coverage.filter(
    (c) => c.minuteStartSec !== scale.watermark.timestampSec - 600,
  );
  const rows = buildRollingMetrics(scale.events, partial, scale.watermark, { pools });
  const poolId = rows[0]!.poolId;
  expect(rows[0]!.rolling).toEqual(referenceFor(poolId, partial).rolling);
  // The removed minute sits ten minutes back, so only the windows that reach it report the hole;
  // the 1m and 5m windows stay closed and must not inherit the wider windows' reasons.
  expect(rows[0]!.rolling!['15m'].reasons).toContain('coverage-missing');
  expect(rows[0]!.rolling!['1h'].reasons).toContain('coverage-missing');
  expect(rows[0]!.rolling!['5m'].reasons).toEqual([]);
  expect(rows[0]!.rolling!['5m'].status).toBe('closed');
});
