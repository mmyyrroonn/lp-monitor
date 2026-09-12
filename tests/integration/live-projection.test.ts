import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import * as v3Decode from '../../src/protocols/uniswap-v3/decode.js';
import { encodeAbiParameters, encodeEventTopics, toHex, type Hex } from 'viem';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { SqliteProjectionStore } from '../../src/storage/projection-store.js';
import { LiveProjectionStore, readProjectionWatermark } from '../../src/storage/live-projection.js';
import {
  rawLogKey,
  type RecordedRangeBatch,
  type PersistedPoolRegistration,
} from '../../src/storage/manifest.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import type { RawLog, LogTime } from '../../src/domain/types.js';
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const address = toHex(1, { size: 20 });
const hash = (n: number) => toHex(n, { size: 32 });
const anchor = { number: 120n, hash: hash(120), timestampSec: 180 };
const minute: LogTime = { minuteStartSec: 120, exactTimestampSec: null, source: 'minute-boundary' };
const swap = (n: number): RawLog => ({
  address,
  blockNumber: BigInt(n),
  blockHash: hash(n),
  transactionHash: hash(n + 1000),
  transactionIndex: 0,
  logIndex: 0,
  rawBlockTimestamp: '0x0',
  topics: encodeEventTopics({
    abi: v3PoolAbi,
    eventName: 'Swap',
    args: { sender: address, recipient: address },
  }) as Hex[],
  data: encodeAbiParameters(
    [
      { type: 'int256' },
      { type: 'int256' },
      { type: 'uint160' },
      { type: 'uint128' },
      { type: 'int24' },
    ],
    [2n ** 150n, -90n, 2n ** 96n, 1000n, 0],
  ),
});
const registration = (log: RawLog): PersistedPoolRegistration => ({
  pool: { chainId: 4663, protocol: 'v3', address },
  token0: address,
  token1: toHex(2, { size: 20 }),
  feePips: 3000,
  tickSpacing: 60,
  hooks: toHex(0, { size: 20 }),
  assetVersion: 'test-v1',
  source: 'synthetic',
  discoveredAt: log,
});
function batch(id: string, logs: RawLog[], time = minute, scopeId = 'test'): RecordedRangeBatch {
  return {
    id,
    scopeId,
    fromBlock: 100n,
    toBlock: 120n,
    end: anchor,
    previous: anchor,
    logs,
    observedAtMs: 1,
    captureMode: 'synthetic',
    filterPlanHash: 'test',
    manifestHash: id,
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'test',
      expectedShardIds: ['one'],
      shards: [
        {
          shardId: 'one',
          filterId: 'operation-v3',
          request: { fromBlock: 100n, toBlock: 120n, address: [address], topics: [] },
          status: 'success',
          responseHash: hash(1),
          logKeys: logs.map(rawLogKey),
          logCount: logs.length,
          error: null,
        },
      ],
    },
    logTimes: logs.map((log) => ({ ref: log, time })),
    poolRegistrations: logs.length ? [registration(logs[0]!)] : [],
  };
}

