import {
  encodeAbiParameters,
  encodeEventTopics,
  toEventSelector,
  type AbiEvent,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, test } from 'vitest';
import { encodeJson } from '../../src/domain/json.js';
import type { ChainReader, RawLog } from '../../src/domain/types.js';
import { createAssetRegistry } from '../../src/registry/assets.js';
import { PoolRegistry, type PoolRegistration } from '../../src/registry/pools.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import { v4ManagerAbi } from '../../src/protocols/uniswap-v4/abi.js';
import { computeV4PoolId } from '../../src/protocols/uniswap-v4/pool-key.js';
import { rawLogKey } from '../../src/storage/manifest.js';
import {
  buildDiscoveryFilterPlan,
  buildOperationFilterPlan,
  computeWatchScopeId,
  operationFilterValues,
  type PlannedFilter,
} from '../../src/ingest/filter-plan.js';
import { fetchRange, type RangeRecordingBatch } from '../../src/ingest/record-range.js';
import { runV4CaptureExperiment } from '../../src/ingest/v4-capture-experiment.js';

const CHAIN_ID = 4663 as const;
const factory = '0x1000000000000000000000000000000000000001' as Address;
const manager = '0x2000000000000000000000000000000000000002' as Address;
const rwa0 = '0x3000000000000000000000000000000000000003' as Address;
const rwa1 = '0x4000000000000000000000000000000000000004' as Address;
const quote = '0x5000000000000000000000000000000000000005' as Address;
const poolA = '0x6000000000000000000000000000000000000006' as Address;
const poolB = '0x7000000000000000000000000000000000000007' as Address;
const zeroAddress = '0x0000000000000000000000000000000000000000' as Address;
const poolIdA = `0x${'0a'.repeat(32)}` as Hex;
const poolIdB = `0x${'0b'.repeat(32)}` as Hex;

const hex = (value: number): Hex => `0x${value.toString(16).padStart(64, '0')}` as Hex;
const eventTopic = (abi: readonly unknown[], name: string): Hex =>
  toEventSelector(
    (abi as readonly { type: string; name?: string }[]).find(
      (entry) => entry.type === 'event' && entry.name === name,
    ) as AbiEvent,
  );

const deployments = { v3Factory: factory, v4Manager: manager };
const assets = createAssetRegistry('assets-1', [rwa0, rwa1]);
const fromBlock = 100n;
const toBlock = 100n;
const end = { number: 100n, hash: hex(100), timestampSec: 1_800 } as const;

/**
 * The five V4 manager event families read straight from the deployed ABI: an independent reference
 * for which events a manager request must ask for, so dropping one from the plan fails here.
 */
const v4OperationTopics = [
  'Initialize',
  'ModifyLiquidity',
  'Swap',
  'Donate',
  'ProtocolFeeUpdated',
].map((name) => eventTopic(v4ManagerAbi, name));

const evidence = (seed: number) => ({
  blockNumber: 90n,
  blockHash: hex(100_000 + seed),
  transactionHash: hex(200_000 + seed),
  transactionIndex: 0,
  logIndex: seed,
});

const registrations: readonly PoolRegistration[] = [
  {
    pool: { chainId: CHAIN_ID, protocol: 'v3', address: poolA },
    token0: rwa0,
    token1: quote,
    feePips: 3_000,
    tickSpacing: 60,
    hooks: zeroAddress,
    discoveredAt: evidence(1),
    assetVersion: 'assets-1',
    source: 'seed-config',
  },
  {
    pool: { chainId: CHAIN_ID, protocol: 'v3', address: poolB },
    token0: rwa1,
    token1: quote,
    feePips: 3_000,
    tickSpacing: 60,
    hooks: zeroAddress,
    discoveredAt: evidence(2),
    assetVersion: 'assets-1',
    source: 'seed-config',
  },
  {
    pool: { chainId: CHAIN_ID, protocol: 'v4', manager, poolId: poolIdA },
    token0: rwa0,
    token1: quote,
    feePips: 500,
    tickSpacing: 10,
    hooks: zeroAddress,
    discoveredAt: evidence(3),
    assetVersion: 'assets-1',
    source: 'seed-config',
  },
  {
    pool: { chainId: CHAIN_ID, protocol: 'v4', manager, poolId: poolIdB },
    token0: rwa1,
    token1: quote,
    feePips: 3_000,
    tickSpacing: 60,
    hooks: zeroAddress,
    discoveredAt: evidence(4),
    assetVersion: 'assets-1',
    source: 'seed-config',
  },
];

