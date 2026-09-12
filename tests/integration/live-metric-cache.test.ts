import { describe, it, expect, vi } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { LiveMetricCache } from '../../src/storage/live-metric-cache.js';

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