test('incremental projection matches replay and repairs direct SQL retimes and removals', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db),
    live = new LiveProjectionStore(db),
    offline = new SqliteProjectionStore(db);
  raw.acceptRange(batch('first', [swap(105), swap(110)]));
  live.sync('test');
  expect(live.read('test', 'test', 'unspecified', 0)?.events).toEqual(
    offline.rebuild('test').events,
  );
  db.prepare(
    'update log_times set minute_start_sec=240 where raw_log_id=(select max(id) from raw_logs)',
  ).run();
  expect(live.read('test', 'test', 'unspecified', 0)).toBeNull();
  new LiveProjectionStore(db).sync('test');
  expect(live.read('test', 'test', 'unspecified', 180)?.events).toHaveLength(1);
  db.prepare('delete from active_logs where raw_log_id=(select max(id) from raw_logs)').run();
  live.sync('test');
  expect(live.read('test', 'test', 'unspecified', 0)?.observations).toEqual(
    offline.rebuild('test').observations,
  );
  expect(db.prepare('select count(*) n from live_dirty_logs').get()).toEqual({ n: 0 });
});
test('no-op sync does not rewrite events; rollback leaves projection fresh', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db),
    live = new LiveProjectionStore(db);
  raw.acceptRange(batch('first', [swap(105)]));
  live.sync('test');
  db.exec(
    "create trigger deny_event_update before delete on live_events begin select raise(abort,'unexpected event rewrite'); end",
  );
  live.sync('test');
  const before = live.read('test', 'test', 'unspecified', 0);
  expect(() =>
    db.transaction(() => {
      db.exec('delete from log_times');
      throw Error('rollback');
    })(),
  ).toThrow('rollback');
  expect(live.read('test', 'test', 'unspecified', 0)).toEqual(before);
});
test('registry removal and readdition repair only affected evidence, raw corrections remain visible', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db),
    live = new LiveProjectionStore(db),
    offline = new SqliteProjectionStore(db);
  raw.acceptRange(batch('a', [swap(105), swap(110)]));
  live.sync('test');
  const registrationRow = db.prepare('select * from pools').get() as Record<string, unknown>;
  db.exec('delete from pools');
  expect(live.sync('test').repairFrom).toBe(105n);
  expect(live.read('test', 'test', 'unspecified', 0)?.qualityErrors).toEqual(
    offline.rebuild('test').qualityErrors,
  );
  db.prepare(
    'insert into pools(scope_id,pool_key,protocol,discovered_raw_log_id,discovered_block_number,discovered_block_hash,payload_json) values(@scope_id,@pool_key,@protocol,@discovered_raw_log_id,@discovered_block_number,@discovered_block_hash,@payload_json)',
  ).run(registrationRow);
  live.sync('test');
  db.prepare("update raw_logs set data='0x00' where block_number=110").run();
  live.sync('test');
  const actual = live.read('test', 'test', 'unspecified', 0),
    expected = offline.rebuild('test');
  expect(actual?.events).toEqual(expected.events);
  expect(actual?.qualityErrors).toEqual(expected.qualityErrors);
  expect(actual?.observations).toEqual(expected.observations);
});
test('discovery does not accumulate dirty history, appends retain old rows and observations', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db),
    live = new LiveProjectionStore(db);
  raw.acceptRange(batch('a', [swap(105)]));
  expect(db.prepare('select count(*) n from live_dirty_logs').get()).toEqual({ n: 0 });
  live.sync('test');
  db.exec(
    "create trigger preserve_old before delete on live_events when old.block_number=105 begin select raise(abort,'old row rewritten'); end",
  );
  const next = batch('b', [swap(105), swap(125)]);
  next.toBlock = 130n;
  next.end = { number: 130n, hash: hash(130), timestampSec: 240 };
  next.manifest.shards[0]!.request.toBlock = 130n;
  raw.acceptRange(next);
  expect(live.sync('test').repairFrom).toBeNull();
  expect(live.read('test', 'test', 'unspecified', 0)?.events).toHaveLength(2);
  expect(live.read('test', 'test', 'unspecified', 300)?.events).toHaveLength(0);
  expect(
    live.read('test', 'test', 'unspecified', 300)?.observations[0]?.lastSwap?.ref.blockNumber,
  ).toBe(125n);
});
test('unknown event expiry requires a boundary, retaining unknown before the first resolved swap', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db),
    live = new LiveProjectionStore(db);
  raw.acceptRange(batch('a', [swap(105), swap(110)]));
  db.exec('delete from log_times');
  live.sync('test');
  expect(live.read('test', 'test', 'unspecified', 180)?.events).toHaveLength(0);
  expect(live.read('test', 'test', 'unspecified', 180)?.windowContextIncomplete).toBe(true);
  db.prepare('insert into minute_boundaries values(?,?,?,?,?,?,?,?,?)').run(
    'test',
    180,
    108,
    107,
    hash(107),
    179,
    108,
    hash(108),
    180,
  );
  expect(live.read('test', 'test', 'unspecified', 180)).toBeNull();
  live.sync('test');
  expect(
    live.read('test', 'test', 'unspecified', 180)?.events.map((e) => e.ref.blockNumber),
  ).toEqual([110n]);
});

test('health watermark prefers verified live revisions and does not fall back after correction', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db),
    live = new LiveProjectionStore(db),
    offline = new SqliteProjectionStore(db);
  raw.acceptRange(batch('a', [swap(105)]));
  const old = offline.rebuild('test');
  expect(readProjectionWatermark(db, 'test')?.source_hash).toBe(old.sourceHash);
  live.sync('test');
  expect(readProjectionWatermark(db, 'test')?.source_hash).toBe(live.read('test')?.sourceHash);
  db.exec('update log_times set minute_start_sec=240');
  expect(readProjectionWatermark(db, 'test')).toBeUndefined();
  live.sync('test');
  expect(readProjectionWatermark(db, 'test')?.block_number).toBe(120);
});

