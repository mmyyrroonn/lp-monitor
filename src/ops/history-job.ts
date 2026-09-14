import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createChainReader } from '../rpc/client.js';
import type Database from 'better-sqlite3';
import { ConfigError } from '../config/env.js';
import { loadChainConfig, type ChainConfig } from '../config/chain.js';
import { loadAssetVersion, type AssetRegistry } from '../registry/assets.js';
import {
  computeWatchScopeId,
  buildDiscoveryFilterPlan,
  buildOperationFilterPlan,
} from '../ingest/filter-plan.js';
import { PoolRegistry } from '../registry/pools.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { rawLogKey } from '../storage/manifest.js';
import { openDatabase } from '../storage/database.js';
import {
  captureHistoryInputSnapshots,
  currentHistoryInputSnapshots,
  historyInputSnapshotsMatch,
  insertHistoryJob,
  newHistoryJobState,
  patchHistoryJob,
  readHistoryJobFromDatabase,
  type HistoryInputSnapshot,
  type HistoryJobMissing,
  type HistoryJobSpec,
  type HistoryJobState,
} from '../storage/history-jobs.js';
import {
  acceptedCoverage,
  missingIntervals,
  type BlockInterval,
  reviewHistory,
} from './history.js';
import { loadMetricMetadata } from '../metrics/metadata.js';
import type { MetricMetadata } from '../metrics/metadata.js';

function range(fromBlock: bigint, toBlock: bigint, reason: string): HistoryJobMissing {
  return { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), reason };
}

function ranges(intervals: readonly BlockInterval[], reason: string): HistoryJobMissing[] {
  return intervals.map(([fromBlock, toBlock]) => range(fromBlock, toBlock, reason));
}

function parseBlock(value: string): bigint {
  return BigInt(value);
}

function unionMissing(
  categories: Pick<
    HistoryJobState,
    'registryMissing' | 'operationMissing' | 'timeUnknown' | 'unpriced'
  >,
): HistoryJobMissing[] {
  return [
    ...categories.registryMissing,
    ...categories.operationMissing,
    ...categories.timeUnknown,
    ...categories.unpriced,
  ];
}

function allRange(spec: HistoryJobSpec): BlockInterval {
  return [parseBlock(spec.fromBlock), parseBlock(spec.toBlock)];
}

function safeLoadInputs(
  spec: HistoryJobSpec,
): { config: ChainConfig; assets: AssetRegistry; metadata: MetricMetadata } | null {
  try {
    const metadataPath = resolve(dirname(spec.configPath), 'metric-metadata.json');
    if (
      !existsSync(spec.configPath) ||
      !existsSync(spec.watchlistPath) ||
      !existsSync(metadataPath)
    )
      return null;
    const config = loadChainConfig(spec.configPath);
    const assets = loadAssetVersion(spec.watchlistPath);
    const metadata = loadMetricMetadata(metadataPath);
    if (config.version !== spec.protocolVersion || assets.version !== spec.assetVersion)
      throw new ConfigError('History job input versions no longer match the fixed spec');
    return { config, assets, metadata };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    return null;
  }
}

function scopes(spec: HistoryJobSpec, config: ChainConfig, assets: AssetRegistry) {
  const deployments = { v3Factory: config.v3Factory, v4Manager: config.v4Manager };
  return {
    deployments,
    scopeId: computeWatchScopeId(assets, 'operations', deployments),
    registryScopeId: computeWatchScopeId(assets, 'discovery-only', deployments),
  };
}

function targetAnchorMissing(
  db: Database.Database,
  scopeIds: readonly string[],
  spec: HistoryJobSpec,
): HistoryJobMissing[] {
  const target = parseBlock(spec.toBlock);
  const rows = db
    .prepare(
      `select scope_id,block_hash from anchors where block_number=? and scope_id in (${scopeIds
        .map(() => '?')
        .join(',')})`,
    )
    .all(Number(target), ...scopeIds) as { scope_id: string; block_hash: string }[];
  if (rows.some((row) => row.block_hash.toLowerCase() === spec.targetHash.toLowerCase())) return [];
  const reason = rows.length ? 'target-anchor-mismatch' : 'target-anchor-missing';
  return [range(target, target, reason)];
}

function unknownTimeRanges(
  db: Database.Database,
  scopeId: string,
  fromBlock: bigint,
  toBlock: bigint,
): HistoryJobMissing[] {
  const store = new SqliteRangeStore(db);
  const times = store.logTimes(scopeId);
  const unknown = store
    .activeLogs(scopeId)
    .filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)
    .filter((log) => {
      const time = times.get(rawLogKey(log));
      return time === undefined || time.minuteStartSec === null;
    })
    .map((log) => log.blockNumber)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const result: BlockInterval[] = [];
  for (const block of unknown) {
    const previous = result.at(-1);
    if (previous && previous[1] + 1n === block) previous[1] = block;
    else result.push([block, block]);
  }
  return ranges(result, 'time-unknown');
}