const rawLog = (
  address: Address,
  logIndex: number,
  topics: readonly Hex[],
  data: Hex = '0x',
  blockNumber = 100n,
): RawLog => ({
  address,
  blockNumber,
  blockHash: hex(Number(blockNumber)),
  transactionHash: hex(300_000 + logIndex),
  transactionIndex: 0,
  logIndex,
  topics,
  data,
  rawBlockTimestamp: null,
});

const fixtureLogs: readonly RawLog[] = [
  rawLog(poolA, 1, [eventTopic(v3PoolAbi, 'Swap')]),
  rawLog(manager, 2, [eventTopic(v4ManagerAbi, 'Swap'), poolIdA]),
];

type Filter = Parameters<ChainReader['getLogs']>[0];

const matchesFilter = (filter: Filter, log: RawLog): boolean =>
  log.blockNumber >= filter.fromBlock &&
  log.blockNumber <= filter.toBlock &&
  filter.address.some((address) => address.toLowerCase() === log.address.toLowerCase()) &&
  filter.topics.every((wanted, index) => {
    if (wanted === null) return true;
    const actual = log.topics[index]?.toLowerCase();
    return typeof wanted === 'string'
      ? wanted.toLowerCase() === actual
      : wanted.some((topic) => topic.toLowerCase() === actual);
  });

/** A reader over a fixed chain whose calls and response bytes are the test's own reference. */
function fixtureReader(logs: readonly RawLog[] = fixtureLogs) {
  const state = {
    calls: [] as Filter[],
    responseBytes: 0,
    async getLogs(filter: Filter) {
      state.calls.push(filter);
      const response = logs.filter((log) => matchesFilter(filter, log));
      state.responseBytes += Buffer.byteLength(encodeJson(response), 'utf8');
      return response;
    },
    async getAnchor(block: bigint | 'latest') {
      const number = block === 'latest' ? 100n : block;
      return { number, hash: hex(Number(number)), timestampSec: 1_800 };
    },
  };
  return state;
}

/** `topicValues` reports one topic's value list exactly as the plan writes it. */
function topicValues(filter: PlannedFilter['filter'], index: number): readonly string[] {
  const value = filter.topics[index];
  if (value === undefined || value === null) return [];
  return typeof value === 'string'
    ? [value.toLowerCase()]
    : value.map((topic) => topic.toLowerCase());
}

const ofFamily = (plan: readonly PlannedFilter[], family: PlannedFilter['family']) =>
  plan.filter((entry) => entry.family === family);

function operationPlan(
  mode: 'pool-ids' | 'manager' | undefined,
  maxFilterValues = 1_000,
  catalogue: readonly PoolRegistration[] = registrations,
): readonly PlannedFilter[] {
  return buildOperationFilterPlan(
    catalogue,
    deployments,
    fromBlock,
    toBlock,
    maxFilterValues,
    ...(mode === undefined ? [] : [{ v4OperationMode: mode }]),
  );
}

/** 77,628 V4 registrations, the catalogue scale the E1 checklist freezes. */
function largeCatalogue(count: number): readonly PoolRegistration[] {
  return Array.from({ length: count }, (_, index) => ({
    pool: {
      chainId: CHAIN_ID,
      protocol: 'v4' as const,
      manager,
      poolId: `0x${(index + 1).toString(16).padStart(64, '0')}` as Hex,
    },
    token0: rwa0,
    token1: quote,
    feePips: 3_000,
    tickSpacing: 60,
    hooks: zeroAddress,
    discoveredAt: evidence(index + 10),
    assetVersion: 'assets-1',
    source: 'seed-config' as const,
  }));
}

