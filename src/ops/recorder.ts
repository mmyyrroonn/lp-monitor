import { ConfigError } from '../config/env.js';
import type { SignalConfig } from '../signals/config.js';
import type { MetricMetadata } from '../metrics/metadata.js';
import { commitAcceptedSignalBatch, projectSignals, retractSignals } from '../signals/project.js';
import { SqliteProjectionStore } from '../storage/projection-store.js';
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
import { computeWatchScopeId } from '../ingest/filter-plan.js';
import { fetchRange } from '../ingest/record-range.js';
import { follow } from '../ingest/follow.js';
import { warmupStart } from '../ingest/checkpoint.js';
import { findMatchingCheckpoint } from '../ingest/reorg.js';
import { resolveLogTimes } from '../ingest/log-time.js';
import { openDatabase } from '../storage/database.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { rawLogKey, type RecordedRangeBatch } from '../storage/manifest.js';
import type { BlockAnchor, ChainReader, RangeChangeSet } from '../domain/types.js';
import { encodeJson } from '../domain/json.js';
import { RpcFailure, classifyRpcError } from '../rpc/errors.js';
import { saveJson } from './files.js';
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
}
export async function runRecorder(options: RecorderOptions): Promise<number> {
  const { config, env } = options;
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
  const deployments = { v3Factory: config.v3Factory, v4Manager: config.v4Manager };
  const scopeId = computeWatchScopeId(assets, 'operations', deployments);
  const discoveryScope = computeWatchScopeId(assets, 'discovery-only', deployments);
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const out = resolve(options.outputDirectory, id);
  mkdirSync(out, { recursive: true });
  mkdirSync(dirname(options.databasePath), { recursive: true });
  const db = openDatabase(options.databasePath);
  const store = new SqliteRangeStore(db);
  const metricInput = {
    scopeId,
    registryScopeId: discoveryScope,
    configVersion: config.version,
    assets,
    usdg: config.tokens.USDG,
    metadata: options.metricMetadata!,
  };
  const outbox = new AlertOutbox(db);
  const fileSink = createJsonlSink(options.databasePath + '.alerts.jsonl');
  const consoleSink = createConsoleSink();
  const drain = async (retractionsOnly = false) => {
    if (options.notify !== 'local') return;
    await outbox.deliverPending(
      async (alert) => {
        await fileSink(alert);
        await consoleSink(alert);
      },
      scopeId,
      retractionsOnly ? 'retracted' : undefined,
    );
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
      if (options.notify === 'local')
        retractSignals(
          db,
          scopeId,
          recoveryContext(),
          'scope-rechecking',
          // Registry revalidation follows; every active reminder is provisional again.
          0n,
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
  const reader = (options.readerFactory ?? createChainReader)(env, {
    maxCalls: options.maxCalls,
    deadlineMs: stopAtMs,
    perSecond: config.rpcPerSecond,
    maxConcurrentRpc: config.maxConcurrentRpc,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    evidenceMode: options.evidenceMode,
    evidenceFile: resolve(out, 'requests.jsonl'),
  });
  const counts = {
    endpointAnchors: 0,
    minuteAnchors: 0,
    warmupAnchors: 0,
    discoveryBatches: 0,
    operationBatches: 0,
  };
  const metered = (
    kind: keyof Pick<typeof counts, 'endpointAnchors' | 'minuteAnchors' | 'warmupAnchors'>,
  ): ChainReader => ({
    getAnchor: async (block) => {
      counts[kind]++;
      return reader.getAnchor(block);
    },
    getLogs: (filter) => reader.getLogs(filter),
  });
  const endpointReader = metered('endpointAnchors');
  const batchRecords: {
    id: string;
    scopeId: string;
    fromBlock: bigint;
    toBlock: bigint;
    manifestHash: string;
    completeness: string;
    logs: number;
    accepted: boolean;
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
  } = {
    status: 'running',
    failures: [],
    follow: null,
    identity: null,
    discoveryComplete: false,
    timingUnresolved: 0,
    timingFailures: [],
  };
  const recordChanges = (changes: RangeChangeSet, cause: string) => {
    revisions.push({
      cause,
      added: changes.added.length,
      removed: changes.removed.length,
      retimed: changes.retimed.length,
      affectedFromBlock: changes.affectedFromBlock,
    });
  };
  let primary: unknown;
  let exitCode = 4;
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
    // Retry only already-established withdrawals before any new RPC can fail.
    await drain(true);
    const initial = await endpointReader.getAnchor('latest');
    const identity = await verifyIdentity(reader, config, initial);
    result.identity = identity;
    if (!identity.requiredPassed) throw new RpcFailure('identity-unverified');
    const verifiedDeployments = [identity.deployments.v3Factory, identity.deployments.v4Manager];
    const floor = verifiedDeployments.every((d) => d.firstCodeBlock !== null)
      ? verifiedDeployments.reduce(
          (min, d) => (d.firstCodeBlock! < min ? d.firstCodeBlock! : min),
          initial.number,
        )
      : 0n;
    const bootstrap = async (head: BlockAnchor): Promise<boolean> => {
      let tip = store.acceptedTip(discoveryScope);
      if (tip) {
        const current = await endpointReader.getAnchor(tip.number);
        if (
          current.hash.toLowerCase() !== tip.hash.toLowerCase() ||
          current.timestampSec !== tip.timestampSec
        ) {
          const match = await findMatchingCheckpoint(
            endpointReader,
            store.checkpoints(discoveryScope),
          );
          if (match) recordChanges(recover(discoveryScope, match), 'discovery-reorg');
          else recordChanges(recover(discoveryScope, null), 'discovery-rebuild');
          // Invalidation is committed: withdrawals must survive registry outages.
          await drain(true);
          tip = store.acceptedTip(discoveryScope);
        }
      }
      let from = tip ? tip.number + 1n : floor;
      while (from <= head.number && Date.now() < stopAtMs) {
        const top = from + BigInt(config.discoveryMaxRangeBlocks) - 1n;
        const end = top < head.number ? await endpointReader.getAnchor(top) : head;
        const batch = await fetchRange(endpointReader, {
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
        store.saveRaw(batch);
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
        saveJson(resolve(out, 'discovery-' + batch.id + '.json'), batch, out);
        if (batch.completeness !== 'complete') return false;
        await reader.flush?.();
        store.acceptRange(batch);
        batchRecords.at(-1)!.accepted = true;
        counts.discoveryBatches++;
        tip = end;
        from = end.number + 1n;
      }
      return (store.acceptedTip(discoveryScope)?.number ?? -1n) >= head.number;
    };
    result.discoveryComplete = await bootstrap(initial);
    if (!result.discoveryComplete) {
      result.status = 'incomplete';
    } else {
      // Verify the operation checkpoint before delivering a persisted backlog.
      // This also reconciles config/source changes when no new range is available.
      const priorTip = store.acceptedTip(scopeId);
      if (options.notify === 'local' && priorTip) {
        const current = await endpointReader.getAnchor(priorTip.number);
        if (
          current.hash.toLowerCase() === priorTip.hash.toLowerCase() &&
          current.timestampSec === priorTip.timestampSec
        ) {
          db.transaction(() => {
            new SqliteProjectionStore(db).rebuild(scopeId, discoveryScope, config.version);
            projectSignals(db, metricInput, options.signalConfig!, {
              ...recoveryContext(),
              captureMode: 'backfill',
            });
          })();
          await drain();
        }
      }
      const start =
        options.fromBlock ??
        (store.acceptedTip(scopeId)?.number !== undefined
          ? 0n
          : await warmupStart(metered('warmupAnchors'), initial, floor, config.warmupMinutes));
      const followResult = await follow(endpointReader, followStore, stopAtMs, {
        scopeId,
        startBlock: start,
        ...(options.toBlock === undefined ? {} : { toBlock: options.toBlock }),
        oneShot: options.command === 'ingest',
        pollIntervalMs: config.pollIntervalMs,
        maxRangeBlocks: config.maxRangeBlocks,
        overlapBlocks: config.overlapBlocks,
        warmupMinutes: config.warmupMinutes,
        checkpointRetentionMinutes: config.checkpointRetentionMinutes,
        deploymentFloor: floor,
        onChanges: recordChanges,
        onRecovery: async () => {
          await drain(true);
          // Revalidate historical registry evidence before applying a new branch.
          const head = await endpointReader.getAnchor('latest');
          if (!(await bootstrap(head))) throw new RpcFailure('discovery-incomplete');
        },
        recordRange: async (from, end, previous) => {
          const pools = new PoolRegistry([...store.pools(discoveryScope), ...store.pools(scopeId)]);
          const batch = await fetchRange(endpointReader, {
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
            captureMode: options.command === 'ingest' ? 'backfill' : 'live',
          });
          store.saveRaw(batch);
          const priorTimes = store.logTimes(scopeId);
          const unresolved = store
            .activeLogs(scopeId)
            .filter(
              (log) =>
                (!priorTimes.has(rawLogKey(log)) ||
                  priorTimes.get(rawLogKey(log))?.source === 'unresolved') &&
                log.blockNumber <= end.number,
            );
          const allLogs = [
            ...new Map([...unresolved, ...batch.logs].map((log) => [rawLogKey(log), log])).values(),
          ];
          const timeFrom = allLogs.reduce(
            (min, log) => (log.blockNumber < min ? log.blockNumber : min),
            from,
          );
          let timed: RecordedRangeBatch = batch;
          let timingFailures: readonly unknown[] = [];
          if (batch.completeness === 'complete') {
            const resolution = await resolveLogTimes(
              metered('minuteAnchors'),
              allLogs,
              timeFrom,
              end,
              store.anchors(scopeId),
              store.boundaries(scopeId),
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
          saveJson(resolve(out, 'range-' + batch.id + '.json'), { ...timed, timingFailures }, out);
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
          if (batch.completeness !== 'complete') return null;
          await reader.flush?.();
          const changes =
            options.notify === 'local'
              ? commitAcceptedSignalBatch(db, metricInput, options.signalConfig!, timed).changes
              : store.acceptRange(timed);
          await drain();
          batchRecords.at(-1)!.accepted = true;
          counts.operationBatches++;
          return changes;
        },
        onProgress: (health) =>
          console.log(
            encodeJson({
              event: 'progress',
              runId: id,
              health,
              counts,
              meter: reader.meter.summary(),
            }),
          ),
      });
      result.follow = followResult;
      result.failures.push(...followResult.failures);
      result.status =
        followResult.complete && counts.operationBatches > 0 ? 'complete' : 'incomplete';
      exitCode = result.status === 'complete' ? 0 : 4;
    }
  } catch (error) {
    primary = error;
    result.status = 'failed';
    const failure = classifyRpcError(error);
    result.failures.push(failure.kind);
    exitCode =
      error instanceof RpcFailure ? (['budget', 'deadline'].includes(error.kind) ? 4 : 3) : 1;
  } finally {
    try {
      await reader.close?.();
    } catch (error) {
      const failure = classifyRpcError(error);
      result.failures.push(failure.kind);
      result.status = 'failed';
      if (primary instanceof RpcFailure && primary !== error) primary.evidenceFailure ??= failure;
      if (!primary) {
        primary = error;
        exitCode = error instanceof RpcFailure ? 3 : 1;
      }
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
      counts,
      meter: reader.meter.summary(),
      acceptedTip: store.acceptedTip(scopeId),
      batches: batchRecords,
      revisions,
      evidenceMode: options.evidenceMode,
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
          meter: reader.meter.summary(),
        }),
      );
    } finally {
      db.close();
    }
  }
  return exitCode;
}
