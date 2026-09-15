import { createHash } from 'node:crypto';
import { padHex, toEventSelector, type Address, type Hex } from 'viem';
import type { ChainReader, WatchScopeId } from '../domain/types.js';
import { encodeJson } from '../domain/json.js';
import type { AssetRegistry } from '../registry/assets.js';
import type { PoolRegistration } from '../registry/pools.js';
import { v3FactoryAbi, v3PoolAbi } from '../protocols/uniswap-v3/abi.js';
import { v4ManagerAbi } from '../protocols/uniswap-v4/abi.js';

export type FetchMode = 'operations' | 'discovery-only';
export type LogFilter = Parameters<ChainReader['getLogs']>[0];
export type OperationFamily = 'operation-v3' | 'operation-v4';
export type FilterFamily = 'discovery-v3' | 'discovery-v4' | OperationFamily;
export interface PlannedFilter {
  readonly id: FilterFamily;
  readonly family: FilterFamily;
  readonly filter: LogFilter;
}
export interface ProtocolDeployments {
  readonly v3Factory: Address;
  readonly v4Manager: Address;
}
/** The values half of a request filter: what to ask for, with no block range attached. */
export interface ShardFilter {
  readonly address: readonly Address[];
  readonly topics: readonly (Hex | readonly Hex[] | null)[];
}
/** One pool-request template: a chunk of values that fits inside a single bounded request. */
export interface OperationShard {
  readonly id: OperationFamily;
  readonly family: OperationFamily;
  readonly filter: ShardFilter;
}
/** The distinct pool identities every operation request for one catalogue is built from. */
export interface OperationFilterValues {
  readonly v3Addresses: readonly Address[];
  readonly v4PoolIds: readonly Hex[];
}

const eventTopic = (abi: readonly unknown[], name: string): Hex =>
  toEventSelector(
    (abi as readonly { type: string; name?: string }[]).find(
      (entry) => entry.type === 'event' && entry.name === name,
    ) as never,
  );
const v3PoolCreatedTopic = eventTopic(v3FactoryAbi, 'PoolCreated');
const v4InitializeTopic = eventTopic(v4ManagerAbi, 'Initialize');
const v3OperationTopics = ['Initialize', 'Mint', 'Burn', 'Collect', 'Swap'].map((name) =>
  eventTopic(v3PoolAbi, name),
);
const v4OperationTopics = [
  'Initialize',
  'ModifyLiquidity',
  'Swap',
  'Donate',
  'ProtocolFeeUpdated',
].map((name) => eventTopic(v4ManagerAbi, name));
const addressTopic = (address: Address): Hex => padHex(address.toLowerCase() as Hex, { size: 32 });
const v4OperationTopicSet = new Set<string>(v4OperationTopics.map((topic) => topic.toLowerCase()));
/** Lowercase a hex identity without losing its type: every request value and index key is lowercase. */
export const lower = <T extends string>(value: T): T => value.toLowerCase() as T;

/** Whether a topic is one of the manager events an operation request asks for. */
export function isV4OperationTopic(topic: string): boolean {
  return v4OperationTopicSet.has(topic.toLowerCase());
}

function valueChunks<T>(values: readonly T[], maximum: number): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += maximum) {
    chunks.push(values.slice(offset, offset + maximum));
  }
  return chunks;
}

function ensureFilterValueLimit(maxFilterValues: number): void {
  if (!Number.isSafeInteger(maxFilterValues) || maxFilterValues <= 0) {
    throw new RangeError('maxFilterValues must be a positive safe integer');
  }
}

/**
 * Every value split of one filter's value lists, each small enough to be one bounded request.
 *
 * Only the value lists move: the rest of a filter is whatever the caller reattaches, which is how
 * the same split shards serve every block range they are asked for.
 */
function partitionValues(filter: ShardFilter, maxFilterValues: number): readonly ShardFilter[] {
  let splits: ShardFilter[] = [{ address: filter.address, topics: filter.topics }];
  if (filter.address.length > maxFilterValues) {
    splits = valueChunks(filter.address, maxFilterValues).map((address) => ({
      address,
      topics: filter.topics,
    }));
  }
  for (let index = 0; index < filter.topics.length; index++) {
    const alternatives = filter.topics[index];
    if (
      alternatives === undefined ||
      alternatives === null ||
      typeof alternatives === 'string' ||
      alternatives.length <= maxFilterValues
    ) {
      continue;
    }
    splits = splits.flatMap((split) =>
      valueChunks(alternatives, maxFilterValues).map((values) => {
        const topics = [...split.topics];
        topics[index] = values.length === 1 ? values[0]! : values;
        return { address: split.address, topics };
      }),
    );
  }
  return splits;
}

function partitionPlans(
  plans: readonly PlannedFilter[],
  maxFilterValues: number,
): readonly PlannedFilter[] {
  ensureFilterValueLimit(maxFilterValues);
  return plans.flatMap((planned) =>
    partitionValues(planned.filter, maxFilterValues).map((partitioned) => ({
      id: planned.id,
      family: planned.family,
      filter: {
        fromBlock: planned.filter.fromBlock,
        toBlock: planned.filter.toBlock,
        address: partitioned.address,
        topics: partitioned.topics,
      },
    })),
  );
}