async function capture(
  state: ReturnType<typeof fixtureReader>,
  extra: Partial<Parameters<typeof fetchRange>[1]> = {},
): Promise<RangeRecordingBatch> {
  return fetchRange(state as unknown as ChainReader, {
    mode: 'operations',
    fromBlock,
    toBlock,
    end,
    assets,
    pools: new PoolRegistry(registrations),
    v3Factory: factory,
    v4Manager: manager,
    observedAtMs: 2_000,
    captureMode: 'synthetic',
    ...extra,
  });
}

/**
 * Values frozen from the unmodified implementation (commit ce62735, before E1) by
 * `node_modules/.e1-snapshot/snapshot.mts`: the default path must reproduce them value for value.
 */
const FROZEN = {
  scopeIdOperations: 'scope-v1-49e6bdafed55f5cee6df12fc3d71b03bf7ab95846fc0d40919a8bbe7683d52e3',
  scopeIdDiscovery: 'scope-v1-71f1d34ca4ea04788d1ccd889396ddd276dcfd57c3f28b660d23317dc1e4b987',
  batchId: 'e4734b530c5f65bccd110205932a33d791ecc315ee7efa399bab05279b8db4b1',
  filterPlanHash: 'e48718dbb981142f5662edf68ddc53203c9e5cecee3f380b33c7120126fb628c',
  manifestHash: '8830ecc45010c188149fd1ee541e36b7886a4c21d459fa566e2610609cbd6539',
  requests: 6,
  discoveryPlanJson: `[
  {
    "id": "discovery-v3",
    "family": "discovery-v3",
    "filter": {
      "fromBlock": "100",
      "toBlock": "100",
      "address": [
        "0x1000000000000000000000000000000000000001"
      ],
      "topics": [
        "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118",
        [
          "0x0000000000000000000000003000000000000000000000000000000000000003",
          "0x0000000000000000000000004000000000000000000000000000000000000004"
        ],
        null,
        null
      ]
    }
  },
  {
    "id": "discovery-v3",
    "family": "discovery-v3",
    "filter": {
      "fromBlock": "100",
      "toBlock": "100",
      "address": [
        "0x1000000000000000000000000000000000000001"
      ],
      "topics": [
        "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118",
        null,
        [
          "0x0000000000000000000000003000000000000000000000000000000000000003",
          "0x0000000000000000000000004000000000000000000000000000000000000004"
        ],
        null
      ]
    }
  },
  {
    "id": "discovery-v4",
    "family": "discovery-v4",
    "filter": {
      "fromBlock": "100",
      "toBlock": "100",
      "address": [
        "0x2000000000000000000000000000000000000002"
      ],
      "topics": [
        "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
        null,
        [
          "0x0000000000000000000000003000000000000000000000000000000000000003",
          "0x0000000000000000000000004000000000000000000000000000000000000004"
        ],
        null
      ]
    }
  },
  {
    "id": "discovery-v4",
    "family": "discovery-v4",
    "filter": {
      "fromBlock": "100",
      "toBlock": "100",
      "address": [
        "0x2000000000000000000000000000000000000002"
      ],
      "topics": [
        "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
        null,
        null,
        [
          "0x0000000000000000000000003000000000000000000000000000000000000003",
          "0x0000000000000000000000004000000000000000000000000000000000000004"
        ]
      ]
    }
  }
]`,
  operationPlanJson: `[
  {
    "id": "operation-v3",
    "family": "operation-v3",
    "filter": {
      "fromBlock": "100",
      "toBlock": "100",
      "address": [
        "0x6000000000000000000000000000000000000006",
        "0x7000000000000000000000000000000000000007"
      ],
      "topics": [
        [
          "0x98636036cb66a9c19a37435efc1e90142190214e8abeb821bdba3f2990dd4c95",
          "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde",
          "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c",
          "0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0",
          "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
        ]
      ]
    }
  },
  {
    "id": "operation-v4",
    "family": "operation-v4",
    "filter": {
      "fromBlock": "100",
      "toBlock": "100",
      "address": [
        "0x2000000000000000000000000000000000000002"
      ],
      "topics": [
        [
          "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
          "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec",
          "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
          "0x29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb",
          "0xe9c42593e71f84403b84352cd168d693e2c9fcd1fdbcc3feb21d92b43e6696f9"
        ],
        [
          "0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
          "0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"
        ]
      ]
    }
  }
]`,
} as const;

