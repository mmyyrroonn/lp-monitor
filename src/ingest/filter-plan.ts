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
export type FilterFamily = 'discovery-v3' | 'discovery-v4' | 'operation-v3' | 'operation-v4';
export interface PlannedFilter {
  readonly id: FilterFamily;
  readonly family: FilterFamily;
  readonly filter: LogFilter;
}
export interface ProtocolDeployments {
  readonly v3Factory: Address;
  readonly v4Manager: Address;
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

function valueChunks<T>(values: readonly T[], maximum: number): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += maximum) {
    chunks.push(values.slice(offset, offset + maximum));
  }
  return chunks;
}

function partitionPlans(
  plans: readonly PlannedFilter[],
  maxFilterValues: number,
): readonly PlannedFilter[] {
  if (!Number.isSafeInteger(maxFilterValues) || maxFilterValues <= 0) {
    throw new RangeError('maxFilterValues must be a positive safe integer');
  }
  return plans.flatMap((planned) => {
    let filters: LogFilter[] = [planned.filter];
    if (planned.filter.address.length > maxFilterValues) {
      filters = valueChunks(planned.filter.address, maxFilterValues).map((address) => ({
        ...planned.filter,
        address,
      }));
    }
    for (let index = 0; index < planned.filter.topics.length; index++) {
      const alternatives = planned.filter.topics[index];
      if (
        alternatives === undefined ||
        alternatives === null ||
        typeof alternatives === 'string' ||
        alternatives.length <= maxFilterValues
      ) {
        continue;
      }
      filters = filters.flatMap((filter) =>
        valueChunks(alternatives, maxFilterValues).map((values) => {
          const topics = [...filter.topics];
          topics[index] = values.length === 1 ? values[0]! : values;
          return { ...filter, topics };
        }),
      );
    }
    return filters.map((filter) => ({ ...planned, filter }));
  });
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

export function buildOperationFilterPlan(
  registrations: readonly PoolRegistration[],
  contracts: Pick<ProtocolDeployments, 'v4Manager'>,
  fromBlock: bigint,
  toBlock: bigint,
  maxFilterValues = 1_000,
): readonly PlannedFilter[] {
  const v3Addresses = [
    ...new Set(
      registrations.flatMap((registration) =>
        registration.pool.protocol === 'v3' ? [registration.pool.address] : [],
      ),
    ),
  ].sort();
  const v4PoolIds = [
    ...new Set(
      registrations.flatMap((registration) =>
        registration.pool.protocol === 'v4' ? [registration.pool.poolId] : [],
      ),
    ),
  ].sort();
  const filters: PlannedFilter[] = [];
  if (v3Addresses.length > 0) {
    filters.push({
      id: 'operation-v3',
      family: 'operation-v3',
      filter: {
        fromBlock,
        toBlock,
        address: v3Addresses,
        topics: [v3OperationTopics],
      },
    });
  }
  if (v4PoolIds.length > 0) {
    filters.push({
      id: 'operation-v4',
      family: 'operation-v4',
      filter: {
        fromBlock,
        toBlock,
        address: [contracts.v4Manager.toLowerCase() as Address],
        topics: [v4OperationTopics, v4PoolIds],
      },
    });
  }
  return partitionPlans(filters, maxFilterValues);
}
