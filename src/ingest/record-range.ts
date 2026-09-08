import { createHash } from 'node:crypto';
import type { Address } from 'viem';
import type { BlockAnchor, ChainReader, RangeBatch, RawLog } from '../domain/types.js';
import { encodeJson } from '../domain/json.js';
import {
  buildDiscoveryFilterPlan,
  buildOperationFilterPlan,
  computeWatchScopeId,
  type FetchMode,
  type PlannedFilter,
  type ProtocolDeployments,
} from './filter-plan.js';
import { fetchBoundedLogs, type FetchFragment, type FetchResult } from './fetch-range.js';
import type { AssetRegistry } from '../registry/assets.js';
import { PoolRegistry, type PoolRegistration } from '../registry/pools.js';
import { discoverPools as discoverV3Pools } from '../protocols/uniswap-v3/discover.js';
import { discoverPools as discoverV4Pools } from '../protocols/uniswap-v4/discover.js';
import { classifyRpcError } from '../rpc/errors.js';
import {
  rawLogKey,
  type FetchManifest,
  type FetchShardManifest,
  type RecordedRangeBatch,
} from '../storage/manifest.js';

export interface FetchRangeOptions extends ProtocolDeployments {
  readonly mode: FetchMode;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly end: BlockAnchor;
  readonly previous?: BlockAnchor | null;
  readonly assets: AssetRegistry;
  readonly pools: PoolRegistry;
  readonly logResponseGuard?: number;
  readonly maxLogsPerResponse?: number | null;
  readonly maxFilterValues?: number;
  readonly maxRangeBlocks?: number | bigint;
  readonly discoveryMaxRangeBlocks?: number | bigint;
  readonly observedAtMs: number;
  readonly captureMode: RangeBatch['captureMode'];
}

export interface RangeRecordingBatch extends RecordedRangeBatch {
  readonly recordingErrors: readonly string[];
}

const digest = (value: unknown): string =>
  createHash('sha256').update(encodeJson(value)).digest('hex');

function positiveBlocks(value: number | bigint | undefined, fallback: bigint): bigint {
  if (value === undefined) return fallback;
  const blocks = typeof value === 'number' ? BigInt(value) : value;
  if (blocks <= 0n) throw new RangeError('Range block limit must be positive');
  return blocks;
}

function deduplicateLogs(logs: readonly RawLog[], errors: string[]): RawLog[] {
  const unique = new Map<string, RawLog>();
  const fingerprints = new Map<string, string>();
  for (const log of logs) {
    const key = rawLogKey(log);
    const fingerprint = encodeJson(log);
    const prior = fingerprints.get(key);
    if (prior !== undefined && prior !== fingerprint) {
      errors.push(`conflicting-log:${key}`);
      continue;
    }
    fingerprints.set(key, fingerprint);
    unique.set(key, log);
  }
  return [...unique.values()].sort((left, right) =>
    left.blockNumber < right.blockNumber
      ? -1
      : left.blockNumber > right.blockNumber
        ? 1
        : left.transactionIndex - right.transactionIndex || left.logIndex - right.logIndex,
  );
}

function failedResult(filter: PlannedFilter['filter'], reason: string): FetchResult {
  return {
    logs: [],
    complete: false,
    failures: [
      {
        fromBlock: filter.fromBlock,
        toBlock: filter.toBlock,
        reason,
      },
    ],
    ranges: [],
    fragments: [
      {
        filter,
        status: 'failed',
        logs: [],
        responseHash: null,
        reason,
      },
    ],
  };
}

function shardFromFragment(
  filterId: string,
  fragment: FetchFragment,
  sequence: number,
): FetchShardManifest {
  const logs = deduplicateLogs(fragment.logs, []);
  const request = {
    fromBlock: fragment.filter.fromBlock,
    toBlock: fragment.filter.toBlock,
    address: fragment.filter.address,
    topics: fragment.filter.topics,
  };
  return {
    shardId: `${filterId}:${sequence.toString().padStart(4, '0')}:${digest(request).slice(0, 16)}`,
    filterId,
    request,
    status: fragment.status,
    responseHash: fragment.responseHash,
    logKeys: logs.map(rawLogKey),
    logCount: logs.length,
    error: fragment.reason,
  };
}

