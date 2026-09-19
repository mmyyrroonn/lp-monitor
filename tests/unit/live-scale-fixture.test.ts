import { expect, test } from 'vitest';
import type { Swap } from '../../src/domain/types.js';
import { type SwapValuationMetadata, valueSwap } from '../../src/metrics/notional.js';
import { createQuoteIndex } from '../../src/metrics/price.js';
import { buildMinuteMetrics } from '../../src/metrics/windows.js';
import { emptyWorkCounts, setWorkCounter } from '../../src/ops/work-counters.js';
import { PoolRegistry, poolRegistrationId } from '../../src/registry/pools.js';
import { openDatabase } from '../../src/storage/database.js';
import { readBatch } from '../../src/storage/payload-store.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { batch, swap } from '../helpers/alert-fixture.js';
import {
  makeScaleData,
  SCALE_CHAIN_ID,
  SCALE_MANAGER,
  SCALE_USDG,
  scaleAssetAddress,
} from '../helpers/live-scale-fixture.js';

const eventPoolIds = (events: readonly { event: { pool: unknown } }[]) =>
  new Set(
    events.flatMap((entry) =>
      entry.event.pool ? [poolRegistrationId({ pool: entry.event.pool as never })] : [],
    ),
  );

test('scale fixture reproduces the review scale with unique pools and only active events', () => {
  const d = makeScaleData({
    poolCount: 80000,
    activePoolCount: 400,
    assetCount: 194,
    historyMinutes: 180,
  });
  expect(d.registrations).toHaveLength(80000);
  expect(new Set(d.registrations.map(poolRegistrationId)).size).toBe(80000);
  expect(eventPoolIds(d.events).size).toBe(400);
  expect(d.coverage).toHaveLength(181);
  expect(
    makeScaleData({ poolCount: 10, activePoolCount: 2, assetCount: 2, historyMinutes: 180 }),
  ).toEqual(
    makeScaleData({ poolCount: 10, activePoolCount: 2, assetCount: 2, historyMinutes: 180 }),
  );
});

test('scale fixture keeps distinct pre-window birth heights and separates window births', () => {
  const d = makeScaleData({
    poolCount: 3000,
    activePoolCount: 40,
    assetCount: 12,
    historyMinutes: 180,
  });
  const windowStart = d.coverage[0]!.fromBlock!;
  const windowEnd = d.coverage.at(-1)!.toBlock!;
  const births = d.registrations.map((r) => r.discoveredAt.blockNumber);
  const old = births.filter((height) => height < windowStart);
  const young = births.filter((height) => height >= windowStart && height <= windowEnd);
  expect(old.length).toBe(2995);
  expect(young.length).toBe(5);
  expect(new Set(old).size).toBe(old.length);
  expect(new Set(births).size).toBe(births.length);
});

test('scale fixture coverage is contiguous, complete, and ends at the watermark block', () => {
  const d = makeScaleData({
    poolCount: 50,
    activePoolCount: 5,
    assetCount: 4,
    historyMinutes: 180,
  });
  expect(d.coverage.map((c) => c.minuteStartSec)).toEqual(
    Array.from({ length: 181 }, (_, i) => d.watermark.timestampSec - (180 - i) * 60),
  );
  for (const [index, minute] of d.coverage.entries()) {
    expect(minute.scopeId).toBe('scale');
    expect(minute.complete).toBe(true);
    expect(minute.reasons).toEqual([]);
    expect(minute.fromBlock).not.toBeNull();
    expect(minute.toBlock).not.toBeNull();
    if (index > 0) expect(minute.fromBlock! - d.coverage[index - 1]!.toBlock!).toBe(1n);
  }
  expect(d.coverage.at(-1)!.toBlock).toBe(d.watermark.number);
});

test('scale fixture registers a stock co-pool and rotates stock tokens across assets', () => {
  const d = makeScaleData({
    poolCount: 500,
    activePoolCount: 20,
    assetCount: 194,
    historyMinutes: 180,
  });
  const stocks = new Set(Array.from({ length: 194 }, (_, i) => scaleAssetAddress(i).toLowerCase()));
  const coPools = d.registrations.filter(
    (r) => stocks.has(r.token0.toLowerCase()) && stocks.has(r.token1.toLowerCase()),
  );
  expect(coPools.length).toBeGreaterThanOrEqual(1);
  const quotePools = d.registrations.filter((r) => r.token1.toLowerCase() === SCALE_USDG);
  expect(quotePools.length).toBe(d.registrations.length - coPools.length);
  expect(new Set(d.registrations.map((r) => r.token0)).size).toBe(194);
  for (const r of d.registrations) expect(r.pool.chainId).toBe(SCALE_CHAIN_ID);
  const manager = d.registrations.filter(
    (r) => r.pool.protocol === 'v4' && r.pool.manager.toLowerCase() === SCALE_MANAGER,
  );
  expect(manager.length).toBeGreaterThan(0);
});

