import {
  encodeAbiParameters,
  encodeEventTopics,
  toEventSelector,
  type AbiEvent,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, test } from 'vitest';
import { RpcFailure } from '../../src/rpc/errors.js';
import type { ChainReader, RawLog } from '../../src/domain/types.js';
import { fetchBoundedLogs } from '../../src/ingest/fetch-range.js';
import { fetchRange } from '../../src/ingest/record-range.js';
import { verifySuccessfulShardCoverage } from '../../src/ingest/completeness.js';
import { loadAssetVersion } from '../../src/registry/assets.js';
import { createAssetRegistry } from '../../src/registry/assets.js';
import { PoolRegistry, type PoolRegistration } from '../../src/registry/pools.js';
import { v3FactoryAbi, v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import { v4ManagerAbi } from '../../src/protocols/uniswap-v4/abi.js';

const factory = '0x1000000000000000000000000000000000000001' as Address;
const manager = '0x2000000000000000000000000000000000000002' as Address;
const rwa0 = '0x3000000000000000000000000000000000000003' as Address;
const rwa1 = '0x4000000000000000000000000000000000000004' as Address;
const quote = '0x5000000000000000000000000000000000000005' as Address;
const poolA = '0x6000000000000000000000000000000000000006' as Address;
const poolB = '0x7000000000000000000000000000000000000007' as Address;
const hooksA = '0x8000000000000000000000000000000000000008' as Address;
const hooksB = '0x9000000000000000000000000000000000000009' as Address;
const zeroAddress = '0x0000000000000000000000000000000000000000' as Address;

const hash = (value: number): Hex => `0x${value.toString(16).padStart(64, '0')}` as Hex;
const topicOf = (abi: typeof v3PoolAbi | typeof v4ManagerAbi, name: string): Hex =>
  toEventSelector(abi.find((entry) => entry.type === 'event' && entry.name === name)! as AbiEvent);

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

function v3Created(
  blockNumber: bigint,
  logIndex: number,
  token0: Address,
  token1: Address,
  pool: Address,
): RawLog {
  const topics = encodeEventTopics({
    abi: v3FactoryAbi,
    eventName: 'PoolCreated',
    args: { token0, token1, fee: 3_000 },
  });
  const data = encodeAbiParameters([{ type: 'int24' }, { type: 'address' }], [60, pool]);
  return rawLog(factory, blockNumber, logIndex, topics as readonly Hex[], data);
}

function v4Initialized(
  blockNumber: bigint,
  logIndex: number,
  token0: Address,
  token1: Address,
  fee: number,
  hooks: Address,
): RawLog {
  const { computeV4PoolId } = requirePoolKey();
  const id = computeV4PoolId({ currency0: token0, currency1: token1, fee, tickSpacing: 60, hooks });
  const topics = encodeEventTopics({
    abi: v4ManagerAbi,
    eventName: 'Initialize',
    args: { id, currency0: token0, currency1: token1 },
  });
  const data = encodeAbiParameters(
    [
      { type: 'uint24' },
      { type: 'int24' },
      { type: 'address' },
      { type: 'uint160' },
      { type: 'int24' },
    ],
    [fee, 60, hooks, 1n << 96n, 0],
  );
  return rawLog(manager, blockNumber, logIndex, topics as readonly Hex[], data);
}

// Keep fixture construction synchronous while using the production identity implementation.
import { computeV4PoolId } from '../../src/protocols/uniswap-v4/pool-key.js';
function requirePoolKey() {
  return { computeV4PoolId };
}

type Filter = Parameters<ChainReader['getLogs']>[0];

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

class FixtureReader implements ChainReader {
  readonly calls: Filter[] = [];
  constructor(
    private readonly logs: readonly RawLog[],
    private readonly override?: (filter: Filter) => Promise<readonly RawLog[]> | undefined,
  ) {}

  async getAnchor(block: bigint | 'latest') {
    const number = block === 'latest' ? 100n : block;
    return { number, hash: hash(Number(number)), timestampSec: 1_800 };
  }

  async getLogs(filter: Filter): Promise<readonly RawLog[]> {
    this.calls.push(filter);
    const overridden = this.override?.(filter);
    if (overridden !== undefined) return overridden;
    return this.logs.filter((log) => matches(filter, log));
  }
}

const end100 = { number: 100n, hash: hash(100), timestampSec: 1_800 } as const;

describe('two-pass discovery', () => {
  test('captures same-block V3 initialization, mint, and swap after PoolCreated', async () => {
    const initialize = rawLog(poolA, 100n, 3, [topicOf(v3PoolAbi, 'Initialize')]);
    const mint = rawLog(poolA, 100n, 4, [topicOf(v3PoolAbi, 'Mint')]);
    const swap = rawLog(poolA, 100n, 5, [topicOf(v3PoolAbi, 'Swap')]);
    const reader = new FixtureReader([
      v3Created(100n, 2, rwa0, quote, poolA),
      initialize,
      mint,
      swap,
    ]);
    const pools = new PoolRegistry();

    const batch = await fetchRange(reader, {
      mode: 'operations',
      fromBlock: 100n,
      toBlock: 100n,
      end: end100,
      assets: createAssetRegistry('assets-v1', [rwa0]),
      pools,
      v3Factory: factory,
      v4Manager: manager,
      observedAtMs: 2_000,
      captureMode: 'synthetic',
    });

    expect(batch.completeness).toBe('complete');
    expect(verifySuccessfulShardCoverage(batch)).toHaveLength(
      batch.manifest.expectedShardIds.length,
    );
    expect(batch.logs.map((log) => log.logIndex)).toEqual([2, 3, 4, 5]);
    expect(
      new Set(batch.logs.map((log) => `${log.blockHash}:${log.transactionHash}:${log.logIndex}`))
        .size,
    ).toBe(batch.logs.length);
    expect(batch.poolRegistrations).toHaveLength(1);
    expect(batch.poolRegistrations?.[0]?.pool).toMatchObject({ protocol: 'v3', address: poolA });
    expect(pools.snapshot()).toEqual([]);
    expect(
      reader.calls.some(
        (call) => call.fromBlock === 100n && call.address.some((address) => address === poolA),
      ),
    ).toBe(true);
  });

  test('unions both RWA topic sides without duplicate logs and preserves full V4 identity', async () => {
    const first = v4Initialized(100n, 2, rwa0, rwa1, 500, hooksA);
    const second = v4Initialized(100n, 3, rwa0, rwa1, 3_000, hooksB);
    const reader = new FixtureReader([first, second]);

    const batch = await fetchRange(reader, {
      mode: 'operations',
      fromBlock: 100n,
      toBlock: 100n,
      end: end100,
      assets: createAssetRegistry('assets-v1', [rwa0, rwa1]),
      pools: new PoolRegistry(),
      v3Factory: factory,
      v4Manager: manager,
      observedAtMs: 2_000,
      captureMode: 'synthetic',
    });

    expect(batch.logs).toHaveLength(2);
    expect(batch.poolRegistrations).toHaveLength(2);
    const registrations = batch.poolRegistrations ?? [];
    const ids = registrations.map((registration) =>
      registration.pool.protocol === 'v4' ? registration.pool.poolId : null,
    );
    expect(new Set(ids).size).toBe(2);
    expect(registrations.map((registration) => registration.hooks)).toEqual([hooksA, hooksB]);
  });

  test('keeps staged discoveries out of the registry and persistence batch after a partial failure', async () => {
    const created = v3Created(100n, 2, rwa0, quote, poolA);
    const pools = new PoolRegistry();
    const reader = new FixtureReader([created], (filter) => {
      if (filter.address.some((address) => address === poolA)) {
        return Promise.reject(new Error('provider unavailable'));
      }
      return undefined;
    });

    const batch = await fetchRange(reader, {
      mode: 'operations',
      fromBlock: 100n,
      toBlock: 100n,
      end: end100,
      assets: createAssetRegistry('assets-v1', [rwa0]),
      pools,
      v3Factory: factory,
      v4Manager: manager,
      observedAtMs: 2_000,
      captureMode: 'synthetic',
    });

    expect(batch.completeness).toBe('incomplete');
    expect(batch.poolRegistrations).toEqual([]);
    expect(pools.snapshot()).toEqual([]);
    expect(batch.manifest.shards.some((shard) => shard.status === 'failed' && shard.error)).toBe(
      true,
    );
  });

  test('discovery-only mode has a separate stable scope and never scans pool operations', async () => {
    const created = v3Created(100n, 2, rwa0, quote, poolA);
    const assets = createAssetRegistry('assets-v1', [rwa0]);
    const reader = new FixtureReader([created]);
    const discovery = await fetchRange(reader, {
      mode: 'discovery-only',
      fromBlock: 1n,
      toBlock: 100n,
      end: end100,
      assets,
      pools: new PoolRegistry(),
      v3Factory: factory,
      v4Manager: manager,
      discoveryMaxRangeBlocks: 100n,
      observedAtMs: 2_000,
      captureMode: 'backfill',
    });
    const operations = await fetchRange(new FixtureReader([]), {
      mode: 'operations',
      fromBlock: 100n,
      toBlock: 100n,
      end: end100,
      assets,
      pools: new PoolRegistry(),
      v3Factory: factory,
      v4Manager: manager,
      observedAtMs: 2_000,
      captureMode: 'synthetic',
    });

    expect(discovery.completeness).toBe('complete');
    expect(discovery.poolRegistrations).toHaveLength(1);
    expect(discovery.scopeId).not.toBe(operations.scopeId);
    expect(reader.calls).toHaveLength(4);
    expect(
      reader.calls.every(
        (call) => call.address.includes(factory) || call.address.includes(manager),
      ),
    ).toBe(true);
  });
});

describe('bounded filter fragmentation', () => {
  test('treats a 5000-log response as capped and recursively splits the range', async () => {
    const calls: string[] = [];
    const capped = Array.from({ length: 5_000 }, (_, index) =>
      rawLog(poolA, 100n, index, [topicOf(v3PoolAbi, 'Swap')]),
    );
    const reader = {
      async getLogs(filter: Filter) {
        calls.push(`${filter.fromBlock}-${filter.toBlock}`);
        return filter.fromBlock === 100n && filter.toBlock === 101n ? capped : [];
      },
    };

    const result = await fetchBoundedLogs(
      reader,
      { fromBlock: 100n, toBlock: 101n, address: [poolA], topics: [] },
      5_000,
    );

    expect(result.complete).toBe(true);
    expect(calls).toEqual(['100-101', '100-100', '101-101']);
    expect(result.fragments.every((fragment) => fragment.status === 'success')).toBe(true);
  });

  test('splits address and then topic OR filters inside one block', async () => {
    const swapTopic = topicOf(v3PoolAbi, 'Swap');
    const mintTopic = topicOf(v3PoolAbi, 'Mint');
    const calls: Filter[] = [];
    const reader = {
      async getLogs(filter: Filter) {
        calls.push(filter);
        const topicOr = filter.topics[0];
        if (filter.address.length > 1 || Array.isArray(topicOr)) {
          return [rawLog(filter.address[0] ?? poolA, 100n, 0, [swapTopic])];
        }
        return [];
      },
    };

    const result = await fetchBoundedLogs(
      reader,
      {
        fromBlock: 100n,
        toBlock: 100n,
        address: [poolA, poolB],
        topics: [[swapTopic, mintTopic]],
      },
      1,
    );

    expect(result.complete).toBe(true);
    expect(calls.some((call) => call.address.length === 1)).toBe(true);
    expect(calls.some((call) => !Array.isArray(call.topics[0]))).toBe(true);
  });

  test('marks a single-block indivisible capped response truncated', async () => {
    const result = await fetchBoundedLogs(
      { getLogs: async () => [rawLog(poolA, 100n, 0, [topicOf(v3PoolAbi, 'Swap')])] },
      {
        fromBlock: 100n,
        toBlock: 100n,
        address: [poolA],
        topics: [topicOf(v3PoolAbi, 'Swap')],
      },
      1,
    );

    expect(result.complete).toBe(false);
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]?.status).toBe('truncated');
  });
});