function missingCategories(
  db: Database.Database,
  spec: HistoryJobSpec,
): Pick<
  HistoryJobState,
  'missing' | 'registryMissing' | 'operationMissing' | 'timeUnknown' | 'unpriced'
> & { scopeId?: string; registryScopeId?: string } {
  const [fromBlock, toBlock] = allRange(spec);
  const input = safeLoadInputs(spec);
  if (!input) {
    const unavailable = range(fromBlock, toBlock, 'input-snapshot-missing');
    return {
      registryMissing: [unavailable],
      operationMissing: [unavailable],
      timeUnknown: [],
      unpriced: [],
      missing: [unavailable, unavailable],
    };
  }
  const { config, assets } = input;
  const { deployments, scopeId, registryScopeId } = scopes(spec, config, assets);
  const registryCoverage = acceptedCoverage(db, registryScopeId, (batch) =>
    buildDiscoveryFilterPlan(
      assets,
      deployments,
      batch.fromBlock,
      batch.toBlock,
      config.maxFilterValues,
    ),
  );
  const registryMissing = ranges(
    missingIntervals(fromBlock, toBlock, registryCoverage),
    'registry-coverage-missing',
  );
  const store = new SqliteRangeStore(db);
  const registry = new PoolRegistry(store.pools(registryScopeId));
  const operationCoverage = acceptedCoverage(db, scopeId, (batch) => [
    ...buildDiscoveryFilterPlan(
      assets,
      deployments,
      batch.fromBlock,
      batch.toBlock,
      config.maxFilterValues,
    ),
    ...buildOperationFilterPlan(
      registry.snapshot().filter((pool) => pool.discoveredAt.blockNumber <= batch.toBlock),
      deployments,
      batch.fromBlock,
      batch.toBlock,
      config.maxFilterValues,
    ),
  ]);
  const operationMissing = ranges(
    missingIntervals(fromBlock, toBlock, operationCoverage),
    'operation-coverage-missing',
  );
  const timeUnknown = unknownTimeRanges(db, scopeId, fromBlock, toBlock);
  const anchorMissing = targetAnchorMissing(db, [scopeId, registryScopeId], spec);
  const registryWithAnchor = [...registryMissing, ...anchorMissing];
  const categories = {
    registryMissing: registryWithAnchor,
    operationMissing,
    timeUnknown,
    unpriced: [] as HistoryJobMissing[],
  };
  return {
    ...categories,
    missing: unionMissing(categories),
    scopeId,
    registryScopeId,
  };
}

function countRaw(db: Database.Database): { events: number; bytes: number } {
  const events = Number(db.prepare('select count(*) as n from raw_logs').pluck().get());
  const bytes = Number(
    db.prepare('select coalesce(sum(length(payload_json)),0) as n from raw_logs').pluck().get(),
  );
  return { events, bytes };
}

function nextPhase(
  state: Pick<HistoryJobState, 'registryMissing' | 'operationMissing' | 'timeUnknown' | 'unpriced'>,
): HistoryJobState['phase'] {
  if (state.registryMissing.length) return 'catalogue';
  if (state.operationMissing.length) return 'operations';
  if (state.timeUnknown.length) return 'time';
  if (state.unpriced.length) return 'metadata';
  return 'finished';
}

export async function prepareHistoryJob(input: HistoryJobSpec): Promise<HistoryJobState> {
  const spec = {
    ...input,
    sourceDatabasePath: resolve(input.sourceDatabasePath),
    studyDatabasePath: resolve(input.studyDatabasePath),
    watchlistPath: resolve(input.watchlistPath),
    configPath: resolve(input.configPath),
  } as HistoryJobSpec;
  const normalizedSnapshots = captureHistoryInputSnapshots(spec);
  if (!existsSync(spec.studyDatabasePath) && existsSync(spec.sourceDatabasePath)) {
    mkdirSync(dirname(spec.studyDatabasePath), { recursive: true });
    const source = openDatabase(spec.sourceDatabasePath, { readonly: true });
    try {
      await source.backup(spec.studyDatabasePath);
    } finally {
      source.close();
    }
  }
  const db = openDatabase(spec.studyDatabasePath);
  try {
    const normalized = {
      ...spec,
      sourceDatabasePath: resolve(spec.sourceDatabasePath),
      studyDatabasePath: resolve(spec.studyDatabasePath),
    };
    const categories = missingCategories(db, normalized);
    const state = newHistoryJobState(normalized, normalizedSnapshots, categories, {
      scopeId: categories.scopeId,
      registryScopeId: categories.registryScopeId,
    });
    insertHistoryJob(db, state);
    return readHistoryJobFromDatabase(db, state.id);
  } finally {
    db.close();
  }
}

