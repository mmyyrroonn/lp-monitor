import { afterEach, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, toHex, type Hex } from 'viem';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { LiveProjectionStore } from '../../src/storage/live-projection.js';
import { eventIndexFor, type LiveEventIndexStore } from '../../src/storage/live-event-index.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';
import { storedRegistrationJson } from '../../src/storage/registration-codec.js';
import {
  rawLogKey,
  type PersistedPoolRegistration,
  type RecordedRangeBatch,
} from '../../src/storage/manifest.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import type { LogTime, PoolEvent, RawLog } from '../../src/domain/types.js';

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const SCOPE = 'test';
const pool = toHex(1, { size: 20 });
const rwa = toHex(2, { size: 20 });
const usdg = toHex(3, { size: 20 });
const hash = (n: number) => toHex(n, { size: 32 });
const anchor = { number: 120n, hash: hash(120), timestampSec: 180 };
const POOL_ID = `4663:v3:${pool.toLowerCase()}`;
const minute = (minuteStartSec: number): LogTime => ({
  minuteStartSec,
  exactTimestampSec: null,
  source: 'minute-boundary',
});
const UNKNOWN: LogTime = { minuteStartSec: null, exactTimestampSec: null, source: 'unresolved' };
const swap = (n: number): RawLog => ({
  address: pool,
  blockNumber: BigInt(n),
  blockHash: hash(n),
  transactionHash: hash(n + 1000),
  transactionIndex: 0,
  logIndex: 0,
  rawBlockTimestamp: '0x0',
  topics: encodeEventTopics({
    abi: v3PoolAbi,
    eventName: 'Swap',
    args: { sender: pool, recipient: pool },
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
/** amount0 is positive, so the registration's other token is always the one the swap takes in. */
const registration = (token0: Hex): PersistedPoolRegistration => ({
  pool: { chainId: 4663 as const, protocol: 'v3' as const, address: pool },
  token0,
  token1: usdg,
  feePips: 3000,
  tickSpacing: 60,
  hooks: toHex(0, { size: 20 }),
  assetVersion: 'test-v1',
  source: 'synthetic',
  discoveredAt: swap(105),
});

function batch(
  id: string,
  logs: RawLog[],
  times: LogTime[],
  token0: Hex = rwa,
): RecordedRangeBatch {
  return {
    id,
    scopeId: SCOPE,
    fromBlock: 1n,
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
          request: { fromBlock: 1n, toBlock: 120n, address: [pool], topics: [] },
          status: 'success',
          responseHash: hash(1),
          logKeys: logs.map(rawLogKey),
          logCount: logs.length,
          error: null,
        },
      ],
    },
    logTimes: logs.map((ref, index) => ({ ref, time: times[index]! })),
    poolRegistrations: logs.length ? [registration(token0)] : [],
  };
}

function fixture() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return { db, raw: new SqliteRangeStore(db) };
}
const sync = (db: Database.Database) => new LiveProjectionStore(db).sync(SCOPE, SCOPE, 'c');

/** Run `work` under the structural counters and report what the live window read from SQLite. */
function measured<T>(work: () => T): { value: T; rows: number } {
  const scope = openWorkCounts();
  try {
    return { value: work(), rows: scope.counts.liveEventRowsRead };
  } finally {
    scope.close();
  }
}

/**
 * Establish the window the way the first round of a process does. The first read owes nothing —
 * nothing was held before it — so a caller only ever learns what left from a later bound.
 */
function open(
  index: LiveEventIndexStore,
  sinceSec = 0,
  sinceBlock: bigint | null = null,
): { expired: ReadonlySet<string>; rows: number } {
  const opened = measured(() => index.expire({ sinceSec, sinceBlock }));
  expect(opened.value).toEqual(new Set());
  return { expired: opened.value, rows: opened.rows };
}

const blocksOf = (index: LiveEventIndexStore): number[] =>
  measured(() => index.eventsFor(index.pools())).value.map((e: PoolEvent) =>
    Number(e.ref.blockNumber),
  );