test('explicit seed registrations bootstrap the operation filter', async () => {
  const swap = rawLog(poolA, 100n, 5, [topicOf(v3PoolAbi, 'Swap')]);
  const seed: PoolRegistration = {
    pool: { chainId: 4663, protocol: 'v3', address: poolA },
    token0: rwa0,
    token1: quote,
    feePips: 3_000,
    tickSpacing: 60,
    hooks: zeroAddress,
    discoveredAt: swap,
    assetVersion: 'assets-v1',
    source: 'seed-config',
  };
  const reader = new FixtureReader([swap]);

  const batch = await fetchRange(reader, {
    mode: 'operations',
    fromBlock: 100n,
    toBlock: 100n,
    end: end100,
    assets: createAssetRegistry('assets-v1', [rwa0]),
    pools: new PoolRegistry([seed]),
    v3Factory: factory,
    v4Manager: manager,
    observedAtMs: 2_000,
    captureMode: 'synthetic',
  });

  expect(batch.logs.some((log) => log.logIndex === 5)).toBe(true);
  expect(batch.poolRegistrations).toContainEqual(seed);
});

test('loads the observed RWA version from the checked watchlist', () => {
  const assets = loadAssetVersion('config/watchlist.amc.json');
  expect(assets.chainId).toBe(4663);
  expect(assets.version).toBe('2026-09-08.p0-seeds');
  expect(assets.addresses).toContain('0x05a3d1cd21d0c88145e82600e62e7e496e0f222b');
});

