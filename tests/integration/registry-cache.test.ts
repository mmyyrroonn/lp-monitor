import type Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import { CHAIN_ID } from '../../src/domain/chain.js';
import type { WorkCounts } from '../../src/ops/work-counters.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';
import type { PoolRegistration } from '../../src/registry/pools.js';
import { PoolRegistry, poolRegistrationId } from '../../src/registry/pools.js';
import { openDatabase } from '../../src/storage/database.js';
import { rawLogKey } from '../../src/storage/manifest.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import {
  decodeStoredRegistration,
  storedPoolKey,
  storedRegistrationJson,
} from '../../src/storage/registration-codec.js';
import type { RegistryView } from '../../src/storage/registry-cache.js';
import { RegistryCache } from '../../src/storage/registry-cache.js';
import { makeScaleData } from '../helpers/live-scale-fixture.js';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const REGISTRY_SCOPE = 'scope-registry';
const OPERATION_SCOPE = 'scope-operations';
const SCALE_POOLS = 80_000;

function hex(value: number): Hex {
  return `0x${value.toString(16).padStart(64, '0')}` as Hex;
}

function address(value: number): Address {
  return `0x${value.toString(16).padStart(40, '0')}` as Address;
}

function open(): Database.Database {
  const database = openDatabase(':memory:');
  databases.push(database);
  return database;
}

/** A registration shaped like the ones the recorder writes. 1 in 7 pools is a v4 pool. */
function registration(seed: number, overrides: Partial<PoolRegistration> = {}): PoolRegistration {
  const pool =
    seed % 7 === 0
      ? { chainId: CHAIN_ID, protocol: 'v4' as const, manager: address(0x9000), poolId: hex(seed) }
      : { chainId: CHAIN_ID, protocol: 'v3' as const, address: address(seed) };
  return {
    pool,
    token0: address(seed % 5 === 0 ? 0x5000 : 0x1000 + seed),
    token1: address(0x2000 + seed),
    feePips: 3000,
    tickSpacing: 60,
    hooks: address(0),
    discoveredAt: {
      blockNumber: 1_000n + BigInt(seed),
      blockHash: hex(0x1_0000 + seed),
      transactionHash: hex(0x2_0000 + seed),
      transactionIndex: 0,
      logIndex: seed,
    },
    assetVersion: 'assets-1',
    source: 'factory-discovery',
    ...overrides,
  };
}

/**
 * A discovery row for every registration, each on its own raw log — the way `acceptRange` writes
 * them, and the only way `pools` accepts a second row for one pool.
 */