test('a swap enters the window by key and a repeated sync neither rewrites nor re-reads it', () => {
  const { db, raw } = fixture();
  raw.acceptRange(batch('a', [swap(105), swap(110)], [minute(120), minute(120)]));
  const first = sync(db);
  expect(first.eventDelta?.upserts.map((e) => Number(e.ref.blockNumber)).sort()).toEqual([
    105, 110,
  ]);
  expect(first.eventDelta?.deletedKeys).toEqual([]);

  const index = eventIndexFor(db, SCOPE);
  expect(open(index).rows).toBe(2);
  expect(index.size).toBe(2);
  expect(index.pools()).toEqual(new Set([POOL_ID]));
  expect(blocksOf(index)).toEqual([105, 110]);

  // The same batch syncing again is a no-op by proof, not by re-reading: the token it would have
  // written is the one already stored, so no event row is read for a delta and none for a window.
  const second = measured(() => sync(db));
  expect(second.value.eventDelta).toEqual({ upserts: [], deletedKeys: [] });
  expect(second.rows).toBe(0);
  expect(index.size).toBe(2);
  expect(measured(() => index.eventsFor(index.pools())).rows).toBe(0);
});

test('a time revision replaces the contribution at the same key instead of adding a second one', () => {
  const { db, raw } = fixture();
  raw.acceptRange(batch('a', [swap(105), swap(110)], [minute(120), minute(120)]));
  sync(db);
  const index = eventIndexFor(db, SCOPE);
  open(index);
  const revisedKey = rawLogKey(swap(110));

  db.prepare(
    'update log_times set minute_start_sec=240 where scope_id=? and minute_start_sec=120',
  ).run(SCOPE);
  const revised = sync(db);
  expect(revised.eventDelta?.upserts).toHaveLength(2);
  expect(revised.eventDelta?.deletedKeys).toEqual([]);

  // Nothing here reloaded: the window the round answered from is the one the delta just advanced.
  const events = measured(() => index.eventsFor(index.pools()));
  expect(events.rows).toBe(0);
  expect(index.size).toBe(2);
  expect(events.value.map((e) => [Number(e.ref.blockNumber), e.time.minuteStartSec])).toEqual([
    [105, 240],
    [110, 240],
  ]);
  // The revised log key is still one key: the window holds one event for it, never two.
  expect(events.value.filter((e) => rawLogKey(e.ref) === revisedKey)).toHaveLength(1);
});

test('a removal retires its key from the window, the pool index and the token index', () => {
  const { db, raw } = fixture();
  raw.acceptRange(batch('a', [swap(105)], [minute(120)]));
  sync(db);
  const index = eventIndexFor(db, SCOPE);
  open(index);
  const removed = rawLogKey(swap(105));
  expect(measured(() => index.poolsForToken(rwa)).value).toEqual(new Set([POOL_ID]));

  db.prepare(
    'delete from active_logs where scope_id=? and raw_log_id=(select id from raw_logs where raw_key=?)',
  ).run(SCOPE, removed);
  const changes = sync(db);
  expect(changes.eventDelta?.deletedKeys).toEqual([removed]);
  expect(changes.eventDelta?.upserts).toEqual([]);

  const read = measured(() => index.poolsForToken(rwa));
  expect(read.rows).toBe(0);
  expect(index.size).toBe(0);
  expect(index.pools()).toEqual(new Set());
  expect(read.value).toEqual(new Set());
  expect(index.poolsForToken(usdg)).toEqual(new Set());
  expect(index.eventsFor(new Set([POOL_ID]))).toEqual([]);
});

test('a revised registration moves the same key to its new tokens without leaving the old ones', () => {
  const { db, raw } = fixture();
  const next = toHex(4, { size: 20 });
  raw.acceptRange(batch('a', [swap(105)], [minute(120)], rwa));
  sync(db);
  const index = eventIndexFor(db, SCOPE);
  open(index);
  expect(measured(() => index.poolsForToken(rwa)).value).toEqual(new Set([POOL_ID]));
  expect(index.poolsForToken(next)).toEqual(new Set());

  // The very same log now decodes against a registration whose input token is a different asset.
  db.prepare('update pools set payload_json=? where scope_id=?').run(
    storedRegistrationJson(registration(next)),
    SCOPE,
  );
  sync(db);

  const moved = measured(() => index.poolsForToken(rwa));
  expect(moved.rows).toBe(0);
  expect(index.size).toBe(1);
  expect(blocksOf(index)).toEqual([105]);
  expect(moved.value).toEqual(new Set());
  expect(index.poolsForToken(next)).toEqual(new Set([POOL_ID]));
  // The token the revision did not change keeps its contribution through the same rewrite.
  expect(index.poolsForToken(usdg)).toEqual(new Set([POOL_ID]));
});

