import type Database from 'better-sqlite3';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, test } from 'vitest';
import { CHAIN_ID } from '../../src/domain/chain.js';
import type { BlockAnchor, ChainReader, RawLog } from '../../src/domain/types.js';
import { computeWatchScopeId } from '../../src/ingest/filter-plan.js';
import { OperationFilterIndex } from '../../src/ingest/operation-filter-index.js';
import { fetchRange } from '../../src/ingest/record-range.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';
import { makeScaleData } from '../helpers/live-scale-fixture.js';
import { v3FactoryAbi, v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import { v4ManagerAbi } from '../../src/protocols/uniswap-v4/abi.js';
import { computeV4PoolId } from '../../src/protocols/uniswap-v4/pool-key.js';
import { createAssetRegistry } from '../../src/registry/assets.js';
import { poolRegistrationId, type PoolRegistration } from '../../src/registry/pools.js';
import { openDatabase } from '../../src/storage/database.js';
import { rawLogKey } from '../../src/storage/manifest.js';
import { readBatch } from '../../src/storage/payload-store.js';
import { RegistryCache } from '../../src/storage/registry-cache.js';
import { storedPoolKey, storedRegistrationJson } from '../../src/storage/registration-codec.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';

const factory = '0x1000000000000000000000000000000000000001' as Address;
const manager = '0x2000000000000000000000000000000000000002' as Address;
const rwa0 = '0x3000000000000000000000000000000000000003' as Address;
const rwa1 = '0x4000000000000000000000000000000000000004' as Address;
const quote = '0x5000000000000000000000000000000000000005' as Address;
/** The pool an earlier run already registered, and a second one that stays silent in every range. */
const held = '0x6000000000000000000000000000000000000006' as Address;
const silent = '0x7000000000000000000000000000000000000007' as Address;
const fresh = '0x8000000000000000000000000000000000000008' as Address;
const hooks = '0x9000000000000000000000000000000000000009' as Address;
const zeroAddress = '0x0000000000000000000000000000000000000000' as Address;

const deployments = { v3Factory: factory, v4Manager: manager };
/** The scope the recorder itself computes for a run over these assets. */
const operationsScope = (assets: readonly Address[] = [rwa0]): string =>
  computeWatchScopeId(createAssetRegistry('assets-v1', assets), 'operations', deployments);
const scopeId = operationsScope();

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function open(): Database.Database {
  const database = openDatabase(':memory:');
  databases.push(database);
  return database;
}

function hash(value: number): Hex {
  return `0x${value.toString(16).padStart(64, '0')}` as Hex;
}

function rawLog(
  address: Address,
  blockNumber: bigint,
  logIndex: number,
  topics: readonly Hex[],
  data: Hex = '0x',
): RawLog {
  return {
    address,
    blockNumber,
    blockHash: hash(Number(blockNumber)),
    transactionHash: hash(10_000 + logIndex),
    transactionIndex: 0,
    logIndex,
    topics,
    data,
    rawBlockTimestamp: null,
  };
}

function v3Created(blockNumber: bigint, logIndex: number, pool: Address): RawLog {
  const topics = encodeEventTopics({
    abi: v3FactoryAbi,
    eventName: 'PoolCreated',
    args: { token0: rwa0, token1: quote, fee: 3_000 },
  });
  return rawLog(
    factory,
    blockNumber,
    logIndex,
    topics as readonly Hex[],
    encodeAbiParameters([{ type: 'int24' }, { type: 'address' }], [60, pool]),
  );
}

/** A V3 pool event. `sender` keeps the second topic an address, exactly as the event declares it. */
function v3Swap(blockNumber: bigint, logIndex: number, pool: Address): RawLog {
  return rawLog(
    pool,
    blockNumber,
    logIndex,
    encodeEventTopics({
      abi: v3PoolAbi,
      eventName: 'Swap',
      args: { sender: pool, recipient: pool },
    }) as readonly Hex[],
  );
}

function v4Initialized(
  blockNumber: bigint,
  logIndex: number,
  currency0: Address,
  currency1: Address,
) {
  const id = computeV4PoolId({ currency0, currency1, fee: 3_000, tickSpacing: 60, hooks });
  const topics = encodeEventTopics({
    abi: v4ManagerAbi,
    eventName: 'Initialize',
    args: { id, currency0, currency1 },
  });
  return {
    id,
    log: rawLog(
      manager,
      blockNumber,
      logIndex,
      topics as readonly Hex[],
      encodeAbiParameters(
        [
          { type: 'uint24' },
          { type: 'int24' },
          { type: 'address' },
          { type: 'uint160' },
          { type: 'int24' },
        ],
        [3_000, 60, hooks, 1n << 96n, 0],
      ),
    ),
  };
}

/** A manager Swap. The pool id in the first topic is the whole identity this batch reads. */
function v4Swap(blockNumber: bigint, logIndex: number, id: Hex): RawLog {
  return rawLog(
    manager,
    blockNumber,
    logIndex,
    encodeEventTopics({
      abi: v4ManagerAbi,
      eventName: 'Swap',
      args: { id, sender: zeroAddress },
    }) as readonly Hex[],
  );
}

type Filter = Parameters<ChainReader['getLogs']>[0];

/** One topic position's values, whichever of the two shapes a plan writes there. */
function topicValues(value: Filter['topics'][number] | undefined): readonly string[] {
  if (value === undefined || value === null) return [];
  return typeof value === 'string'
    ? [value.toLowerCase()]
    : value.map((topic) => topic.toLowerCase());
}

function matches(filter: Filter, log: RawLog): boolean {
  if (log.blockNumber < filter.fromBlock || log.blockNumber > filter.toBlock) return false;
  if (
    filter.address.length > 0 &&
    !filter.address.some((address) => address.toLowerCase() === log.address.toLowerCase())
  )
    return false;
  return filter.topics.every((wanted, index) => {
    if (wanted === null) return true;
    const actual = log.topics[index]?.toLowerCase();
    return typeof wanted === 'string'
      ? wanted.toLowerCase() === actual
      : wanted.some((topic) => topic.toLowerCase() === actual);
  });
}

/** A provider that answers every request from one log set, plus whatever it volunteers on top. */
class FixtureReader implements ChainReader {
  readonly calls: Filter[] = [];
  constructor(
    private readonly logs: readonly RawLog[],
    private readonly extra: (
      filter: Filter,
      matched: readonly RawLog[],
    ) => readonly RawLog[] = () => [],
  ) {}

  async getAnchor(block: bigint | 'latest') {
    const number = block === 'latest' ? 100n : block;
    return { number, hash: hash(Number(number)), timestampSec: 1_800 };
  }

  async getLogs(filter: Filter): Promise<readonly RawLog[]> {
    this.calls.push(filter);
    const matched = this.logs.filter((log) => matches(filter, log));
    return [...matched, ...this.extra(filter, matched)];
  }
}

/** A pool an earlier run registered, discovered long before the range under test. */
function heldPool(seed: number, address: Address): PoolRegistration {
  return {
    pool: { chainId: CHAIN_ID, protocol: 'v3', address },
    token0: rwa0,
    token1: quote,
    feePips: 3_000,
    tickSpacing: 60,
    hooks: zeroAddress,
    discoveredAt: {
      blockNumber: BigInt(seed),
      blockHash: hash(1_000 + seed),
      transactionHash: hash(2_000 + seed),
      transactionIndex: 0,
      logIndex: 0,
    },
    assetVersion: 'assets-v1',
    source: 'seed-config',
  };
}

/** Catalogue rows the way `acceptRange` writes them: one raw log, one merged record per pool. */
function seedCatalogue(
  database: Database.Database,
  registrations: readonly PoolRegistration[],
  scope = scopeId,
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
        zeroAddress,
        '[]',
        '0x',
        null,
        '{}',
      );
      insertPool.run(
        scope,
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

/**
 * The recorder's own sequence: the registry context is prepared first, the batch fetches against it,
 * and the round's templates are settled by the caller afterwards.
 */
async function record(
  reader: FixtureReader,
  database: Database.Database,
  assets: readonly Address[] = [rwa0],
  maxFilterValues = 1_000,
  range: { fromBlock: bigint; toBlock: bigint; previous?: BlockAnchor } = {
    fromBlock: 100n,
    toBlock: 100n,
  },
) {
  const scope = operationsScope(assets);
  const context = new RegistryCache(database, scope, scope);
  const prepared = context.prepare();
  const index = new OperationFilterIndex(deployments, maxFilterValues);
  const batch = await fetchRange(reader, {
    mode: 'operations',
    fromBlock: range.fromBlock,
    toBlock: range.toBlock,
    end: { number: range.toBlock, hash: hash(Number(range.toBlock)), timestampSec: 1_800 },
    ...(range.previous === undefined ? {} : { previous: range.previous }),
    assets: createAssetRegistry('assets-v1', assets),
    registry: prepared,
    operationFilters: index,
    ...deployments,
    maxFilterValues,
    observedAtMs: 2_000,
    captureMode: 'synthetic',
  });
  index.publish();
  prepared.publish();
  return batch;
}

function ids(batch: { poolRegistrations?: readonly PoolRegistration[] }): readonly string[] {
  return (batch.poolRegistrations ?? []).map(poolRegistrationId).sort();
}

function registrationAt(
  batch: { poolRegistrations?: readonly PoolRegistration[] },
  address: Address,
) {
  return (batch.poolRegistrations ?? []).find(
    (record) => record.pool.protocol === 'v3' && record.pool.address === address,
  );
}

/** Every array in a batch that holds pool registrations, wherever it is nested. */
function registrationArrays(value: unknown, path = ''): readonly string[] {
  if (Array.isArray(value)) {
    const isRegistration =
      value.length > 0 &&
      value.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'pool' in entry &&
          'discoveredAt' in entry &&
          'token0' in entry,
      );
    return [
      ...(isRegistration ? [path] : []),
      ...value.flatMap((entry, position) => registrationArrays(entry, `${path}[${position}]`)),
    ];
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    registrationArrays(entry, path === '' ? key : `${path}.${key}`),
  );
}

/** One round through the recorder's own sequence, sharing the index and context with its siblings. */
async function round(
  reader: FixtureReader,
  database: Database.Database,
  context: RegistryCache,
  index: OperationFilterIndex,
  fromBlock: bigint,
  toBlock: bigint,
  previous?: BlockAnchor,
) {
  const prepared = context.prepare();
  const batch = await fetchRange(reader, {
    mode: 'operations',
    fromBlock,
    toBlock,
    end: { number: toBlock, hash: hash(Number(toBlock)), timestampSec: 1_800 },
    ...(previous === undefined ? {} : { previous }),
    assets: createAssetRegistry('assets-v1', [rwa0]),
    registry: prepared,
    operationFilters: index,
    ...deployments,
    maxFilterValues: 1_000,
    observedAtMs: 2_000,
    captureMode: 'synthetic',
  });
  index.publish();
  prepared.publish();
  return batch;
}

describe('the plan holds at the review scale', () => {
  test('an 80k catalogue is adopted once and costs nothing per unchanged round', async () => {
    const database = open();
    const scale = makeScaleData({
      poolCount: 80_000,
      activePoolCount: 400,
      assetCount: 194,
      historyMinutes: 181,
    });
    seedCatalogue(database, scale.registrations);
    const context = new RegistryCache(database, scopeId, scopeId);
    const index = new OperationFilterIndex(deployments, 1_000);
    // A V3 pool, so the one log of the second range names a pool by address.
    const target = scale.registrations.find((record) => record.pool.protocol === 'v3')!;
    const address = target.pool.protocol === 'v3' ? target.pool.address : zeroAddress;
    const reader = new FixtureReader([v3Swap(101n, 3, address)]);

    const adopting = openWorkCounts();
    let first: Awaited<ReturnType<typeof round>>;
    try {
      first = await round(reader, database, context, index, 100n, 100n);
    } finally {
      adopting.close();
    }
    const worked = openWorkCounts();
    let second: Awaited<ReturnType<typeof round>>;
    try {
      second = await round(reader, database, context, index, 101n, 101n, first.end);
    } finally {
      worked.close();
    }

    // Adopting the catalogue is one rebuild per protocol and one scan of every pool value.
    expect(adopting.counts.operationFilterRebuilds).toBe(2);
    expect(adopting.counts.operationFilterValuesScanned).toBe(80_000);
    expect(second.completeness).toBe('complete');
    expect(second.logs.map((entry) => entry.logIndex)).toEqual([3]);
    // An unchanged round rebuilds no template and sorts no pool value: the plan is re-wrapped around
    // the bounds of this range, and the batch carries the one pool its log names out of 80,000.
    expect(worked.counts.operationFilterRebuilds).toBe(0);
    expect(worked.counts.operationFilterValuesScanned).toBe(0);
    expect(second.poolRegistrations).toHaveLength(1);
    expect(poolRegistrationId(second.poolRegistrations![0]!)).toBe(poolRegistrationId(target));
    // The array is a dependency set, so the round asked for all 80,000 pools and carried one.
    expect(reader.calls.some((call) => call.address.length === 1_000)).toBe(true);
    // ...and the requests themselves still scale with the catalogue: the array shrank, the filter
    // plan did not. That cost is R05's, and it is counted here rather than hidden.
    expect(second.manifest.shards.length).toBe(84);
  }, 180_000);
});

describe('a batch carries the registrations its own logs depend on', () => {
  test('an old pool swap and a new pool in one batch carry exactly those two registrations', async () => {
    const database = open();
    const active = heldPool(5, held);
    const cold = heldPool(6, silent);
    seedCatalogue(database, [active, cold]);
    const reader = new FixtureReader([
      v3Created(100n, 2, fresh),
      v3Swap(100n, 3, held),
      v3Swap(100n, 4, fresh),
    ]);

    const batch = await record(reader, database);

    expect(batch.completeness).toBe('complete');
    expect(batch.registryMode).toBe('referenced-v1');
    // The catalogue's own record for the old pool, and this batch's discovery of the new one: the
    // array is exactly what the batch's logs name, not what the registry holds.
    const oldActivePoolId = poolRegistrationId(active);
    const newPoolId = poolRegistrationId(registrationAt(batch, fresh)!);
    expect(ids(batch)).toEqual([newPoolId, oldActivePoolId].sort());
    expect(batch.poolRegistrations).toHaveLength(2);
    expect(registrationAt(batch, held)).toEqual(active);
    expect(registrationAt(batch, fresh)?.source).toBe('uniswap-v3:PoolCreated');
    // ...while the silent pool is neither in the array nor missing from the requests: the batch
    // still asks for every pool the registry holds.
    expect(registrationAt(batch, silent)).toBeUndefined();
    expect(
      reader.calls.some((call) => call.address.includes(held) && call.address.includes(silent)),
    ).toBe(true);
    // Nothing else in the batch hides the array it no longer carries.
    expect(registrationArrays(batch)).toEqual(['poolRegistrations']);
  });

  test('plans a pool created and swapped in the same block, and keeps its log once', async () => {
    const database = open();
    seedCatalogue(database, [heldPool(5, held)]);
    const { id, log } = v4Initialized(100n, 2, rwa0, quote);
    const reader = new FixtureReader([log, v4Swap(100n, 3, id)]);

    const batch = await record(reader, database);

    expect(batch.completeness).toBe('complete');
    expect(batch.registryMode).toBe('referenced-v1');
    // The Initialize log answers both the discovery request and the operations request that the
    // same round planned for it; one raw log and one registration come out of that.
    expect(new Set(batch.logs.map(rawLogKey)).size).toBe(batch.logs.length);
    expect(batch.logs.map((entry) => entry.logIndex)).toEqual([2, 3]);
    expect(batch.poolRegistrations).toHaveLength(1);
    expect(batch.poolRegistrations?.[0]?.pool).toMatchObject({ protocol: 'v4', poolId: id });
    // The round planned the pool it had just discovered: its id is in the manager request's values.
    expect(
      reader.calls.some(
        (call) => call.address.includes(manager) && topicValues(call.topics[1]).includes(id),
      ),
    ).toBe(true);
  });

  test('keeps one registration for a pool two stocks share, however many logs name it', async () => {
    const database = open();
    seedCatalogue(database, [heldPool(5, held)], operationsScope([rwa0, rwa1]));
    const { id, log } = v4Initialized(100n, 2, rwa0, rwa1);
    const reader = new FixtureReader([log, v4Swap(100n, 3, id), v4Swap(100n, 4, id)]);

    const batch = await record(reader, database, [rwa0, rwa1]);

    expect(batch.completeness).toBe('complete');
    expect(new Set(batch.logs.map(rawLogKey)).size).toBe(batch.logs.length);
    expect(batch.poolRegistrations).toHaveLength(1);
    const only = batch.poolRegistrations![0]!;
    expect(only.pool.protocol === 'v4' && only.pool.poolId).toBe(id);
    expect([only.token0, only.token1].map((token) => token.toLowerCase()).sort()).toEqual(
      [rwa0, rwa1].sort(),
    );
  });

  test('carries the pool a range only discovered, and no operation request of its own', async () => {
    const database = open();
    seedCatalogue(database, [heldPool(5, held), heldPool(6, silent)]);
    const reader = new FixtureReader([v3Created(100n, 2, fresh)]);

    const batch = await record(reader, database);

    expect(batch.completeness).toBe('complete');
    expect(batch.registryMode).toBe('referenced-v1');
    expect(batch.logs.map((entry) => entry.logIndex)).toEqual([2]);
    expect(ids(batch)).toEqual([poolRegistrationId(registrationAt(batch, fresh)!)]);
    expect(registrationAt(batch, fresh)?.discoveredAt.blockNumber).toBe(100n);
  });

  test('an empty referenced batch claims nothing about the pools it did not see', async () => {
    const database = open();
    seedCatalogue(database, [heldPool(5, held), heldPool(6, silent)]);
    const reader = new FixtureReader([]);

    const batch = await record(reader, database);

    expect(batch.completeness).toBe('complete');
    expect(batch.logs).toEqual([]);
    // An empty array under the mode means "this batch referenced nothing" — the registry behind it
    // still holds both pools, which is exactly what an unmarked empty array could not say.
    expect(batch.poolRegistrations).toEqual([]);
    expect(batch.registryMode).toBe('referenced-v1');
    expect(new SqliteRangeStore(database).pools(scopeId)).toHaveLength(2);
  });

  test('keeps an unresolvable log as raw evidence and fabricates no registration for it', async () => {
    const database = open();
    seedCatalogue(database, [heldPool(5, held)]);
    const unknownPool = '0xa00000000000000000000000000000000000000a' as Address;
    const strangerSwap = v3Swap(100n, 5, unknownPool);
    const unknownId = hash(0xbeef);
    const foreign = [
      // A manager event no operation request asks for, whose second topic is not a pool id.
      rawLog(manager, 100n, 6, [hash(0xfeed), hash(0xdead)]),
      // An operation event naming a pool id this registry does not hold.
      v4Swap(100n, 7, unknownId),
    ];
    // The provider volunteers logs the request never asked for: a pool address this registry has
    // never seen, a manager event that is not an operation event, and an operation event naming a
    // pool id it does not hold. Only the last two can even be candidates, and neither resolves.
    const volunteer = (filter: Filter) =>
      filter.address.includes(held) ? [strangerSwap, ...foreign] : [];
    const reader = new FixtureReader([v3Swap(100n, 3, held)], volunteer);

    const batch = await record(reader, database);

    expect(batch.completeness).toBe('complete');
    // Every log the provider returned is kept...
    expect(batch.logs.map((entry) => entry.logIndex)).toEqual([3, 5, 6, 7]);
    // ...and not one of them invents a pool: the array holds the registry's own record, nothing else.
    expect(ids(batch)).toEqual([poolRegistrationId(heldPool(5, held))]);
  });
});

describe('the mode travels with the batch', () => {
  test('survives both stores, refuses a rewrite that drops it, and never deletes a silent pool', async () => {
    const database = open();
    const active = heldPool(5, held);
    seedCatalogue(database, [active, heldPool(6, silent)]);
    const reader = new FixtureReader([v3Created(100n, 2, fresh), v3Swap(100n, 3, held)]);
    const batch = await record(reader, database);
    const store = new SqliteRangeStore(database);

    store.saveRaw(batch, { compact: true });
    expect(readBatch(database, batch.id)).toEqual(batch);
    expect(readBatch(database, batch.id).registryMode).toBe('referenced-v1');

    const inline = { ...batch, id: `${batch.id}-inline` };
    store.saveRaw(inline);
    expect(readBatch(database, inline.id).registryMode).toBe('referenced-v1');
    // The persisted bytes, not just the decoded object, say how to read the array.
    expect(
      database
        .prepare('select payload_json from ingest_batches where id = ?')
        .pluck()
        .get(inline.id),
    ).toContain('referenced-v1');

    // The batch's array is written as rows, and it never withdraws a pool it did not mention: what
    // a referenced batch carries is a set of dependencies, not a catalogue.
    const changes = store.acceptRange(batch);
    expect(changes.added.length).toBeGreaterThan(0);
    expect(new SqliteRangeStore(database).pools(scopeId)).toHaveLength(3);
    expect(readBatch(database, batch.id).registryMode).toBe('referenced-v1');

    // A re-write that drops the mode is a different transport, and the store refuses it rather than
    // silently reinterpreting the array as the whole catalogue.
    const stripped = { ...batch } as Record<string, unknown>;
    delete stripped.registryMode;
    expect(() => store.saveRaw(stripped as never)).toThrow(/immutable/i);
  });

  test('carries a dependency an earlier accepted batch discovered, and resolves it there', async () => {
    const database = open();
    const store = new SqliteRangeStore(database);
    const reader = new FixtureReader([v3Created(100n, 2, fresh), v3Swap(200n, 3, fresh)]);
    const first = await record(reader, database);
    store.saveRaw(first, { compact: true });
    store.acceptRange(first);

    const second = await record(reader, database, [rwa0], 1_000, {
      fromBlock: 101n,
      toBlock: 200n,
      previous: first.end,
    });

    expect(second.completeness).toBe('complete');
    expect(second.registryMode).toBe('referenced-v1');
    expect(second.logs.map((entry) => entry.logIndex)).toEqual([3]);
    // The pool's discovery log lives in the earlier batch, never in this one: the dependency is the
    // registry's own record, and the store resolves it against evidence that batch already
    // persisted rather than re-fetching a discovery log the provider was never asked for.
    expect(second.poolRegistrations).toHaveLength(1);
    expect(registrationAt(second, fresh)?.discoveredAt.blockNumber).toBe(100n);
    const changes = store.acceptRange(second);
    // This range's own swap is the change; the pool it names was already added by the batch that
    // discovered it, and the dependency it carried neither duplicates nor withdraws it.
    expect(changes.added.map((log) => log.logIndex)).toEqual([3]);
    expect(store.pools(scopeId)).toHaveLength(1);
    expect(store.acceptedTip(scopeId)?.number).toBe(200n);
    expect(
      database
        .prepare('select count(*) from raw_logs where raw_key = ?')
        .pluck()
        .get(rawLogKey(registrationAt(second, fresh)!.discoveredAt)),
    ).toBe(1);
  });
});
