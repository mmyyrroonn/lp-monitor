import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { SqliteProjectionStore } from '../../src/storage/projection-store.js';
import { buildMetricsReport } from '../../src/storage/metric-store.js';
import { decimalsAt } from '../../src/metrics/metadata.js';
import { batch, hash, hotLogs, metricInput, rwa } from '../helpers/alert-fixture.js';

describe('live bounded metrics', () => {
  it('matches offline five-minute results and reuses persisted minute contributions', () => {
    const db = openDatabase(':memory:');
    try {
      const b = batch('first', hotLogs());
      b.previous = null;
      new SqliteRangeStore(db).acceptRange(b);
      new SqliteProjectionStore(db).rebuild('s', 's', 'c');
      const offline = buildMetricsReport(db, metricInput);
      const live = buildMetricsReport(db, metricInput, { live: { historyMinutes: 180 } });
      expect(live.windows.map((w) => w.recentClosed5x1m)).toEqual(
        offline.windows.map((w) => w.recentClosed5x1m),
      );
      expect(live.rwa).toEqual(offline.rwa);
      expect(db.prepare('select count(*) n from live_metric_cache').get()).not.toEqual({ n: 0 });
      const first = db
        .prepare(
          "select cache_key,input_hash,payload_json from live_metric_cache where cache_key like 'minute:%' order by cache_key",
        )
        .all();
      buildMetricsReport(db, metricInput, { live: { historyMinutes: 180 } });
      expect(
        db
          .prepare(
            "select cache_key,input_hash,payload_json from live_metric_cache where cache_key like 'minute:%' order by cache_key",
          )
          .all(),
      ).toEqual(first);
    } finally {
      db.close();
    }
  });

  it('hands consecutive rounds the same metadata object, so one index serves the run', () => {
    const db = openDatabase(':memory:');
    try {
      const b = batch('first', hotLogs());
      b.previous = null;
      new SqliteRangeStore(db).acceptRange(b);
      new SqliteProjectionStore(db).rebuild('s', 's', 'c');
      // One stored observation is what puts the report on the built cache rather than on the seed it
      // was handed, and the built cache is the object a round has to hand back: were it rebuilt per
      // round, `decimalsAt` would rebuild its index — a digest per entry — for every report.
      db.prepare(
        'insert into token_metadata(address,decimals,block_number,block_hash) values(?,?,?,?)',
      ).run(rwa, 8, 10, hash(10));
      const first = buildMetricsReport(db, metricInput, { live: { historyMinutes: 180 } });
      const second = buildMetricsReport(db, metricInput, { live: { historyMinutes: 180 } });
      // The height is one no stored anchor covers, so the seed's entries survive and the round has
      // nothing to reconcile away.
      expect(second.metadataConflicts).toEqual([]);
      expect(second.metadata).toBe(first.metadata);
      expect(decimalsAt(second.metadata, rwa, 10n)).toBe(8);
    } finally {
      db.close();
    }
  });
});

it('does not replay accumulated history; old contributions expire and a new swap is valued once', async () => {
  const { vi } = await import('vitest');
  const { commitAcceptedSignalBatch } = await import('../../src/signals/project.js');
  const { initialSignalConfig } = await import('../../src/signals/config.js');
  const { LiveProjectionStore } = await import('../../src/storage/live-projection.js');
  const { swap, anchor } = await import('../helpers/alert-fixture.js');
  const { rawLogKey } = await import('../../src/storage/manifest.js');
  const notional = await import('../../src/metrics/notional.js');
  const db = openDatabase(':memory:');
  try {
    const logs = Array.from({ length: 398 }, (_, i) => swap(70 + i * 60));
    const b = batch('long', logs);
    b.previous = null;
    b.toBlock = 24000n;
    b.end = anchor(24000);
    b.manifest.shards[0]!.request.toBlock = b.toBlock;
    b.boundaries = Array.from({ length: 400 }, (_, i) => {
      const t = 120 + i * 60;
      return {
        timestampSec: t,
        firstBlock: BigInt(t - 60),
        before: anchor(t - 61),
        at: anchor(t - 60),
      };
    });
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, b);
    const rebuild = vi.spyOn(SqliteProjectionStore.prototype, 'rebuild').mockImplementation(() => {
      throw new Error('full rebuild in hot path');
    });
    const decode = vi.spyOn(await import('../../src/protocols/uniswap-v3/decode.js'), 'decodeV3');
    const value = vi.spyOn(notional, 'valueSwap');
    db.exec(
      'create table cache_writes(k text); create trigger cache_write after update on live_metric_cache begin insert into cache_writes values(new.cache_key); end;',
    );
    const log = swap(24010, 3000);
    const next = batch('append', [log]);
    next.fromBlock = 24001n;
    next.toBlock = 24060n;
    next.previous = b.end;
    next.end = anchor(24060);
    next.manifest.shards[0]!.request.fromBlock = next.fromBlock;
    next.manifest.shards[0]!.request.toBlock = next.toBlock;
    next.poolRegistrations = b.poolRegistrations;
    next.boundaries = [
      { timestampSec: 24120, firstBlock: 24060n, before: anchor(24059), at: anchor(24060) },
    ];
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, next);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(value).toHaveBeenCalledTimes(1);
    expect(rebuild).not.toHaveBeenCalled();
    expect(db.prepare("select count(*) n from cache_writes where k like 'minute:%'").get()).toEqual(
      { n: 1 },
    );
    const snapshot = new LiveProjectionStore(db).read('s', 's', 'c', 24120 - 180 * 60)!;
    expect(snapshot.events.length).toBeLessThan(190);
    expect(db.prepare('select count(*) n from raw_logs').get()).toEqual({ n: 399 });
    expect(db.prepare('select min(minute_start_sec) m from live_metric_cache').get()).toEqual({
      m: 13200,
    });
    const current = buildMetricsReport(db, metricInput, { live: { historyMinutes: 180 } });
    expect(current.windows[0]!.rolling?.['1m']?.usdMicros).toBe(3000_000000n);
    expect(
      current.valuations.every(
        (v) => v.time.minuteStartSec === null || v.time.minuteStartSec >= current.liveSinceSec!,
      ),
    ).toBe(true);
    expect(current.rwa[0]!.blockRangeActivity.swapCount).toBe(current.valuations.length);
    expect(current.valuations.find((v) => v.eventId === rawLogKey(log))?.usdMicros).toBe(
      3000_000000n,
    );
    vi.restoreAllMocks();
  } finally {
    vi.restoreAllMocks();
    db.close();
  }
});

