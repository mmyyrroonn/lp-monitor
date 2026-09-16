import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, toHex, type Hex } from 'viem';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { LiveProjectionStore } from '../../src/storage/live-projection.js';
import { eventIndexFor, type LiveEventIndexStore } from '../../src/storage/live-event-index.js';
import {
  liveWorksetFor,
  snapshotHasMemory,
  type LiveWorksetStore,
  type WorksetInput,
} from '../../src/storage/live-workset.js';
import { encodeSignalState } from '../../src/signals/codec.js';
import { initialSignalSnapshot } from '../../src/signals/engine.js';
import type { SignalSnapshot } from '../../src/signals/types.js';
import { openWorkCounts, type WorkCounts } from '../../src/ops/work-counters.js';
import {
  rawLogKey,
  type PersistedPoolRegistration,
  type RecordedRangeBatch,
} from '../../src/storage/manifest.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import { CHAIN_ID } from '../../src/domain/chain.js';
import type { LogTime, RawLog } from '../../src/domain/types.js';

const dbs: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => {
  // Close before removing: a database Windows still holds open keeps its directory undeletable,
  // and the cleanup failure would arrive instead of whatever the test was actually reporting.
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = 'scale';
const WATERMARK_SEC = 1_800_000_000;
const WINDOW = { sinceSec: WATERMARK_SEC, sinceBlock: null };
const HOT_POOLS = 400;
const CATALOGUE_POOLS = 80_000;
const HOT_BASE = 0x100000;
const BALLAST_BASE = 0x300000;

const hash = (n: number) => toHex(n, { size: 32 });
const token0 = toHex(2, { size: 20 });
const token1 = toHex(3, { size: 20 });
const hotAddress = (index: number) => toHex(HOT_BASE + index, { size: 20 });
const poolId = (index: number) => `${CHAIN_ID}:v3:${hotAddress(index)}`;
const ballastPoolId = (index: number) =>
  `${CHAIN_ID}:v3:${toHex(BALLAST_BASE + index, { size: 20 })}`;
const minute = (minuteStartSec: number): LogTime => ({
  minuteStartSec,
  exactTimestampSec: null,
  source: 'minute-boundary',
});

const swapFor = (index: number): RawLog => ({
  address: hotAddress(index),
  blockNumber: BigInt(index + 1),
  blockHash: hash(index + 1),
  transactionHash: hash(10_000 + index),
  transactionIndex: 0,
  logIndex: 0,
  rawBlockTimestamp: '0x0',
  topics: encodeEventTopics({
    abi: v3PoolAbi,
    eventName: 'Swap',
    args: { sender: hotAddress(index), recipient: hotAddress(index) },
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

function batch(logs: RawLog[], times: LogTime[]): RecordedRangeBatch {
  const registrations: PersistedPoolRegistration[] = logs.map((log, index) => ({
    pool: { chainId: CHAIN_ID, protocol: 'v3', address: hotAddress(index) },
    token0,
    token1,
    feePips: 3000,
    tickSpacing: 60,
    hooks: toHex(0, { size: 20 }),
    assetVersion: 'scale-v1',
    source: 'synthetic',
    discoveredAt: log,
  }));
  const tip = { number: BigInt(logs.length), hash: hash(logs.length), timestampSec: WATERMARK_SEC };
  return {
    id: 'hot',
    scopeId: SCOPE,
    fromBlock: 1n,
    toBlock: tip.number,
    end: tip,
    previous: tip,
    logs,
    observedAtMs: 1,
    captureMode: 'synthetic',
    filterPlanHash: 'test',
    manifestHash: 'hot',
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'test',
      expectedShardIds: ['one'],
      shards: [
        {
          shardId: 'one',
          filterId: 'operation-v3',
          request: {
            fromBlock: 1n,
            toBlock: tip.number,
            address: [...new Set(logs.map((log) => log.address))],
            topics: [],
          },
          status: 'success',
          responseHash: hash(1),
          logKeys: logs.map(rawLogKey),
          logCount: logs.length,
          error: null,
        },
      ],
    },
    logTimes: logs.map((ref, index) => ({ ref, time: times[index]! })),
    poolRegistrations: registrations,
  };
}

/** The stores one scope of one database is read through, shared exactly as a caller shares them. */
function stores(db: Database.Database): {
  index: LiveEventIndexStore;
  workset: LiveWorksetStore;
} {
  const index = eventIndexFor(db, SCOPE);
  return { index, workset: liveWorksetFor(db, SCOPE, index) };
}

/** Project one windowed swap for each of `hotPools` pools, through the real ingest and sync path. */
function build(
  db: Database.Database,
  hotPools: number,
): ReturnType<typeof stores> & {
  poolIds: string[];
} {
  const logs = Array.from({ length: hotPools }, (_, index) => swapFor(index));
  new SqliteRangeStore(db).acceptRange(
    batch(
      logs,
      logs.map(() => minute(WATERMARK_SEC)),
    ),
  );
  new LiveProjectionStore(db).sync(SCOPE, SCOPE, 'c');
  return { ...stores(db), poolIds: logs.map((_, index) => poolId(index)) };
}

/** Fill `pools` with registrations nothing in this round may read. */
function seedBallast(db: Database.Database, count: number): void {
  const key = 'ballast';
  db.prepare(
    `insert or ignore into raw_logs(raw_key, chain_id, block_hash, block_number, transaction_hash,
       transaction_index, log_index, address, topics_json, data, raw_block_timestamp, payload_json)
     values (?, ?, ?, 0, ?, 0, 0, ?, '[]', '0x', null, '{}')`,
  ).run(key, CHAIN_ID, hash(0), hash(0), toHex(0, { size: 20 }));
  const { id } = db.prepare('select id from raw_logs where raw_key=?').get(key) as { id: number };
  db.prepare(
    `with recursive n(i) as (select 0 union all select i+1 from n where i < ?)
     insert into pools(scope_id, pool_key, protocol, discovered_raw_log_id, discovered_block_number,
       discovered_block_hash, payload_json)
     select ?, printf('{"chainId":${CHAIN_ID},"protocol":"v3","address":"0x%040x"}', i + ?),
       'v3', ?, 0, ?,
       printf('{"pool":{"chainId":${CHAIN_ID},"protocol":"v3","address":"0x%040x"},"token0":"0x%040x","token1":"0x%040x","feePips":3000,"tickSpacing":60,"hooks":"0x%040x","assetVersion":"scale-v1","source":"synthetic","discoveredAt":{"blockNumber":"0","blockHash":"0x%064x","transactionHash":"0x%064x","transactionIndex":0,"logIndex":0}}', i + ?, 2, 3, 0, 0, 0)
     from n`,
  ).run(count - 1, SCOPE, BALLAST_BASE, id, hash(0), BALLAST_BASE);
}

/** Run one round the way its caller does, naming only the fields a test cares about. */
function round(
  workset: LiveWorksetStore,
  watermarkSec: number,
  over: Partial<WorksetInput> = {},
): ReadonlySet<string> {
  const selected = workset.select({
    changedPoolIds: new Set<string>(),
    dependencyPoolIds: new Set<string>(),
    watermarkSec,
    coverageChanged: false,
    bounds: WINDOW,
    ...over,
  });
  workset.arm(watermarkSec);
  workset.commit();
  return selected;
}

function measured<T>(work: () => T): { value: T; counts: WorkCounts } {
  const scope = openWorkCounts();
  try {
    return { value: work(), counts: scope.counts };
  } finally {
    scope.close();
  }
}

test('a round selects the hot pools of an eighty thousand pool catalogue without reading it', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const { workset, poolIds } = build(db, HOT_POOLS);
  seedBallast(db, CATALOGUE_POOLS - HOT_POOLS);
  expect(db.prepare('select count(*) n from pools').get()).toEqual({ n: CATALOGUE_POOLS });

  const first = measured(() => round(workset, WATERMARK_SEC));
  expect(first.value.size).toBe(HOT_POOLS);
  expect([...first.value].sort()).toEqual([...poolIds].sort());
  // Selecting is four set unions over the window and a read of the members table: the catalogue
  // contributes to it only through the identities a batch actually revised, never through a scan.
  expect(first.counts.registryRowsRead).toBe(0);
  expect(first.counts.evaluatedWorksetPools).toBe(HOT_POOLS);
});

test('an empty round that advances the watermark still reconsiders the pools with signal memory', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const { workset } = build(db, 4);
  // Four pools are cooling: they carry signal memory and have no window input of their own.
  expect(workset.members()).toEqual(new Set());
  const cooling = Array.from({ length: 4 }, (_, index) => `cooling-${index}`);
  workset.retain(cooling);

  expect(round(workset, WATERMARK_SEC).size).toBe(8); // the first round of a process
  expect(round(workset, WATERMARK_SEC).size).toBe(4); // nothing moved under a standing watermark
  expect(round(workset, WATERMARK_SEC + 60).size).toBe(8); // the chain advanced
  expect(round(workset, WATERMARK_SEC + 60).size).toBe(4); // standing again
  // Coverage moving under a standing watermark is the other half of that rule.
  expect(round(workset, WATERMARK_SEC + 60, { coverageChanged: true }).size).toBe(8);
});

test('a round that rolled back leaves no standing watermark for its retry to trust', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const { workset } = build(db, 4);
  workset.retain(['cooling-a', 'cooling-b']);
  expect(round(workset, WATERMARK_SEC).size).toBe(6); // four windowed pools plus two in cooling

  // The next round is attempted at a new watermark and then fails. It selected the cooling pools,
  // armed that watermark, and the whole transaction went back with it — so the retry of the same
  // batch is owed them again, and nothing the failed attempt armed may be what answers for it.
  const attempted = workset.select({
    changedPoolIds: new Set<string>(),
    dependencyPoolIds: new Set<string>(),
    watermarkSec: WATERMARK_SEC + 60,
    coverageChanged: false,
    bounds: WINDOW,
  });
  workset.arm(WATERMARK_SEC + 60);
  expect(attempted.size).toBe(6);

  const retry = round(workset, WATERMARK_SEC + 60);
  expect(retry.size).toBe(6);
  expect(retry.has('cooling-a')).toBe(true);
  expect(retry.has('cooling-b')).toBe(true);

  // The retry is the round that counted, so from here the watermark stands again.
  expect(round(workset, WATERMARK_SEC + 60).size).toBe(4);
});

test('a pool named by this round inputs is selected for it, not remembered after it', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const { workset } = build(db, 4);
  round(workset, WATERMARK_SEC);
  const revised = ballastPoolId(0);
  const dependency = ballastPoolId(1);

  const selected = round(workset, WATERMARK_SEC, {
    changedPoolIds: new Set([revised]),
    dependencyPoolIds: new Set([dependency]),
  });
  expect(selected.has(revised)).toBe(true);
  expect(selected.has(dependency)).toBe(true);
  expect(selected.size).toBe(6);

  // The round ends with nothing to remember — no window input, and a snapshot still at its initial
  // value — so the next round at the same watermark does not carry either of them.
  workset.retain([]);
  expect(round(workset, WATERMARK_SEC).size).toBe(4);
  expect(workset.members()).toEqual(new Set());
});