test('scale fixture events stay inside registered pools and inside the covered window', () => {
  const d = makeScaleData({
    poolCount: 100,
    activePoolCount: 7,
    assetCount: 5,
    historyMinutes: 180,
  });
  const registered = new Set(d.registrations.map(poolRegistrationId));
  const start = d.coverage[0]!.minuteStartSec;
  for (const metric of d.events) {
    expect(metric.event.pool).not.toBeNull();
    expect(registered.has(poolRegistrationId({ pool: metric.event.pool! }))).toBe(true);
    expect(metric.event.ref.blockNumber).toBeLessThanOrEqual(d.watermark.number);
    expect(metric.event.time.source).toBe('log-verified');
    expect(metric.event.time.exactTimestampSec).not.toBeNull();
    expect(metric.event.time.exactTimestampSec!).toBeGreaterThan(start);
    expect(metric.event.time.exactTimestampSec!).toBeLessThanOrEqual(d.watermark.timestampSec);
    expect(metric.usdMicros).not.toBeNull();
  }
  expect(d.events.length).toBeGreaterThan(7);
});

test('work counters stay off by default and count real storage, decode, valuation and evaluation sites', () => {
  const counts = emptyWorkCounts();
  const db = openDatabase(':memory:');
  const stored = batch('counter-batch', [swap(60)]);
  const store = new SqliteRangeStore(db);
  const d = makeScaleData({ poolCount: 8, activePoolCount: 2, assetCount: 2, historyMinutes: 4 });
  const quotePool = d.registrations[1]!;
  const valuationSwap: Swap = {
    kind: 'swap',
    ref: d.events[0]!.event.ref,
    time: d.events[0]!.event.time,
    pool: quotePool.pool,
    rawAmount0: 1_000_000_000_000_000_000n,
    rawAmount1: -500_000n,
    tokenIn: quotePool.token0,
    amountIn: 1_000_000_000_000_000_000n,
    tokenOut: SCALE_USDG,
    amountOut: 500_000n,
    sqrtPriceX96After: 1n,
    liquidityAfter: 1n,
    tickAfter: 0,
    effectiveSwapFeePips: 3000,
  };
  const valuationMetadata: SwapValuationMetadata = {
    token0: { address: quotePool.token0, decimals: 18, role: 'rwa' },
    token1: { address: SCALE_USDG, decimals: 6, role: 'usdg' },
    rwa: quotePool.token0,
    usdg: SCALE_USDG,
    usdgDecimals: 6,
  };
  const evaluate = () =>
    buildMinuteMetrics(d.events, d.coverage, d.watermark, {
      pools: d.registrations.map((r) => ({
        pool: r.pool,
        discoveredAtBlock: r.discoveredAt.blockNumber,
        rawToken: r.token0,
      })),
    });
  try {
    store.saveRaw(stored);
    store.acceptRange(stored);
    readBatch(db, stored.id);
    store.pools('s');
    valueSwap(valuationSwap, valuationMetadata, createQuoteIndex());
    evaluate();
    expect(counts).toEqual(emptyWorkCounts());

    setWorkCounter((key, delta) => {
      counts[key] += delta;
    });
    readBatch(db, stored.id);
    expect(counts.rawBatchDecodes).toBe(1);
    store.pools('s');
    expect(counts.registryRowsRead).toBe(1);
    new PoolRegistry([stored.poolRegistrations![0]!]).preview(stored.poolRegistrations!);
    expect(counts.registryRowsSerialized).toBeGreaterThanOrEqual(2);
    valueSwap(valuationSwap, valuationMetadata, createQuoteIndex());
    expect(counts.valuationComputes).toBe(1);
    evaluate();
    expect(counts.evaluatedPools).toBe(8);
  } finally {
    setWorkCounter(null);
    db.close();
  }
});