it('window expiry keeps prior alerts, and a later archived correction survives an intermediate metric read', async () => {
  const { commitAcceptedSignalBatch, projectSignals } =
    await import('../../src/signals/project.js');
  const { initialSignalConfig } = await import('../../src/signals/config.js');
  const { anchor } = await import('../helpers/alert-fixture.js');
  const { decodeSignalState } = await import('../../src/signals/codec.js');
  const db = openDatabase(':memory:');
  try {
    const first = batch('hot', hotLogs());
    first.previous = null;
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, first);
    const later = batch('later', [...first.logs]);
    later.toBlock = 24000n;
    later.end = anchor(24000);
    later.manifest.shards[0]!.request.toBlock = 24000n;
    later.boundaries = Array.from({ length: 400 }, (_, i) => {
      const t = 120 + i * 60;
      return {
        timestampSec: t,
        firstBlock: BigInt(t - 60),
        before: anchor(t - 61),
        at: anchor(t - 60),
      };
    });
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, later);
    const records = () =>
      (db.prepare('select payload_json from alerts').all() as { payload_json: string }[]).map((r) =>
        decodeSignalState<any>(r.payload_json),
      );
    expect(records().map((r) => r.kind)).toEqual(['hot']);
    db.prepare('delete from minute_boundaries where scope_id=? and timestamp_sec=?').run('s', 4620);
    buildMetricsReport(db, metricInput, { live: { historyMinutes: 180 } });
    expect(
      db.prepare('select min_block from live_pending_signal_repairs where scope_id=?').get('s'),
    ).toBeDefined();
    projectSignals(db, metricInput, initialSignalConfig, {
      batchId: 'repaired',
      observedAtMs: 200000,
      captureMode: 'synthetic',
    });
    expect(records().map((r) => r.kind)).toEqual(['retracted']);
    expect(
      db.prepare('select min_block from live_pending_signal_repairs where scope_id=?').get('s'),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});

it('reads an upgraded database through the live cursor without writing or consulting its stale offline cursor', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { vi } = await import('vitest');
  const { LiveProjectionStore } = await import('../../src/storage/live-projection.js');
  const { anchor } = await import('../helpers/alert-fixture.js');
  const directory = mkdtempSync(join(tmpdir(), 'lp-live-readonly-'));
  const path = join(directory, 'db.sqlite');
  let db = openDatabase(path);
  try {
    const b = batch('first', hotLogs());
    b.previous = null;
    const raw = new SqliteRangeStore(db);
    raw.acceptRange(b);
    new SqliteProjectionStore(db).rebuild('s', 's', 'c');
    const next = batch('next', hotLogs());
    next.toBlock = 4801n;
    next.end = anchor(4801);
    next.manifest.shards[0]!.request.toBlock = 4801n;
    raw.acceptRange(next);
    new LiveProjectionStore(db).sync('s', 's', 'c');
    db.close();
    db = openDatabase(path, { readonly: true });
    const before = db.prepare('select count(*) n from live_metric_cache').get();
    const offline = vi.spyOn(SqliteProjectionStore.prototype, 'read').mockImplementation(() => {
      throw new Error('obsolete offline cursor');
    });
    const report = buildMetricsReport(db, metricInput);
    expect(report.at.number).toBe(4801n);
    expect(report.windows[0]!.rolling?.['5m']?.swapCount).toBe(5);
    expect(offline).not.toHaveBeenCalled();
    expect(db.prepare('select count(*) n from live_metric_cache').get()).toEqual(before);
  } finally {
    vi.restoreAllMocks();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps accepted large sample configurations within the existing coverage limit', async () => {
  const { commitAcceptedSignalBatch } = await import('../../src/signals/project.js');
  const { initialSignalConfig } = await import('../../src/signals/config.js');
  const db = openDatabase(':memory:');
  try {
    const b = batch('large-samples', hotLogs());
    b.previous = null;
    const config = {
      ...initialSignalConfig,
      candidate: { ...initialSignalConfig.candidate, samples: 20000 },
    };
    expect(() => commitAcceptedSignalBatch(db, metricInput, config, b)).not.toThrow();
    expect(new SqliteRangeStore(db).acceptedTip('s')).toEqual(b.end);
  } finally {
    db.close();
  }
});