test('the last event leaving the window selects its pool once, and then the round has nothing to do', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const { workset, index, poolIds } = build(db, 4);
  round(workset, WATERMARK_SEC);
  expect(index.size).toBe(4);

  const past = { sinceSec: WATERMARK_SEC + 3_600, sinceBlock: null };
  const left = measured(() => round(workset, WATERMARK_SEC + 60, { bounds: past }));
  expect([...left.value].sort()).toEqual([...poolIds].sort());
  expect(index.size).toBe(0);
  expect(index.windowContextIncomplete).toBe(false);

  // Once those four have been evaluated they hold nothing and owe nothing, and a round with no
  // input at all is empty rather than a scan waiting to happen.
  workset.retain([]);
  const idle = measured(() => round(workset, WATERMARK_SEC + 60, { bounds: past }));
  expect(idle.value).toEqual(new Set());
  expect(idle.counts.evaluatedWorksetPools).toBe(0);
});

test('an unknown-time event without a boundary keeps its pool in the round and says why', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const { workset, index } = build(db, 1);
  db.prepare(
    "update log_times set minute_start_sec=null, source='unresolved' where scope_id=?",
  ).run(SCOPE);
  new LiveProjectionStore(db).sync(SCOPE, SCOPE, 'c');

  expect(round(workset, WATERMARK_SEC)).toEqual(new Set([poolId(0)]));
  expect(index.windowContextIncomplete).toBe(true);
  // The pool keeps its place in the next round too: nothing has bounded the event since, so the
  // window still holds it and still reports that it cannot place it.
  expect(round(workset, WATERMARK_SEC)).toEqual(new Set([poolId(0)]));
  expect(index.windowContextIncomplete).toBe(true);
});