test('expire drops the minutes that left the window and reports each pool once', () => {
  const { db, raw } = fixture();
  raw.acceptRange(
    batch('a', [swap(105), swap(110), swap(115)], [minute(120), minute(180), minute(240)]),
  );
  sync(db);
  const index = eventIndexFor(db, SCOPE);
  expect(open(index, 120).rows).toBe(3);
  expect(index.size).toBe(3);

  // A minute leaves while its pool still has two events in the window: nothing is owed yet.
  expect(index.expire({ sinceSec: 180, sinceBlock: null })).toEqual(new Set());
  expect(index.size).toBe(2);
  expect(index.expire({ sinceSec: 240, sinceBlock: null })).toEqual(new Set());
  expect(index.size).toBe(1);

  // The last one leaves: the pool is reported exactly once, for the round it left in.
  expect(index.expire({ sinceSec: 300, sinceBlock: null })).toEqual(new Set([POOL_ID]));
  expect(index.size).toBe(0);
  expect(index.expire({ sinceSec: 360, sinceBlock: null })).toEqual(new Set());
  expect(index.recentlyExpired).toEqual(new Set([POOL_ID]));
});

test('an unknown-time event is held while no boundary can bound it, and the window says so', () => {
  const { db, raw } = fixture();
  raw.acceptRange(batch('a', [swap(105), swap(110)], [minute(120), UNKNOWN]));
  sync(db);
  const index = eventIndexFor(db, SCOPE);
  expect(open(index).rows).toBe(2);

  // The resolved minute leaves on its own evidence; the unresolved one has none, so it stays and
  // the window reports the missing boundary instead of dropping an event it cannot place.
  expect(index.expire({ sinceSec: 180, sinceBlock: null })).toEqual(new Set());
  expect(index.size).toBe(1);
  expect(blocksOf(index)).toEqual([110]);
  expect(index.windowContextIncomplete).toBe(true);
  expect(index.recentlyExpired).toEqual(new Set());
});

test('a verified boundary releases the unknown-time event it can bound', () => {
  const { db, raw } = fixture();
  raw.acceptRange(batch('a', [swap(105), swap(110)], [minute(120), UNKNOWN]));
  sync(db);
  const index = eventIndexFor(db, SCOPE);
  expect(open(index).rows).toBe(2);
  expect(index.expire({ sinceSec: 180, sinceBlock: null })).toEqual(new Set());
  expect(index.windowContextIncomplete).toBe(true);

  // A boundary above it proves it is outside the window, and the pool still owes one evaluation:
  // being carried here is what turns "its events are gone" into a cooling result.
  expect(index.expire({ sinceSec: 180, sinceBlock: 115n })).toEqual(new Set([POOL_ID]));
  expect(index.size).toBe(0);
  expect(index.windowContextIncomplete).toBe(false);
  expect(index.recentlyExpired).toEqual(new Set([POOL_ID]));
  expect(index.pools()).toEqual(new Set());
});

test('the first load reads only the window rows and a later round reads none of them', () => {
  const { db, raw } = fixture();
  const logs = Array.from({ length: 60 }, (_, i) => swap(61 + i));
  const times = logs.map((_, i) => minute(120 + i * 60));
  raw.acceptRange(batch('a', logs, times));
  sync(db);
  const index = eventIndexFor(db, SCOPE);

  // Sixty events are stored; a window over the last twenty minutes is answered from twenty.
  expect(open(index, 2520).rows).toBe(20);
  expect(index.size).toBe(20);
  expect(blocksOf(index)[0]).toBe(101);
  expect(measured(() => index.expire({ sinceSec: 2520, sinceBlock: null }))).toEqual({
    value: new Set(),
    rows: 0,
  });
  expect(index.size).toBe(20);
});