test('an on-chain discovery supersedes a metadata-equivalent explicit seed', async () => {
  const seedEvidence = rawLog(factory, 90n, 1, [hash(123)]);
  const seed: PoolRegistration = {
    pool: { chainId: 4663, protocol: 'v3', address: poolA },
    token0: rwa0,
    token1: quote,
    feePips: 3_000,
    tickSpacing: 60,
    hooks: zeroAddress,
    discoveredAt: seedEvidence,
    assetVersion: 'assets-v1',
    source: 'seed-config',
  };
  const batch = await fetchRange(new FixtureReader([v3Created(100n, 2, rwa0, quote, poolA)]), {
    mode: 'operations',
    fromBlock: 100n,
    toBlock: 100n,
    end: end100,
    assets: createAssetRegistry('assets-v1', [rwa0]),
    pools: new PoolRegistry([seed]),
    v3Factory: factory,
    v4Manager: manager,
    observedAtMs: 2_000,
    captureMode: 'synthetic',
  });

  expect(batch.completeness).toBe('complete');
  expect(batch.poolRegistrations).toHaveLength(1);
  expect(batch.poolRegistrations?.[0]?.source).toBe('uniswap-v3:PoolCreated');
});

test('provider response cap is the minimum guard and cannot pass as complete', async () => {
  const batch = await fetchRange(new FixtureReader([v3Created(100n, 2, rwa0, quote, poolA)]), {
    mode: 'discovery-only',
    fromBlock: 100n,
    toBlock: 100n,
    end: end100,
    assets: createAssetRegistry('assets-v1', [rwa0]),
    pools: new PoolRegistry(),
    v3Factory: factory,
    v4Manager: manager,
    logResponseGuard: 5_000,
    maxLogsPerResponse: 1,
    observedAtMs: 2_000,
    captureMode: 'synthetic',
  });

  expect(batch.completeness).toBe('incomplete');
  expect(batch.manifest.shards.some((shard) => shard.status === 'truncated')).toBe(true);
  expect(batch.poolRegistrations).toEqual([]);
});