test('duplicate accepted overlap decodes zero unchanged events', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db),
    live = new LiveProjectionStore(db);
  raw.acceptRange(batch('a', [swap(105), swap(110)]));
  live.sync('test');
  const decode = vi.spyOn(v3Decode, 'decodeV3');
  try {
    raw.acceptRange(batch('b', [swap(105), swap(110)]));
    expect(live.sync('test').repairFrom).toBeNull();
    expect(decode).not.toHaveBeenCalled();
  } finally {
    decode.mockRestore();
  }
});
test('historical coverage-only edits emit repairs; duplicate boundaries and current closure do not', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db),
    live = new LiveProjectionStore(db);
  raw.acceptRange(batch('a', []));
  live.sync('test');
  const boundary = db.prepare('insert into minute_boundaries values(?,?,?,?,?,?,?,?,?)');
  boundary.run('test', 120, 100, 99, hash(99), 119, 100, hash(100), 120);
  expect(live.sync('test').repairFrom).toBe(0n);
  db.exec('update minute_boundaries set first_block=first_block');
  expect(live.sync('test').repairFrom).toBeNull();
  boundary.run('test', 240, 130, 129, hash(129), 239, 130, hash(130), 240);
  expect(live.sync('test').repairFrom).toBeNull();
  db.exec('delete from minute_boundaries where timestamp_sec=120');
  expect(live.sync('test').repairFrom).toBe(0n);
  db.exec('delete from accepted_ranges');
  expect(live.sync('test').repairFrom).toBe(100n);
  expect(db.prepare('select count(*) n from live_dirty_coverage').get()).toEqual({ n: 0 });
});

test('a process reopening SQLite consumes pending repairs and revives protocol bigint quantities', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lp-live-projection-'));
  const path = join(directory, 'state.sqlite');
  let db = openDatabase(path);
  try {
    new SqliteRangeStore(db).acceptRange(batch('a', [swap(105), swap(110)]));
    new LiveProjectionStore(db).sync('test');
    db.exec('delete from active_logs where raw_log_id=(select max(id) from raw_logs)');
    db.close();
    db = openDatabase(path);
    const live = new LiveProjectionStore(db);
    expect(live.read('test')).toBeNull();
    expect(live.sync('test').repairFrom).toBe(110n);
    expect(live.read('test')?.observations[0]?.lastSwap?.rawAmount0).toBe(2n ** 150n);
    expect(live.read('test')?.events).toHaveLength(1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('signal repairs survive independent sync consumers and rolled back acknowledgement', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db),
    live = new LiveProjectionStore(db);
  raw.acceptRange(batch('a', [swap(105), swap(110)]));
  live.sync('test');
  expect(db.prepare('select * from live_pending_signal_repairs').all()).toEqual([]);
  db.exec('delete from active_logs where raw_log_id=(select max(id) from raw_logs)');
  expect(live.sync('test').repairFrom).toBe(110n);
  expect(live.sync('test').repairFrom).toBeNull();
  expect(db.prepare('select * from live_pending_signal_repairs').get()).toEqual({
    scope_id: 'test',
    min_block: 110,
  });
  expect(() =>
    db.transaction(() => {
      db.exec('delete from live_pending_signal_repairs');
      throw Error('failed signal transaction');
    })(),
  ).toThrow('failed signal transaction');
  expect(db.prepare('select min_block from live_pending_signal_repairs').get()).toEqual({
    min_block: 110,
  });
  db.exec('update log_times set minute_start_sec=240');
  live.sync('test');
  expect(db.prepare('select min_block from live_pending_signal_repairs').get()).toEqual({
    min_block: 105,
  });
});

test('positive window without a proving boundary does not materialize arbitrary unknown history', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db),
    live = new LiveProjectionStore(db);
  raw.acceptRange(batch('a', [swap(105), swap(110)]));
  db.exec('delete from log_times');
  live.sync('test');
  // Poison old payloads to prove the bounded reader never parses omitted history.
  db.exec(
    "update live_events set payload_json='not-json'; update live_quality_errors set payload_json='not-json'",
  );
  const result = live.read('test', 'test', 'unspecified', 180);
  expect(result?.events).toEqual([]);
  expect(result?.qualityErrors).toEqual([]);
  expect(result?.windowContextIncomplete).toBe(true);
  expect(live.read('test', 'test', 'unspecified', 180)?.windowContextIncomplete).toBe(true);
});
test('an ancient boundary does not authorize materializing unknown history for a later window', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db),
    live = new LiveProjectionStore(db);
  raw.acceptRange(batch('a', [swap(105), swap(110)]));
  db.exec('delete from log_times');
  db.prepare('insert into minute_boundaries values(?,?,?,?,?,?,?,?,?)').run(
    'test',
    120,
    100,
    99,
    hash(99),
    119,
    100,
    hash(100),
    120,
  );
  live.sync('test');
  db.exec(
    "update live_events set payload_json='not-json'; update live_quality_errors set payload_json='not-json'",
  );
  const result = live.read('test', 'test', 'unspecified', 13200);
  expect(result?.events).toEqual([]);
  expect(result?.qualityErrors).toEqual([]);
  expect(result?.windowContextIncomplete).toBe(true);
});