test('a window that outlived a rolled back round is derived again from the rows that survived', () => {
  const { db, raw } = fixture();
  raw.acceptRange(batch('a', [swap(105)], [minute(120)]));
  sync(db);
  const index = eventIndexFor(db, SCOPE);
  expect(open(index).rows).toBe(1);
  expect(blocksOf(index)).toEqual([105]);

  // A second batch replaces the active log, and the round that would project it never commits.
  raw.acceptRange(batch('b', [swap(110)], [minute(120)]));
  expect(() =>
    db.transaction(() => {
      sync(db);
      throw new Error('rollback');
    })(),
  ).toThrow('rollback');

  // The cursor the round wrote went back with the rest of its transaction, and the window that was
  // derived from those rows goes back with it rather than being trusted for the rest of the process.
  const recovered = measured(() => index.expire({ sinceSec: 0, sinceBlock: null }));
  expect(recovered.rows).toBe(1);
  expect(recovered.value).toEqual(new Set());
  expect(index.size).toBe(1);
  expect(blocksOf(index)).toEqual([105]);

  // Once the round really commits, the window is the one that round wrote and stays that way.
  sync(db);
  expect(blocksOf(index)).toEqual([110]);
  expect(measured(() => index.expire({ sinceSec: 0, sinceBlock: null }))).toEqual({
    value: new Set(),
    rows: 0,
  });
  expect(index.size).toBe(1);
});

test('delta tracking follows the sync delta applied directly to the index', () => {
  const { db, raw } = fixture();
  raw.acceptRange(batch('a', [swap(105), swap(110)], [minute(120), minute(120)]));
  const index = eventIndexFor(db, SCOPE);
  index.enableDeltaTracking();
  // The first sync applies its own delta to the same index the test holds, and the tracker reports
  // exactly that delta without a second walk.
  sync(db);
  expect(index.takeEventDelta().upserts.map((e) => Number(e.ref.blockNumber))).toEqual([105, 110]);
  expect(index.takeEventDelta()).toEqual({ upserts: [], deletedKeys: [] });
});

test('delta tracking reports installs, revisions, removals and slide-outs across reloads', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'live-index-delta-')), 'test.sqlite');
  const db = openDatabase(path);
  dbs.push(db);
  const raw = new SqliteRangeStore(db);
  raw.acceptRange(
    batch('a', [swap(105), swap(110), swap(115)], [minute(120), minute(180), minute(240)]),
  );
  sync(db);
  // The reader is a second, read-only handle on the file, exactly as the dashboard worker opens it:
  // its window is derived from the rows, never from the writer's own applied delta.
  const readonly = openDatabase(path, { readonly: true });
  dbs.push(readonly);
  const index = eventIndexFor(readonly, SCOPE);
  index.enableDeltaTracking();

  // The first load reads the window rows and reports every event as new, once.
  expect(open(index).rows).toBe(3);
  expect(index.takeEventDelta().upserts.map((e) => Number(e.ref.blockNumber))).toEqual([
    105, 110, 115,
  ]);
  expect(index.takeEventDelta()).toEqual({ upserts: [], deletedKeys: [] });

  // A re-timing revises the keys already held: each is an upsert again, none is a deletion.
  db.prepare('update log_times set minute_start_sec=300 where scope_id=?').run(SCOPE);
  sync(db);
  index.expire({ sinceSec: 0, sinceBlock: null });
  expect(index.takeEventDelta().upserts).toHaveLength(3);
  expect(index.takeEventDelta()).toEqual({ upserts: [], deletedKeys: [] });

  // A removal retires its key, and the unchanged keys are recognized as such rather than re-reported.
  const removed = rawLogKey(swap(105));
  db.prepare(
    'delete from active_logs where scope_id=? and raw_log_id=(select id from raw_logs where raw_key=?)',
  ).run(SCOPE, removed);
  sync(db);
  index.expire({ sinceSec: 0, sinceBlock: null });
  expect(index.takeEventDelta()).toEqual({ upserts: [], deletedKeys: [removed] });

  // Sliding the window out reports the keys that left as removals, never as upserts.
  index.expire({ sinceSec: 360, sinceBlock: null });
  const slid = index.takeEventDelta();
  expect(slid.upserts).toEqual([]);
  expect(slid.deletedKeys).toHaveLength(2);
});
