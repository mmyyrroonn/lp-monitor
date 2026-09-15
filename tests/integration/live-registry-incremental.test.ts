import type Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { CHAIN_ID } from '../../src/domain/chain.js';
import { encodeJson } from '../../src/domain/json.js';
import type { RawLog } from '../../src/domain/types.js';
import type { WorkCounts } from '../../src/ops/work-counters.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import type { PoolRegistration } from '../../src/registry/pools.js';
import { PoolRegistry, poolRegistrationId } from '../../src/registry/pools.js';
import { decodeSignalState } from '../../src/signals/codec.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { commitAcceptedSignalBatch, projectSignals } from '../../src/signals/project.js';
import type { AlertRecord } from '../../src/signals/types.js';
import { openDatabase } from '../../src/storage/database.js';
import { LiveProjectionStore } from '../../src/storage/live-projection.js';
import { rawLogKey, type PersistedPoolRegistration } from '../../src/storage/manifest.js';
import { RegistryCache, registryCacheFor } from '../../src/storage/registry-cache.js';
import { SqliteProjectionStore } from '../../src/storage/projection-store.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { storedPoolKey, storedRegistrationJson } from '../../src/storage/registration-codec.js';
import { makeScaleData } from '../helpers/live-scale-fixture.js';
import {
  addr,
  batch,
  hash,
  hotLogs,
  metricInput,
  pool,
  registration,
} from '../helpers/alert-fixture.js';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function open(): Database.Database {
  const database = openDatabase(':memory:');
  databases.push(database);
  return database;
}

/** A second v3 pool on the same pair, so one registry move can be compared against an untouched pool. */
const other = addr(9);
const coldPool = addr(0x0c01);
const context = { batchId: 'sync', observedAtMs: 100_000, captureMode: 'live' as const };
/** Exactly the registration `batch()` derives from `hotLogs()`, so a later batch can redeclare it. */
const hotRegistration: PersistedPoolRegistration = { ...registration, discoveredAt: hotLogs()[0]! };

/** The fixture's swap at another address. The transaction hash carries the address, so two pools
 * swapping in the same block are two raw logs rather than one colliding key. */
function swapAt(address: `0x${string}`, block: number, usdgUnits = 2000): RawLog {
  return {
    address,
    blockNumber: BigInt(block),
    blockHash: hash(block),
    transactionHash: hash(block + 20_000 + parseInt(address.slice(-4), 16)),
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
      [1000000n, -BigInt(usdgUnits) * 1000000n, 2n ** 96n, 1000n, 0],
    ),
  };
}

/** The fixture's hot pattern, replayed at another address. */
function hotLogsAt(address: `0x${string}`): RawLog[] {
  return Array.from({ length: 79 }, (_, i) =>
    swapAt(address, 70 + i * 60, i >= 73 && i <= 77 ? 30000 : 2000),
  );
}

function registrationOf(address: `0x${string}`, log: RawLog): PersistedPoolRegistration {
  return {
    ...registration,
    pool: { chainId: CHAIN_ID, protocol: 'v3', address },
    discoveredAt: log,
  };
}

/** A batch that covers both pools, exactly like `alertFixture.batch` covers one. */
function twoPoolBatch(
  id: string,
  logs: readonly RawLog[],
  registrations: readonly PersistedPoolRegistration[],
): ReturnType<typeof batch> {
  const built = batch(id, [...logs]);
  built.manifest.shards[0]!.request.address = [pool, other];
  built.poolRegistrations = [...registrations];
  return built;
}

function outbox(db: Database.Database): AlertRecord[] {
  return (
    db.prepare('select payload_json from alert_outbox order by sequence').all() as {
      payload_json: string;
    }[]
  ).map((row) => decodeSignalState<AlertRecord>(row.payload_json));
}

function countsFor<T>(work: () => T): { value: T; counts: WorkCounts } {
  const scope = openWorkCounts();
  try {
    return { value: work(), counts: scope.counts };
  } finally {
    scope.close();
  }
}

