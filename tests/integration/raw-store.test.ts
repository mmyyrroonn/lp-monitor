import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import type { BlockAnchor, LogTime, RawLog } from '../../src/domain/types.js';
import { openDatabase } from '../../src/storage/database.js';
import {
  rawLogKey,
  type FetchShardManifest,
  type PersistedPoolRegistration,
  type RecordedRangeBatch,
} from '../../src/storage/manifest.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';

const databases: Database.Database[] = [];
const tempDirectories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of tempDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function hex(value: number): Hex {
  return `0x${value.toString(16).padStart(64, '0')}` as Hex;
}

function address(value: number): Address {
  return `0x${value.toString(16).padStart(40, '0')}` as Address;
}

function anchor(number: bigint, branch = 0): BlockAnchor {
  return { number, hash: hex(Number(number) + branch * 10_000), timestampSec: Number(number) };
}

function log(id: number, blockNumber: bigint): RawLog {
  return {
    blockHash: hex(Number(blockNumber)),
    blockNumber,
    transactionHash: hex(100_000 + id),
    transactionIndex: id,
    logIndex: id,
    address: address(10 + id),
    topics: [hex(20 + id)],
    data: hex(30 + id),
    rawBlockTimestamp: null,
  };
}

type BatchOptions = {
  id: string;
  scopeId?: string;
  fromBlock?: bigint;
  toBlock?: bigint;
  logs?: readonly RawLog[];
  filterId?: string;
  status?: FetchShardManifest['status'];
  shards?: readonly FetchShardManifest[];
  expectedShardIds?: readonly string[];
  logTimes?: RecordedRangeBatch['logTimes'];
  anchors?: RecordedRangeBatch['anchors'];
  boundaries?: RecordedRangeBatch['boundaries'];
  poolRegistrations?: readonly PersistedPoolRegistration[];
  previous?: BlockAnchor | null;
  filterPlanHash?: string;
};

function batch(options: BatchOptions): RecordedRangeBatch {
  const fromBlock = options.fromBlock ?? 101n;
  const toBlock = options.toBlock ?? 120n;
  const logs = options.logs ?? [];
  const filterId = options.filterId ?? 'F';
  const shardId = `${filterId}:${fromBlock}-${toBlock}`;
  const defaultShard: FetchShardManifest = {
    shardId,
    filterId,
    request: {
      fromBlock,
      toBlock,
      address: logs.length === 0 ? [address(1)] : [...new Set(logs.map((item) => item.address))],
      topics: [],
    },
    status: options.status ?? 'success',
    responseHash: hex(900),
    logKeys: logs.map(rawLogKey),
    logCount: logs.length,
    error: options.status === 'failed' ? 'rpc-error' : null,
  };
  const shards = options.shards ?? [defaultShard];
  return {
    id: options.id,
    scopeId: options.scopeId ?? 'scope-a',
    fromBlock,
    toBlock,
    end: anchor(toBlock),
    previous:
      'previous' in options ? options.previous! : fromBlock === 0n ? null : anchor(fromBlock - 1n),
    logs,
    observedAtMs: 1_000,
    captureMode: 'synthetic',
    filterPlanHash: options.filterPlanHash ?? `plan-${filterId}`,
    manifestHash: `manifest-${options.id}`,
    completeness:
      options.status === undefined || options.status === 'success' ? 'complete' : 'incomplete',
    manifest: {
      version: 1,
      filterVersion: `version-${filterId}`,
      expectedShardIds: options.expectedShardIds ?? shards.map((shard) => shard.shardId),
      shards,
    },
    logTimes: options.logTimes,
    anchors: options.anchors,
    boundaries: options.boundaries,
    poolRegistrations: options.poolRegistrations,
  };
}

function store(): { database: Database.Database; store: SqliteRangeStore } {
  const database = openDatabase(':memory:');
  databases.push(database);
  return { database, store: new SqliteRangeStore(database) };
}

function keys(logs: readonly RawLog[]): string[] {
  return logs.map(rawLogKey).sort();
}

