import type { Address, Hex } from 'viem';
import type {
  BlockAnchor,
  LogRef,
  LogTime,
  MinuteBoundary,
  PoolRef,
  RangeBatch,
  RawLog,
} from '../domain/types.js';
import { CHAIN_ID } from '../domain/chain.js';

export type FetchShardStatus = 'success' | 'failed' | 'truncated';

/** Credential-free RPC request evidence for one independently verified shard. */
export type FetchShardRequest = {
  fromBlock: bigint;
  toBlock: bigint;
  address: readonly Address[];
  topics: readonly (Hex | readonly Hex[] | null)[];
};

export type FetchShardManifest = {
  shardId: string;
  filterId: string;
  request: FetchShardRequest;
  status: FetchShardStatus;
  responseHash: string | null;
  logKeys: readonly string[];
  logCount: number;
  error: string | null;
};

export type FetchManifest = {
  version: 1;
  filterVersion: string;
  expectedShardIds: readonly string[];
  shards: readonly FetchShardManifest[];
};

export type LogTimeAssignment = { ref: LogRef; time: LogTime };

/** Storage-facing registry record; registry discovery may alias this contract. */
export type PersistedPoolRegistration = {
  pool: PoolRef;
  token0: Address;
  token1: Address;
  feePips: number;
  tickSpacing: number;
  hooks: Address;
  discoveredAt: LogRef;
  assetVersion: string;
  source: string;
};

/** P1 persistence input. P0's RangeBatch remains unchanged. */
export interface RecordedRangeBatch extends RangeBatch {
  manifest: FetchManifest;
  logTimes?: readonly LogTimeAssignment[];
  anchors?: readonly BlockAnchor[];
  boundaries?: readonly MinuteBoundary[];
  poolRegistrations?: readonly PersistedPoolRegistration[];
}

export type RangeInvalidationRecord = {
  fromBlock: bigint;
  toBlock: bigint;
  reason: 'reorg' | 'warmup-rechecking';
};

export type RunRecord = {
  id: string;
  scopeId: string | null;
  startedAtMs: number;
  finishedAtMs: number | null;
  status: string;
  payload: unknown;
};

export function rawLogKey(log: RawLog | LogRef): string {
  return `${CHAIN_ID}:${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`;
}