test('a snapshot counts as memory exactly when the state machine has something to read back', () => {
  expect(snapshotHasMemory(initialSignalSnapshot())).toBe(false);
  // Every field the state machine reads back counts, the optional ones included.
  expect(
    snapshotHasMemory({ ...initialSignalSnapshot(), candidateFingerprint: 'f', lastHeatSec: 7 }),
  ).toBe(true);
  expect(snapshotHasMemory({ ...initialSignalSnapshot(), state: 'cooling' })).toBe(true);
  expect(snapshotHasMemory({ ...initialSignalSnapshot(), episodeId: 'episode' })).toBe(true);
  expect(snapshotHasMemory({ ...initialSignalSnapshot(), lastAlertSec: 1 })).toBe(true);
  expect(snapshotHasMemory({ ...initialSignalSnapshot(), lastAlertVolume: 1n })).toBe(true);
  expect(snapshotHasMemory({ ...initialSignalSnapshot(), lastAlertScale: '5m' })).toBe(true);
  expect(snapshotHasMemory({ ...initialSignalSnapshot(), lowBuckets: 1 })).toBe(true);
  expect(snapshotHasMemory({ ...initialSignalSnapshot(), entryThreshold: 1n })).toBe(true);
  expect(snapshotHasMemory({ ...initialSignalSnapshot(), lastAlertKind: 'hot' })).toBe(true);
  expect(snapshotHasMemory({ ...initialSignalSnapshot(), candidateMinuteStartSec: 1 })).toBe(true);
  // Two fields are not memory, and neither is written by a decision. `evaluateSignal` stamps the
  // config version on every snapshot it writes, and sets the 5m watermark on every round that
  // closes a bucket, so counting either one keeps every pool ever evaluated in the workset for good
  // — the catalogue this table exists to bound. The row keeps both, so a pool that is selected
  // again reads its watermark back exactly as it left it.
  expect(snapshotHasMemory({ ...initialSignalSnapshot(), configVersion: 'sig:1' })).toBe(false);
  expect(snapshotHasMemory({ ...initialSignalSnapshot(), lastFiveEndSec: 1 })).toBe(false);
  // A field this test has never heard of is not memory either: the fields above are the whole of
  // what the state machine reads back, and a predicate that counted anything else would be back to
  // remembering every pool a round merely touched.
  expect(snapshotHasMemory({ ...initialSignalSnapshot(), extra: 1 } as SignalSnapshot)).toBe(false);
});

