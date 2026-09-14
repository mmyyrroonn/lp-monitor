import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createChainReader } from '../rpc/client.js';
import type Database from 'better-sqlite3';
import type { BlockAnchor } from '../domain/types.js';
import { ConfigError, loadEnv } from '../config/env.js';
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

function anchorHashes(db: Database.Database, scopeId: string, blockNumber: number): string[] {
  return (
    db
      .prepare('select block_hash from anchors where scope_id=? and block_number=?')
      .all(scopeId, blockNumber) as { block_hash: string }[]
  ).map((row) => row.block_hash.toLowerCase());
}

/** Every declared scope must carry the fixed target hash. One matching scope
 * cannot excuse a conflicting branch in the other. */
function targetAnchorMissing(
  db: Database.Database,
  scopeIds: readonly string[],
  spec: HistoryJobSpec,
): HistoryJobMissing[] {
  const target = parseBlock(spec.toBlock);
  const expected = spec.targetHash.toLowerCase();
  const missing: HistoryJobMissing[] = [];
  for (const scopeId of scopeIds) {
    const hashes = anchorHashes(db, scopeId, Number(target));
    if (hashes.includes(expected)) continue;
    missing.push(
      range(target, target, hashes.length ? 'target-anchor-mismatch' : 'target-anchor-missing'),
    );
  }
  return missing;
}

export interface HistoryBranchDivergence {
  blockNumber: bigint;
  hashes: { scopeId: string; hash: string }[];
}

/** Heights where two scopes hold anchors that share no hash. */
export function historyBranchDivergence(
  db: Database.Database,
  scopeIds: readonly string[],
): HistoryBranchDivergence[] {
  if (scopeIds.length < 2) return [];
  const rows = db
    .prepare(
      `select scope_id,block_number,block_hash from anchors where scope_id in (${scopeIds
        .map(() => '?')
        .join(',')})`,
    )
    .all(...scopeIds) as { scope_id: string; block_number: number; block_hash: string }[];
  const byHeight = new Map<number, Map<string, Set<string>>>();
  for (const row of rows) {
    const perScope = byHeight.get(row.block_number) ?? new Map<string, Set<string>>();
    const hashes = perScope.get(row.scope_id) ?? new Set<string>();
    hashes.add(row.block_hash.toLowerCase());
    perScope.set(row.scope_id, hashes);
    byHeight.set(row.block_number, perScope);
  }
  const divergences: HistoryBranchDivergence[] = [];
  for (const [height, perScope] of byHeight) {
    if (perScope.size < 2) continue;
    const sets = [...perScope.values()];
    const shared = [...sets[0]!].some((hash) => sets.every((set) => set.has(hash)));
    if (shared) continue;
    divergences.push({
      blockNumber: BigInt(height),
      hashes: [...perScope].flatMap(([scopeId, hashes]) =>
        [...hashes].map((hash) => ({ scopeId, hash })),
      ),
    });
  }
  return divergences.sort((left, right) =>
    left.blockNumber < right.blockNumber ? -1 : left.blockNumber > right.blockNumber ? 1 : 0,
  );
}

/** Invalidate the scope that disagrees with the fixed target so the affected
 * coverage is refetched instead of mixing withdrawn and replacement events. */
