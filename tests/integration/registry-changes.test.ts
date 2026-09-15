import type Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import type { RawLog } from '../../src/domain/types.js';
import type { PoolRegistration } from '../../src/registry/pools.js';
import { poolRegistrationId } from '../../src/registry/pools.js';
import { openDatabase } from '../../src/storage/database.js';
import type { FetchShardManifest } from '../../src/storage/manifest.js';
import { rawLogKey } from '../../src/storage/manifest.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { registryChangesAfter, registryRevision } from '../../src/storage/registry-changes.js';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function hex(value: number): Hex {
  return `0x${value.toString(16).padStart(64, '0')}` as Hex;
}

function address(value: number): Address {
  return `0x${value.toString(16).padStart(40, '0')}` as Address;
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

/** The discovery log of every fixture pool in this file. */
const DISCOVERY = log(1, 105n);

function registration(seed: number, overrides: Partial<PoolRegistration> = {}): PoolRegistration {
  return {
    pool: { chainId: 4663, protocol: 'v3', address: address(seed) },
    token0: address(seed + 100),
    token1: address(seed + 200),
    feePips: 3000,
    tickSpacing: 60,
    hooks: address(0),
    discoveredAt: {
      blockNumber: DISCOVERY.blockNumber,
      blockHash: DISCOVERY.blockHash,
      transactionHash: DISCOVERY.transactionHash,
      transactionIndex: DISCOVERY.transactionIndex,
      logIndex: DISCOVERY.logIndex,
    },
    assetVersion: 'assets-1',
    source: 'factory-discovery',
    ...overrides,
  };
}

/**
 * The stored payload shape, rebuilt here rather than taken from the codec under test: the fixture
 * row has to be a legal `pools` row even if the production encoder changes.
 */
function fixturePayload(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString(10) : item,
  );
}

function fixtureKey(value: PoolRegistration): string {
  const pool = value.pool;
  return fixturePayload(
    pool.protocol === 'v3'
      ? { chainId: pool.chainId, protocol: pool.protocol, address: pool.address.toLowerCase() }
      : {
          chainId: pool.chainId,
          protocol: pool.protocol,
          manager: pool.manager.toLowerCase(),
          poolId: pool.poolId.toLowerCase(),
        },
  );
}

type Fixture = { database: Database.Database; store: SqliteRangeStore };

function open(): Fixture {
  const database = openDatabase(':memory:');
  databases.push(database);
  return { database, store: new SqliteRangeStore(database) };
}

function accept(
  store: SqliteRangeStore,
  id: string,
  scopeId: string,
  fromBlock: bigint,
  toBlock: bigint,
  logs: readonly RawLog[],
  poolRegistrations: readonly PoolRegistration[],
): void {
  const shard: FetchShardManifest = {
    shardId: `${id}:shard`,
    filterId: `filter-${id}`,
    request: {
      fromBlock,
      toBlock,
      address: logs.length === 0 ? [address(1)] : [...new Set(logs.map((item) => item.address))],
      topics: [],
    },
    status: 'success',
    responseHash: hex(900),
    logKeys: logs.map(rawLogKey),
    logCount: logs.length,
    error: null,
  };
  store.acceptRange({
    id,
    scopeId,
    fromBlock,
    toBlock,
    end: { number: toBlock, hash: hex(Number(toBlock)), timestampSec: Number(toBlock) },
    previous: {
      number: fromBlock - 1n,
      hash: hex(Number(fromBlock) - 1),
      timestampSec: Number(fromBlock) - 1,
    },
    logs,
    observedAtMs: 1_000,
    captureMode: 'synthetic',
    filterPlanHash: `plan-${id}`,
    manifestHash: `manifest-${id}`,
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: `version-${id}`,
      expectedShardIds: [shard.shardId],
      shards: [shard],
    },
    poolRegistrations,
  });
}

