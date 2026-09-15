import {
  refreshTokenMetadata,
  validateTokenMetadata,
  type TokenMetadataTarget,
} from '../storage/token-metadata.js';
import type { MetricInput } from '../storage/metric-store.js';
import { ConfigError } from '../config/env.js';
import type { SignalConfig } from '../signals/config.js';
import { loadMetricMetadata, type MetricMetadata } from '../metrics/metadata.js';
import { commitAcceptedSignalBatch, projectSignals, retractSignals } from '../signals/project.js';
import { LiveProjectionStore } from '../storage/live-projection.js';
import { AlertOutbox } from '../notify/outbox.js';
import { createConsoleSink } from '../notify/console.js';
import { createJsonlSink } from '../notify/jsonl.js';
import type { FollowStore } from '../ingest/follow.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { ChainConfig } from '../config/chain.js';
import type { RuntimeEnv } from '../config/env.js';
import { createChainReader } from '../rpc/client.js';
import { verifyIdentity } from '../registry/identity.js';
import { loadAssetVersion } from '../registry/assets.js';
import { PoolRegistry } from '../registry/pools.js';
import { countWork, openWorkCounts } from './work-counters.js';
import { BatchTimings } from './batch-timings.js';
import { buildDiscoveryFilterPlan, computeWatchScopeId } from '../ingest/filter-plan.js';
import {
  classifyDiscoveryFailures,
  discoveryRetryDelayMs,
  DiscoveryRecoveryStop,
  isCooperativeDiscoveryStop,
} from '../ingest/discovery-recovery.js';
import { fetchRange } from '../ingest/record-range.js';
import { follow } from '../ingest/follow.js';
import { warmupStart } from '../ingest/checkpoint.js';
import { findMatchingCheckpoint } from '../ingest/reorg.js';
import { resolveLogTimes } from '../ingest/log-time.js';
import { acceptedCoverage, missingIntervals } from './history.js';
import { openDatabase } from '../storage/database.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { rawLogKey, type RecordedRangeBatch } from '../storage/manifest.js';
import type { BlockAnchor, ChainReader, RangeChangeSet } from '../domain/types.js';
import { encodeJson } from '../domain/json.js';
import { RpcFailure, classifyRpcError } from '../rpc/errors.js';
import { saveJson } from './files.js';
import {
  createShutdownController,
  ShutdownRequested,
  type ShutdownController,
} from './shutdown.js';
import { RuntimeTelemetry } from './runtime-telemetry.js';
class RawSaveFailure extends Error {
  constructor(
    readonly phase: 'discovery' | 'operations',
    cause: unknown,
  ) {
    super('Raw save failed', { cause });
  }
}
function rawSaveStage(phase: RawSaveFailure['phase'], action: () => void): void {
  try {
    action();
  } catch (cause) {
    throw new RawSaveFailure(phase, cause);
  }
}
class SignalEvaluationFailure extends Error {
  constructor(
    readonly phase: 'startup' | 'accepted-batch' | 'recovery',
    cause: unknown,
  ) {
    super('Signal evaluation failed', { cause });
  }
}
function signalStage<T>(phase: SignalEvaluationFailure['phase'], action: () => T): T {
  try {
    return action();
  } catch (cause) {
    throw new SignalEvaluationFailure(phase, cause);
  }
}

const DISCOVERY_MAX_RECOVERY_RETRIES = 3;

function sameAnchor(left: BlockAnchor, right: BlockAnchor): boolean {
  return (
    left.number === right.number &&
    left.hash.toLowerCase() === right.hash.toLowerCase() &&
    left.timestampSec === right.timestampSec
  );
}

/** Convert persisted safe reasons to the small closed set understood by discovery recovery. */
function discoveryFailureKinds(batch: {
  recordingErrors: readonly string[];
  recordingFailureKinds?: readonly string[];
}): readonly string[] {
  if (batch.recordingFailureKinds !== undefined) return [...new Set(batch.recordingFailureKinds)];
  return [
    ...new Set(
      batch.recordingErrors.map((error) => {
        if (error === 'end-anchor-changed') return 'anchor-changed';
        if (error === 'end-block-log-hash-mismatch') return 'anchor-conflict';
        if (error.startsWith('end-anchor:')) return error.slice('end-anchor:'.length);
        if (error.startsWith('conflicting-log:')) return 'conflicting-log-identity';
        if (error.startsWith('mixed-block-hash:')) return 'conflicting-log-identity';
        if (error.startsWith('discovery-decode:')) return 'discovery-decode';
        if (error.startsWith('registry-plan:')) return 'registry-plan';
        return error;
      }),
    ),
  ];
}