describe('frozen default path', () => {
  test('default plan, scope ids, plan hash, manifest hash and batch id are unchanged', async () => {
    expect(computeWatchScopeId(assets, 'operations', deployments)).toBe(FROZEN.scopeIdOperations);
    expect(computeWatchScopeId(assets, 'discovery-only', deployments)).toBe(
      FROZEN.scopeIdDiscovery,
    );
    expect(encodeJson(buildDiscoveryFilterPlan(assets, deployments, fromBlock, toBlock))).toBe(
      FROZEN.discoveryPlanJson,
    );
    expect(encodeJson(operationPlan(undefined))).toBe(FROZEN.operationPlanJson);
    expect(operationFilterValues(registrations)).toEqual({
      v3Addresses: [poolA, poolB],
      v4PoolIds: [poolIdA, poolIdB],
    });

    const state = fixtureReader();
    const batch = await capture(state);
    expect(batch.filterPlanHash).toBe(FROZEN.filterPlanHash);
    expect(batch.manifestHash).toBe(FROZEN.manifestHash);
    expect(batch.id).toBe(FROZEN.batchId);
    expect(batch.completeness).toBe('complete');
    expect(state.calls).toHaveLength(FROZEN.requests);
  });

  test('an explicit pool-ids option is byte-identical to the default at every value limit', async () => {
    for (const limit of [1_000, 2]) {
      expect(encodeJson(operationPlan('pool-ids', limit))).toBe(
        encodeJson(operationPlan(undefined, limit)),
      );
    }

    const implicit = fixtureReader();
    const explicit = fixtureReader();
    const implicitBatch = await capture(implicit);
    const explicitBatch = await capture(explicit, { v4OperationMode: 'pool-ids' });
    expect(explicitBatch.filterPlanHash).toBe(implicitBatch.filterPlanHash);
    expect(explicitBatch.manifestHash).toBe(implicitBatch.manifestHash);
    expect(explicitBatch.id).toBe(implicitBatch.id);
    expect(encodeJson(explicit.calls)).toBe(encodeJson(implicit.calls));
  });
});

