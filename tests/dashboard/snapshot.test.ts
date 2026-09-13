import * as metricStore from '../../src/storage/metric-store.js';
import { SqliteProjectionStore } from '../../src/storage/projection-store.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { LiveProjectionStore } from '../../src/storage/live-projection.js';
import { batch, hotLogs, metricInput, swap, anchor } from '../helpers/alert-fixture.js';
import {
  buildDashboardSnapshot,
  readDashboardSnapshot,
  createDashboardReader,
} from '../../src/dashboard/snapshot.js';
const handles: Database.Database[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});
function fixture(project = true, logs = hotLogs(), long = false) {
  const path = join(mkdtempSync(join(tmpdir(), 'dashboard-')), 'test.sqlite');
  const db = openDatabase(path);
  handles.push(db);
  const recorded = batch('initial', logs);
  if (long) {
    recorded.toBlock = 24000n;
    recorded.end = anchor(24000);
    recorded.previous = null;
    recorded.manifest.shards[0]!.request.toBlock = recorded.toBlock;
    recorded.boundaries = Array.from({ length: 400 }, (_, i) => {
      const t = 120 + i * 60;
      return {
        timestampSec: t,
        firstBlock: BigInt(t - 60),
        before: anchor(t - 61),
        at: anchor(t - 60),
      };
    });
  }
  new SqliteRangeStore(db).acceptRange(recorded);
  if (project) new LiveProjectionStore(db).sync('s', 's', 'c');
  const readonly = openDatabase(path, { readonly: true });
  handles.push(readonly);
  return { db, readonly, path };
}
test('fresh snapshot is read-only and compares equal duration against chain time', () => {
  const { db, readonly } = fixture();
  const before = db.prepare('select total_changes() as n').get();
  const result = buildDashboardSnapshot(readonly, metricInput, { nowMs: 4900000 });
  expect(result.sourceChainTimeSec).toBe(4860);
  expect(result.generatedAtMs).toBe(4900000);
  expect(result.tokens[0]!.windows['1m'].current.endSec).toBe(4860);
  expect(result.tokens[0]!.windows['1m'].previous.endSec).toBe(4800);
  expect(result.tokens[0]!.minutes.find((m) => m.minuteStartSec === 4740)?.txCount).toBe(1);
  expect(db.prepare('select total_changes() as n').get()).toEqual(before);
});
test('unprojected data is explicitly stale and cannot be silently repaired', () => {
  const { readonly } = fixture(false);
  expect(buildDashboardSnapshot(readonly, metricInput).status).toBe('stale');
});
test('historical end minute excludes later swaps, while complete empty minutes are zero', () => {
  const { readonly } = fixture(true, [swap(70), swap(200), swap(400)]);
  const result = buildDashboardSnapshot(readonly, metricInput, { at: 359, nowMs: 4900000 });
  expect(result.selectedEndSec).toBe(359);
  expect(result.tokens[0]!.windows['1m'].current.swapCount).toBe(0);
  expect(result.tokens[0]!.windows['1m'].previous.swapCount).toBe(1);
  expect(result.tokens[0]!.minutes.at(-1)?.minuteStartSec).toBe(4860);
});
test('missing minute coverage stays null and duplicate transaction logs count once per token', () => {
  const first = swap(200),
    second = { ...first, logIndex: 1 };
  const { db, readonly } = fixture(true, [swap(70), first, second]);
  let result = buildDashboardSnapshot(readonly, metricInput, { at: 299, nowMs: 4900000 });
  expect(result.tokens[0]!.windows['1m'].current).toMatchObject({ txCount: 1, swapCount: 2 });
  db.prepare('delete from minute_boundaries where scope_id=? and timestamp_sec=?').run('s', 300);
  new LiveProjectionStore(db).sync('s', 's', 'c');
  result = buildDashboardSnapshot(readonly, metricInput, { at: 299, nowMs: 4900000 });
  expect(result.tokens[0]!.windows['1m'].current.txCount).toBeNull();
});
test('invalid, future and too-old cutoffs are rejected', () => {
  const { readonly } = fixture();
  for (const at of [300, 4919, -1, NaN, 59])
    expect(() => buildDashboardSnapshot(readonly, metricInput, { at })).toThrow(RangeError);
});

