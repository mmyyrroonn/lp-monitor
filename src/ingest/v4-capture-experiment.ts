import type { Hex } from 'viem';
import { encodeJson } from '../domain/json.js';
import type { ChainReader, RawLog } from '../domain/types.js';
import { PoolRegistry, poolRegistrationId, type PoolRegistration } from '../registry/pools.js';
import type { RegistryView } from '../storage/registry-cache.js';
import { rawLogKey } from '../storage/manifest.js';
import {
  isV4OperationTopic,
  lower,
  v4OperationTopics,
  type ProtocolDeployments,
  type V4OperationMode,
} from './filter-plan.js';
import { fetchRange, type FetchRangeOptions, type RangeRecordingBatch } from './record-range.js';
import { referencedRegistrations } from './registry-dependencies.js';

export type { V4OperationMode };

export type V4ExperimentResult = {
  mode: V4OperationMode;
  complete: boolean;
  eligibleForLive: boolean;
  reasons: string[];
  watchedLogKeys: string[];
  unknownLogKeys: string[];
  requestCount: number;
  responseBytes: number;
};

export interface V4CaptureExperimentOptions extends Omit<
  FetchRangeOptions,
  'mode' | 'registry' | 'operationFilters' | 'v4OperationMode'
> {
  /**
   * Required and explicit: `manager` is an experiment, so no configuration, CLI default or live
   * run may reach it by omission.
   */
  readonly v4OperationMode: V4OperationMode;
  /**
   * The catalogue the range is planned from. An experiment runs over an in-memory registry or a
   * throwaway database: its captures are wider than the watch universe, so they must never be
   * mixed into the accepted ranges of the default scope.
   */
  readonly pools: PoolRegistry;
}

export interface V4CaptureExperimentOutcome {
  /** The complete raw evidence the provider returned, before any classification. */
  readonly batch: RangeRecordingBatch;
  readonly result: V4ExperimentResult;
}

/** A V4 pool id is one 32-byte word; no other shape is read as a pool identity. */
const POOL_ID = /^0x[0-9a-f]{64}$/;

/**
 * The pool identity a manager log names when nothing this experiment knows answers to it.
 *
 * Only the shape is decided here: which topics are manager operation events, and how a known pool
 * is resolved from one, stay in `registry-dependencies.ts` and are reached through the view below.
 */
function unknownPoolId(log: RawLog, deployments: ProtocolDeployments): Hex | null {
  if (lower(log.address) !== deployments.v4Manager) return null;
  const topic = log.topics[0];
  const poolId = log.topics[1];
  if (topic === undefined || poolId === undefined || !isV4OperationTopic(topic)) return null;
  const lowered = lower(poolId);
  return POOL_ID.test(lowered) ? lowered : null;
}

/**
 * A read-only view over the pools one experiment knows, so classifying a log asks the same
 * registry-dependency rules the live batch asks rather than a second identity scheme.
 *
 * `revisionKey` is a constant: this view is built per capture and never claims to follow the
 * journal, so nothing may cache it as a position in the live registry.
 */
function catalogueView(records: readonly PoolRegistration[]): RegistryView {
  const byId = new Map<string, PoolRegistration>();
  const byV3 = new Map<string, PoolRegistration>();
  const byV4 = new Map<string, PoolRegistration>();
  const discovery = new Set<string>();
  for (const record of records) {
    byId.set(poolRegistrationId(record), record);
    if (record.pool.protocol === 'v3') byV3.set(lower(record.pool.address), record);
    else byV4.set(`${lower(record.pool.manager)}:${lower(record.pool.poolId)}`, record);
    discovery.add(rawLogKey(record.discoveredAt).toLowerCase());
  }
  return {
    get: (id) => byId.get(id),
    isDiscoveryRef: (key) => discovery.has(key.toLowerCase()),
    getByV3Address: (address) => byV3.get(lower(address)),
    getByV4Id: (manager, poolId) => byV4.get(`${lower(manager)}:${lower(poolId)}`),
    forAsset: function* (address) {
      const wanted = lower(address);
      for (const record of byId.values()) {
        if (lower(record.token0) === wanted || lower(record.token1) === wanted) yield record;
      }
    },
    all: function* () {
      yield* byId.values();
    },
    revisionKey: 'v4-capture-experiment',
  };
}

/** The catalogue a capture was planned from: the registry it holds plus what the round discovered. */
function knownCatalogue(
  pools: PoolRegistry,
  assetVersion: string,
  discovered: readonly PoolRegistration[],
): readonly PoolRegistration[] {
  const byId = new Map<string, PoolRegistration>();
  for (const registration of [...pools.snapshot(assetVersion), ...discovered])
    byId.set(poolRegistrationId(registration), registration);
  return [...byId.values()];
}

/**
 * Whether the requests this capture really made still asked for the watch targets, read from the
 * manifest's own leaves rather than from a re-planned guess.
 *
 * A `manager` request must be the whole manager universe — the manager address, the operation
 * topics and no pool-id narrowing — which includes every target by construction. A `pool-ids`
 * request must name every V4 pool the catalogue holds; asking for a pool discovered in the same
 * round is still asking for a target, so the planned values only have to contain the targets.
 */