export interface RecorderOptions {
  command: 'ingest' | 'follow';
  notify?: 'local';
  signalConfig?: SignalConfig;
  metricMetadata?: MetricMetadata;
  config: ChainConfig;
  env: RuntimeEnv;
  watchlistPath: string;
  databasePath: string;
  outputDirectory: string;
  fromBlock?: bigint;
  toBlock?: bigint;
  durationMs: number | null;
  maxCalls: number;
  evidenceMode: 'full' | 'sampled' | 'off';
  readerFactory?: typeof createChainReader;
  shutdown?: ShutdownController;
  /** Run only the fixed-target discovery/catalogue phase; skip operation follow. */
  catalogueOnly?: boolean;
  /** Fixed discovery target used by catalogueOnly; defaults to the startup anchor. */
  targetBlock?: bigint;
}
export async function runRecorder(options: RecorderOptions): Promise<number> {
  const { config, env } = options;
  const latestStart = options.command === 'follow' && options.fromBlock === undefined;
  if (
    options.notify !== undefined &&
    (options.notify !== 'local' ||
      options.command !== 'follow' ||
      !options.signalConfig ||
      !options.metricMetadata)
  )
    throw new ConfigError(
      'notify local requires follow and validated signal/metadata configuration',
    );
  const assets = loadAssetVersion(options.watchlistPath);
  const seedMetadata = options.metricMetadata ?? loadMetricMetadata('config/metric-metadata.json');
  const deployments = { v3Factory: config.v3Factory, v4Manager: config.v4Manager };
  const scopeId = computeWatchScopeId(assets, 'operations', deployments);
  const discoveryScope = computeWatchScopeId(assets, 'discovery-only', deployments);
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const out = resolve(options.outputDirectory, id);
  mkdirSync(out, { recursive: true });
  mkdirSync(dirname(options.databasePath), { recursive: true });
  const db = openDatabase(options.databasePath);
  const store = new SqliteRangeStore(db);
  const metricInput: MetricInput | null =
    options.notify === 'local' && options.metricMetadata
      ? {
          scopeId,
          registryScopeId: discoveryScope,
          configVersion: config.version,
          assets,
          usdg: config.tokens.USDG,
          metadata: options.metricMetadata,
        }
      : null;
  const outbox = new AlertOutbox(db);
  const fileSink = createJsonlSink(options.databasePath + '.alerts.jsonl');
  const consoleSink = createConsoleSink();
  const alertDelivery = { sent: 0, failed: 0, status: 'ok' as 'ok' | 'degraded' };
  const drain = async (retractionsOnly = false) => {
    if (options.notify !== 'local')
      return { sent: 0, failed: 0, deliveredAtMs: null as number | null };
    let deliveredAtMs: number | null = null;
    const delivered = await outbox.deliverPending(
      async (alert) => {
        await fileSink(alert);
        await consoleSink(alert);
        deliveredAtMs = Date.now();
      },
      scopeId,
      retractionsOnly ? 'retracted' : undefined,
    );
    alertDelivery.sent += delivered.sent;
    alertDelivery.failed += delivered.failed;
    if (delivered.failed > 0) alertDelivery.status = 'degraded';
    else if (delivered.sent > 0) alertDelivery.status = 'ok';
    if (delivered.sent > 0 || delivered.failed > 0)
      console.log(
        encodeJson({
          event: 'alert-delivery',
          runId: id,
          ...delivered,
          status: alertDelivery.status,
          retractionsOnly,
        }),
      );
    return { ...delivered, deliveredAtMs };
  };
  const recoveryContext = () => ({
    batchId: 'recovery-' + randomUUID(),
    observedAtMs: Date.now(),
    captureMode: 'live' as const,
  });
  const recover = (targetScope: string, anchor: BlockAnchor | null) =>
    db.transaction(() => {
      const changes = anchor
        ? store.invalidateAfter(targetScope, anchor)
        : store.resetForWarmup(targetScope);
      db.prepare('delete from token_metadata where block_number>?').run(
        Number(anchor?.number ?? -1n),
      );
      db.prepare('delete from token_metadata_failures').run();
      if (options.notify === 'local')
        signalStage('recovery', () =>
          retractSignals(
            db,
            scopeId,
            recoveryContext(),
            'scope-rechecking',
            // Registry revalidation follows; every active reminder is provisional again.
            0n,
          ),
        );
      return changes;
    })();
  const followStore: FollowStore = {
    acceptedTip: (scope) => store.acceptedTip(scope),
    checkpoints: (scope) => store.checkpoints(scope),
    invalidateAfter: (scope, anchor) => recover(scope, anchor),
    resetForWarmup: (scope) => recover(scope, null),
    pruneCheckpoints: (scope, min) => store.pruneCheckpoints(scope, min),
  };
  const startedAtMs = Date.now();
  const stopAtMs = startedAtMs + (options.durationMs ?? 3600000);
  // Stop admitting batches at the requested cutoff; let the current batch finish bounded RPC work.
  const rpcDrainDeadlineMs = stopAtMs + 30_000;
  const reader = (options.readerFactory ?? createChainReader)(env, {
    maxCalls: options.maxCalls,
    deadlineMs: rpcDrainDeadlineMs,
    perSecond: config.rpcPerSecond,
    maxConcurrentRpc: config.maxConcurrentRpc,
    maxBackfillRpcRps: config.maxBackfillRpcRps,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    evidenceMode: options.evidenceMode,
    evidenceFile: resolve(out, 'requests.jsonl'),
  });
  const shutdown = options.shutdown ?? createShutdownController();
  const telemetry = new RuntimeTelemetry({
    db,
    databasePath: options.databasePath,
    scopeId,
    sourceAlias: env.providerAlias,
    chainId: config.chainId,
    meter: reader.meter,
  });
  const counts = {
    endpointAnchors: 0,
    minuteAnchors: 0,
    warmupAnchors: 0,
    discoveryBatches: 0,
    operationBatches: 0,
  };
  // The open per-batch counter scope is tracked here so a batch that fails midway
  // cannot leave the process counting into a scope nobody will read.
  let batchWorkCounts: ReturnType<typeof openWorkCounts> | null = null;
  const closeBatchWorkCounts = () => batchWorkCounts?.close();
  const metered = (
    kind: keyof Pick<typeof counts, 'endpointAnchors' | 'minuteAnchors' | 'warmupAnchors'>,
  ): ChainReader => ({
    getAnchor: async (block) => {
      shutdown.throwIfRequested();
      counts[kind]++;
      const purpose =
        kind === 'minuteAnchors'
          ? 'minute-boundary'
          : kind === 'warmupAnchors'
            ? 'warmup-anchor'
            : 'endpoint-anchor';
      const work = () => reader.meter.withPurpose(purpose, () => reader.getAnchor(block));
      // Numeric anchors are historical acquisition, including recovery and minute searches.
      const anchor = await (block === 'latest' ? work() : reader.meter.withBackfill(work));
      if (block === 'latest') telemetry.observeHead(anchor);
      return anchor;
    },
    getLogs: (filter) => {
      shutdown.throwIfRequested();
      return reader.meter.withPurpose('logs', () => reader.getLogs(filter));
    },
  });
  const endpointReader = metered('endpointAnchors');
  const metadataReader = {
    getAnchor: (block: bigint | 'latest') => {
      shutdown.throwIfRequested();
      return reader.meter.withPurpose('metadata', () => reader.getAnchor(block));
    },
    request: (method: string, params: readonly unknown[]) => {
      shutdown.throwIfRequested();
      return reader.meter.withPurpose('metadata', () => reader.request(method, params));
    },
  };
  const refreshMetadata = async (targets: readonly TokenMetadataTarget[], maxTokens = 16) => {
    const update = await refreshTokenMetadata(db, metadataReader, targets, {
      maxTokens,
      seed: seedMetadata,
    });
    if (update.attempted)
      console.log(encodeJson({ event: 'token-metadata', runId: id, ...update }));
  };
  const batchRecords: {
    id: string;
    scopeId: string;
    fromBlock: bigint;
    toBlock: bigint;
    manifestHash: string;
    completeness: string;
    logs: number;
    accepted: boolean;
    failureKinds?: readonly string[];
    rpcAttempts?: number;
  }[] = [];
  const revisions: unknown[] = [];
  const result: {
    status: string;
    failures: string[];
    follow: unknown;
    identity: unknown;
    discoveryComplete: boolean;
    timingUnresolved: number;
    timingFailures: unknown[];
    localFailure: { category: 'raw-save'; phase: RawSaveFailure['phase'] } | null;
  } = {
    status: 'running',
    failures: [],
    follow: null,
    identity: null,
    discoveryComplete: false,
    timingUnresolved: 0,
    timingFailures: [],
    localFailure: null,
  };
  const recordChanges = (changes: RangeChangeSet, cause: string) => {
    if (cause !== 'range') telemetry.invalidateProjection();
    revisions.push({
      cause,
      added: changes.added.length,
      removed: changes.removed.length,
      retimed: changes.retimed.length,
      affectedFromBlock: changes.affectedFromBlock,
    });
  };
  let primary: unknown;
  let catalogueTarget: BlockAnchor | null = null;
  let catalogueFloor = 0n;
  let exitCode = 4;
  let catalogueTargetConflict: string | null = null;
  const discoveryCoverageEvidence = () =>
    acceptedCoverage(db, discoveryScope, (batch) =>
      buildDiscoveryFilterPlan(
        assets,
        deployments,
        batch.fromBlock,
        batch.toBlock,
        config.maxFilterValues,
      ),
    );
  const catalogueMissingSummary = (): {
    fromBlock: bigint;
    toBlock: bigint;
    reason: string;
  }[] => {
    if (catalogueTarget === null) return [];
    // Completion already verified coverage and the fixed target; skip a second scan.
    if (result.discoveryComplete && catalogueTargetConflict === null) return [];
    const gaps = missingIntervals(
      catalogueFloor,
      catalogueTarget.number,
      discoveryCoverageEvidence(),
    ).map(([fromBlock, toBlock]) => ({
      fromBlock,
      toBlock,
      reason: 'registry-coverage-missing',
    }));
    if (catalogueTargetConflict !== null)
      gaps.push({
        fromBlock: catalogueTarget.number,
        toBlock: catalogueTarget.number,
        reason: catalogueTargetConflict,
      });
    return gaps;
  };
  try {
    store.recordRun({
      id,
      scopeId,
      startedAtMs,
      finishedAtMs: null,
      status: 'running',
      payload: {
        chainId: config.chainId,
        assetVersion: assets.version,
        configVersion: config.version,
        sourceAlias: env.providerAlias,
      },
    });
    telemetry.transition('starting');
    // Retry only already-established withdrawals before any new RPC can fail.
    await drain(true);
    shutdown.throwIfRequested();
    const initial = await endpointReader.getAnchor('latest');
    if (options.targetBlock !== undefined) {
      if (options.targetBlock < 0n || options.targetBlock > initial.number)
        throw new ConfigError('Catalogue target must be within the observed head');
      catalogueTarget =
        options.targetBlock === initial.number
          ? initial
          : await endpointReader.getAnchor(options.targetBlock);
    } else catalogueTarget = initial;
    const identity = await reader.meter
      .withBackfill(() =>
        verifyIdentity(
          {
            ...reader,
            getAnchor: endpointReader.getAnchor,
            getLogs: endpointReader.getLogs,
            request: (method, params) => {
              shutdown.throwIfRequested();
              return reader.request(method, params);
            },
          },
          config,
          initial,
          { verifyDeployments: !latestStart },
        ),
      )
      .catch((error: unknown) => {
        shutdown.throwIfRequested();
        throw error;
      });
    result.identity = identity;
    shutdown.throwIfRequested();
    if (!identity.requiredPassed) throw new RpcFailure('identity-unverified');
    await validateTokenMetadata(db, metadataReader, seedMetadata);
    if (options.command === 'follow')
      await refreshMetadata(
        [config.tokens.USDG, ...assets.addresses].map((address) => ({
          address,
          blockNumber: initial.number,
        })),
        assets.addresses.length + 1,
      );
    const verifiedDeployments = [identity.deployments.v3Factory, identity.deployments.v4Manager];
    const floor = verifiedDeployments.every((d) => d.firstCodeBlock !== null)
      ? verifiedDeployments.reduce(
          (min, d) => (d.firstCodeBlock! < min ? d.firstCodeBlock! : min),
          initial.number,
        )
      : 0n;
    catalogueFloor = floor;
    const bootstrap = async (head: BlockAnchor): Promise<boolean> => {
      let tip = store.acceptedTip(discoveryScope);
      let from = tip ? tip.number + 1n : floor;
      let retryEnd: BlockAnchor | null = null;
      let consecutiveFailures = 0;
      let retriesForRange = 0;
      let missingRanges: [bigint, bigint][] = [];
      const noteFailure = (failure: string) => {
        if (!result.failures.includes(failure)) result.failures.push(failure);
      };
      const preflight = (): void => {
        shutdown.throwIfRequested();
        if (Date.now() >= stopAtMs) throw new DiscoveryRecoveryStop('deadline');
        if (reader.meter.remainingCalls !== null && reader.meter.remainingCalls < 1)
          throw new DiscoveryRecoveryStop('budget');
      };
      const preflightOrStop = (): boolean => {
        try {
          preflight();
          return true;
        } catch (error) {
          if (error instanceof DiscoveryRecoveryStop) {
            noteFailure('discovery:' + error.kind);
            return false;
          }
          throw error;
        }
      };
      const discoveryReader: ChainReader = {
        getAnchor: async (block) => {
          preflight();
          return endpointReader.getAnchor(block);
        },
        getLogs: async (filter) => {
          preflight();
          return endpointReader.getLogs(filter);
        },
      };
      const recheckAcceptedTip = async (): Promise<void> => {
        const saved = store.acceptedTip(discoveryScope);
        if (!saved) {
          tip = null;
          return;
        }
        const current = await discoveryReader.getAnchor(saved.number);
        if (sameAnchor(current, saved)) {
          tip = saved;
          return;
        }
        const match = await findMatchingCheckpoint(
          discoveryReader,
          store.checkpoints(discoveryScope),
        );
        if (match) recordChanges(recover(discoveryScope, match), 'discovery-reorg');
        else recordChanges(recover(discoveryScope, null), 'discovery-rebuild');
        // Invalidation is committed: withdrawals must survive registry outages.
        await drain(true);
        tip = store.acceptedTip(discoveryScope);
      };
      const waitForRetry = async (
        failureKinds: readonly string[],
        endNumber: bigint,
        rpcAttempts = 0,
        phase: 'batch' | 'anchor' = 'batch',
      ) => {
        if (retriesForRange >= DISCOVERY_MAX_RECOVERY_RETRIES) {
          noteFailure('discovery:retry-exhausted');
          return false;
        }
        retriesForRange++;
        consecutiveFailures++;
        if (!preflightOrStop()) return false;
        const delayMs = discoveryRetryDelayMs(consecutiveFailures);
        console.log(
          encodeJson({
            event: 'discovery-retry',
            state: 'waiting-retry',
            phase,
            fromBlock: from,
            toBlock: endNumber,
            attempt: retriesForRange,
            delayMs,
            failureKinds,
            rpcAttempts,
          }),
        );
        telemetry.transition('waiting-retry');
        const waitingAt = Date.now();
        await shutdown.wait(Math.min(delayMs, Math.max(0, stopAtMs - Date.now())));
        telemetry.addWait(Math.max(0, Date.now() - waitingAt));
        return preflightOrStop();
      };
      const refreshRetryAnchor = async (end: BlockAnchor): Promise<boolean> => {
        for (;;) {
          if (!preflightOrStop()) return false;
          const callsBefore = reader.meter.summary().calls;
          try {
            await recheckAcceptedTip();
            from = tip ? tip.number + 1n : floor;
            retryEnd = await discoveryReader.getAnchor(end.number);
            return true;
          } catch (error) {
            if (error instanceof DiscoveryRecoveryStop) {
              noteFailure('discovery:' + error.kind);
              return false;
            }
            const failure = classifyRpcError(error);
            const action = classifyDiscoveryFailures([failure.kind]);
            if (action === 'retry') {
              noteFailure('discovery:' + failure.kind);
              const rpcAttempts = reader.meter.summary().calls - callsBefore;
              if (!(await waitForRetry([failure.kind], end.number, rpcAttempts, 'anchor')))
                return false;
              continue;
            }
            if (action === 'stop') {
              noteFailure('discovery:' + failure.kind);
              return false;
            }
            throw error;
          }
        }
      };

      const withRecovery = async <T>(
        step: () => Promise<T>,
        endNumber: bigint,
        phase: 'batch' | 'anchor',
      ): Promise<T | null> => {
        for (;;) {
          if (!preflightOrStop()) return null;
          const callsBefore = reader.meter.summary().calls;
          try {
            return await step();
          } catch (error) {
            if (error instanceof DiscoveryRecoveryStop) {
              noteFailure('discovery:' + error.kind);
              return null;
            }
            const failure = classifyRpcError(error);
            const action = classifyDiscoveryFailures([failure.kind]);
            const rpcAttempts = reader.meter.summary().calls - callsBefore;
            if (action === 'stop') {
              noteFailure('discovery:' + failure.kind);
              return null;
            }
            if (action !== 'retry') throw error;
            noteFailure('discovery:' + failure.kind);
            if (!(await waitForRetry([failure.kind], endNumber, rpcAttempts, phase))) return null;
          }
        }
      };
      const verifiedCoverage = () =>
        acceptedCoverage(db, discoveryScope, (batch) =>
          buildDiscoveryFilterPlan(
            assets,
            deployments,
            batch.fromBlock,
            batch.toBlock,
            config.maxFilterValues,
          ),
        );
      const recomputeMissing = (): void => {
        missingRanges = missingIntervals(floor, head.number, verifiedCoverage());
      };
      const fetchEndAnchor = async (endNumber: bigint): Promise<BlockAnchor | null> =>
        withRecovery(
          async () => {
            const pending = retryEnd;
            retryEnd = null;
            return (
              pending ??
              (endNumber < head.number ? await discoveryReader.getAnchor(endNumber) : head)
            );
          },
          endNumber,
          'anchor',
        );
      /** A confirmation failure means the accepted catalogue no longer belongs to
       * the fixed target branch. `reset` is required when the declared target block
       * itself disappeared: an ancestor rewind could keep evidence fetched from a
       * different branch, so the whole catalogue scope is invalidated instead. */
      const invalidateStaleCatalogue = async (reset: boolean): Promise<void> => {
        const match = reset
          ? null
          : await findMatchingCheckpoint(discoveryReader, store.checkpoints(discoveryScope));
        if (match) recordChanges(recover(discoveryScope, match), 'discovery-reorg');
        else recordChanges(recover(discoveryScope, null), 'discovery-rebuild');
        // Invalidation is committed: withdrawals must survive provider outages.
        await drain(true);
      };
      const confirmTargetOnce = async (): Promise<boolean> => {
        recomputeMissing();
        if (missingRanges.length > 0) return false;
        const accepted = store.acceptedTip(discoveryScope);
        if (!accepted || accepted.number < head.number) return false;
        const chainTarget = await discoveryReader.getAnchor(head.number);
        if (!sameAnchor(chainTarget, head)) {
          noteFailure('discovery:target-anchor-changed');
          catalogueTargetConflict = 'target-anchor-changed';
          await invalidateStaleCatalogue(true);
          return false;
        }
        const chainTip = await discoveryReader.getAnchor(accepted.number);
        if (!sameAnchor(chainTip, accepted)) {
          noteFailure('discovery:accepted-tip-changed');
          await invalidateStaleCatalogue(false);
          return false;
        }
        if (accepted.number === head.number && !sameAnchor(accepted, head)) {
          noteFailure('discovery:target-anchor-conflict');
          catalogueTargetConflict = 'target-anchor-conflict';
          await invalidateStaleCatalogue(true);
          return false;
        }
        return true;
      };

      const rechecked = await withRecovery(
        async () => {
          await recheckAcceptedTip();
          return true;
        },
        head.number,
        'anchor',
      );
      if (rechecked === null) return false;
      // A legal database can hold accepted tail ranges whose prefix was never proven.
      // The accepted cursor cannot be advanced over an uncovered interval, so the
      // scope is rebuilt from the verified deployment floor before refetching.
      recomputeMissing();
      if (
        missingRanges.length > 0 &&
        tip !== null &&
        (missingRanges[0]![0] <= tip.number || missingRanges[0]![0] > tip.number + 1n)
      ) {
        recordChanges(recover(discoveryScope, null), 'discovery-rebuild');
        await drain(true);
        tip = store.acceptedTip(discoveryScope);
        recomputeMissing();
      }
      from = tip ? tip.number + 1n : floor;
      let gapIndex = 0;
      while (gapIndex < missingRanges.length) {
        const gap = missingRanges[gapIndex]!;
        if (from < gap[0]) from = gap[0];
        if (from > gap[1]) {
          gapIndex++;
          continue;
        }
        if (from > head.number) break;
        if (!preflightOrStop()) return false;
        const top = from + BigInt(config.discoveryMaxRangeBlocks) - 1n;
        const capped = top < gap[1] ? top : gap[1];
        const endNumber = capped < head.number ? capped : head.number;
        const end = await fetchEndAnchor(endNumber);
        if (end === null) return false;
        // The fixed target block must keep the hash it was declared with. A
        // substitute branch at the same height cannot satisfy completion and must
        // not leave the withdrawn catalogue reusable either.
        if (end.number === head.number && !sameAnchor(end, head)) {
          noteFailure('discovery:target-anchor-changed');
          catalogueTargetConflict = 'target-anchor-changed';
          await invalidateStaleCatalogue(true);
          return false;
        }
        const callsBefore = reader.meter.summary().calls;
        let batch: Awaited<ReturnType<typeof fetchRange>>;
        try {
          batch = await fetchRange(discoveryReader, {
            mode: 'discovery-only',
            fromBlock: from,
            toBlock: end.number,
            end,
            previous: tip,
            assets,
            pools: new PoolRegistry(store.pools(discoveryScope)),
            ...deployments,
            logResponseGuard: config.logResponseGuard,
            maxLogsPerResponse: config.maxLogsPerResponse,
            maxFilterValues: config.maxFilterValues,
            discoveryMaxRangeBlocks: config.discoveryMaxRangeBlocks,
            observedAtMs: Date.now(),
            captureMode: 'backfill',
          });
        } catch (error) {
          if (error instanceof DiscoveryRecoveryStop) {
            noteFailure('discovery:' + error.kind);
            return false;
          }
          throw error;
        }
        const rpcAttempts = reader.meter.summary().calls - callsBefore;
        rawSaveStage('discovery', () => store.saveRaw(batch, { compact: true }));
        const failureKinds = discoveryFailureKinds(batch);
        batchRecords.push({
          id: batch.id,
          scopeId: batch.scopeId,
          fromBlock: from,
          toBlock: end.number,
          manifestHash: batch.manifestHash,
          completeness: batch.completeness,
          logs: batch.logs.length,
          accepted: false,
          failureKinds,
          rpcAttempts,
        });
        saveJson(resolve(out, 'discovery-' + batch.id + '.json'), batch, out);
        if (batch.completeness !== 'complete') {
          for (const kind of failureKinds) noteFailure('discovery:' + kind);
          const action = classifyDiscoveryFailures(failureKinds);
          if (action === 'retry') {
            if (!(await waitForRetry(failureKinds, end.number, rpcAttempts))) return false;
            if (
              failureKinds.some((kind) => kind === 'anchor-changed' || kind === 'anchor-conflict')
            ) {
              if (!(await refreshRetryAnchor(end))) return false;
              // Branches may have been invalidated by the recheck; re-derive the gaps.
              recomputeMissing();
              gapIndex = missingRanges.findIndex(([, gapTo]) => gapTo >= from);
              if (gapIndex === -1) gapIndex = missingRanges.length;
            }
            continue;
          }
          if (action === 'stop' || isCooperativeDiscoveryStop(failureKinds)) return false;
          throw new RpcFailure(failureKinds[0] ?? 'discovery-incomplete');
        }

        consecutiveFailures = 0;
        retriesForRange = 0;
        await reader.flush?.();
        shutdown.throwIfRequested();
        store.acceptRange(batch);
        batchRecords.at(-1)!.accepted = true;
        counts.discoveryBatches++;
        tip = end;
        from = end.number + 1n;
      }
      // The final confirmation shares the same bounded, interruptible recovery as
      // the rest of the discovery phase instead of turning a transient read into
      // an unrecoverable end of the run.
      const confirmed = await withRecovery(confirmTargetOnce, head.number, 'anchor');
      return confirmed === true;
    };
    telemetry.setPhase(latestStart ? 'steady' : 'backfill');
    result.discoveryComplete = latestStart
      ? false
      : await reader.meter.withPurpose('backfill', () => bootstrap(catalogueTarget!));
    Object.assign(result, {
      startMode: latestStart ? 'latest' : 'historical',
      liveStartBlock: latestStart ? initial.number : null,
      registryCoverage: latestStart ? 'known-pools-only' : 'historical-discovery',
    });
    if (latestStart)
      console.log(
        encodeJson({
          event: 'live-start',
          block: initial.number,
          registryCoverage: 'known-pools-only',
          message: '从启动时最新块采集；复用本地池登记并发现新池，未登记老池覆盖未知，不补历史。',
        }),
      );
    shutdown.throwIfRequested();
    if (options.catalogueOnly) {
      result.status = result.discoveryComplete ? 'complete' : 'incomplete';
      exitCode = result.discoveryComplete ? 0 : 4;
    } else if (!latestStart && !result.discoveryComplete) {
      result.status = 'incomplete';
    } else {
      // Verify the operation checkpoint before delivering a persisted backlog.
      // This also reconciles config/source changes when no new range is available.
      const priorTip = store.acceptedTip(scopeId);
      if (metricInput && options.signalConfig && priorTip) {
        const current = await endpointReader.getAnchor(priorTip.number);
        const latest = await endpointReader.getAnchor('latest');
        if (
          current.hash.toLowerCase() === priorTip.hash.toLowerCase() &&
          current.timestampSec === priorTip.timestampSec &&
          latest.number === priorTip.number &&
          latest.hash.toLowerCase() === priorTip.hash.toLowerCase() &&
          latest.timestampSec === priorTip.timestampSec
        ) {
          signalStage('startup', () =>
            db.transaction(() => {
              const liveChanges = new LiveProjectionStore(db).sync(
                scopeId,
                discoveryScope,
                config.version,
              );
              projectSignals(
                db,
                metricInput,
                options.signalConfig!,
                {
                  ...recoveryContext(),
                  captureMode: 'live',
                },
                liveChanges,
              );
            })(),
          );
          telemetry.markProjectionFresh();
          await drain();
        }
      }
      const start =
        options.fromBlock ??
        (latestStart
          ? initial.number
          : store.acceptedTip(scopeId)?.number !== undefined
            ? 0n
            : await warmupStart(metered('warmupAnchors'), initial, floor, config.warmupMinutes));
      const followResult = await follow(endpointReader, followStore, stopAtMs, {
        scopeId,
        startBlock: start,
        recoverAtHead: latestStart,
        ...(options.toBlock === undefined ? {} : { toBlock: options.toBlock }),
        oneShot: options.command === 'ingest',
        pollIntervalMs: config.pollIntervalMs,
        maxRangeBlocks: config.maxRangeBlocks,
        overlapBlocks: config.overlapBlocks,
        warmupMinutes: config.warmupMinutes,
        checkpointRetentionMinutes: config.checkpointRetentionMinutes,
        deploymentFloor: floor,
        shouldStop: () => shutdown.requested,
        sleep: (ms) => shutdown.wait(ms),
        onWait: (ms) => telemetry.addWait(ms),
        onStateChange: (state) => {
          if (telemetry.transition(state))
            console.log(encodeJson({ event: 'health-change', runId: id, state }));
        },
        onFailure: () => telemetry.sample(null),
        onResult: (partial) => {
          result.follow = partial;
          result.failures.push(...partial.failures);
        },
        onChanges: recordChanges,
        onRecovery: async () => {
          await drain(true);
          if (latestStart) return;
          // Revalidate historical registry evidence before applying a new branch.
          const head = await endpointReader.getAnchor('latest');
          telemetry.setPhase('backfill');
          if (!(await reader.meter.withPurpose('backfill', () => bootstrap(head))))
            throw new RpcFailure('discovery-incomplete');
        },
        recordRange: async (from, end, previous, head, acquisitionStartedAtMs) => {
          shutdown.throwIfRequested();
          const phase =
            options.command === 'ingest' || end.number !== head.number || end.hash !== head.hash
              ? 'backfill'
              : 'steady';
          telemetry.setPhase(phase);
          telemetry.sample(null);
          const acquisitionAt = acquisitionStartedAtMs;
          // Stage timings and structural counts cover exactly this one batch, so a
          // per-batch log line can explain the batch instead of re-reading the run.
          const timings = new BatchTimings();
          const workCounts = (batchWorkCounts = openWorkCounts());
          const pools = timings.measure(
            'registry',
            () => new PoolRegistry([...store.pools(discoveryScope), ...store.pools(scopeId)]),
          );
          // The acquisition stage wraps the fetch alone; rpcAcquisitionMs below keeps
          // its legacy wider window so existing reports stay comparable.
          const batch = await timings.measureAsync('rpcAcquisition', () =>
            reader.meter.withPurpose(phase === 'backfill' ? 'backfill' : 'logs', () =>
              fetchRange(endpointReader, {
                mode: 'operations',
                fromBlock: from,
                toBlock: end.number,
                end,
                previous,
                assets,
                pools,
                ...deployments,
                logResponseGuard: config.logResponseGuard,
                maxLogsPerResponse: config.maxLogsPerResponse,
                maxFilterValues: config.maxFilterValues,
                maxRangeBlocks: config.maxRangeBlocks,
                observedAtMs: Date.now(),
                captureMode:
                  options.command === 'ingest' ||
                  end.number !== head.number ||
                  end.hash !== head.hash
                    ? 'backfill'
                    : 'live',
              }),
            ),
          );
          const rawWriteAt = Date.now();
          rawSaveStage('operations', () =>
            timings.measure('rawPersist', () => store.saveRaw(batch, { compact: true })),
          );
          const rawWriteMs = Date.now() - rawWriteAt;
          if (shutdown.requested) {
            timings.measure('artifactPersist', () =>
              saveJson(resolve(out, 'range-' + batch.id + '.json'), batch, out),
            );
            batchRecords.push({
              id: batch.id,
              scopeId: batch.scopeId,
              fromBlock: from,
              toBlock: end.number,
              manifestHash: batch.manifestHash,
              completeness: batch.completeness,
              logs: batch.logs.length,
              accepted: false,
            });
            shutdown.throwIfRequested();
          }
          const liveTimeHistoryMinutes = Math.min(
            10080,
            Math.max(
              180,
              (options.signalConfig?.candidate.samples ?? 0) + 10,
              (options.signalConfig?.confirmRelative.samples ?? 0) * 5 + 10,
              (options.signalConfig?.cooling.buckets ?? 0) * 5 + 10,
            ) + 2,
          );
          const timeContext = timings.measure('coverage', () =>
            store.liveTimeContext(scopeId, from, end, liveTimeHistoryMinutes),
          );
          const allLogs = [
            ...new Map(
              [...timeContext.unresolved, ...batch.logs].map((log) => [rawLogKey(log), log]),
            ).values(),
          ];
          const timeFrom = allLogs.reduce(
            (min, log) => (log.blockNumber < min ? log.blockNumber : min),
            timeContext.retryFromBlock,
          );
          let timed: RecordedRangeBatch = batch;
          let timingFailures: readonly unknown[] = [];
          if (batch.completeness === 'complete') {
            const resolution = await timings.measureAsync('coverage', () =>
              resolveLogTimes(
                metered('minuteAnchors'),
                allLogs,
                timeFrom,
                end,
                timeContext.anchors,
                timeContext.boundaries,
              ),
            );
            timingFailures = resolution.failures;
            result.timingFailures.push(
              ...resolution.failures.map((failure) => ({ batchId: batch.id, ...failure })),
            );
            timed = {
              ...batch,
              anchors: [end, ...resolution.queriedAnchors],
              boundaries: resolution.boundaries,
              logTimes: allLogs.map((log) => ({
                ref: log,
                time: resolution.times.get(rawLogKey(log))!,
              })),
            };
            result.timingUnresolved = timed.logTimes!.filter(
              (item) => item.time.source === 'unresolved',
            ).length;
          }
          const completeEvidenceAtMs =
            batch.completeness === 'complete' && result.timingUnresolved === 0 ? Date.now() : null;
          const rpcAcquisitionMs = Date.now() - acquisitionAt;
          timings.measure('artifactPersist', () =>
            saveJson(
              resolve(out, 'range-' + batch.id + '.json'),
              { ...timed, timingFailures },
              out,
            ),
          );
          batchRecords.push({
            id: batch.id,
            scopeId: batch.scopeId,
            fromBlock: from,
            toBlock: end.number,
            manifestHash: batch.manifestHash,
            completeness: batch.completeness,
            logs: batch.logs.length,
            accepted: false,
          });
          if (batch.completeness !== 'complete') {
            workCounts.close();
            return null;
          }
          if (batch.completeness === 'complete') {
            const registered = timings.measure('registry', () =>
              new PoolRegistry([
                ...pools.snapshot(),
                ...(batch.poolRegistrations ?? []),
              ]).snapshot(),
            );
            const targets: TokenMetadataTarget[] = [
              { address: config.tokens.USDG, blockNumber: from },
            ];
            // A new pool may contain a token deployed after the range start.
            for (const pool of registered) {
              const height =
                pool.discoveredAt.blockNumber > from ? pool.discoveredAt.blockNumber : from;
              if (height <= end.number)
                for (const address of [pool.token0, pool.token1])
                  targets.push({ address, blockNumber: height });
            }
            countWork('metadataCandidates', targets.length);
            await refreshMetadata(targets);
          }

          await timings.measureAsync('commitOther', async () => reader.flush?.());
          shutdown.throwIfRequested();
          const commitAt = Date.now();
          const changes =
            metricInput && options.signalConfig
              ? signalStage('accepted-batch', () =>
                  commitAcceptedSignalBatch(db, metricInput, options.signalConfig!, timed, {
                    startNewSegment: latestStart && from === start,
                    timings,
                  }),
                ).changes
              : store.acceptRange(timed, { startNewSegment: latestStart && from === start });
          const outboxDurableAtMs = metricInput ? Date.now() : null;
          const writeLatencyMs = rawWriteMs + Date.now() - commitAt;
          if (metricInput) telemetry.markProjectionFresh();
          const processingLatencyMs =
            completeEvidenceAtMs !== null && outboxDurableAtMs !== null
              ? outboxDurableAtMs - completeEvidenceAtMs
              : null;
          if (processingLatencyMs !== null) reader.meter.recordProcessing(processingLatencyMs);
          const delivery = await timings.measureAsync('notify', () =>
            drain(batch.captureMode !== 'live'),
          );
          const localProcessingMs = processingLatencyMs;
          const headObservedAgeMs =
            telemetry.headObservedAtMs === null ? null : Date.now() - telemetry.headObservedAtMs;
          // Wall-clock age of the data this batch accepted, next to the stage
          // breakdown, so a fast batch on stale data cannot look healthy.
          const acceptedDataAgeMs =
            end.timestampSec > 0 ? Math.max(0, Date.now() - end.timestampSec * 1000) : null;
          telemetry.batchTimings.push({
            phase,
            batchId: batch.id,
            fromBlock: from,
            toBlock: end.number,
            logs: batch.logs.length,
            rpcAcquisitionMs,
            completeEvidenceAtMs,
            outboxDurableAtMs,
            acquisitionStartedAtMs: acquisitionAt,
            headObservedAtMs: telemetry.headObservedAtMs,
            notifyAttemptCompletedAtMs: metricInput ? Date.now() : null,
            deliveredAtMs: delivery.deliveredAtMs,
            writeLatencyMs,
            processingLatencyMs,
            headAcquisitionLagMs:
              head.timestampSec > 0 ? Math.max(0, acquisitionAt - head.timestampSec * 1000) : null,
            stageMs: timings.snapshot(),
            localProcessingMs,
            headObservedAgeMs,
            acceptedDataAgeMs,
            counts: { ...workCounts.counts },
          });
          workCounts.close();
          // Per-batch line: stages, real structural counts and data ages only. No
          // endpoint URL, credential or full catalogue ever reaches this log.
          console.log(
            encodeJson({
              event: 'batch-timing',
              runId: id,
              batchId: batch.id,
              phase,
              captureMode: batch.captureMode,
              fromBlock: from,
              toBlock: end.number,
              logs: batch.logs.length,
              rpcAcquisitionMs,
              writeLatencyMs,
              localProcessingMs,
              headObservedAgeMs,
              acceptedDataAgeMs,
              stageMs: timings.snapshot(),
              counts: workCounts.counts,
            }),
          );
          batchRecords.at(-1)!.accepted = true;
          counts.operationBatches++;
          telemetry.sample(null);
          return changes;
        },
        onProgress: (health) => {
          const runtimeHealth = telemetry.sample(
            health.coverage === 'gap' ? true : health.coverage === 'complete' ? false : null,
          );
          console.log(
            encodeJson({
              event: 'progress',
              runId: id,
              health,
              runtimeHealth,
              counts,
              alertDelivery,
              meter: reader.meter.summary(),
            }),
          );
        },
      });
      result.follow = followResult;
      result.status =
        followResult.complete && counts.operationBatches > 0 ? 'complete' : 'incomplete';
      if (shutdown.requested) result.status = 'stopped';
      else if (
        !followResult.complete &&
        Date.now() >= stopAtMs &&
        followResult.failures.length === 0
      )
        result.failures.push('duration-ended-with-backlog');
      exitCode = ['complete', 'stopped'].includes(result.status) ? 0 : 4;
    }
  } catch (error) {
    primary = error;
    result.status = 'failed';
    if (error instanceof ShutdownRequested) {
      result.status = 'stopped';
    } else if (error instanceof RawSaveFailure) {
      result.failures.push('raw-save');
      result.localFailure = { category: 'raw-save', phase: error.phase };
      console.error(encodeJson({ event: 'raw-save-failure', ...result.localFailure }));
    } else if (error instanceof SignalEvaluationFailure) {
      result.failures.push('signal-evaluation');
      console.error(
        encodeJson({
          event: 'signal-evaluation-failure',
          phase: error.phase,
          atomicRollback: true,
          rawEvidenceRetained: true,
        }),
      );
    } else result.failures.push(error instanceof RpcFailure ? error.kind : 'local-error');
    exitCode =
      error instanceof ShutdownRequested
        ? 0
        : error instanceof RpcFailure
          ? ['budget', 'deadline'].includes(error.kind)
            ? 4
            : 3
          : 1;
  } finally {
    closeBatchWorkCounts();
    try {
      await reader.close?.();
    } catch (error) {
      const failure = classifyRpcError(error);
      result.failures.push(error instanceof RpcFailure ? failure.kind : 'local-error');
      result.status = 'failed';
      if (primary instanceof RpcFailure && primary !== error) primary.evidenceFailure ??= failure;
      if (!primary) {
        primary = error;
        exitCode = error instanceof RpcFailure ? 3 : 1;
      }
    }
    let measurements: ReturnType<RuntimeTelemetry['finish']> | null = null;
    try {
      telemetry.transition(result.status === 'failed' ? 'failed' : result.status);
      measurements = telemetry.finish();
      saveJson(resolve(out, 'ops-report.json'), measurements.report, out);
    } catch {
      result.failures.push('runtime-report-write');
      result.status = 'failed';
      if (exitCode === 0) exitCode = 1;
    }
    const summary = {
      version: 1,
      runId: id,
      chainId: config.chainId,
      scopeId,
      discoveryScope,
      sourceAlias: env.providerAlias,
      startedAtMs,
      finishedAtMs: Date.now(),
      configVersion: config.version,
      assetVersion: assets.version,
      configurationHash: createHash('sha256').update(encodeJson(config)).digest('hex'),
      finality: 'provisional',
      coverageAssumption: 'RPC filter contract; no independent chain verification',
      maxLogsPerResponse: config.maxLogsPerResponse,
      maxFilterValues: config.maxFilterValues,
      logResponseGuard: config.logResponseGuard,
      ...result,
      alertDelivery,
      counts,
      meter: reader.meter.summary(),
      acceptedTip: store.acceptedTip(scopeId),
      batches: batchRecords,
      revisions,
      evidenceMode: options.evidenceMode,
      stopReason:
        shutdown.reason ??
        (result.status !== 'failed' && Date.now() >= stopAtMs ? 'duration' : null),
      requestedDurationMs: options.durationMs,
      stopAtMs,
      rpcDrainDeadlineMs,
      telemetry: measurements,
      catalogue: options.catalogueOnly
        ? {
            targetAnchor: catalogueTarget,
            acceptedTip: store.acceptedTip(discoveryScope),
            missing: catalogueMissingSummary(),
            sourceHash: createHash('sha256')
              .update(
                encodeJson({
                  chainId: assets.chainId,
                  version: assets.version,
                  assets: assets.assets,
                }),
              )
              .digest('hex'),
            protocolVersion: 'uniswap-v3+uniswap-v4@1',
            excluded: ['pons-v2-curves', 'other-dexes'],
            providerCompletenessAssumption:
              'Complete means all declared V3 Factory/V4 Manager discovery filters returned complete, hash-checked ranges through the fixed target anchor; the public RPC filter is not independently verified.',
          }
        : null,
      replayInputs:
        options.notify === 'local'
          ? {
              signalConfig: options.signalConfig,
              metricMetadata: options.metricMetadata,
              chainConfig: config,
              assets,
              order:
                'batches and revisions are separately ordered; cross-stream revision order unavailable',
            }
          : null,
    };
    const persistFinalRun = () => {
      try {
        store.recordRun({
          id,
          scopeId,
          startedAtMs,
          finishedAtMs: Date.now(),
          status: result.status,
          payload: summary,
        });
      } catch {
        if (!result.failures.includes('run-record-write')) result.failures.push('run-record-write');
        result.status = summary.status = 'failed';
        if (exitCode === 0) exitCode = 1;
      }
    };
    try {
      persistFinalRun();
      let manifest: string | null = resolve(out, 'manifest.json');
      try {
        saveJson(manifest, summary, out);
      } catch {
        result.failures.push('manifest-write');
        result.status = summary.status = 'failed';
        if (exitCode === 0) exitCode = 1;
        if (primary instanceof RpcFailure)
          primary.evidenceFailure ??= new RpcFailure('manifest-write');
        manifest = null;
        // The database may still be writable when only the output path failed.
        persistFinalRun();
        console.error(
          encodeJson({ event: 'evidence-failure', failure: 'manifest-write', exitCode }),
        );
      }
      console.log(
        encodeJson({
          event: 'finished',
          manifest,
          status: result.status,
          exitCode,
          counts,
          failures: result.failures,
          alertDelivery,
          meter: reader.meter.summary(),
        }),
      );
    } finally {
      try {
        db.close();
      } finally {
        if (!options.shutdown) shutdown.dispose();
      }
    }
  }
  return exitCode;
}