test('the first fill is a one-time scan, and a rolled back fill is a fill that never happened', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const { workset } = build(db, 4);
  const write = db.prepare('insert into signal_snapshots values(?,?,?)');
  const cold = (id: string) => write.run(SCOPE, id, encodeSignalState(initialSignalSnapshot()));
  const hot = (id: string) =>
    write.run(
      SCOPE,
      id,
      encodeSignalState({
        ...initialSignalSnapshot(),
        state: 'cooling',
        episodeId: 'e',
        lowBuckets: 2,
      }),
    );
  for (let index = 0; index < 3; index += 1) hot(`hot-${index}`);
  for (let index = 0; index < 5; index += 1) cold(`cold-${index}`);

  // A fill that never commits leaves neither members nor a note claiming the scan already ran.
  expect(() =>
    db.transaction(() => {
      workset.seed(1);
      throw new Error('rollback');
    })(),
  ).toThrow('rollback');
  expect(workset.seeded()).toBe(false);
  expect(workset.members()).toEqual(new Set());

  expect(workset.seed(2)).toBe(3);
  expect(workset.members()).toEqual(new Set(['hot-0', 'hot-1', 'hot-2']));
  expect(workset.seed(3)).toBe(0);

  // A workset that is legitimately empty is not one that was never filled: the note is what keeps
  // every later open from scanning the snapshots again.
  workset.retain([]);
  expect(workset.members()).toEqual(new Set());
  expect(workset.seed(4)).toBe(0);
  expect(workset.members()).toEqual(new Set());
});

test('a reopened database selects the same cooling and candidate pools it did before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-workset-'));
  dirs.push(dir);
  const path = join(dir, 'live.db');
  const db = openDatabase(path);
  dbs.push(db);
  const { workset } = build(db, 3);
  workset.retain(['cooling-a', 'candidate-b']);
  const before = [...round(workset, WATERMARK_SEC)].sort();
  expect(before).toEqual([poolId(0), poolId(1), poolId(2), 'candidate-b', 'cooling-a'].sort());
  db.close();

  const reopened = openDatabase(path);
  dbs.push(reopened);
  // The new process has no window at all, and the snapshots are the only thing that says which
  // pools were mid-cooling or mid-candidate when the last one stopped.
  const again = stores(reopened);
  expect(again.workset.members()).toEqual(new Set(['cooling-a', 'candidate-b']));
  expect([...round(again.workset, WATERMARK_SEC)].sort()).toEqual(before);
  expect(again.index.size).toBe(3);
});