function watchTargetsPlanned(
  batch: RangeRecordingBatch,
  mode: V4OperationMode,
  known: readonly PoolRegistration[],
  deployments: ProtocolDeployments,
): boolean {
  const requests = batch.manifest.shards
    .filter((shard) => shard.filterId === 'operation-v4')
    .map((shard) => shard.request);
  const targets = new Set(
    known.flatMap((registration) =>
      registration.pool.protocol === 'v4' ? [lower(registration.pool.poolId)] : [],
    ),
  );
  if (requests.length === 0) return mode === 'pool-ids' && targets.size === 0;

  const plannedTopics = new Set<string>();
  const plannedPoolIds = new Set<string>();
  for (const request of requests) {
    if (
      request.address.length !== 1 ||
      lower(request.address[0]!) !== deployments.v4Manager ||
      request.fromBlock < batch.fromBlock ||
      request.toBlock > batch.toBlock
    )
      return false;
    const topics = request.topics[0];
    if (topics === undefined || topics === null) return false;
    for (const topic of typeof topics === 'string' ? [topics] : topics)
      plannedTopics.add(lower(topic));
    const poolIds = request.topics[1];
    if (poolIds !== undefined && poolIds !== null) {
      for (const poolId of typeof poolIds === 'string' ? [poolIds] : poolIds)
        plannedPoolIds.add(lower(poolId));
    }
  }
  if (!v4OperationTopics.every((topic) => plannedTopics.has(lower(topic)))) return false;
  if (plannedTopics.size !== v4OperationTopics.length) return false;
  if (mode === 'manager') return plannedPoolIds.size === 0;
  return [...targets].every((poolId) => plannedPoolIds.has(poolId));
}

/**
 * One bounded V4 capture under an explicit operation strategy, plus the reasons it may or may not
 * be a live candidate.
 *
 * The capture itself is the production path: discovery first, then the batch's own operations
 * planned by `buildOperationFilterPlan`, fetched by `fetchBoundedLogs` with the same range splits,
 * guard, provider cap, retries and manifest — so a manager response that hits a limit is split and
 * an indivisible capped response fails the batch rather than passing as complete. Nothing here
 * filters a response before it is hashed or counted: the batch keeps the provider's whole answer,
 * and `watchedLogKeys`/`unknownLogKeys` are a reading of that evidence, not a replacement for it.
 *
 * `eligibleForLive` is deliberately narrow — complete capture, watch targets still planned, and no
 * log the known registry cannot explain. It says an offline candidate meets the conditions this
 * experiment can check; it is not a provider acceptance, and unknown pools keep it false rather
 * than being explained away.
 */
export async function runV4CaptureExperiment(
  reader: ChainReader,
  options: V4CaptureExperimentOptions,
): Promise<V4CaptureExperimentOutcome> {
  const { v4OperationMode, pools, ...range } = options;
  const observed = { requests: 0, responseBytes: 0 };
  const instrumented: ChainReader = {
    getAnchor: (block) => reader.getAnchor(block),
    getLogs: async (filter) => {
      observed.requests += 1;
      const logs = await reader.getLogs(filter);
      // The same bytes `fetchBoundedLogs` takes its response hash over, counted where they arrive.
      observed.responseBytes += Buffer.byteLength(encodeJson(logs), 'utf8');
      return logs;
    },
  };
  const batch = await fetchRange(instrumented, {
    ...range,
    mode: 'operations',
    pools,
    v4OperationMode,
  });

  const deployments: ProtocolDeployments = {
    v3Factory: lower(options.v3Factory),
    v4Manager: lower(options.v4Manager),
  };
  const known = knownCatalogue(pools, options.assets.version, batch.poolRegistrations ?? []);
  const view = catalogueView(known);
  const watchedLogKeys: string[] = [];
  const unknownLogKeys: string[] = [];
  for (const log of batch.logs) {
    const key = rawLogKey(log);
    if (
      view.isDiscoveryRef(key) ||
      referencedRegistrations([log], [], view, deployments).length > 0
    )
      watchedLogKeys.push(key);
    else if (unknownPoolId(log, deployments) !== null) unknownLogKeys.push(key);
  }
  watchedLogKeys.sort();
  unknownLogKeys.sort();

  const complete = batch.completeness === 'complete';
  const reasons: string[] = [];
  if (!complete) reasons.push('incomplete-capture');
  for (const kind of batch.recordingFailureKinds ?? []) reasons.push(`failure:${kind}`);
  if (unknownLogKeys.length > 0) reasons.push('unknown-pool-logs');
  if (!watchTargetsPlanned(batch, v4OperationMode, known, deployments))
    reasons.push('watch-target-mismatch');

  return {
    batch,
    result: {
      mode: v4OperationMode,
      complete,
      eligibleForLive: reasons.length === 0,
      reasons,
      watchedLogKeys,
      unknownLogKeys,
      requestCount: observed.requests,
      responseBytes: observed.responseBytes,
    },
  };
}