/** A legal fixture row written straight into `pools`, on top of an existing raw log. */
function insertPoolRow(
  database: Database.Database,
  scopeId: string,
  value: PoolRegistration,
  payload = fixturePayload(value),
): void {
  const rawLogId = (
    database.prepare('select id from raw_logs where raw_key = ?').get(rawLogKey(DISCOVERY)) as {
      id: number;
    }
  ).id;
  database
    .prepare(
      `insert into pools(scope_id, pool_key, protocol, discovered_raw_log_id,
         discovered_block_number, discovered_block_hash, payload_json) values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(scopeId, fixtureKey(value), value.pool.protocol, rawLogId, 105, hex(105), payload);
}

/** One batch that seeds the discovery raw log, then one that carries the registrations. */
function withPools(
  store: SqliteRangeStore,
  scopeId: string,
  registrations: readonly PoolRegistration[],
): void {
  accept(store, 'seed', scopeId, 101n, 120n, [DISCOVERY], []);
  accept(store, 'pools', scopeId, 121n, 140n, [], registrations);
}

test('a rolled back transaction leaves both the journal and the revision untouched', () => {
  const { database, store } = open();
  withPools(store, 'scope-a', [registration(1)]);
  const before = registryRevision(database, 'scope-a');
  expect(before).toBeGreaterThan(0);

  const extra = registration(2);
  expect(() =>
    database.transaction(() => {
      insertPoolRow(database, 'scope-a', extra);
      throw new Error('rollback');
    })(),
  ).toThrow('rollback');

  expect(
    database.prepare('select count(*) as count from pools where scope_id = ?').get('scope-a'),
  ).toEqual({
    count: 1,
  });
  expect(registryRevision(database, 'scope-a')).toBe(before);
  expect(registryChangesAfter(database, 'scope-a', before)).toEqual([]);
});

test('an insert, a real update and a delete each record exactly one change in seq order', () => {
  const { database, store } = open();
  const first = registration(1);
  const second = registration(2);
  withPools(store, 'scope-a', [first, second]);

  const inserted = registryChangesAfter(database, 'scope-a', 0);
  expect(inserted).toHaveLength(2);
  expect(inserted.map((change) => poolRegistrationId(change.after!))).toEqual([
    poolRegistrationId(first),
    poolRegistrationId(second),
  ]);
  expect(inserted.map((change) => change.before)).toEqual([null, null]);
  expect(inserted[1]!.seq).toBeGreaterThan(inserted[0]!.seq);
  // The journal carries the stored bytes, so the revived record has to keep its bigint height.
  expect(inserted[0]!.after!.discoveredAt.blockNumber).toBe(105n);
  expect(inserted[0]!.after!.discoveredAt.blockHash).toBe(DISCOVERY.blockHash);
  expect(inserted[0]!.scopeId).toBe('scope-a');
  expect(inserted[0]!.poolKey).toBe(fixtureKey(first));

  const updated = registration(1, { assetVersion: 'assets-2' });
  database
    .prepare('update pools set payload_json = ? where scope_id = ? and pool_key = ?')
    .run(fixturePayload(updated), 'scope-a', fixtureKey(first));
  const afterUpdate = registryChangesAfter(database, 'scope-a', inserted.at(-1)!.seq);
  expect(afterUpdate).toHaveLength(1);
  expect(afterUpdate[0]!.before!.assetVersion).toBe('assets-1');
  expect(afterUpdate[0]!.after!.assetVersion).toBe('assets-2');
  expect(afterUpdate[0]!.seq).toBeGreaterThan(inserted.at(-1)!.seq);

  database
    .prepare('delete from pools where scope_id = ? and pool_key = ?')
    .run('scope-a', fixtureKey(second));
  const afterDelete = registryChangesAfter(database, 'scope-a', afterUpdate[0]!.seq);
  expect(afterDelete).toHaveLength(1);
  expect(afterDelete[0]!.before!.discoveredAt.blockNumber).toBe(105n);
  expect(afterDelete[0]!.after).toBeNull();
});

test('a rewrite that changes nothing records nothing', () => {
  const { database, store } = open();
  const only = registration(1);
  withPools(store, 'scope-a', [only]);
  const before = registryRevision(database, 'scope-a');
  const key = fixtureKey(only);

  // Same payload, same key, same scope: the classic no-op upsert that must not invalidate a cache.
  database
    .prepare('update pools set payload_json = ? where scope_id = ? and pool_key = ?')
    .run(fixturePayload(only), 'scope-a', key);
  database
    .prepare('update pools set discovered_block_hash = ? where scope_id = ? and pool_key = ?')
    .run(hex(777), 'scope-a', key);
  database
    .prepare(
      `insert or ignore into pools(scope_id, pool_key, protocol, discovered_raw_log_id,
         discovered_block_number, discovered_block_hash, payload_json)
       values (?, ?, ?, (select id from raw_logs where raw_key = ?), ?, ?, ?)`,
    )
    .run('scope-a', key, 'v3', rawLogKey(DISCOVERY), 105, hex(105), fixturePayload(only));

  expect(registryRevision(database, 'scope-a')).toBe(before);
  expect(registryChangesAfter(database, 'scope-a', before)).toEqual([]);
});

test('an update that moves a pool between scopes records an old-scope delete and a new-scope insert', () => {
  const { database, store } = open();
  const only = registration(1);
  withPools(store, 'scope-a', [only]);
  const key = fixtureKey(only);
  const beforeOld = registryRevision(database, 'scope-a');
  const beforeNew = registryRevision(database, 'scope-b');

  database
    .prepare('update pools set scope_id = ? where scope_id = ? and pool_key = ?')
    .run('scope-b', 'scope-a', key);

  expect(registryChangesAfter(database, 'scope-a', beforeOld)).toMatchObject([
    { scopeId: 'scope-a', poolKey: key, after: null },
  ]);
  const moved = registryChangesAfter(database, 'scope-b', beforeNew);
  expect(moved).toHaveLength(1);
  expect(moved[0]!.scopeId).toBe('scope-b');
  expect(moved[0]!.before).toBeNull();
  expect(poolRegistrationId(moved[0]!.after!)).toBe(poolRegistrationId(only));
  expect(registryRevision(database, 'scope-a')).toBeGreaterThan(beforeOld);
  expect(registryRevision(database, 'scope-b')).toBeGreaterThan(beforeNew);
});

test('a key rewrite records the old key as removed and the new key as present', () => {
  const { database, store } = open();
  const only = registration(1);
  withPools(store, 'scope-a', [only]);
  const oldKey = fixtureKey(only);
  const newKey = fixtureKey(registration(9));
  const before = registryRevision(database, 'scope-a');

  database
    .prepare('update pools set pool_key = ? where scope_id = ? and pool_key = ?')
    .run(newKey, 'scope-a', oldKey);

  expect(registryChangesAfter(database, 'scope-a', before)).toMatchObject([
    { scopeId: 'scope-a', poolKey: oldKey, before: expect.anything(), after: null },
    { scopeId: 'scope-a', poolKey: newKey, before: null, after: expect.anything() },
  ]);
});

test('the revision is per scope and a scope with no rows reports zero', () => {
  const { database, store } = open();
  expect(registryRevision(database, 'scope-a')).toBe(0);
  expect(registryRevision(database, 'untouched')).toBe(0);
  withPools(store, 'scope-a', [registration(1)]);
  expect(registryRevision(database, 'untouched')).toBe(0);
  expect(registryChangesAfter(database, 'untouched', 0)).toEqual([]);
  expect(registryChangesAfter(database, 'scope-a', registryRevision(database, 'scope-a'))).toEqual(
    [],
  );
});