test('a changed end anchor leaves successful raw fragments in an incomplete batch', async () => {
  const base = new FixtureReader([v3Created(100n, 2, rwa0, quote, poolA)]);
  const reader: ChainReader = {
    getLogs: (filter) => base.getLogs(filter),
    getAnchor: async (block) => {
      const number = block === 'latest' ? 100n : block;
      return { number, hash: hash(999), timestampSec: 1_800 };
    },
  };
  const batch = await fetchRange(reader, {
    mode: 'operations',
    fromBlock: 100n,
    toBlock: 100n,
    end: end100,
    assets: createAssetRegistry('assets-v1', [rwa0]),
    pools: new PoolRegistry(),
    v3Factory: factory,
    v4Manager: manager,
    observedAtMs: 2_000,
    captureMode: 'synthetic',
  });

  expect(batch.completeness).toBe('incomplete');
  expect(batch.logs).toHaveLength(1);
  expect(batch.manifest.shards.some((shard) => shard.status === 'success')).toBe(true);
  expect(batch.recordingErrors).toContain('end-anchor-changed');
  expect(batch.poolRegistrations).toEqual([]);
});

test('preserves successful shard evidence when a later chunk exhausts the budget', async () => {
  const created = v3Created(1n, 2, rwa0, quote, poolA);
  let calls = 0;
  const reader: ChainReader = {
    getAnchor: async () => ({ number: 2n, hash: hash(2), timestampSec: 1_800 }),
    getLogs: async (filter) => {
      calls++;
      if (calls === 2) throw new RpcFailure('budget');
      return matches(filter, created) ? [created] : [];
    },
  };

  const batch = await fetchRange(reader, {
    mode: 'discovery-only',
    fromBlock: 1n,
    toBlock: 2n,
    end: { number: 2n, hash: hash(2), timestampSec: 1_800 },
    assets: createAssetRegistry('assets-v1', [rwa0]),
    pools: new PoolRegistry(),
    v3Factory: factory,
    v4Manager: manager,
    discoveryMaxRangeBlocks: 1,
    observedAtMs: 2_000,
    captureMode: 'synthetic',
  });

  expect(batch.completeness).toBe('incomplete');
  expect(batch.logs.map((log) => log.logIndex)).toContain(2);
  expect(batch.manifest.shards.some((shard) => shard.status === 'success')).toBe(true);
  expect(batch.manifest.shards.some((shard) => shard.error === 'budget')).toBe(true);
});

