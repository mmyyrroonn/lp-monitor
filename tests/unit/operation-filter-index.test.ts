import { describe, expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import { CHAIN_ID } from '../../src/domain/chain.js';
import { buildOperationFilterPlan, type PlannedFilter } from '../../src/ingest/filter-plan.js';
import { OperationFilterIndex } from '../../src/ingest/operation-filter-index.js';
import { openWorkCounts, type WorkCounts } from '../../src/ops/work-counters.js';
import type { PoolRegistration } from '../../src/registry/pools.js';
import { poolRegistrationId } from '../../src/registry/pools.js';
import type { PreparedRegistry, RegistryView } from '../../src/storage/registry-cache.js';

const MANAGER = '0x9000000000000000000000000000000000000009' as Address;
const FACTORY = '0x8000000000000000000000000000000000000008' as Address;
const deployments = { v3Factory: FACTORY, v4Manager: MANAGER };

const hex = (value: number): Hex => `0x${value.toString(16).padStart(64, '0')}` as Hex;
const address = (value: number): Address =>
  `0x${value.toString(16).padStart(40, '0')}` as Address;

function registration(seed: number, protocol: 'v3' | 'v4' = seed % 3 === 0 ? 'v4' : 'v3') {
  return {
    pool:
      protocol === 'v3'
        ? { chainId: CHAIN_ID, protocol: 'v3' as const, address: address(0x1000 + seed) }
        : {
            chainId: CHAIN_ID,
            protocol: 'v4' as const,
            manager: MANAGER,
            poolId: hex(seed + 1),
          },
    token0: address(0x2000 + seed),
    token1: address(0x3000 + seed),
    feePips: 3_000,
    tickSpacing: 60,
    hooks: address(0),
    discoveredAt: {
      blockNumber: 100n + BigInt(seed),
      blockHash: hex(0x4_0000 + seed),
      transactionHash: hex(0x5_0000 + seed),
      transactionIndex: 0,
      logIndex: seed,
    },
    assetVersion: 'assets-1',
    source: 'factory-discovery',
  } satisfies PoolRegistration;
}

/** The identity a request carries: a pool address for v3, a pool id for v4. */
function poolId(record: PoolRegistration): string {
  return record.pool.protocol === 'v3' ? record.pool.address : record.pool.poolId;
}

/** A one-value topic set is delivered as the bare value, exactly as `partitionPlans` writes it. */
function topicValues(filter: PlannedFilter['filter'], index: number): readonly string[] {
  const value = filter.topics[index];
  if (value === undefined || value === null) return [];
  return typeof value === 'string' ? [value.toLowerCase()] : value.map((topic) => topic.toLowerCase());
}

function shardsOf(plan: readonly PlannedFilter[], family: PlannedFilter['family']) {
  return plan.filter((entry) => entry.family === family);
}

type Fixture = {
  readonly view: RegistryView;
  readonly calls: { all: number };
  readonly scopeKey: string;
  prepared(changed?: readonly string[], revisionKey?: string): PreparedRegistry;
};

/** A view over one catalogue whose `all()` is counted, so a round's catalogue work is visible. */
function catalogue(
  records: readonly PoolRegistration[],
  keys: { scopeKey?: string; revisionKey?: string } = {},
): Fixture {
  const byId = new Map(records.map((record) => [poolRegistrationId(record), record]));
  const byV3 = new Map(
    records.flatMap((record) =>
      record.pool.protocol === 'v3'
        ? [[record.pool.address.toLowerCase(), poolRegistrationId(record)] as const]
        : [],
    ),
  );
  const byV4 = new Map(
    records.flatMap((record) =>
      record.pool.protocol === 'v4'
        ? [
            [
              `${record.pool.manager.toLowerCase()}:${record.pool.poolId.toLowerCase()}`,
              poolRegistrationId(record),
            ] as const,
          ]
        : [],
    ),
  );
  const scopeKey = keys.scopeKey ?? '["scope-registry","scope-operations"]';
  const revisionKey = keys.revisionKey ?? 'scope-registry#2:scope-operations#3';
  const calls = { all: 0 };
  const view: RegistryView = {
    get: (id) => byId.get(id),
    isDiscoveryRef: () => false,
    getByV3Address: (value) => {
      const id = byV3.get(value.toLowerCase());
      return id === undefined ? undefined : byId.get(id);
    },
    getByV4Id: (manager, id) => {
      const key = byV4.get(`${manager.toLowerCase()}:${id.toLowerCase()}`);
      return key === undefined ? undefined : byId.get(key);
    },
    forAsset: function* () {},
    all: function* () {
      calls.all += 1;
      yield* byId.values();
    },
    revisionKey,
  };
  return {
    view,
    calls,
    scopeKey,
    prepared: (changed = [], revision = revisionKey) => ({
      scopeKey,
      view,
      changedPoolIds: new Set(changed),
      stage: () => {},
      publish: () => {},
      discard: () => {},
      covers: () => true,
    }),
  };
}

function measured(run: () => unknown): WorkCounts {
  const worked = openWorkCounts();
  try {
    run();
  } finally {
    worked.close();
  }
  return worked.counts;
}

describe('operation filter index', () => {
  test('plans exactly what the legacy planner plans for the same catalogue', () => {
    const records = Array.from({ length: 39 }, (_, index) => registration(index + 1));
    const v4Pools = records.filter((record) => record.pool.protocol === 'v4').length;
    const index = new OperationFilterIndex(deployments, 2);
    const planned = index.prepare(catalogue(records).prepared(), []).plan(1_000n, 1_999n);
    expect(planned).toEqual(buildOperationFilterPlan(records, deployments, 1_000n, 1_999n, 2));
    // Every value list is split to the limit — the finished plan is the cross product of the split
    // topic alternatives and the split pool values, so a plan is not one request per pool.
    const v4 = shardsOf(planned, 'operation-v4');
    const events = new Set(v4.flatMap((entry) => topicValues(entry.filter, 0)));
    const ids = new Set(v4.flatMap((entry) => topicValues(entry.filter, 1)));
    expect(v4[0]!.filter.address).toEqual([MANAGER]);
    expect(ids.size).toBe(v4Pools);
    expect(v4.length).toBe(Math.ceil(events.size / 2) * Math.ceil(ids.size / 2));
    const v3 = shardsOf(planned, 'operation-v3');
    expect(new Set(v3.flatMap((entry) => entry.filter.address)).size).toBe(records.length - v4Pools);
    for (const entry of planned)
      for (const values of [
        entry.filter.address,
        ...entry.filter.topics.map((topic) => (typeof topic === 'string' ? [topic] : (topic ?? []))),
      ])
        expect(values.length).toBeLessThanOrEqual(2);
  });

  test('reuses the sorted shards and reads no catalogue for a round with no registry change', () => {
    const records = Array.from({ length: 12 }, (_, index) => registration(index + 1));
    const fixture = catalogue(records);
    const index = new OperationFilterIndex(deployments, 100);
    const first = index.prepare(fixture.prepared(), []).plan(1_000n, 1_100n);
    const counts = measured(() => {
      const second = index.prepare(fixture.prepared(), []).plan(2_000n, 2_100n);
      expect(second).toHaveLength(first.length);
      for (const [position, entry] of second.entries()) {
        // Fresh bounds around the same delivered shard: shared arrays, no rebuild, no re-sort.
        expect(entry.filter.address).toBe(first[position]!.filter.address);
        expect(entry.filter.topics).toBe(first[position]!.filter.topics);
        expect(entry.filter).not.toBe(first[position]!.filter);
        expect(entry.filter.fromBlock).toBe(2_000n);
      }
    });
    expect(counts.operationFilterRebuilds).toBe(0);
    expect(counts.operationFilterValuesScanned).toBe(0);
    expect(fixture.calls.all).toBe(1);
  });

  test('rebuilds only the protocol index a registry change moved', () => {
    const records = Array.from({ length: 8 }, (_, index) => registration(index + 1));
    const added = registration(40, 'v4');
    const v4Pools = [...records, added].filter((record) => record.pool.protocol === 'v4').length;
    const index = new OperationFilterIndex(deployments, 100);
    const before = shardsOf(index.prepare(catalogue(records).prepared(), []).plan(1_000n, 1_100n), 'operation-v3');
    const moved = catalogue([...records, added], {
      revisionKey: 'scope-registry#3:scope-operations#3',
    });
    const counts = measured(() => {
      const after = index
        .prepare(moved.prepared([poolRegistrationId(added)], moved.view.revisionKey), [])
        .plan(1_000n, 1_100n);
      // The v3 addresses did not move: the delivered arrays are the ones the first round saw.
      expect(shardsOf(after, 'operation-v3')[0]!.filter.address).toBe(before[0]!.filter.address);
      expect(topicValues(shardsOf(after, 'operation-v4')[0]!.filter, 1)).toContain(
        poolId(added).toLowerCase(),
      );
    });
    expect(counts.operationFilterRebuilds).toBe(1);
    expect(counts.operationFilterValuesScanned).toBe(v4Pools);
    // The changed pool was read by identity, never by sweeping the catalogue.
    expect(moved.calls.all).toBe(0);
  });

  test('leaves an already delivered plan untouched when the template is rebuilt', () => {
    const records = Array.from({ length: 6 }, (_, index) => registration(index + 1));
    const added = registration(41, 'v3');
    const index = new OperationFilterIndex(deployments, 100);
    const delivered = index.prepare(catalogue(records).prepared(), []).plan(1_000n, 1_100n);
    const snapshot = structuredClone(delivered);
    const moved = catalogue([...records, added], {
      revisionKey: 'scope-registry#4:scope-operations#3',
    });
    index
      .prepare(moved.prepared([poolRegistrationId(added)], moved.view.revisionKey), [])
      .plan(2_000n, 2_100n);
    expect(delivered).toEqual(snapshot);
    const rebuilt = shardsOf(index.prepare(moved.prepared(), []).plan(3_000n, 3_100n), 'operation-v3');
    expect(rebuilt[0]!.filter.address).toContain(poolId(added));
    expect(rebuilt[0]!.filter.address).not.toBe(delivered[0]!.filter.address);
  });

  test('plans a staged discovery in its own round and drops it when the batch is discarded', () => {
    const records = Array.from({ length: 5 }, (_, index) => registration(index + 1));
    const staged = registration(50, 'v4');
    const fixture = catalogue(records);
    const index = new OperationFilterIndex(deployments, 100);
    index.prepare(fixture.prepared(), []).plan(1_000n, 1_100n);
    const counts = measured(() => {
      const lease = index.prepare(fixture.prepared(), [staged]);
      for (const from of [1_100n, 1_200n]) {
        const v4 = shardsOf(lease.plan(from, from + 99n), 'operation-v4');
        expect(topicValues(v4[0]!.filter, 1)).toContain(poolId(staged).toLowerCase());
      }
      lease.discard();
    });
    // Two rounds of one lease planned the staged pool from one rebuild, and no catalogue was read.
    expect(counts.operationFilterRebuilds).toBe(1);
    expect(fixture.calls.all).toBe(1);
    const after = shardsOf(index.prepare(fixture.prepared(), []).plan(1_300n, 1_399n), 'operation-v4');
    expect(topicValues(after[0]!.filter, 1)).not.toContain(poolId(staged).toLowerCase());
  });

  test('keeps a published discovery without taking the catalogue again', () => {
    const records = Array.from({ length: 5 }, (_, index) => registration(index + 1));
    const staged = registration(60, 'v4');
    const v4Pools = [...records, staged].filter((record) => record.pool.protocol === 'v4').length;
    const fixture = catalogue(records);
    const index = new OperationFilterIndex(deployments, 100);
    index.prepare(fixture.prepared(), []).plan(1_000n, 1_100n);
    index.prepare(fixture.prepared(), [staged]).publish();
    const counts = measured(() => {
      const after = shardsOf(index.prepare(fixture.prepared(), []).plan(2_000n, 2_100n), 'operation-v4');
      expect(topicValues(after[0]!.filter, 1)).toContain(poolId(staged).toLowerCase());
    });
    // Publishing settled the batch's own discovery: the next round rebuilds the protocol it moved
    // and reads no catalogue row to do it.
    expect(counts.operationFilterValuesScanned).toBe(v4Pools);
    expect(fixture.calls.all).toBe(1);
    // The folded identity is a member now, so a later removal still withdraws its value.
    const gone = catalogue(records, { revisionKey: 'scope-registry#5:scope-operations#3' });
    const withdrawn = shardsOf(
      index.prepare(gone.prepared([poolRegistrationId(staged)], gone.view.revisionKey), []).plan(3_000n, 3_100n),
      'operation-v4',
    );
    expect(topicValues(withdrawn[0]!.filter, 1)).not.toContain(poolId(staged).toLowerCase());
  });

  test('rebuilds from its own catalogue when the registry scope changes', () => {
    const index = new OperationFilterIndex(deployments, 100);
    const first = catalogue(Array.from({ length: 4 }, (_, position) => registration(position + 1)));
    expect(index.prepare(first.prepared(), []).plan(1n, 2n)).toHaveLength(2);
    const other = catalogue([registration(70, 'v3')], {
      scopeKey: '["scope-other","scope-other"]',
      revisionKey: 'scope-other#0:scope-other#0',
    });
    const planned = index.prepare(other.prepared(), []).plan(1n, 2n);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.family).toBe('operation-v3');
    expect(planned[0]!.filter.address).toEqual([poolId(registration(70, 'v3'))]);
  });

  test('plans nothing for an empty catalogue', () => {
    const index = new OperationFilterIndex(deployments, 100);
    const counts = measured(() => {
      expect(index.prepare(catalogue([]).prepared(), []).plan(1n, 2n)).toEqual([]);
    });
    expect(counts.operationFilterRebuilds).toBe(2);
    expect(counts.operationFilterValuesScanned).toBe(0);
  });

  test('rejects a filter value limit that cannot bound a request', () => {
    expect(() => new OperationFilterIndex(deployments, 0)).toThrow(RangeError);
    expect(() => new OperationFilterIndex(deployments, 1.5)).toThrow(RangeError);
  });
});