describe('manager operation filter', () => {
  test('asks one manager address for the same five event families, with from/to preserved', () => {
    const plan = operationPlan('manager');
    const v4 = ofFamily(plan, 'operation-v4');
    expect(v4).toHaveLength(1);
    expect(v4[0]?.filter.address).toEqual([manager]);
    expect(v4[0]?.filter.fromBlock).toBe(fromBlock);
    expect(v4[0]?.filter.toBlock).toBe(toBlock);
    expect(v4[0]?.filter.topics[0]).toEqual(v4OperationTopics);
    expect(v4[0]?.filter.topics[1]).toBeUndefined();
    expect(v4[0]?.filter.topics).toHaveLength(1);
  });

  test('leaves the discovery plan and the V3 operation request exactly as the default has them', () => {
    const byDefault = operationPlan(undefined);
    const managerPlan = operationPlan('manager');
    expect(ofFamily(managerPlan, 'operation-v3')).toEqual(ofFamily(byDefault, 'operation-v3'));
    expect(encodeJson(buildDiscoveryFilterPlan(assets, deployments, fromBlock, toBlock))).toBe(
      FROZEN.discoveryPlanJson,
    );
    expect(computeWatchScopeId(assets, 'operations', deployments)).toBe(FROZEN.scopeIdOperations);
  });

  test('never shards by pool id, at any value limit', () => {
    const plan = operationPlan('manager', 2);
    const v4 = ofFamily(plan, 'operation-v4');
    expect(v4).toHaveLength(3);
    for (const entry of v4) {
      expect(entry.filter.address).toEqual([manager]);
      expect(entry.filter.topics[1]).toBeUndefined();
      expect(entry.filter.topics).toHaveLength(1);
      expect(topicValues(entry.filter, 0).length).toBeLessThanOrEqual(2);
    }
    expect(v4.flatMap((entry) => topicValues(entry.filter, 0)).sort()).toEqual(
      [...v4OperationTopics].sort(),
    );
  });

  test('manager mode is refused with a registry context instead of silently planning pool ids', async () => {
    const state = fixtureReader();
    await expect(
      fetchRange(state as unknown as ChainReader, {
        mode: 'operations',
        fromBlock,
        toBlock,
        end,
        assets,
        v3Factory: factory,
        v4Manager: manager,
        observedAtMs: 2_000,
        captureMode: 'synthetic',
        registry: {} as never,
        operationFilters: {} as never,
        v4OperationMode: 'manager',
      }),
    ).rejects.toThrow('registry templates');
    expect(state.calls).toEqual([]);
  });

  test('captures the manager universe even with no registered pool', () => {
    expect(operationPlan(undefined, 1_000, []).map((entry) => entry.family)).toEqual([]);
    const managerPlan = operationPlan('manager', 1_000, []);
    expect(managerPlan.map((entry) => entry.family)).toEqual(['operation-v4']);
    expect(managerPlan[0]?.filter.address).toEqual([manager]);
    expect(managerPlan[0]?.filter.topics[0]).toEqual(v4OperationTopics);
  });
});

const unknownCurrency0 = '0x8000000000000000000000000000000000000008' as Address;
const unknownCurrency1 = '0x9000000000000000000000000000000000000009' as Address;
const poolKeyA = {
  currency0: rwa0,
  currency1: quote,
  fee: 500,
  tickSpacing: 10,
  hooks: zeroAddress,
};
/** A pool whose currencies the watch list never asked about: no discovery request can find it. */
const poolKeyOld = {
  currency0: unknownCurrency0,
  currency1: unknownCurrency1,
  fee: 3_000,
  tickSpacing: 60,
  hooks: zeroAddress,
};

function v4Registration(
  key: typeof poolKeyA,
  seed: number,
  discoveredAt = evidence(seed),
): PoolRegistration {
  return {
    pool: { chainId: CHAIN_ID, protocol: 'v4', manager, poolId: computeV4PoolId(key) },
    token0: key.currency0,
    token1: key.currency1,
    feePips: key.fee,
    tickSpacing: key.tickSpacing,
    hooks: key.hooks,
    discoveredAt,
    assetVersion: 'assets-1',
    source: 'seed-config',
  };
}

function v4InitializeLog(key: typeof poolKeyA, logIndex: number): RawLog {
  const topics = encodeEventTopics({
    abi: v4ManagerAbi,
    eventName: 'Initialize',
    args: {
      id: computeV4PoolId(key),
      currency0: key.currency0 as Address,
      currency1: key.currency1 as Address,
    },
  });
  const data = encodeAbiParameters(
    [
      { type: 'uint24' },
      { type: 'int24' },
      { type: 'address' },
      { type: 'uint160' },
      { type: 'int24' },
    ],
    [key.fee, key.tickSpacing, key.hooks, 1n << 96n, 0],
  );
  return rawLog(manager, logIndex, topics as readonly Hex[], data);
}

function v4EventLog(key: typeof poolKeyA, name: string, logIndex: number): RawLog {
  return rawLog(manager, logIndex, [eventTopic(v4ManagerAbi, name), computeV4PoolId(key)]);
}

const keysOf = (batch: RangeRecordingBatch): readonly string[] => batch.logs.map(rawLogKey).sort();