export function reconcileHistoryJobBranches(
  db: Database.Database,
  spec: HistoryJobSpec,
  scopeId: string,
  registryScopeId: string,
): {
  conflicts: HistoryJobMissing[];
  invalidated: { scopeId: string; afterBlock: string | null }[];
  notes: string[];
} {
  const divergences = historyBranchDivergence(db, [scopeId, registryScopeId]);
  if (divergences.length === 0) return { conflicts: [], invalidated: [], notes: [] };
  const target = parseBlock(spec.toBlock);
  const expected = spec.targetHash.toLowerCase();
  const keepers = [scopeId, registryScopeId].filter((scope) =>
    anchorHashes(db, scope, Number(target)).includes(expected),
  );
  if (keepers.length !== 1)
    return {
      conflicts: [range(target, target, 'target-anchor-conflict')],
      invalidated: [],
      notes: ['Branch divergence without exactly one target-matching scope'],
    };
  const keeper = keepers[0]!;
  const other = keeper === scopeId ? registryScopeId : scopeId;
  const firstDivergence = divergences[0]!.blockNumber;
  const rows = db
    .prepare(
      `select scope_id,block_number,block_hash,timestamp_sec from anchors
       where scope_id in (?,?) and block_number < ? order by block_number desc`,
    )
    .all(scopeId, registryScopeId, Number(firstDivergence)) as {
    scope_id: string;
    block_number: number;
    block_hash: string;
    timestamp_sec: number;
  }[];
  const byHeight = new Map<number, Map<string, { hash: string; timestampSec: number }>>();
  for (const row of rows) {
    const perScope = byHeight.get(row.block_number) ?? new Map();
    perScope.set(row.scope_id, {
      hash: row.block_hash.toLowerCase(),
      timestampSec: row.timestamp_sec,
    });
    byHeight.set(row.block_number, perScope);
  }
  let keep: BlockAnchor | null = null;
  for (const height of [...byHeight.keys()].sort((left, right) => right - left)) {
    const perScope = byHeight.get(height)!;
    const left = perScope.get(scopeId);
    const right = perScope.get(registryScopeId);
    if (left && right && left.hash === right.hash) {
      keep = {
        number: BigInt(height),
        hash: left.hash as `0x${string}`,
        timestampSec: left.timestampSec,
      };
      break;
    }
  }
  const store = new SqliteRangeStore(db);
  const tip = store.acceptedTip(other);
  const retained = keep !== null && tip !== null && keep.number <= tip.number ? keep : null;
  const changes = retained ? store.invalidateAfter(other, retained) : store.resetForWarmup(other);
  return {
    conflicts: [],
    invalidated: [{ scopeId: other, afterBlock: retained?.number.toString() ?? null }],
    notes: [
      `Branch divergence from block ${firstDivergence} invalidated ${other}` +
        (retained === null ? ' (full scope reset)' : ` after block ${retained.number}`) +
        `; ${changes.removed.length} events removed`,
    ],
  };
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

/** Recorded anchors bound the chain times of the fixed range. Without a proven
 * bound on both ends the analysis period, warmup and outcome context are not
 * contained, so the job cannot claim the study window was collected. */
function analysisWindowMissing(
  db: Database.Database,
  spec: HistoryJobSpec,
  scopeId: string,
): HistoryJobMissing[] {
  const [fromBlock, toBlock] = allRange(spec);
  const requiredStartSec = spec.analysisStartSec - spec.warmupMinutes * 60;
  const requiredEndSec = spec.analysisEndSec + spec.outcomeMinutes * 60;
  const anchors = new SqliteRangeStore(db).anchors(scopeId, { fromBlock, toBlock });
  if (anchors.length === 0) return [range(fromBlock, toBlock, 'analysis-window-unproven')];
  const earliest = anchors.reduce(
    (min, anchor) => (anchor.timestampSec < min ? anchor.timestampSec : min),
    anchors[0]!.timestampSec,
  );
  const latest = anchors.reduce(
    (max, anchor) => (anchor.timestampSec > max ? anchor.timestampSec : max),
    anchors[0]!.timestampSec,
  );
  if (earliest <= requiredStartSec && latest >= requiredEndSec) return [];
  return [range(fromBlock, toBlock, 'analysis-window-unproven')];
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
  const divergent = historyBranchDivergence(db, [scopeId, registryScopeId]).map((item) =>
    range(item.blockNumber, item.blockNumber, 'branch-anchor-divergence'),
  );
  const registryWithAnchor = [...registryMissing, ...anchorMissing, ...divergent];
  const categories = {
    registryMissing: registryWithAnchor,
    operationMissing: [...operationMissing, ...analysisWindowMissing(db, spec, scopeId)],
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

/** The fixed target must still be the chain's block at that height. Local scopes
 * agreeing with each other cannot prove that, and a stale target must not keep
 * refetching coverage that will never match it. */
async function verifyFixedTarget(
  spec: HistoryJobSpec,
  config: ChainConfig,
  options: HistoryJobRunOptions,
  deadlineMs: number | undefined,
): Promise<{ ok: boolean; calls: number; reason: string | null }> {
  const target = parseBlock(spec.toBlock);
  const reader = (options.readerFactory ?? createChainReader)(
    loadEnv(options.environment ?? process.env),
    {
      maxCalls: 1,
      perSecond: config.rpcPerSecond,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      evidenceMode: 'off',
      // The precheck shares the run's absolute deadline instead of extending it.
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    },
  );
  try {
    const anchor = await reader.getAnchor(target);
    const calls = reader.meter.summary().calls;
    if (anchor.number !== target || anchor.hash.toLowerCase() !== spec.targetHash.toLowerCase())
      return {
        ok: false,
        calls,
        reason:
          'target-anchor-mismatch: block ' +
          target +
          ' is ' +
          anchor.hash.toLowerCase() +
          ' but the job fixed ' +
          spec.targetHash.toLowerCase() +
          '; prepare a new job for the current target',
      };
    return { ok: true, calls, reason: null };
  } catch (error) {
    return {
      ok: false,
      calls: reader.meter.summary().calls,
      reason: 'target-verification-unavailable: ' + errorText(error),
    };
  } finally {
    try {
      await reader.close?.();
    } catch {
      /* Evidence close failures are reported by the review path. */
    }
  }
}

export async function runHistoryJob(options: HistoryJobRunOptions): Promise<HistoryJobState> {
  const databasePath = resolve(options.studyDatabasePath);
  // One absolute deadline covers the target precheck, the review and every wait.
  const runStartedAtMs = Date.now();
  const deadlineMs =
    options.durationMs === undefined ? undefined : runStartedAtMs + options.durationMs;
  // A missing study database must never be silently re-created from a live source.
  if (!existsSync(databasePath))
    throw new ConfigError('History job study database does not exist; prepare the job first');
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
  let branchNotes: string[] = [];
  let targetRunCalls = 0;
  try {
    const input = safeLoadInputs(spec);
    if (!input)
      throw new ConfigError('History job config/watchlist/metadata snapshot is unavailable');
    const targetCheck = await verifyFixedTarget(spec, input.config, options, deadlineMs);
    targetRunCalls = targetCheck.calls;
    if (!targetCheck.ok) {
      const stateDb = openDatabase(databasePath);
      try {
        const current = readHistoryJobFromDatabase(stateDb, options.jobId);
        const resumable = (targetCheck.reason ?? '').startsWith('target-verification-unavailable');
        const conflict = range(
          parseBlock(spec.toBlock),
          parseBlock(spec.toBlock),
          'target-anchor-mismatch',
        );
        return patchHistoryJob(stateDb, current.id, {
          status: resumable ? 'waiting-retry' : 'failed',
          phase: 'catalogue',
          registryMissing: resumable ? current.registryMissing : [conflict],
          operationMissing: resumable ? current.operationMissing : [],
          timeUnknown: resumable ? current.timeUnknown : [],
          unpriced: resumable ? current.unpriced : [],
          missing: resumable ? current.missing : [conflict],
          currentRunRpcCalls: targetCheck.calls,
          cumulativeRpcCalls: current.cumulativeRpcCalls + targetCheck.calls,
          notes: [...current.notes, targetCheck.reason ?? 'target-unverified'],
          lastError: targetCheck.reason,
        });
      } finally {
        stateDb.close();
      }
    }
    // The precheck shares the run budget and deadline; nothing further starts once
    // either is spent, even if the precheck only returned after the deadline.
    const remainingCalls =
      options.maxRpcCalls === undefined ? undefined : options.maxRpcCalls - targetRunCalls;
    const deadlinePassed = deadlineMs !== undefined && Date.now() >= deadlineMs;
    if (deadlinePassed || (remainingCalls !== undefined && remainingCalls < 1)) {
      const budgetDb = openDatabase(databasePath);
      try {
        const current = readHistoryJobFromDatabase(budgetDb, options.jobId);
        return patchHistoryJob(budgetDb, current.id, {
          status: 'paused',
          phase: current.phase,
          currentRunRpcCalls: targetRunCalls,
          cumulativeRpcCalls: current.cumulativeRpcCalls + targetRunCalls,
          notes: [
            ...current.notes,
            deadlinePassed
              ? 'deadline reached during target verification'
              : 'rpc budget consumed by target verification',
          ],
          lastError: deadlinePassed
            ? 'History job deadline is exhausted before acquisition'
            : 'History job RPC budget is exhausted before acquisition',
        });
      } finally {
        budgetDb.close();
      }
    }
    const { scopeId, registryScopeId } = scopes(spec, input.config, input.assets);
    const reconcileDb = openDatabase(databasePath);
    try {
      const reconciliation = reconcileHistoryJobBranches(
        reconcileDb,
        spec,
        scopeId,
        registryScopeId,
      );
      branchNotes = reconciliation.notes;
    } finally {
      reconcileDb.close();
    }
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
      maxCalls: remainingCalls,
      deadlineMs,
      requiredContext: {
        startSec: spec.analysisStartSec - spec.warmupMinutes * 60,
        endSec: spec.analysisEndSec + spec.outcomeMinutes * 60,
      },
      targetAnchor: { block: parseBlock(spec.toBlock), hash: spec.targetHash },
    });
  } catch (error) {
    const failedDb = openDatabase(databasePath);
    try {
      const current = readHistoryJobFromDatabase(failedDb, options.jobId);
      patchHistoryJob(failedDb, current.id, {
        status: isPause(errorText(error)) ? 'paused' : 'failed',
        phase: current.phase,
        currentRunRpcCalls: current.currentRunRpcCalls + targetRunCalls,
        cumulativeRpcCalls: current.cumulativeRpcCalls + targetRunCalls,
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
      currentRunRpcCalls: calls + targetRunCalls,
      cumulativeRpcCalls: current.cumulativeRpcCalls + calls + targetRunCalls,
      rawEventsAdded: Math.max(0, after.events - before.events),
      rawBytesAdded: Math.max(0, after.bytes - before.bytes),
      completedCoverage:
        status === 'complete'
          ? [range(parseBlock(spec.fromBlock), parseBlock(spec.toBlock), 'accepted-complete')]
          : [],
      notes: [...current.notes, ...branchNotes, ...(report.reconciled ?? [])],
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