async function executePlan(
  reader: Pick<ChainReader, 'getLogs'>,
  plan: readonly PlannedFilter[],
  guard: number,
  maxRangeBlocks: bigint,
  sequenceStart: number,
): Promise<{
  readonly complete: boolean;
  readonly logs: readonly RawLog[];
  readonly logsByFamily: ReadonlyMap<string, readonly RawLog[]>;
  readonly shards: readonly FetchShardManifest[];
  readonly nextSequence: number;
  readonly errors: readonly string[];
}> {
  const logs: RawLog[] = [];
  const logsByFamily = new Map<string, RawLog[]>();
  const shards: FetchShardManifest[] = [];
  const errors: string[] = [];
  let complete = true;
  let sequence = sequenceStart;
  for (const planned of plan) {
    let result: FetchResult;
    try {
      result = await fetchBoundedLogs(reader, planned.filter, guard, maxRangeBlocks, {
        captureCriticalFailures: true,
      });
    } catch (error) {
      const failure = classifyRpcError(error);
      result = failedResult(planned.filter, failure.kind);
    }
    complete &&= result.complete;
    for (const failure of result.failures) errors.push(failure.reason);
    logs.push(...result.logs);
    const familyLogs = logsByFamily.get(planned.family) ?? [];
    familyLogs.push(...result.logs);
    logsByFamily.set(planned.family, familyLogs);
    for (const fragment of result.fragments) {
      shards.push(shardFromFragment(planned.id, fragment, sequence++));
    }
  }
  return {
    complete,
    logs,
    logsByFamily,
    shards,
    nextSequence: sequence,
    errors,
  };
}

function ensureObservedAssets(
  registrations: readonly PoolRegistration[],
  assets: AssetRegistry,
): readonly PoolRegistration[] {
  return registrations.filter(
    (registration) => assets.has(registration.token0) || assets.has(registration.token1),
  );
}

function validateRange(options: FetchRangeOptions): void {
  if (options.fromBlock < 0n || options.toBlock < options.fromBlock) {
    throw new RangeError('Invalid recording range');
  }
  if (options.end.number !== options.toBlock) {
    throw new RangeError('End anchor must identify toBlock');
  }
  if (!Number.isSafeInteger(options.observedAtMs) || options.observedAtMs < 0) {
    throw new RangeError('observedAtMs must be a non-negative safe integer');
  }
}