export const discoveryEventFamilies = ['uniswap-v3:PoolCreated', 'uniswap-v4:Initialize'] as const;
export const operationEventFamilies = [
  ...discoveryEventFamilies,
  'uniswap-v3:pool-operations-v1',
  'uniswap-v4:pool-operations-v1',
] as const;

export function computeWatchScopeId(
  assets: AssetRegistry,
  mode: FetchMode,
  deployments: ProtocolDeployments,
): WatchScopeId {
  const eventFamilies = mode === 'discovery-only' ? discoveryEventFamilies : operationEventFamilies;
  const input = {
    version: 1,
    chainId: assets.chainId,
    assetVersion: assets.version,
    assets: [...assets.addresses].map((address) => address.toLowerCase()).sort(),
    deployments: {
      v3Factory: deployments.v3Factory.toLowerCase(),
      v4Manager: deployments.v4Manager.toLowerCase(),
    },
    protocols: ['uniswap-v3', 'uniswap-v4'],
    eventFamilies,
  };
  return `scope-v1-${createHash('sha256').update(encodeJson(input)).digest('hex')}`;
}

export function buildDiscoveryFilterPlan(
  assets: AssetRegistry,
  contracts: ProtocolDeployments,
  fromBlock: bigint,
  toBlock: bigint,
  maxFilterValues = 1_000,
): readonly PlannedFilter[] {
  const assetTopics = assets.addresses.map(addressTopic);
  const base = { fromBlock, toBlock };
  const v3Address = contracts.v3Factory.toLowerCase() as Address;
  const v4Address = contracts.v4Manager.toLowerCase() as Address;
  return partitionPlans(
    [
      {
        id: 'discovery-v3',
        family: 'discovery-v3',
        filter: {
          ...base,
          address: [v3Address],
          topics: [v3PoolCreatedTopic, assetTopics, null, null],
        },
      },
      {
        id: 'discovery-v3',
        family: 'discovery-v3',
        filter: {
          ...base,
          address: [v3Address],
          topics: [v3PoolCreatedTopic, null, assetTopics, null],
        },
      },
      {
        id: 'discovery-v4',
        family: 'discovery-v4',
        filter: {
          ...base,
          address: [v4Address],
          topics: [v4InitializeTopic, null, assetTopics, null],
        },
      },
      {
        id: 'discovery-v4',
        family: 'discovery-v4',
        filter: {
          ...base,
          address: [v4Address],
          topics: [v4InitializeTopic, null, null, assetTopics],
        },
      },
    ],
    maxFilterValues,
  );
}

/** The distinct values of one protocol's pool identities, in the one order every request uses. */
function identityValues<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort();
}

/** The distinct, sorted pool identities one catalogue asks operations for. */
export function operationFilterValues(
  registrations: readonly PoolRegistration[],
): OperationFilterValues {
  return {
    v3Addresses: identityValues(
      registrations.flatMap((registration) =>
        registration.pool.protocol === 'v3' ? [lower(registration.pool.address)] : [],
      ),
    ),
    v4PoolIds: identityValues(
      registrations.flatMap((registration) =>
        registration.pool.protocol === 'v4' ? [lower(registration.pool.poolId)] : [],
      ),
    ),
  };
}

/**
 * Every operation request the given pool identities need, already split to the value limit.
 *
 * The returned shards carry no block range: a caller that keeps them can plan the same pools for a
 * later range without sorting, deduplicating or re-reading the catalogue they came from.
 */
export function buildOperationShardFilters(
  values: OperationFilterValues,
  contracts: Pick<ProtocolDeployments, 'v4Manager'>,
  maxFilterValues = 1_000,
): readonly OperationShard[] {
  ensureFilterValueLimit(maxFilterValues);
  const shards: OperationShard[] = [];
  if (values.v3Addresses.length > 0) {
    shards.push({
      id: 'operation-v3',
      family: 'operation-v3',
      filter: { address: values.v3Addresses, topics: [v3OperationTopics] },
    });
  }
  if (values.v4PoolIds.length > 0) {
    shards.push({
      id: 'operation-v4',
      family: 'operation-v4',
      filter: {
        address: [contracts.v4Manager.toLowerCase() as Address],
        topics: [v4OperationTopics, values.v4PoolIds],
      },
    });
  }
  return shards.flatMap((shard) =>
    partitionValues(shard.filter, maxFilterValues).map((filter) => ({
      id: shard.id,
      family: shard.family,
      filter,
    })),
  );
}

export function buildOperationFilterPlan(
  registrations: readonly PoolRegistration[],
  contracts: Pick<ProtocolDeployments, 'v4Manager'>,
  fromBlock: bigint,
  toBlock: bigint,
  maxFilterValues = 1_000,
): readonly PlannedFilter[] {
  return buildOperationShardFilters(
    operationFilterValues(registrations),
    contracts,
    maxFilterValues,
  ).map((shard) => ({
    id: shard.family,
    family: shard.family,
    filter: {
      fromBlock,
      toBlock,
      address: shard.filter.address,
      topics: shard.filter.topics,
    },
  }));
}