describe('SqliteRangeStore', () => {
  test('reconciles a complete same-filter range while retaining immutable raw logs', () => {
    const { database, store: rangeStore } = store();
    const a = log(1, 105n);
    const b = log(2, 110n);
    const c = log(3, 115n);

    rangeStore.acceptRange(batch({ id: 'first', logs: [a, b] }));
    const changes = rangeStore.acceptRange(
      batch({ id: 'second', logs: [b, c], previous: anchor(120n) }),
    );

    expect(keys(rangeStore.activeLogs('scope-a'))).toEqual(keys([b, c]));
    expect(changes.added.map(rawLogKey)).toEqual([rawLogKey(c)]);
    expect(changes.removed.map(rawLogKey)).toEqual([rawLogKey(a)]);
    expect(database.prepare('select count(*) as count from raw_logs').get()).toEqual({ count: 3 });
  });

  test('accepts a complete empty response and does not delete another filter coverage', () => {
    const { store: rangeStore } = store();
    const a = log(1, 105n);
    rangeStore.acceptRange(batch({ id: 'f', logs: [a], filterId: 'F' }));

    const changes = rangeStore.acceptRange(
      batch({ id: 'g', logs: [], filterId: 'G', previous: anchor(120n) }),
    );

    expect(keys(rangeStore.activeLogs('scope-a'))).toEqual([rawLogKey(a)]);
    expect(changes.removed).toEqual([]);
  });

  test('rejects failed, truncated, missing, and gapped shard coverage without advancing cursor', () => {
    const { database, store: rangeStore } = store();
    const first = batch({ id: 'first', toBlock: 110n });
    rangeStore.acceptRange(first);

    const failed = batch({ id: 'failed', fromBlock: 101n, toBlock: 120n, status: 'failed' });
    rangeStore.saveRaw(failed);
    expect(() => rangeStore.acceptRange(failed)).toThrow(/complete/i);

    const truncated = batch({
      id: 'truncated',
      fromBlock: 101n,
      toBlock: 120n,
      status: 'truncated',
    });
    rangeStore.saveRaw(truncated);
    expect(() => rangeStore.acceptRange(truncated)).toThrow(/complete/i);
    expect(
      database
        .prepare(
          "select status from fetch_shards where batch_id in ('failed', 'truncated') order by batch_id",
        )
        .pluck()
        .all(),
    ).toEqual(['failed', 'truncated']);

    const outsideFilterBase = batch({ id: 'outside-filter', logs: [log(9, 105n)] });
    const outsideFilter = {
      ...outsideFilterBase,
      manifest: {
        ...outsideFilterBase.manifest,
        shards: outsideFilterBase.manifest.shards.map((shard) => ({
          ...shard,
          request: { ...shard.request, address: [address(999)] },
        })),
      },
    };
    expect(() => rangeStore.acceptRange(outsideFilter)).toThrow(/outside its filter/i);

    const missing = batch({ id: 'missing', expectedShardIds: ['missing-shard'] });
    expect(() => rangeStore.acceptRange(missing)).toThrow(/shard/i);

    const gap = batch({ id: 'gap', fromBlock: 112n, toBlock: 120n, previous: first.end });
    expect(() => rangeStore.acceptRange(gap)).toThrow(/gap/i);
    expect(rangeStore.acceptedTip('scope-a')).toEqual(first.end);
  });

  test('unions overlapping shards in one stable filter family and rejects an internal range gap', () => {
    const { store: rangeStore } = store();
    const a = log(1, 105n);
    const overlapping: FetchShardManifest[] = [
      {
        ...batch({ id: 'left', fromBlock: 101n, toBlock: 110n, logs: [a] }).manifest.shards[0]!,
        shardId: 'left',
        filterId: 'F',
      },
      {
        ...batch({ id: 'right', fromBlock: 105n, toBlock: 120n }).manifest.shards[0]!,
        shardId: 'right',
        filterId: 'F',
      },
    ];
    const complete = batch({
      id: 'overlap',
      logs: [a],
      shards: overlapping,
      expectedShardIds: ['left', 'right'],
    });
    expect(() => rangeStore.acceptRange(complete)).not.toThrow();
    expect(keys(rangeStore.activeLogs('scope-a'))).toEqual([rawLogKey(a)]);

    const gapped: FetchShardManifest[] = [
      {
        ...batch({ id: 'left-gap', fromBlock: 101n, toBlock: 109n }).manifest.shards[0]!,
        shardId: 'left-gap',
        filterId: 'G',
      },
      {
        ...batch({ id: 'right-gap', fromBlock: 111n, toBlock: 120n }).manifest.shards[0]!,
        shardId: 'right-gap',
        filterId: 'G',
      },
    ];
    expect(() =>
      rangeStore.acceptRange(
        batch({
          id: 'internal-gap',
          shards: gapped,
          expectedShardIds: ['left-gap', 'right-gap'],
          previous: complete.end,
        }),
      ),
    ).toThrow(/coverage gap/i);
    expect(rangeStore.acceptedTip('scope-a')).toEqual(complete.end);
  });

  test('is idempotent and rejects a changed payload for an existing raw identity', () => {
    const { database, store: rangeStore } = store();
    const a = log(1, 105n);
    const accepted = batch({ id: 'first', logs: [a] });
    rangeStore.acceptRange(accepted);

    const repeated = rangeStore.acceptRange(
      batch({ id: 'repeat', logs: [a], previous: accepted.end }),
    );
    expect(repeated.added).toEqual([]);
    expect(repeated.removed).toEqual([]);

    const canonicalChanges: [string, RawLog][] = [
      ['data', { ...a, data: hex(999) }],
      ['topics', { ...a, topics: [hex(999)] }],
      ['address', { ...a, address: address(999) }],
      ['transaction-index', { ...a, transactionIndex: 999 }],
      ['block-number', { ...a, blockNumber: 106n }],
    ];
    for (const [id, changed] of canonicalChanges)
      expect(() => rangeStore.saveRaw(batch({ id: `changed-${id}`, logs: [changed] }))).toThrow(
        /immutable/i,
      );

    // Block and transaction hashes participate in rawLogKey, so changing either is
    // a distinct identity rather than a mutation of this row.
    rangeStore.saveRaw(batch({ id: 'changed-identity', logs: [{ ...a, blockHash: hex(999) }] }));
    expect(database.prepare('select count(*) as count from raw_logs').get()).toEqual({ count: 2 });
  });

  test('keeps first raw annotation while preserving timestamp variants in batch evidence', () => {
    const { database, store: rangeStore } = store();
    const canonical = log(1, 105n);
    const first = { ...canonical, rawBlockTimestamp: '0x6aa28ff3' as Hex };
    const variants = [
      { id: 'zero', rawBlockTimestamp: '0x0' as Hex },
      { id: 'missing', rawBlockTimestamp: null },
      { id: 'different', rawBlockTimestamp: '0x6aa28ff4' as Hex },
    ];

    rangeStore.saveRaw(batch({ id: 'first-stamped', logs: [first] }));
    for (const variant of variants)
      rangeStore.saveRaw(
        batch({
          id: variant.id,
          logs: [{ ...canonical, rawBlockTimestamp: variant.rawBlockTimestamp }],
        }),
      );

    expect(database.prepare('select count(*) as count from raw_logs').get()).toEqual({ count: 1 });
    const raw = database
      .prepare('select raw_block_timestamp, payload_json from raw_logs where raw_key = ?')
      .get(rawLogKey(first)) as { raw_block_timestamp: string; payload_json: string };
    expect(raw.raw_block_timestamp).toBe('0x6aa28ff3');
    expect(JSON.parse(raw.payload_json).rawBlockTimestamp).toBe('0x6aa28ff3');

    const batches = database
      .prepare('select id, payload_json from ingest_batches order by rowid')
      .all() as { id: string; payload_json: string }[];
    expect(
      batches.map(({ id, payload_json }) => [
        id,
        JSON.parse(payload_json).logs[0].rawBlockTimestamp,
      ]),
    ).toEqual([
      ['first-stamped', '0x6aa28ff3'],
      ['zero', '0x0'],
      ['missing', null],
      ['different', '0x6aa28ff4'],
    ]);
  });

  test('isolates cursors and active sets by scope', () => {
    const { store: rangeStore } = store();
    const a = log(1, 105n);
    const b = log(2, 106n);
    const scopeA = batch({ id: 'a', scopeId: 'scope-a', logs: [a] });
    const scopeB = batch({ id: 'b', scopeId: 'scope-b', logs: [b] });
    rangeStore.acceptRange(scopeA);
    rangeStore.acceptRange(scopeB);

    expect(rangeStore.acceptedTip('scope-a')).toEqual(scopeA.end);
    expect(rangeStore.acceptedTip('scope-b')).toEqual(scopeB.end);
    expect(keys(rangeStore.activeLogs('scope-a'))).toEqual([rawLogKey(a)]);
    expect(keys(rangeStore.activeLogs('scope-b'))).toEqual([rawLogKey(b)]);
  });

  test('rolls back active, cursor, time, pool, and checkpoint writes on a database failure', () => {
    const { database, store: rangeStore } = store();
    const a = log(1, 105n);
    const first = batch({ id: 'first', logs: [a], toBlock: 110n });
    rangeStore.acceptRange(first);
    const b = log(2, 111n);
    const captured = batch({
      id: 'second',
      fromBlock: 101n,
      toBlock: 120n,
      logs: [a, b],
      previous: first.end,
    });
    rangeStore.saveRaw(captured);
    database.exec(`
      create trigger fail_active_insert before insert on active_logs
      when NEW.scope_id = 'scope-a'
      begin select raise(abort, 'simulated database failure'); end
    `);

    expect(() =>
      rangeStore.acceptRange({
        ...captured,
        logTimes: [{ ref: b, time: minuteTime(60) }],
        anchors: [anchor(120n)],
        poolRegistrations: [pool(b)],
      }),
    ).toThrow(/simulated database failure/i);

    expect(rangeStore.acceptedTip('scope-a')).toEqual(first.end);
    expect(keys(rangeStore.activeLogs('scope-a'))).toEqual([rawLogKey(a)]);
    expect([...rangeStore.logTimes('scope-a')]).toEqual([]);
    expect(rangeStore.pools('scope-a')).toEqual([]);
    expect(rangeStore.checkpoints('scope-a')).toEqual([first.end]);
    expect(database.prepare('select count(*) from raw_logs').pluck().get()).toBe(2);
  });

  test('removes a pool when complete discovery coverage drops its creation log', () => {
    const { store: rangeStore } = store();
    const created = log(1, 105n);
    const first = batch({
      id: 'discovered',
      logs: [created],
      filterId: 'discovery-v3',
      poolRegistrations: [pool(created)],
    });
    rangeStore.acceptRange(first);
    expect(rangeStore.pools('scope-a')).toHaveLength(1);

    rangeStore.acceptRange(
      batch({
        id: 'disappeared',
        filterId: 'discovery-v3',
        previous: first.end,
      }),
    );
    expect(rangeStore.pools('scope-a')).toEqual([]);
  });

  test('returns retimed for an existing active log when minute evidence is corrected', () => {
    const { store: rangeStore } = store();
    const a = log(1, 105n);
    rangeStore.acceptRange(
      batch({ id: 'unresolved', logs: [a], logTimes: [{ ref: a, time: unresolvedTime() }] }),
    );

    const changes = rangeStore.acceptRange(
      batch({
        id: 'resolved',
        logs: [a],
        logTimes: [{ ref: a, time: minuteTime(60) }],
        previous: anchor(120n),
      }),
    );

    expect(changes.added).toEqual([]);
    expect(changes.removed).toEqual([]);
    expect(changes.retimed.map(rawLogKey)).toEqual([rawLogKey(a)]);
    expect(rangeStore.logTimes('scope-a').get(rawLogKey(a))).toEqual(minuteTime(60));
  });

  test('invalidates dependent times below an anchor and rolls back branch pool discovery', () => {
    const { store: rangeStore } = store();
    const lower = log(1, 105n);
    const upper = log(2, 115n);
    const crossedBoundary = {
      timestampSec: 120,
      firstBlock: 120n,
      before: anchor(119n),
      at: anchor(120n),
    };
    rangeStore.acceptRange(
      batch({
        id: 'state',
        logs: [lower, upper],
        logTimes: [{ ref: lower, time: minuteTime(60) }],
        boundaries: [crossedBoundary],
        poolRegistrations: [pool(lower), pool(upper)],
      }),
    );

    const changes = rangeStore.invalidateAfter('scope-a', anchor(110n));

    expect(keys(rangeStore.activeLogs('scope-a'))).toEqual([rawLogKey(lower)]);
    expect(changes.removed.map(rawLogKey)).toEqual([rawLogKey(upper)]);
    expect(changes.retimed.map(rawLogKey)).toEqual([rawLogKey(lower)]);
    expect(rangeStore.boundaries('scope-a')).toEqual([]);
    expect([...rangeStore.logTimes('scope-a')]).toEqual([]);
    expect(
      rangeStore.pools('scope-a').map((registration) => rawLogKey(registration.discoveredAt)),
    ).toEqual([rawLogKey(lower)]);
    expect(rangeStore.acceptedTip('scope-a')).toEqual(anchor(110n));
    expect(rangeStore.invalidations('scope-a')).toEqual([
      { fromBlock: 111n, toBlock: 120n, reason: 'reorg' },
    ]);
  });

  test('supports checkpoint pruning, warmup reset, run records, and safe height bounds', () => {
    const { database, store: rangeStore } = store();
    rangeStore.acceptRange(batch({ id: 'first', toBlock: 110n, anchors: [anchor(105n)] }));
    rangeStore.acceptRange(
      batch({
        id: 'second',
        fromBlock: 101n,
        toBlock: 120n,
        anchors: [anchor(115n)],
        previous: anchor(110n),
      }),
    );
    expect(rangeStore.checkpoints('scope-a', 'desc').map((item) => item.number)).toEqual([
      120n,
      110n,
    ]);
    expect(rangeStore.pruneCheckpoints('scope-a', 115)).toBe(1);
    rangeStore.recordRun({
      id: 'run-1',
      scopeId: 'scope-a',
      startedAtMs: 1,
      finishedAtMs: 2,
      status: 'complete',
      payload: { calls: 3n },
    });
    expect(
      database.prepare('select payload_json from runs where id = ?').pluck().get('run-1'),
    ).toBe('{"calls":"3"}');
    rangeStore.recordRun({
      id: 'run-1',
      scopeId: 'scope-a',
      startedAtMs: 1,
      finishedAtMs: 3,
      status: 'complete',
      payload: { calls: 4n },
    });
    expect(
      database.prepare('select status, payload_json from runs where id = ?').get('run-1'),
    ).toEqual({ status: 'complete', payload_json: '{"calls":"4"}' });

    const reset = rangeStore.resetForWarmup('scope-a');
    expect(reset.removed).toEqual([]);
    expect(rangeStore.acceptedTip('scope-a')).toBeNull();
    expect(rangeStore.checkpoints('scope-a')).toEqual([]);
    expect(rangeStore.invalidations('scope-a')).toEqual([
      { fromBlock: 101n, toBlock: 120n, reason: 'warmup-rechecking' },
    ]);

    expect(() =>
      rangeStore.saveRaw(
        batch({
          id: 'unsafe',
          fromBlock: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          toBlock: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        }),
      ),
    ).toThrow(/safe|range/i);
  });

  test('uses stable filter coverage across a changed pool plan and rejects stale writers', () => {
    const { store: rangeStore } = store();
    const a = log(1, 105n);
    const first = batch({ id: 'old-plan', logs: [a], filterPlanHash: 'old-pools' });
    rangeStore.acceptRange(first);

    const stale = batch({ id: 'stale', logs: [a], previous: anchor(119n) });
    expect(() => rangeStore.acceptRange(stale)).toThrow(/stale/i);
    expect(rangeStore.acceptedTip('scope-a')).toEqual(first.end);
    expect(() => rangeStore.invalidateAfter('scope-a', anchor(121n))).toThrow(/advance/i);

    const expandedBase = batch({
      id: 'expanded-plan',
      logs: [],
      filterId: 'F',
      filterPlanHash: 'expanded-pools',
      previous: first.end,
    });
    const expanded: RecordedRangeBatch = {
      ...expandedBase,
      manifest: {
        ...expandedBase.manifest,
        shards: expandedBase.manifest.shards.map((shard) => ({
          ...shard,
          request: { ...shard.request, address: [a.address, address(999)] },
        })),
      },
    };
    const changes = rangeStore.acceptRange(expanded);
    expect(changes.removed.map(rawLogKey)).toEqual([rawLogKey(a)]);
    expect(rangeStore.activeLogs('scope-a')).toEqual([]);
  });

  test('allows a saved transport batch to be enriched with derived evidence at acceptance', () => {
    const { store: rangeStore } = store();
    const a = log(1, 105n);
    const captured = batch({ id: 'captured', logs: [a] });
    rangeStore.saveRaw(captured);

    expect(() =>
      rangeStore.acceptRange({
        ...captured,
        logTimes: [{ ref: a, time: minuteTime(60) }],
        anchors: [anchor(105n)],
      }),
    ).not.toThrow();
    expect(rangeStore.logTimes('scope-a').get(rawLogKey(a))).toEqual(minuteTime(60));
  });

  test('persists accepted state when the database is reopened', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lp-raw-store-'));
    tempDirectories.push(directory);
    const path = join(directory, 'raw.sqlite');
    const firstDatabase = openDatabase(path);
    const a = log(1, 105n);
    new SqliteRangeStore(firstDatabase).acceptRange(batch({ id: 'persisted', logs: [a] }));
    firstDatabase.close();

    const reopened = openDatabase(path);
    databases.push(reopened);
    const reopenedStore = new SqliteRangeStore(reopened);
    expect(keys(reopenedStore.activeLogs('scope-a'))).toEqual([rawLogKey(a)]);
    expect(reopenedStore.acceptedTip('scope-a')).toEqual(anchor(120n));
  });
});

function minuteTime(minuteStartSec: number): LogTime {
  return { minuteStartSec, exactTimestampSec: null, source: 'minute-boundary' };
}

function unresolvedTime(): LogTime {
  return { minuteStartSec: null, exactTimestampSec: null, source: 'unresolved' };
}

function pool(discoveredAt: RawLog): PersistedPoolRegistration {
  return {
    pool: { chainId: 4663, protocol: 'v3', address: address(90) },
    token0: address(91),
    token1: address(92),
    feePips: 3_000,
    tickSpacing: 60,
    hooks: address(0),
    discoveredAt,
    assetVersion: 'assets-v1',
    source: 'fixture',
  };
}