export interface HistoryJobRunOptions {
  studyDatabasePath: string;
  jobId: string;
  durationMs?: number;
  maxRpcCalls?: number;
  metadataPath?: string;
  environment?: NodeJS.ProcessEnv;
  readerFactory?: typeof createChainReader;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function callCount(report: { rpc?: { calls?: number } | null }): number {
  return Number.isSafeInteger(report.rpc?.calls) ? (report.rpc?.calls as number) : 0;
}

function isPause(message: string): boolean {
  return /budget|deadline|duration|stopped|paused/i.test(message);
}

export async function runHistoryJob(options: HistoryJobRunOptions): Promise<HistoryJobState> {
  const databasePath = resolve(options.studyDatabasePath);
  const db = openDatabase(databasePath);
  let state = readHistoryJobFromDatabase(db, options.jobId);
  const expected = state.inputSnapshots;
  const actual = currentHistoryInputSnapshots(state);
  if (!historyInputSnapshotsMatch(expected, actual)) {
    const message = 'History job input snapshot changed; prepare a new fixed job';
    state = patchHistoryJob(db, state.id, { status: 'failed', lastError: message });
    db.close();
    throw new ConfigError(message);
  }
  if (state.status === 'complete') {
    db.close();
    return state;
  }
  if (!['prepared', 'paused', 'waiting-retry', 'running'].includes(state.status)) {
    db.close();
    throw new ConfigError(`History job cannot run from status ${state.status}`);
  }
  if (
    options.maxRpcCalls !== undefined &&
    (!Number.isSafeInteger(options.maxRpcCalls) || options.maxRpcCalls < 1)
  ) {
    db.close();
    throw new ConfigError('History job maxRpcCalls must be a positive safe integer');
  }
  if (
    options.durationMs !== undefined &&
    (!Number.isSafeInteger(options.durationMs) || options.durationMs < 1)
  ) {
    db.close();
    throw new ConfigError('History job duration must be a positive safe integer');
  }
  const before = countRaw(db);
  state = patchHistoryJob(db, state.id, {
    status: 'running',
    phase: nextPhase(state),
    attempts: state.attempts + 1,
    currentRunRpcCalls: 0,
    lastError: null,
  });
  db.close();
  const spec = state.spec;
  let report: Awaited<ReturnType<typeof reviewHistory>>;
  try {
    const input = safeLoadInputs(spec);
    if (!input)
      throw new ConfigError('History job config/watchlist/metadata snapshot is unavailable');
    const metadata = options.metadataPath
      ? loadMetricMetadata(resolve(options.metadataPath))
      : input.metadata;
    report = await reviewHistory({
      databasePath: spec.sourceDatabasePath,
      studyDatabasePath: spec.studyDatabasePath,
      outputDirectory: resolve(dirname(spec.studyDatabasePath), 'history-runs'),
      fromBlock: parseBlock(spec.fromBlock),
      toBlock: parseBlock(spec.toBlock),
      config: input.config,
      assets: input.assets,
      metadata,
      environment: options.environment,
      readerFactory: options.readerFactory,
      maxCalls: options.maxRpcCalls,
      deadlineMs: options.durationMs === undefined ? undefined : Date.now() + options.durationMs,
    });
  } catch (error) {
    const failedDb = openDatabase(databasePath);
    try {
      const current = readHistoryJobFromDatabase(failedDb, options.jobId);
      patchHistoryJob(failedDb, current.id, {
        status: isPause(errorText(error)) ? 'paused' : 'failed',
        phase: current.phase,
        lastError: errorText(error),
      });
    } finally {
      failedDb.close();
    }
    throw error;
  }
  const finishedDb = openDatabase(databasePath);
  try {
    const current = readHistoryJobFromDatabase(finishedDb, options.jobId);
    const categories = missingCategories(finishedDb, spec);
    const after = countRaw(finishedDb);
    const calls = callCount(report);
    const unavailable = report.unavailable.join('; ');
    const incomplete =
      categories.missing.length > 0 || !report.complete || report.unavailable.length > 0;
    const status: HistoryJobState['status'] = incomplete
      ? isPause(unavailable)
        ? 'paused'
        : 'waiting-retry'
      : 'complete';
    const updated = patchHistoryJob(finishedDb, current.id, {
      ...categories,
      status,
      phase: nextPhase(categories),
      currentRunRpcCalls: calls,
      cumulativeRpcCalls: current.cumulativeRpcCalls + calls,
      rawEventsAdded: Math.max(0, after.events - before.events),
      rawBytesAdded: Math.max(0, after.bytes - before.bytes),
      completedCoverage:
        status === 'complete'
          ? [range(parseBlock(spec.fromBlock), parseBlock(spec.toBlock), 'accepted-complete')]
          : [],
      lastError: incomplete ? unavailable || 'History evidence remains incomplete' : null,
    });
    return updated;
  } finally {
    finishedDb.close();
  }
}

export function refreshHistoryJob(studyDatabasePath: string, jobId: string): HistoryJobState {
  const db = openDatabase(resolve(studyDatabasePath));
  try {
    const state = readHistoryJobFromDatabase(db, jobId);
    const categories = missingCategories(db, state.spec);
    return patchHistoryJob(db, jobId, { ...categories, phase: nextPhase(categories) });
  } finally {
    db.close();
  }
}

export type HistoryJobReaderFactory = typeof createChainReader;