/** The catalogue as the pre-journal code read it: one merged record per identity. */
function catalogue(database: Database.Database, scopeId: string): PoolRegistration[] {
  return [...new PoolRegistry(new SqliteRangeStore(database).pools(scopeId)).snapshot()];
}

/**
 * A discovery row for every registration, each on its own raw log — the way `acceptRange` writes
 * them, and the only way `pools` accepts a second row for one pool.
 */
function seedRegistrations(
  database: Database.Database,
  scopeId: string,
  registrations: readonly PoolRegistration[],
): void {
  const insertLog = database.prepare(
    `insert or ignore into raw_logs(
       raw_key, chain_id, block_hash, block_number, transaction_hash, transaction_index,
       log_index, address, topics_json, data, raw_block_timestamp, payload_json
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const logId = database.prepare('select id from raw_logs where raw_key = ?');
  const insertPool = database.prepare(
    `insert or ignore into pools(scope_id, pool_key, protocol, discovered_raw_log_id,
       discovered_block_number, discovered_block_hash, payload_json) values (?, ?, ?, ?, ?, ?, ?)`,
  );
  database.transaction(() => {
    for (const record of registrations) {
      const ref = record.discoveredAt;
      const key = rawLogKey(ref);
      insertLog.run(
        key,
        CHAIN_ID,
        ref.blockHash,
        Number(ref.blockNumber),
        ref.transactionHash,
        ref.transactionIndex,
        ref.logIndex,
        '0x0000000000000000000000000000000000000001',
        '[]',
        '0x',
        null,
        '{}',
      );
      insertPool.run(
        scopeId,
        storedPoolKey(record),
        record.pool.protocol,
        (logId.get(key) as { id: number }).id,
        Number(record.discoveredAt.blockNumber),
        record.discoveredAt.blockHash,
        storedRegistrationJson(record),
      );
    }
  })();
}

/** A registration the chain never recorded in this range: one raw log and one catalogue row. */
function registerOutsideRange(
  database: Database.Database,
  scopeId: string,
  record: PersistedPoolRegistration,
): void {
  seedRegistrations(database, scopeId, [record]);
}

function liveSync(db: Database.Database) {
  return new LiveProjectionStore(db).sync('s', 's', 'c');
}

test('a batch with no registry change reads no catalogue row and serializes no registration', () => {
  const db = open();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('first', hotLogs()));
  const otherAt = hotLogsAt(other);
  const both = [hotRegistration, registrationOf(other, otherAt[0]!)];
  commitAcceptedSignalBatch(
    db,
    metricInput,
    initialSignalConfig,
    twoPoolBatch('second', [...hotLogs(), ...otherAt], both),
  );
  commitAcceptedSignalBatch(
    db,
    metricInput,
    initialSignalConfig,
    twoPoolBatch('third', [...hotLogs(), ...otherAt, swapAt(pool, 4800)], both),
  );
  // The fourth batch adds one operation log and redeclares the same two pools: the projection moves,
  // the registry does not.
  new SqliteRangeStore(db).acceptRange(
    twoPoolBatch('fourth', [...hotLogs(), ...otherAt, swapAt(other, 4800)], both),
  );

  const sync = countsFor(() => liveSync(db));
  expect(sync.counts.registryRowsRead).toBe(0);
  expect(sync.counts.registryRowsSerialized).toBe(0);
  expect(sync.counts.registryChangesRead).toBe(0);
  expect(sync.value.registry?.changes).toEqual([]);
  expect(sync.value.registryInitialization).toBe(false);

  // The projection itself still agrees with the offline replay of the same evidence.
  const live = new LiveProjectionStore(db).read('s', 's', 'c', 0)!;
  const offline = new SqliteProjectionStore(db).rebuild('s', 's', 'c');
  expect(live.events).toEqual(offline.events);
  expect(live.qualityErrors).toEqual(offline.qualityErrors);
  expect(live.events.length).toBeGreaterThan(0);
}, 30_000);

test('new pools cost one journal row each and never a catalogue read', () => {
  const db = open();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('first', hotLogs()));
  const bornAt = 4800;
  const second = addr(0x0c02);
  const bornAt4800 = [swapAt(pool, bornAt), swapAt(coldPool, bornAt), swapAt(second, bornAt)];
  const born = [registrationOf(coldPool, bornAt4800[1]!), registrationOf(second, bornAt4800[2]!)];
  const withBirths = batch('births', bornAt4800);
  withBirths.previous = new SqliteRangeStore(db).acceptedTip('s')!;
  withBirths.poolRegistrations = [...born];
  withBirths.manifest.shards[0]!.request.address = [pool, coldPool, second];
  new SqliteRangeStore(db).acceptRange(withBirths);

  const sync = countsFor(() => liveSync(db));
  expect(sync.counts.registryRowsRead).toBe(0);
  // One journal row per new pool, read twice: once to fold into the registry view, once to bound
  // the identities this batch has to repair.
  expect(sync.counts.registryChangesRead).toBe(4);
  const changes = sync.value.registry?.changes ?? [];
  expect(changes.map((change) => change.poolId).sort()).toEqual(
    born.map(poolRegistrationId).sort(),
  );
  expect(changes.map((change) => change.block)).toEqual([BigInt(bornAt), BigInt(bornAt)]);
  expect(changes.every((change) => change.record !== null)).toBe(true);
  // The two identities the journal moved, plus the fixture pool — which this batch re-projects
  // because it carries a new operation log for it, not because its registration moved.
  expect(sync.value.affectedPoolIds).toEqual(
    [...born.map(poolRegistrationId), poolRegistrationId(registration)].sort(),
  );

  // A pool that carries no event is still in the registry this batch projects from.
  const view = new SqliteRangeStore(db).pools('s');
  expect(view.map(poolRegistrationId)).toContain(poolRegistrationId(born[0]!));
});

test('an unrelated cold pool leaves the hot pool and its alerts untouched', () => {
  const db = open();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('first', hotLogs()));
  const before = outbox(db);
  expect(before.map((record) => record.kind)).toEqual(['hot']);
  const hotId = before[0]!.poolId;

  // A registration can appear outside the recorded range: the range store accepts it directly, and
  // the journal is the only thing that can tell the next batch it appeared.
  const cold = registrationOf(coldPool, swapAt(coldPool, 4700));
  registerOutsideRange(db, 's', cold);

  const sync = countsFor(() => liveSync(db));
  expect(sync.counts.registryRowsRead).toBe(0);
  expect(sync.counts.registryRowsSerialized).toBe(0);
  // One journal row, read once to fold it in and once to bound the repair.
  expect(sync.counts.registryChangesRead).toBe(2);
  expect(sync.value.registry?.changes.map((change) => change.poolId)).toEqual([
    poolRegistrationId(cold),
  ]);
  // The movement is scoped to the identity that moved, never the whole catalogue.
  expect(sync.value.affectedPoolIds).toEqual([poolRegistrationId(cold)]);

  // A registration the hot alert does not depend on must not withdraw it.
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('quiet', hotLogs()));
  expect(outbox(db)).toEqual(before);
  expect(outbox(db)[0]!.poolId).toBe(hotId);
}, 20_000);

test('removing a hot pool withdraws its alerts and leaves the projection equal to the offline replay', () => {
  const db = open();
  const logs = hotLogs();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('first', logs));
  expect(outbox(db).map((record) => record.kind)).toEqual(['hot']);
  const hotId = poolRegistrationId(registration);

  db.prepare('delete from pools where scope_id = ?').run('s');
  // The next batch redeclares nothing, so the only thing that moved is the removal itself.
  const gone = batch('gone', logs);
  gone.poolRegistrations = [];
  const sync = countsFor(() =>
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, gone),
  );
  expect(sync.counts.registryRowsRead).toBe(0);
  expect(sync.counts.registryRowsSerialized).toBe(0);
  expect(outbox(db).map((record) => record.kind)).toEqual(['hot', 'retracted']);
  expect(outbox(db)[0]!.poolId).toBe(hotId);

  const live = new LiveProjectionStore(db).read('s', 's', 'c', 0)!;
  const offline = new SqliteProjectionStore(db).rebuild('s', 's', 'c');
  expect(live.qualityErrors.some((error) => error.code === 'unregistered-pool')).toBe(true);
  expect(live.qualityErrors).toEqual(offline.qualityErrors);
  expect(live.events).toEqual(offline.events);
});

test('the old full-array cursor is compared once, then replaced by a reference', () => {
  const db = open();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('first', hotLogs()));
  // The cursor a pre-journal process wrote: the whole catalogue as an array of full records.
  db.prepare('update live_projection_cursors set registry_json = ? where scope_id = ?').run(
    encodeJson(catalogue(db, 's')),
    's',
  );
  const newer = batch('newer', hotLogs());
  newer.poolRegistrations = [hotRegistration];
  new SqliteRangeStore(db).acceptRange(newer);

  const first = countsFor(() => liveSync(db));
  expect(first.value.registryInitialization).toBe(true);
  expect(first.counts.registryRowsSerialized).toBeGreaterThan(0);
  // The one-time comparison must find the real differences, not a re-encoding of every record.
  expect(first.value.registry?.changes).toEqual([]);
  const stored = db
    .prepare('select registry_json from live_projection_cursors where scope_id = ?')
    .get('s') as { registry_json: string };
  expect(JSON.parse(stored.registry_json)).toMatchObject({ format: 'registry-cursor-v1' });
  expect(stored.registry_json).not.toContain('token0');

  const second = countsFor(() => liveSync(db));
  expect(second.value.registryInitialization).toBe(false);
  expect(second.counts.registryRowsSerialized).toBe(0);
  expect(second.counts.registryRowsRead).toBe(0);
  expect(second.counts.registryChangesRead).toBe(0);
  expect(second.value.registry?.changes).toEqual([]);
});

test('a restart reads what the journal moved while the process was down', () => {
  const db = open();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('first', hotLogs()));
  const stored = db
    .prepare('select registry_json from live_projection_cursors where scope_id = ?')
    .get('s') as { registry_json: string };
  expect(JSON.parse(stored.registry_json)).toMatchObject({ format: 'registry-cursor-v1' });

  // The pool appears outside this process: only the journal can say what moved.
  const cold = registrationOf(coldPool, swapAt(coldPool, 4750));
  registerOutsideRange(db, 's', cold);

  // A restarted process holds no warmed registry state: it loads the catalogue once, and the
  // journal position in the cursor still says exactly which identity moved since the last batch.
  registryCacheFor(db, 's', 's').invalidate();
  const sync = countsFor(() => liveSync(db));
  expect(sync.value.registryInitialization).toBe(false);
  expect(sync.value.registry?.changes.map((change) => change.poolId)).toEqual([
    poolRegistrationId(cold),
  ]);
  expect(sync.counts.registryRowsSerialized).toBe(0);
  // Only the cold catalogue load, never a full-registry comparison.
  expect(sync.counts.registryRowsRead).toBe(catalogue(db, 's').length);

  const again = countsFor(() => liveSync(db));
  expect(again.counts.registryRowsRead).toBe(0);
  expect(again.counts.registryRowsSerialized).toBe(0);
  expect(again.value.registry?.changes).toEqual([]);
});

test('a rolled-back batch leaves no registry state behind', () => {
  const db = open();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('first', hotLogs()));
  const cursor = db
    .prepare('select registry_json, source_hash from live_projection_cursors where scope_id = ?')
    .get('s') as { registry_json: string; source_hash: string };

  // The discovery log has to be in the batch, or the registration is not persistable at all.
  const coldAt4800 = swapAt(coldPool, 4800);
  const crashed = batch('crash', [swapAt(pool, 4800), coldAt4800]);
  crashed.previous = new SqliteRangeStore(db).acceptedTip('s')!;
  crashed.poolRegistrations = [registrationOf(coldPool, coldAt4800)];
  crashed.manifest.shards[0]!.request.address = [pool, coldPool];
  db.exec(
    "create trigger crash_sync before insert on live_events begin select raise(abort,'crash'); end",
  );
  const registry = new RegistryCache(db, 's', 's');
  const prepared = registry.prepare();
  prepared.stage(crashed.poolRegistrations!);
  const sync = new LiveProjectionStore(db);
  expect(() =>
    db.transaction(() => {
      new SqliteRangeStore(db).acceptRange(crashed);
      sync.sync('s', 's', 'c', prepared);
      throw new Error('crash');
    })(),
  ).toThrow('crash');
  prepared.discard();
  db.exec('drop trigger crash_sync');

  expect(
    db
      .prepare('select registry_json, source_hash from live_projection_cursors where scope_id = ?')
      .get('s'),
  ).toEqual(cursor);
  // The rolled-back discovery is not in the registry the next batch projects from...
  const view = registry.prepare().view;
  expect(view.get(poolRegistrationId(crashed.poolRegistrations![0]!))).toBeUndefined();
  // ...and the journal still reports it once it really lands.
  db.prepare('delete from live_projection_cursors where scope_id = ?').run('s');
  db.prepare('delete from live_dirty_logs where scope_id = ?').run('s');
  new SqliteRangeStore(db).acceptRange(crashed);
  const landed = registry.prepare();
  expect([...landed.changedPoolIds]).toEqual([poolRegistrationId(crashed.poolRegistrations![0]!)]);
});

test('an accepted batch publishes the context it staged, and a rolled-back one does not', () => {
  const db = open();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('first', hotLogs()));
  const registry = registryCacheFor(db, 's', 's');
  const coldAt4800 = swapAt(coldPool, 4800);
  const cold = registrationOf(coldPool, coldAt4800);

  // The recorder's sequence: prepare and stage before the accepted transaction, sync inside it,
  // publish only once it committed.
  const prepared = registry.prepare();
  prepared.stage([cold]);
  const next = batch('second', [swapAt(pool, 4800), coldAt4800]);
  next.previous = new SqliteRangeStore(db).acceptedTip('s')!;
  next.poolRegistrations = [cold];
  next.manifest.shards[0]!.request.address = [pool, coldPool];
  const costs = countsFor(() => {
    new SqliteRangeStore(db).acceptRange(next);
    return new LiveProjectionStore(db).sync('s', 's', 'c', prepared);
  });
  expect(prepared.covers).toBeTypeOf('function');
  prepared.publish();

  // The staged view stood in for the registry at the position the batch wrote: the sync never took
  // the catalogue, and the identity the journal moved is the one the batch discovered.
  expect(costs.counts.registryRowsRead).toBe(0);
  // One comparison per registration the batch wrote, to prove the view already holds it, and never
  // a serialization of the catalogue.
  expect(costs.counts.registryRowsSerialized).toBe(2 * next.poolRegistrations!.length);
  expect(costs.value.registry?.changes.map((change) => change.poolId)).toEqual([
    poolRegistrationId(cold),
  ]);

  // Publishing stepped the context over the rows the batch wrote, so the next reader is already
  // standing where the journal is: it reads nothing, is told nothing moved, and still holds the
  // pool — settled from its rows, not from what the batch staged.
  const after = countsFor(() => registry.prepare());
  expect(after.counts.registryRowsRead).toBe(0);
  expect(after.counts.registryChangesRead).toBe(0);
  expect(after.value.changedPoolIds.size).toBe(0);
  expect(after.value.view.get(poolRegistrationId(cold))).toBeDefined();

  // A batch whose transaction never committed publishes nothing: the staged pool is gone from the
  // view, and the context still stands at the position it had.
  const orphan = registrationOf(other, hotLogsAt(other)[0]!);
  const uncommitted = registry.prepare();
  uncommitted.stage([orphan]);
  uncommitted.discard();
  const settled = registry.prepare();
  expect(settled.changedPoolIds.size).toBe(0);
  expect(settled.view.get(poolRegistrationId(orphan))).toBeUndefined();
});

test('zero registry change over a large catalogue costs nothing in the sync path', () => {
  const db = open();
  const scale = makeScaleData({
    poolCount: SCALE_POOLS,
    activePoolCount: 40,
    assetCount: 20,
    historyMinutes: 181,
  });
  seedRegistrations(db, 's', scale.registrations);
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('first', hotLogs()));
  const size = new SqliteRangeStore(db).pools('s').length;

  // A batch that adds one operation log and registers nothing: the projection moves, the registry
  // does not.
  const second = batch('second', [swapAt(pool, 4800)]);
  second.poolRegistrations = [];
  const accepted = countsFor(() =>
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, second),
  );
  // A selected round attributes its events through the view it selected from, so it reads no
  // catalogue row at all: the two scope reads this test used to bound at `2 * size` (C1) are now the
  // zero the selection exists to make them, for a catalogue of this many registrations. `size` is
  // what each of those reads was worth. What the test still holds the sync path to is the rest of
  // it: the registry delta and the evidence built from it add no read and no comparison of their own.
  expect(size).toBeGreaterThan(SCALE_POOLS);
  expect(accepted.counts.registryRowsRead).toBe(0);
  expect(accepted.counts.registryRowsSerialized).toBe(0);
  expect(accepted.counts.registryChangesRead).toBe(0);

  // And the sync a later reader runs over the same state costs nothing at all: the delta is empty
  // by the journal's own position, not by a comparison of the catalogue.
  const settled = countsFor(() => liveSync(db));
  expect(settled.counts.registryRowsRead).toBe(0);
  expect(settled.counts.registryRowsSerialized).toBe(0);
  expect(settled.counts.registryChangesRead).toBe(0);
  expect(settled.value.registry?.changes).toEqual([]);
}, 120_000);

test('an identity a registry delta omits is never withdrawn on the strength of the omission', () => {
  const db = open();
  // The first window has no cursor to advance, so it rebuilds the projection and reports no registry
  // movement at all.
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('first', hotLogs()));
  const hotId = poolRegistrationId(registration);
  expect(outbox(db).map((record) => record.poolId)).toEqual([hotId]);

  // The second window registers a second pool that is hot in its own right. That registration is the
  // one movement this window's delta carries, and the alert it earns is this window's own.
  const otherAt = hotLogsAt(other);
  const otherRegistration = registrationOf(other, otherAt[0]!);
  const otherId = poolRegistrationId(otherRegistration);
  commitAcceptedSignalBatch(
    db,
    metricInput,
    initialSignalConfig,
    twoPoolBatch('second', [...hotLogs(), ...otherAt], [hotRegistration, otherRegistration]),
  );
  const before = outbox(db);
  // The second window is free to revise the first pool's alert: what matters is that it reports the
  // second pool's arrival as an alert of its own, so there is one of each to be withdrawn here.
  expect(
    new Set(before.filter((record) => record.kind === 'hot').map((record) => record.poolId)),
  ).toEqual(new Set([hotId, otherId]));

  // A third pool registered outside the recorded range: the next window's delta is that pool and
  // nothing else, and it carries no log at all, so nothing about either alert's evidence moved.
  const cold = registrationOf(coldPool, swapAt(coldPool, 4700));
  registerOutsideRange(db, 's', cold);
  const third = batch('third', [...hotLogs(), ...otherAt]);
  third.manifest.shards[0]!.request.address = [pool, other];
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, third);

  // The window's delta really is the one identity that moved, and not the two it stayed silent about.
  const cursor = db
    .prepare('select evidence_json from signal_cursors where scope_id = ?')
    .get('s') as { evidence_json: string };
  expect(
    Object.keys(decodeSignalState<{ pools: Record<string, unknown> }>(cursor.evidence_json).pools),
  ).toEqual([poolRegistrationId(cold)]);

  // An identity a delta omits is one that did not move — not one that was deregistered — so the
  // alerts the previous window reported still stand, both of them.
  const after = outbox(db);
  expect(after.map((record) => [record.kind, record.poolId])).toEqual(
    before.map((record) => [record.kind, record.poolId]),
  );
});

const SCALE_POOLS = 4_000;