async function experiment(
  mode: 'pool-ids' | 'manager',
  logs: readonly RawLog[],
  catalogue: readonly PoolRegistration[],
  extra: Record<string, unknown> = {},
) {
  const state = fixtureReader(logs);
  const outcome = await runV4CaptureExperiment(state as unknown as ChainReader, {
    fromBlock,
    toBlock,
    end,
    assets,
    pools: new PoolRegistry(catalogue),
    v3Factory: factory,
    v4Manager: manager,
    observedAtMs: 2_000,
    captureMode: 'synthetic',
    v4OperationMode: mode,
    ...extra,
  });
  return { state, ...outcome };
}

describe('manager capture experiment', () => {
  test('class 1: a catalogue of known target pools is watched whole and eligible', async () => {
    const catalogue = [v4Registration(poolKeyA, 3)];
    const logs = [
      v4EventLog(poolKeyA, 'ModifyLiquidity', 1),
      v4EventLog(poolKeyA, 'Swap', 2),
      v4EventLog(poolKeyA, 'Donate', 3),
    ];
    const forManager = await experiment('manager', logs, catalogue);

    expect(forManager.result.mode).toBe('manager');
    expect(forManager.batch.completeness).toBe('complete');
    expect(forManager.result.complete).toBe(true);
    expect(forManager.result.unknownLogKeys).toEqual([]);
    expect(forManager.result.watchedLogKeys).toEqual(logs.map(rawLogKey).sort());
    expect(forManager.result.reasons).toEqual([]);
    expect(forManager.result.eligibleForLive).toBe(true);
    // Counts and bytes come from the reader itself, not from anything the capture re-derived.
    expect(forManager.result.requestCount).toBe(forManager.state.calls.length);
    expect(forManager.result.responseBytes).toBe(forManager.state.responseBytes);
    expect(forManager.result.responseBytes).toBeGreaterThan(0);

    const forPoolIds = await experiment('pool-ids', logs, catalogue);
    expect(forPoolIds.result.watchedLogKeys).toEqual(forManager.result.watchedLogKeys);
    expect(keysOf(forPoolIds.batch)).toEqual(keysOf(forManager.batch));
    expect(forPoolIds.result.eligibleForLive).toBe(true);
    // The two modes really planned different filters: the mode is not just a log line.
    expect(forPoolIds.batch.filterPlanHash).not.toBe(forManager.batch.filterPlanHash);
  });

  test('class 2: a pool created and swapped in the same block is watched in both modes', async () => {
    const fresh = {
      currency0: rwa1,
      currency1: quote,
      fee: 3_000,
      tickSpacing: 60,
      hooks: zeroAddress,
    };
    const initialize = v4InitializeLog(fresh, 1);
    const swap = v4EventLog(fresh, 'Swap', 2);
    const catalogue = [v4Registration(poolKeyA, 3)];

    for (const mode of ['pool-ids', 'manager'] as const) {
      const run = await experiment(mode, [initialize, swap], catalogue);
      expect(run.batch.completeness).toBe('complete');
      expect(run.result.complete).toBe(true);
      expect(run.result.watchedLogKeys).toEqual([initialize, swap].map(rawLogKey).sort());
      expect(run.result.unknownLogKeys).toEqual([]);
      expect(run.result.eligibleForLive).toBe(true);
      expect(
        (run.batch.poolRegistrations ?? []).some(
          (entry) => entry.pool.protocol === 'v4' && entry.pool.poolId === computeV4PoolId(fresh),
        ),
      ).toBe(true);
    }
  });

  test('class 3: an unregistered old pool stays raw evidence, is listed unknown, and is not eligible', async () => {
    const catalogue = [v4Registration(poolKeyA, 3)];
    const known = v4EventLog(poolKeyA, 'Swap', 1);
    const old = v4EventLog(poolKeyOld, 'Swap', 2);

    const run = await experiment('manager', [known, old], catalogue);
    expect(run.batch.completeness).toBe('complete');
    expect(run.result.complete).toBe(true);
    // The unknown pool's log is kept exactly as the provider returned it.
    expect(keysOf(run.batch)).toEqual([known, old].map(rawLogKey).sort());
    expect(run.result.watchedLogKeys).toEqual([rawLogKey(known)]);
    expect(run.result.unknownLogKeys).toEqual([rawLogKey(old)]);
    expect(run.result.eligibleForLive).toBe(false);
    expect(run.result.reasons).toContain('unknown-pool-logs');
    // The manager response was recorded whole: both logs are counted and hashed, so the capture
    // did not filter the provider's answer before measuring it.
    const managerShards = run.batch.manifest.shards.filter(
      (shard) => shard.filterId === 'operation-v4',
    );
    expect(managerShards.reduce((total, shard) => total + shard.logCount, 0)).toBe(2);
    expect(managerShards.every((shard) => shard.responseHash !== null)).toBe(true);

    // The pool-id plan never asks for the old pool: seeing nothing there is not evidence about it.
    const forPoolIds = await experiment('pool-ids', [known, old], catalogue);
    expect(keysOf(forPoolIds.batch)).toEqual([rawLogKey(known)]);
    expect(forPoolIds.result.unknownLogKeys).toEqual([]);
    expect(forPoolIds.result.eligibleForLive).toBe(true);
  });

  test('a capped manager response splits further and is never called complete', async () => {
    const catalogue = [v4Registration(poolKeyA, 3)];
    const logs = [v4EventLog(poolKeyA, 'Swap', 1), v4EventLog(poolKeyOld, 'Swap', 2)];

    const control = await experiment('manager', logs, catalogue);
    expect(control.batch.completeness).toBe('complete');

    const capped = await experiment('manager', logs, catalogue, {
      logResponseGuard: 5_000,
      maxLogsPerResponse: 1,
    });
    expect(capped.result.complete).toBe(false);
    expect(capped.batch.completeness).toBe('incomplete');
    expect(capped.result.eligibleForLive).toBe(false);
    expect(capped.result.reasons).toContain('incomplete-capture');
    expect(
      capped.batch.manifest.shards.some(
        (shard) => shard.filterId === 'operation-v4' && shard.status === 'truncated',
      ),
    ).toBe(true);

    const swapTopic = eventTopic(v4ManagerAbi, 'Swap');
    const managerRequests = capped.state.calls.filter((call) => {
      const topics = call.topics[0];
      if (!Array.isArray(topics)) return false;
      return (
        call.address.length === 1 &&
        call.address[0] === manager &&
        topics.some((topic) => topic.toLowerCase() === swapTopic)
      );
    });
    // The capped request was re-asked with smaller topic lists instead of accepted as an answer.
    expect(managerRequests.length).toBeGreaterThan(1);
    expect(managerRequests.some((call) => (call.topics[0] as readonly Hex[]).length < 5)).toBe(
      true,
    );
    expect(capped.result.requestCount).toBeGreaterThan(control.result.requestCount);
  });
});

describe('catalogue scale', () => {
  test('77,628 V4 registrations stay 78 pool-id requests by default and 1 in manager mode', () => {
    const catalogue = largeCatalogue(77_628);
    const byDefault = operationPlan(undefined, 1_000, catalogue);
    const explicit = operationPlan('pool-ids', 1_000, catalogue);
    const managerPlan = operationPlan('manager', 1_000, catalogue);

    const defaultV4 = ofFamily(byDefault, 'operation-v4');
    expect(byDefault).toHaveLength(78);
    expect(defaultV4).toHaveLength(78);
    expect(defaultV4.map((entry) => topicValues(entry.filter, 1).length)).toEqual([
      ...Array.from({ length: 77 }, () => 1_000),
      628,
    ]);
    expect(new Set(defaultV4.flatMap((entry) => topicValues(entry.filter, 1))).size).toBe(77_628);
    expect(encodeJson(explicit)).toBe(encodeJson(byDefault));

    expect(managerPlan).toHaveLength(1);
    expect(managerPlan[0]?.filter.address).toEqual([manager]);
    expect(managerPlan[0]?.filter.topics[0]).toEqual(v4OperationTopics);
    expect(managerPlan[0]?.filter.topics[1]).toBeUndefined();
  });
});