function seed(
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
        address(1),
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

function encode(record: PoolRegistration): string {
  return `${poolRegistrationId(record)}|${JSON.stringify(record, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString(10) : item,
  )}`;
}

/**
 * The catalogue as the pre-cache code read it — both scopes, merged by `PoolRegistry` — with every
 * record's full content, so a view that merely agrees on the identities still fails.
 */
function catalogue(database: Database.Database): string[] {
  const read = (scopeId: string) =>
    (
      database
        .prepare(
          'select payload_json from pools where scope_id = ? order by discovered_block_number, pool_key',
        )
        .all(scopeId) as { payload_json: string }[]
    ).map((row) => decodeStoredRegistration(row.payload_json));
  return new PoolRegistry([...read(REGISTRY_SCOPE), ...read(OPERATION_SCOPE)])
    .snapshot()
    .map(encode)
    .sort();
}

function seen(view: RegistryView): string[] {
  return [...view.all()].map(encode).sort();
}

function cache(database: Database.Database): RegistryCache {
  return new RegistryCache(database, REGISTRY_SCOPE, OPERATION_SCOPE);
}

function countsFor<T>(work: () => T): { value: T; counts: WorkCounts } {
  const scope = openWorkCounts();
  try {
    return { value: work(), counts: scope.counts };
  } finally {
    scope.close();
  }
}

test('the first prepare reads both catalogues once and an unchanged prepare reads nothing', () => {
  const database = open();
  const data = makeScaleData({
    poolCount: SCALE_POOLS,
    activePoolCount: 400,
    assetCount: 194,
    historyMinutes: 181,
  });
  seed(database, REGISTRY_SCOPE, data.registrations.slice(0, SCALE_POOLS / 2));
  seed(database, OPERATION_SCOPE, data.registrations.slice(SCALE_POOLS / 2));

  const registry = cache(database);
  const first = countsFor(() => {
    const prepared = registry.prepare();
    prepared.publish();
    return prepared;
  });
  expect(first.counts.registryRowsRead).toBe(SCALE_POOLS);
  expect(first.counts.registryChangesRead).toBe(0);
  expect(first.value.changedPoolIds.size).toBe(SCALE_POOLS);
  expect(seen(first.value.view)).toEqual(catalogue(database));

  const second = countsFor(() => {
    const prepared = registry.prepare();
    prepared.publish();
    return prepared;
  });
  expect(second.counts.registryRowsRead).toBe(0);
  expect(second.counts.registryChangesRead).toBe(0);
  expect(second.counts.registryRowsSerialized).toBe(0);
  expect(second.value.changedPoolIds.size).toBe(0);
  expect(seen(second.value.view)).toEqual(catalogue(database));
  expect(seen(second.value.view)).toHaveLength(SCALE_POOLS);
}, 120_000);

test('two new pools cost two journal rows and never a catalogue read', () => {
  const database = open();
  const known = [registration(1), registration(2), registration(3)];
  seed(database, OPERATION_SCOPE, known);
  const registry = cache(database);
  registry.prepare().publish();

  const added = [registration(11), registration(12)];
  seed(database, OPERATION_SCOPE, added);
  const { value, counts } = countsFor(() => registry.prepare());

  expect(counts.registryRowsRead).toBe(0);
  expect(counts.registryChangesRead).toBe(2);
  expect([...value.changedPoolIds].sort()).toEqual(added.map(poolRegistrationId).sort());
  expect(seen(value.view)).toEqual(catalogue(database));
  expect(value.view.get(poolRegistrationId(added[0]!))).toMatchObject({
    assetVersion: 'assets-1',
    discoveredAt: { blockNumber: added[0]!.discoveredAt.blockNumber },
  });
});

test('a deleted pool disappears and a rewritten pool shows its new record', () => {
  const database = open();
  const stable = registration(1);
  const doomed = registration(2);
  const rewritten = registration(3);
  const seedRecord = registration(4, { source: 'seed-config' });
  seed(database, REGISTRY_SCOPE, [seedRecord, rewritten]);
  seed(database, OPERATION_SCOPE, [stable, doomed]);
  const registry = cache(database);
  registry.prepare().publish();

  database
    .prepare('delete from pools where scope_id = ? and pool_key = ?')
    .run(OPERATION_SCOPE, storedPoolKey(doomed));
  const replaced = registration(4, {
    source: 'factory-discovery',
    discoveredAt: { ...seedRecord.discoveredAt, blockNumber: 9_999n, blockHash: hex(0x9_9999) },
  });
  seed(database, OPERATION_SCOPE, [replaced]);
  const rewrittenRecord = { ...rewritten, assetVersion: 'assets-2' };
  database
    .prepare('update pools set payload_json = ? where scope_id = ? and pool_key = ?')
    .run(storedRegistrationJson(rewrittenRecord), REGISTRY_SCOPE, storedPoolKey(rewritten));

  const { value, counts } = countsFor(() => registry.prepare());
  // Only the pool that already had rows is read back: two rows for the replaced pool, one for the
  // rewritten one. The pool that went away costs nothing but its journal entry.
  expect(counts.registryRowsRead).toBe(3);
  expect(counts.registryChangesRead).toBe(3);
  expect([...value.changedPoolIds].sort()).toEqual(
    [doomed, rewritten, seedRecord].map(poolRegistrationId).sort(),
  );

  // The seed record yields to the chain record, exactly like the batch preview merges them.
  expect(value.view.get(poolRegistrationId(seedRecord))?.source).toBe('factory-discovery');
  expect(value.view.get(poolRegistrationId(seedRecord))?.discoveredAt.blockNumber).toBe(9_999n);
  expect(value.view.get(poolRegistrationId(doomed))).toBeUndefined();
  expect(value.view.get(poolRegistrationId(rewritten))?.assetVersion).toBe('assets-2');
  expect(seen(value.view)).toEqual(catalogue(database));
});

test('the journal speaks about a row while the registry speaks about a pool', () => {
  const database = open();
  const pool = registration(1);
  seed(database, OPERATION_SCOPE, [pool]);
  // A second discovery of the same pool in another range is a second row, not a second pool.
  const rediscovered = registration(1, {
    discoveredAt: { ...pool.discoveredAt, blockNumber: 5_000n, blockHash: hex(0x5_0000) },
  });
  seed(database, OPERATION_SCOPE, [rediscovered]);
  const registry = cache(database);
  expect(registry.prepare().changedPoolIds.size).toBe(1);
  registry.prepare().publish();

  // Removing the older row leaves the pool standing, described by the row that survives.
  database
    .prepare(
      'delete from pools where scope_id = ? and pool_key = ? and discovered_block_number = ?',
    )
    .run(OPERATION_SCOPE, storedPoolKey(pool), Number(pool.discoveredAt.blockNumber));
  const { value, counts } = countsFor(() => registry.prepare());
  expect(counts.registryChangesRead).toBe(1);
  expect(value.view.get(poolRegistrationId(pool))?.discoveredAt.blockNumber).toBe(5_000n);
  expect(seen(value.view)).toEqual(catalogue(database));

  // Removing the last row removes the pool.
  database
    .prepare('delete from pools where scope_id = ? and pool_key = ?')
    .run(OPERATION_SCOPE, storedPoolKey(pool));
  const emptied = registry.prepare();
  expect(emptied.changedPoolIds.size).toBe(1);
  expect(emptied.view.get(poolRegistrationId(pool))).toBeUndefined();
  expect(seen(emptied.view)).toEqual([]);
  expect(seen(emptied.view)).toEqual(catalogue(database));
});

test('uncommitted work is visible to its own view and reaches the cache only on publish', () => {
  const database = open();
  const known = registration(1);
  seed(database, OPERATION_SCOPE, [known]);
  const registry = cache(database);
  registry.prepare().publish();

  const staged = registration(22);
  if (staged.pool.protocol !== 'v3') throw new Error('fixture: 22 must be a v3 pool');
  const rolledBack = registry.prepare();
  rolledBack.stage([staged]);
  expect(rolledBack.view.get(poolRegistrationId(staged))).toEqual(staged);
  expect(rolledBack.view.isDiscoveryRef(rawLogKey(staged.discoveredAt))).toBe(true);
  expect(rolledBack.view.getByV3Address(staged.pool.address)).toEqual(staged);
  rolledBack.discard();

  const afterDiscard = registry.prepare();
  expect(afterDiscard.view.get(poolRegistrationId(staged))).toBeUndefined();
  expect(seen(afterDiscard.view)).toEqual(catalogue(database));

  const committed = registry.prepare();
  committed.stage([staged]);
  // The staged row is the accepted batch's own commit: it lands in `pools` inside the accepting
  // transaction, and `publish` settles the staged work against that row rather than against what
  // the batch asked for.
  seed(database, REGISTRY_SCOPE, [staged]);
  committed.publish();
  const afterPublish = countsFor(() => registry.prepare());
  expect(catalogue(database)).toContain(encode(staged));
  expect(afterPublish.value.view.get(poolRegistrationId(staged))).toEqual(staged);
  expect(seen(afterPublish.value.view)).toEqual(catalogue(database));
  // Publishing folded the row into the shared cache: the next reader replays no journal row and
  // reads no catalogue row back.
  expect(afterPublish.counts.registryRowsRead).toBe(0);
  expect(afterPublish.counts.registryChangesRead).toBe(0);
});

test('publishing inside a transaction is refused', () => {
  const database = open();
  seed(database, OPERATION_SCOPE, [registration(1)]);
  const registry = cache(database);
  const prepared = registry.prepare();
  prepared.stage([registration(2)]);
  expect(() => database.transaction(() => prepared.publish())()).toThrow(/inside a transaction/);
  prepared.discard();
});

test('indexes answer by pool id, v3 address, v4 identity, asset and discovery log', () => {
  const database = open();
  const v3 = registration(1);
  const v4 = registration(7);
  const stock = registration(31, { token0: address(0x5000), token1: address(0xb0b0) });
  if (v3.pool.protocol !== 'v3' || v4.pool.protocol !== 'v4')
    throw new Error('fixture: 1 must be v3 and 7 must be v4');
  seed(database, REGISTRY_SCOPE, [v3]);
  seed(database, OPERATION_SCOPE, [v4, stock]);
  const registry = cache(database);
  const { view } = registry.prepare();

  expect(view.get(poolRegistrationId(v3))).toEqual(v3);
  expect(view.get('4663:v3:missing')).toBeUndefined();
  expect(view.getByV3Address(v3.pool.address)).toEqual(v3);
  expect(view.getByV3Address(address(0xfefe))).toBeUndefined();
  expect(view.getByV4Id(v4.pool.manager, v4.pool.poolId.toUpperCase() as Hex)).toEqual(v4);
  expect(view.getByV4Id(address(0xfefe), v4.pool.poolId)).toBeUndefined();
  // Both sides of a stock pool are attributed, like `stockPoolAttributions`.
  expect([...view.forAsset(stock.token0)].map(poolRegistrationId)).toEqual([
    poolRegistrationId(stock),
  ]);
  expect([...view.forAsset(stock.token1)].map(poolRegistrationId)).toEqual([
    poolRegistrationId(stock),
  ]);
  expect([...view.forAsset(address(0xfefe))]).toEqual([]);
  expect(view.isDiscoveryRef(rawLogKey(v3.discoveredAt))).toBe(true);
  expect(view.isDiscoveryRef(rawLogKey(stock.discoveredAt))).toBe(true);
  expect(view.isDiscoveryRef(`${rawLogKey(v3.discoveredAt)}0`)).toBe(false);
});

test('a seed record yields to the chain record and a cross-scope conflict still throws', () => {
  const database = open();
  const seedRecord = registration(5, { source: 'seed-config' });
  const chainRecord = registration(5, {
    source: 'factory-discovery',
    discoveredAt: { ...seedRecord.discoveredAt, blockNumber: 2_000n, blockHash: hex(0x2_0000) },
  });
  seed(database, REGISTRY_SCOPE, [seedRecord]);
  seed(database, OPERATION_SCOPE, [chainRecord]);
  const merged = cache(database).prepare().view;
  expect(merged.get(poolRegistrationId(seedRecord))?.source).toBe('factory-discovery');
  expect(seen(merged)).toEqual(catalogue(database));

  // The registry scope is read first, so a chain record there is not displaced by a seed record.
  const other = open();
  seed(other, REGISTRY_SCOPE, [chainRecord]);
  seed(other, OPERATION_SCOPE, [seedRecord]);
  expect(cache(other).prepare().view.get(poolRegistrationId(seedRecord))?.source).toBe(
    'factory-discovery',
  );

  const conflicting = open();
  seed(conflicting, REGISTRY_SCOPE, [registration(6)]);
  seed(conflicting, OPERATION_SCOPE, [registration(6, { feePips: 500 })]);
  expect(() => cache(conflicting).prepare()).toThrow(/Conflicting pool registration/);
  expect(() => catalogue(conflicting)).toThrow(/Conflicting pool registration/);
});

test('a database without the journal keeps the compatible full read', () => {
  const database = open();
  const known = registration(1);
  seed(database, OPERATION_SCOPE, [known]);
  for (const trigger of [
    'pools_change_insert',
    'pools_change_delete',
    'pools_change_update',
    'pools_change_move',
  ])
    database.prepare(`drop trigger if exists ${trigger}`).run();
  database.prepare('drop table registry_changes').run();

  const registry = cache(database);
  const first = countsFor(() => registry.prepare());
  expect(first.counts.registryRowsRead).toBe(1);
  expect(first.value.view.revisionKey).toBe('legacy');
  // With no journal there is no way to know what moved, so every pool is reported as changed.
  expect(first.value.changedPoolIds.size).toBe(1);

  const second = countsFor(() => registry.prepare());
  expect(second.counts.registryRowsRead).toBe(1);
  expect(second.counts.registryChangesRead).toBe(0);
  expect(second.value.view.revisionKey).toBe('legacy');
  expect(seen(second.value.view)).toEqual(catalogue(database));

  // A cache invalidated mid-batch reloads instead of trusting its own memory.
  registry.invalidate();
  expect(countsFor(() => registry.prepare()).counts.registryRowsRead).toBe(1);
});

test('invalidate makes the next prepare read the catalogue again', () => {
  const database = open();
  seed(database, OPERATION_SCOPE, [registration(1), registration(2)]);
  const registry = cache(database);
  registry.prepare().publish();
  const { value, counts } = countsFor(() => {
    registry.invalidate();
    return registry.prepare();
  });
  expect(counts.registryRowsRead).toBe(2);
  expect(value.changedPoolIds.size).toBe(2);
  expect(seen(value.view)).toEqual(catalogue(database));
});

test('the live view answers like the range store it replaces', () => {
  const database = open();
  const data = makeScaleData({
    poolCount: 400,
    activePoolCount: 40,
    assetCount: 20,
    historyMinutes: 181,
  });
  seed(database, OPERATION_SCOPE, data.registrations);
  const store = new SqliteRangeStore(database);
  const view = cache(database).prepare().view;

  expect(seen(view)).toEqual(catalogue(database));
  expect([...view.all()].map(poolRegistrationId).sort()).toEqual(
    new PoolRegistry(store.pools(OPERATION_SCOPE)).snapshot().map(poolRegistrationId),
  );
  const first = store.pools(OPERATION_SCOPE)[0]!;
  expect(view.get(poolRegistrationId(first))).toEqual(first);
});