test('marks conflicting duplicate identities inside one RPC response incomplete', async () => {
  const first = rawLog(poolA, 100n, 1, [topicOf(v3PoolAbi, 'Swap')], '0x01');
  const second = { ...first, data: '0x02' as Hex };
  const result = await fetchBoundedLogs(
    { getLogs: async () => [first, second] },
    { fromBlock: 100n, toBlock: 100n, address: [poolA], topics: [] },
    5_000,
  );

  expect(result.complete).toBe(false);
  expect(result.logs).toHaveLength(1);
  expect(result.fragments).toHaveLength(1);
  expect(result.fragments[0]).toMatchObject({
    status: 'failed',
    reason: 'conflicting-log-identity',
  });
  expect(result.fragments[0]?.responseHash).not.toBeNull();
});

test('marks conflicting duplicate identities across split leaves incomplete', async () => {
  const first = rawLog(poolA, 100n, 1, [topicOf(v3PoolAbi, 'Swap')], '0x01');
  const second = { ...first, address: poolB, data: '0x02' as Hex };
  const reader = {
    async getLogs(filter: Filter) {
      if (filter.address.length > 1) return [first, second];
      return filter.address[0] === poolA ? [first] : [second];
    },
  };
  const result = await fetchBoundedLogs(
    reader,
    { fromBlock: 100n, toBlock: 100n, address: [poolA, poolB], topics: [] },
    2,
  );

  expect(result.complete).toBe(false);
  expect(result.logs).toHaveLength(1);
  expect(result.fragments.some((fragment) => fragment.reason === 'conflicting-log-identity')).toBe(
    true,
  );
});

