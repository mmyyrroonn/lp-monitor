import { describe, it, expect, vi } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { LiveMetricCache } from '../../src/storage/live-metric-cache.js';
import { buildRollingMetrics } from '../../src/metrics/rolling.js';
import { makeScaleData } from '../helpers/live-scale-fixture.js';

describe('durable live metric contributions', () => {
  it('reuses an unchanged contribution across instances and recomputes only a corrected input', () => {
    const db = openDatabase(':memory:');
    try {
      const compute = vi.fn(() => ({ value: 12345678901234567890n }));
      const a = new LiveMetricCache(db, 's');
      expect(a.memo('minute:p:60', 60, { amount: 1n }, compute)).toEqual(
        compute.mock.results[0]!.value,
      );
      expect(new LiveMetricCache(db, 's').memo('minute:p:60', 60, { amount: 1n }, compute)).toEqual(
        { value: 12345678901234567890n },
      );
      expect(compute).toHaveBeenCalledTimes(1);
      a.memo('minute:p:60', 60, { amount: 2n }, compute);
      expect(compute).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });
  it('expires hot contributions without touching other scopes and rolls back failed transactions', () => {
    const db = openDatabase(':memory:');
    try {
      const a = new LiveMetricCache(db, 's');
      a.memo('old', 60, {}, () => 1n);
      a.memo('keep', 120, {}, () => 2n);
      new LiveMetricCache(db, 'other').memo('old', 60, {}, () => 3n);
      expect(() =>
        db.transaction(() => {
          a.memo('keep', 120, { changed: true }, () => 9n);
          throw new Error('rollback');
        })(),
      ).toThrow('rollback');
      const compute = vi.fn(() => 99n);
      expect(a.memo('keep', 120, {}, compute)).toBe(2n);
      expect(compute).not.toHaveBeenCalled();
      a.expireBefore(120);
      expect(
        db
          .prepare('select scope_id,cache_key from live_metric_cache order by scope_id,cache_key')
          .all(),
      ).toEqual([
        { scope_id: 'other', cache_key: 'old' },
        { scope_id: 's', cache_key: 'keep' },
      ]);
    } finally {
      db.close();
    }
  });
});

it('sparse activity keeps durable cache work bounded by event minutes and preserves repaired windows', () => {
  const db = openDatabase(':memory:');
  try {
    const scale = makeScaleData({
      poolCount: 10,
      activePoolCount: 5,
      assetCount: 4,
      historyMinutes: 181,
    });
    const pools = scale.registrations.map((r) => ({
      pool: r.pool,
      discoveredAtBlock: r.discoveredAt.blockNumber,
      rawToken: r.token0,
    }));
    const cache = new LiveMetricCache(db, 's');
    let cacheReads = 0;
    const options = {
      pools,
      memo: <T>(key: string, at: number, input: unknown, compute: () => T): T => {
        cacheReads += 1;
        return cache.memo(key, at, input, compute);
      },
    };
    const assertEquivalent = (
      events: typeof scale.events,
      coverage: typeof scale.coverage,
      watermark = scale.watermark,
    ) => {
      cacheReads = 0;
      expect(buildRollingMetrics(events, coverage, watermark, options)).toEqual(
        buildRollingMetrics(events, coverage, watermark, { pools }),
      );
      expect(cacheReads).toBeLessThanOrEqual(events.length);
    };
    assertEquivalent(scale.events, scale.coverage);
    assertEquivalent(scale.events, scale.coverage);
    // Remove an event from a previously cached minute, then repair coverage while advancing time.
    assertEquivalent(
      scale.events.slice(1),
      scale.coverage.filter((_, i) => i !== 20),
      {
        ...scale.watermark,
        timestampSec: scale.watermark.timestampSec + 60,
      },
    );
    // Rolling back source time must not resurrect a stale empty contribution.
    assertEquivalent(scale.events, scale.coverage);
  } finally {
    db.close();
  }
});

it('minute cache invalidation follows derived values, not unused swap payload fields', () => {
  const db = openDatabase(':memory:');
  try {
    const scale = makeScaleData({
      poolCount: 2,
      activePoolCount: 2,
      assetCount: 2,
      historyMinutes: 181,
    });
    const pools = scale.registrations.map((r) => ({
      pool: r.pool,
      discoveredAtBlock: r.discoveredAt.blockNumber,
      rawToken: r.token0,
    }));
    const cache = new LiveMetricCache(db, 's');
    db.exec(
      'create temp table cache_writes(n integer); insert into cache_writes values(0); create temp trigger count_cache_writes after update on live_metric_cache begin update cache_writes set n=n+1; end;',
    );
    const memo = <T>(key: string, at: number, input: unknown, compute: () => T) =>
      cache.memo(key, at, input, compute);
    const before = buildRollingMetrics(scale.events, scale.coverage, scale.watermark, {
      pools,
      memo,
    });
    const irrelevant = scale.events.map((item) => ({
      ...item,
      event:
        item.event.kind === 'swap'
          ? {
              ...item.event,
              rawAmount0: item.event.rawAmount0 + 1n,
              tickAfter: item.event.tickAfter + 1,
            }
          : item.event,
    }));
    expect(
      buildRollingMetrics(irrelevant, scale.coverage, scale.watermark, { pools, memo }),
    ).toEqual(before);
    expect(db.prepare('select n from cache_writes').pluck().get()).toBe(0);
    const first = scale.events[0]!;
    const variants = [
      { ...first, usdMicros: null },
      { ...first, usdgNotionalRaw: 456n },
      { ...first, rawNotional: { token: 'changed', raw: 123n } },
      {
        ...first,
        event: {
          ...first.event,
          ref: { ...first.event.ref, transactionHash: ('0x' + 'f'.repeat(64)) as `0x${string}` },
        },
      },
      {
        ...first,
        event: {
          ...first.event,
          kind: 'liquidity' as const,
          delta: -1n,
          pool: first.event.pool!,
          tickLower: -60,
          tickUpper: 60,
          actor: ('0x' + '1'.repeat(40)) as `0x${string}`,
          salt: null,
        },
      },
    ];
    for (const changed of variants) {
      const events = [changed, ...scale.events.slice(1)];
      expect(buildRollingMetrics(events, scale.coverage, scale.watermark, { pools, memo })).toEqual(
        buildRollingMetrics(events, scale.coverage, scale.watermark, { pools }),
      );
    }
  } finally {
    db.close();
  }
});