export async function fetchRange(
  reader: ChainReader,
  options: FetchRangeOptions,
): Promise<RangeRecordingBatch> {
  validateRange(options);
  const localGuard = options.logResponseGuard ?? 5_000;
  if (!Number.isSafeInteger(localGuard) || localGuard <= 0) {
    throw new RangeError('logResponseGuard must be a positive safe integer');
  }
  const providerCap = options.maxLogsPerResponse;
  if (
    providerCap !== undefined &&
    providerCap !== null &&
    (!Number.isSafeInteger(providerCap) || providerCap <= 0)
  ) {
    throw new RangeError('maxLogsPerResponse must be null or a positive safe integer');
  }
  const guard =
    providerCap === undefined || providerCap === null
      ? localGuard
      : Math.min(localGuard, providerCap);
  const deployments: ProtocolDeployments = {
    v3Factory: options.v3Factory.toLowerCase() as Address,
    v4Manager: options.v4Manager.toLowerCase() as Address,
  };
  const scopeId = computeWatchScopeId(options.assets, options.mode, deployments);
  const span = options.toBlock - options.fromBlock + 1n;
  const blockLimit =
    options.mode === 'discovery-only'
      ? positiveBlocks(options.discoveryMaxRangeBlocks, span)
      : positiveBlocks(options.maxRangeBlocks, 1_000n);
  const errors: string[] = [];
  const maxFilterValues = options.maxFilterValues ?? 1_000;
  const discoveryPlan = buildDiscoveryFilterPlan(
    options.assets,
    deployments,
    options.fromBlock,
    options.toBlock,
    maxFilterValues,
  );
  const discovery = await executePlan(reader, discoveryPlan, guard, blockLimit, 0);
  errors.push(...discovery.errors);

  let staged: readonly PoolRegistration[] = [];
  try {
    const v3Logs = deduplicateLogs(discovery.logsByFamily.get('discovery-v3') ?? [], errors);
    const v4Logs = deduplicateLogs(discovery.logsByFamily.get('discovery-v4') ?? [], errors);
    staged = ensureObservedAssets(
      [
        ...discoverV3Pools(v3Logs, options.assets.version),
        ...discoverV4Pools(v4Logs, options.assets.version),
      ],
      options.assets,
    );
  } catch (error) {
    errors.push(`discovery-decode:${error instanceof Error ? error.name : 'unknown'}`);
  }

  let complete =
    discovery.complete &&
    !errors.some(
      (error) => error.startsWith('discovery-decode:') || error.startsWith('conflicting-log:'),
    );
  let operationPlan: readonly PlannedFilter[] = [];
  let operation: Awaited<ReturnType<typeof executePlan>> | null = null;
  let candidateRegistrations: readonly PoolRegistration[] = [];
  try {
    candidateRegistrations = options.pools.preview(staged, options.assets.version);
    if (options.mode === 'operations') {
      operationPlan = buildOperationFilterPlan(
        candidateRegistrations,
        deployments,
        options.fromBlock,
        options.toBlock,
        maxFilterValues,
      );
      operation = await executePlan(
        reader,
        operationPlan,
        guard,
        blockLimit,
        discovery.nextSequence,
      );
      complete &&= operation.complete;
      errors.push(...operation.errors);
    }
  } catch (error) {
    complete = false;
    errors.push(`registry-plan:${error instanceof Error ? error.name : 'unknown'}`);
  }

  const allLogs = deduplicateLogs([...discovery.logs, ...(operation?.logs ?? [])], errors);
  const blockHashes = new Map<bigint, string>();
  for (const log of allLogs) {
    const prior = blockHashes.get(log.blockNumber);
    const hash = log.blockHash.toLowerCase();
    if (prior !== undefined && prior !== hash) {
      complete = false;
      errors.push(`mixed-block-hash:${log.blockNumber}`);
    }
    blockHashes.set(log.blockNumber, hash);
    if (log.blockNumber === options.end.number && hash !== options.end.hash.toLowerCase()) {
      complete = false;
      errors.push('end-block-log-hash-mismatch');
    }
  }
  try {
    const recheckedEnd = await reader.getAnchor(options.end.number);
    if (
      recheckedEnd.hash.toLowerCase() !== options.end.hash.toLowerCase() ||
      recheckedEnd.timestampSec !== options.end.timestampSec
    ) {
      complete = false;
      errors.push('end-anchor-changed');
    }
  } catch (error) {
    complete = false;
    errors.push(`end-anchor:${classifyRpcError(error).kind}`);
  }
  if (errors.some((error) => error.startsWith('conflicting-log:'))) complete = false;

  const allPlans = [...discoveryPlan, ...operationPlan];
  const filterPlanHash = digest({
    version: 1,
    guard,
    filters: allPlans.map((planned) => ({
      filterId: planned.id,
      request: planned.filter,
    })),
  });
  const shards = [...discovery.shards, ...(operation?.shards ?? [])];
  const manifest: FetchManifest = {
    version: 1,
    filterVersion: filterPlanHash,
    expectedShardIds: shards.map((shard) => shard.shardId),
    shards,
  };
  const manifestHash = digest(manifest);
  const completeness = complete ? 'complete' : 'incomplete';
  const batchIdentity = {
    version: 1,
    scopeId,
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    end: options.end,
    observedAtMs: options.observedAtMs,
    captureMode: options.captureMode,
    manifestHash,
  };
  return {
    id: digest(batchIdentity),
    scopeId,
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    end: options.end,
    previous: options.previous ?? null,
    logs: allLogs,
    observedAtMs: options.observedAtMs,
    captureMode: options.captureMode,
    filterPlanHash,
    manifestHash,
    completeness,
    manifest,
    poolRegistrations: complete ? candidateRegistrations : [],
    recordingErrors: [...new Set(errors)],
  };
}