test('proactively shards 1810 V4 pool topic values below the provider filter limit', async () => {
  const evidence = rawLog(manager, 90n, 1, [hash(99)]);
  const seeds: PoolRegistration[] = Array.from({ length: 1_810 }, (_, index) => ({
    pool: {
      chainId: 4663,
      protocol: 'v4',
      manager,
      poolId: hash(20_000 + index),
    },
    token0: rwa0,
    token1: quote,
    feePips: 3_000,
    tickSpacing: 60,
    hooks: zeroAddress,
    discoveredAt: { ...evidence, logIndex: index },
    assetVersion: 'assets-v1',
    source: 'seed-config',
  }));
  const calls: Filter[] = [];
  const reader: ChainReader = {
    getAnchor: async () => end100,
    getLogs: async (filter) => {
      calls.push(filter);
      if (
        filter.address.length > 1_000 ||
        filter.topics.some(
          (topic) => typeof topic !== 'string' && topic !== null && topic.length > 1_000,
        )
      ) {
        throw new Error('invalid argument 0: exceed max topics');
      }
      return [];
    },
  };

  const batch = await fetchRange(reader, {
    mode: 'operations',
    fromBlock: 100n,
    toBlock: 100n,
    end: end100,
    assets: createAssetRegistry('assets-v1', [rwa0]),
    pools: new PoolRegistry(seeds),
    v3Factory: factory,
    v4Manager: manager,
    maxFilterValues: 1_000,
    observedAtMs: 2_000,
    captureMode: 'synthetic',
  });

  expect(batch.completeness).toBe('complete');
  const operationCalls = calls.filter(
    (filter) =>
      filter.address.length === 1 &&
      filter.address[0] === manager &&
      filter.topics[1] !== null &&
      filter.topics[1] !== undefined,
  );
  expect(operationCalls).toHaveLength(2);
  expect(operationCalls.map((filter) => (filter.topics[1] as readonly Hex[]).length)).toEqual([
    1_000, 810,
  ]);
});

test('reactively splits explicit provider filter-limit errors by topic values before block range', async () => {
  const topics = [hash(1), hash(2), hash(3), hash(4)];
  const calls: Filter[] = [];
  const result = await fetchBoundedLogs(
    {
      getLogs: async (filter) => {
        calls.push(filter);
        const alternatives = filter.topics[0];
        if (
          alternatives !== undefined &&
          typeof alternatives !== 'string' &&
          alternatives !== null &&
          alternatives.length > 2
        ) {
          throw new RpcFailure('filter-limit');
        }
        return [];
      },
    },
    { fromBlock: 100n, toBlock: 100n, address: [poolA], topics: [topics] },
    5_000,
  );

  expect(result.complete).toBe(true);
  expect(calls.map((filter) => (filter.topics[0] as readonly Hex[]).length)).toEqual([4, 2, 2]);
  expect(calls.every((filter) => filter.fromBlock === 100n && filter.toBlock === 100n)).toBe(true);
});

test('evidence failure prevents reactive filter splitting in P0 throw mode', async () => {
  const failure = new RpcFailure('filter-limit');
  failure.evidenceFailure = new RpcFailure('evidence-write');
  let calls = 0;
  await expect(
    fetchBoundedLogs(
      {
        getLogs: async () => {
          calls++;
          throw failure;
        },
      },
      { fromBlock: 100n, toBlock: 100n, address: [poolA, poolB], topics: [] },
      5_000,
    ),
  ).rejects.toBe(failure);
  expect(calls).toBe(1);
});

test('evidence failure becomes one incomplete leaf in recorder capture mode', async () => {
  const failure = new RpcFailure('filter-limit');
  failure.evidenceFailure = new RpcFailure('evidence-write');
  let calls = 0;
  const result = await fetchBoundedLogs(
    {
      getLogs: async () => {
        calls++;
        throw failure;
      },
    },
    { fromBlock: 100n, toBlock: 100n, address: [poolA, poolB], topics: [] },
    5_000,
    undefined,
    { captureCriticalFailures: true },
  );

  expect(calls).toBe(1);
  expect(result.complete).toBe(false);
  expect(result.fragments).toHaveLength(1);
  expect(result.fragments[0]?.reason).toBe('filter-limit:evidence-evidence-write');
});