test('missing source is empty and optional runtime data never leaks paths or provider fields', () => {
  const { path } = fixture();
  const missing = readDashboardSnapshot(path + '.missing', metricInput);
  expect(missing.status).toBe('empty');
  const noSidecar = readDashboardSnapshot(path, metricInput);
  expect(noSidecar.health.rpcCalls).toBeNull();
  expect(noSidecar.health.processingLatencyMs).toBeNull();
  expect(noSidecar.health.scannedBlock).toBe('4800');
  writeFileSync(
    path + '.health.json',
    JSON.stringify({
      databasePath: path,
      scopeId: 's',
      sampledAtMs: Date.now(),
      sourceAlias: 'secret-provider-key',
      runtimeState: 'healthy',
      rpc: { eth_getLogs: 12 },
      processingLatencyMs: 7,
    }),
  );
  const result = readDashboardSnapshot(path, metricInput);
  expect(result.health).toMatchObject({
    rpcCalls: 12,
    processingLatencyMs: 7,
    runtimeState: 'healthy',
  });
  expect(JSON.stringify(result)).not.toContain('secret-provider-key');
  expect(JSON.stringify(result)).not.toContain(path);
});
test('dashboard rejects writable handles and never invokes incremental sync while reading', () => {
  const { db, readonly } = fixture();
  expect(() => buildDashboardSnapshot(db, metricInput)).toThrow('read-only');
  const sync = vi.spyOn(LiveProjectionStore.prototype, 'sync').mockImplementation(() => {
    throw Error('unexpected write');
  });
  try {
    expect(buildDashboardSnapshot(readonly, metricInput).tokens).toHaveLength(1);
    expect(sync).not.toHaveBeenCalled();
  } finally {
    sync.mockRestore();
  }
});

test('latest pool swap keeps unknown seconds rather than displaying an earlier exact swap', () => {
  const { db, readonly } = fixture(true, [swap(70), swap(200)]);
  db.prepare('update log_times set exact_timestamp_sec=null where minute_start_sec=?').run(240);
  new LiveProjectionStore(db).sync('s', 's', 'c');
  const result = buildDashboardSnapshot(readonly, metricInput);
  expect(result.tokens[0]!.pools[0]!.lastSwapTimeSec).toBeNull();
});

test('explicit legacy reader verifies once and yields labeled bounded snapshots', () => {
  const { db, path } = fixture(false);
  new SqliteProjectionStore(db).rebuild('s', 's', 'c');
  const verify = vi.spyOn(SqliteProjectionStore.prototype, 'read');
  const reader = createDashboardReader(path, metricInput, { legacySnapshot: true });
  try {
    const first = reader.read();
    expect(first.tokens).toHaveLength(1);
    expect(first.notes).toContain('旧库只读快照 · 不自动跟随写入；重启重新核验');
    expect(reader.read(359).selectedEndSec).toBe(359);
    expect(verify).toHaveBeenCalledTimes(1);
  } finally {
    reader.close();
    verify.mockRestore();
  }
});
test('legacy reader invalidates on same-tip writes and never automatically repeats full verification', () => {
  const { db, path } = fixture(false);
  new SqliteProjectionStore(db).rebuild('s', 's', 'c');
  const reader = createDashboardReader(path, metricInput, { legacySnapshot: true });
  const verify = vi.spyOn(SqliteProjectionStore.prototype, 'read');
  try {
    expect(reader.read().tokens).toHaveLength(1);
    db.prepare('update log_times set exact_timestamp_sec=null where minute_start_sec=?').run(240);
    const stale = reader.read();
    expect(stale.status).toBe('stale');
    expect(stale.tokens).toEqual([]);
    expect(stale.message).toContain('重启');
    reader.read();
    expect(verify).toHaveBeenCalledTimes(1);
  } finally {
    reader.close();
    verify.mockRestore();
  }
});
test('legacy opt-in still prefers existing live cursor and does not perform full verification', () => {
  const { path } = fixture();
  const reader = createDashboardReader(path, metricInput, { legacySnapshot: true });
  const verify = vi.spyOn(SqliteProjectionStore.prototype, 'read').mockImplementation(() => {
    throw Error('full verification unexpected');
  });
  try {
    expect(reader.read().tokens).toHaveLength(1);
    expect(verify).not.toHaveBeenCalled();
  } finally {
    reader.close();
    verify.mockRestore();
  }
});

test('legacy full verification immediately trims known history before repeated metric builds', () => {
  const { db, path } = fixture(
    false,
    Array.from({ length: 398 }, (_, i) => swap(70 + i * 60)),
    true,
  );
  new SqliteProjectionStore(db).rebuild('s', 's', 'c');
  const report = vi.spyOn(metricStore, 'buildMetricsReport');
  const reader = createDashboardReader(path, metricInput, { legacySnapshot: true });
  try {
    const result = reader.read();
    expect(result.tokens).toHaveLength(1);
    const projected = report.mock.calls.at(-1)?.[2]?.projection;
    expect(projected?.events.length).toBeLessThanOrEqual(183);
    const floor = Math.floor(24060 / 60) * 60 - 180 * 60 - 120;
    expect(
      projected?.events.every(
        (e) => e.time.minuteStartSec === null || e.time.minuteStartSec >= floor,
      ),
    ).toBe(true);
    reader.read();
    expect(report.mock.calls.at(-1)?.[2]?.projection).toBe(projected);
  } finally {
    reader.close();
    report.mockRestore();
  }
});
