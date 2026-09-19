import { readCachedMetricMetadata } from '../storage/token-metadata.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { ChainConfig } from '../config/chain.js';
import { ConfigError, loadEnv } from '../config/env.js';
import type { AssetRegistry } from '../registry/assets.js';
import { PoolRegistry, poolRegistrationId } from '../registry/pools.js';
import { verifyIdentity } from '../registry/identity.js';
import {
  computeWatchScopeId,
  buildDiscoveryFilterPlan,
  buildOperationFilterPlan,
  type PlannedFilter,
} from '../ingest/filter-plan.js';
import { discoverPools as discoverV3 } from '../protocols/uniswap-v3/discover.js';
import { discoverPools as discoverV4 } from '../protocols/uniswap-v4/discover.js';
import { fetchRange } from '../ingest/record-range.js';
import { verifySuccessfulShardCoverage } from '../ingest/completeness.js';
import { resolveLogTimes } from '../ingest/log-time.js';
import { findMatchingCheckpoint } from '../ingest/reorg.js';
import { openDatabase } from '../storage/database.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { rawLogKey, type RecordedRangeBatch } from '../storage/manifest.js';
import { readBatch } from '../storage/payload-store.js';
import { projectRange } from '../state/project-range.js';
import { encodeJson } from '../domain/json.js';
import { createChainReader } from '../rpc/client.js';
import { classifyRpcError } from '../rpc/errors.js';
import { saveJson } from './files.js';
import {
  loadMetricMetadata,
  reconcileMetricMetadata,
  decimalsAt,
  type MetricMetadata,
} from '../metrics/metadata.js';
import { valueSwap, type SwapValuation, type SwapValuationMetadata } from '../metrics/notional.js';
import { addQuote, createQuoteIndex, quoteFromRwaUsdgSwap } from '../metrics/price.js';
import { aggregateRwa } from '../metrics/rwa-aggregate.js';
import type { BlockAnchor } from '../domain/types.js';
import type { Address } from 'viem';

export type BlockInterval = [bigint, bigint];
/** The declared fixed target no longer exists on this branch; reusing or
 * refetching local coverage would silently mix two branches. */
class FixedTargetStale extends Error {}
const digest = (value: unknown) => createHash('sha256').update(encodeJson(value)).digest('hex');
export function missingIntervals(
  from: bigint,
  to: bigint,
  covered: readonly BlockInterval[],
): BlockInterval[] {
  if (to < from) return [];
  let cursor = from;
  const missing: BlockInterval[] = [];
  for (const [start, end] of [...covered].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    if (end < cursor || start > to) continue;
    if (start > cursor) missing.push([cursor, start - 1n]);
    if (end >= cursor) cursor = end + 1n;
    if (cursor > to) break;
  }
  if (cursor <= to) missing.push([cursor, to]);
  return missing;
}

/** Only accepted intervals backed by a complete, hash-checked shard manifest count. */
function selectorKeys(id: string, filter: PlannedFilter['filter']): string[] {
  let selectors: (string | null)[][] = filter.address.map((address) => [address.toLowerCase()]);
  for (const topic of filter.topics) {
    const values =
      topic === null
        ? [null]
        : typeof topic === 'string'
          ? [topic.toLowerCase()]
          : topic.map((value) => value.toLowerCase());
    if (selectors.length * values.length > 100000) throw new Error('Selector expansion limit');
    selectors = selectors.flatMap((prefix) => values.map((value) => [...prefix, value]));
  }
  return selectors.map((selector) => JSON.stringify([id, ...selector]));
}
function recordedFloor(db: Database.Database, scopeId: string, config: ChainConfig): bigint {
  const rows = db
    .prepare('select payload_json from runs where scope_id=? order by finished_at_ms desc')
    .all(scopeId) as { payload_json: string }[];
  for (const row of rows) {
    try {
      const run = JSON.parse(row.payload_json);
      if (run.configurationHash !== digest(config) || run.identity?.requiredPassed !== true)
        continue;
      const deployments = run.identity.deployments;
      const records = [deployments.v3Factory, deployments.v4Manager];
      if (
        records.some(
          (record, i) =>
            record.status !== 'verified' ||
            record.address.toLowerCase() !== [config.v3Factory, config.v4Manager][i] ||
            !/^\d+$/.test(record.firstCodeBlock) ||
            BigInt(record.firstCodeBlock) > BigInt(Number.MAX_SAFE_INTEGER),
        )
      )
        continue;
      return records.reduce(
        (floor: bigint, record) =>
          BigInt(record.firstCodeBlock) < floor ? BigInt(record.firstCodeBlock) : floor,
        BigInt(Number.MAX_SAFE_INTEGER),
      );
    } catch {
      /* Unknown deployment history requires discovery from genesis. */
    }
  }
  return 0n;
}
export function acceptedCoverage(
  db: Database.Database,
  scope: string,
  plans?: (batch: RecordedRangeBatch) => readonly PlannedFilter[],
): BlockInterval[] {
  const batches = db
    .prepare(
      'select distinct b.id from ingest_batches b join accepted_ranges a on a.batch_id=b.id where a.scope_id=?',
    )
    .all(scope) as { id: string }[];
  const result: BlockInterval[] = [];
  for (const row of batches) {
    try {
      const batch = readBatch(db, row.id);
      const shards = verifySuccessfulShardCoverage(batch);
      if (digest(batch.manifest) !== batch.manifestHash) continue;
      const stored = db
        .prepare('select shard_id,status,response_hash from fetch_shards where batch_id=?')
        .all(batch.id) as { shard_id: string; status: string; response_hash: string | null }[];
      if (
        stored.length !== shards.length ||
        shards.some(
          (s) =>
            !stored.some(
              (r) =>
                r.shard_id === s.shardId &&
                r.status === 'success' &&
                r.response_hash === s.responseHash,
            ),
        )
      )
        continue;
      if (batch.scopeId !== scope) continue;
      const bySelector = new Map<string, BlockInterval[]>();
      for (const shard of shards) {
        for (const key of selectorKeys(shard.filterId, shard.request)) {
          const ranges = bySelector.get(key) ?? [];
          ranges.push([shard.request.fromBlock, shard.request.toBlock]);
          bySelector.set(key, ranges);
        }
      }
      const expected = plans
        ? plans(batch).flatMap((plan) => selectorKeys(plan.id, plan.filter))
        : [...bySelector.keys()];
      if (
        expected.some(
          (key) =>
            missingIntervals(batch.fromBlock, batch.toBlock, bySelector.get(key) ?? []).length > 0,
        )
      )
        continue;
      const filters = [...new Set(shards.map((s) => s.filterId))];
      const holes: BlockInterval[] = [];
      for (const filter of filters) {
        const rows = db
          .prepare(
            'select from_block,to_block from accepted_ranges where scope_id=? and batch_id=? and filter_id=?',
          )
          .all(scope, batch.id, filter) as { from_block: number; to_block: number }[];
        holes.push(
          ...missingIntervals(
            batch.fromBlock,
            batch.toBlock,
            rows.map((r) => [BigInt(r.from_block), BigInt(r.to_block)]),
          ),
        );
      }
      result.push(...missingIntervals(batch.fromBlock, batch.toBlock, holes));
    } catch {
      /* Corrupt evidence stays missing; never accepted as an empty result. */
    }
  }
  return result;
}
export interface HistoryOptions {
  databasePath: string;
  studyDatabasePath?: string;
  outputDirectory: string;
  fromBlock: bigint;
  toBlock: bigint;
  config: ChainConfig;
  assets: AssetRegistry;
  environment?: NodeJS.ProcessEnv;
  readerFactory?: typeof createChainReader;
  maxCalls?: number;
  deadlineMs?: number;
  metadata?: MetricMetadata;
  /** Chain-time window the fixed range must contain (analysis period plus context). */
  requiredContext?: { startSec: number; endSec: number };
  /** Fixed target that the recorded prefix must still belong to. */
  targetAnchor?: { block: bigint; hash: string };
}

/** Recorded anchors must prove both endpoints of the fixed range, otherwise the
 * requested study window and its warmup/outcome context are not contained. */
function contextUnproven(
  store: SqliteRangeStore,
  scopeId: string,
  fromBlock: bigint,
  toBlock: bigint,
  required: { startSec: number; endSec: number },
): boolean {
  const anchors = store.anchors(scopeId, { fromBlock, toBlock });
  if (anchors.length === 0) return true;
  const earliest = anchors.reduce(
    (min, anchor) => (anchor.timestampSec < min ? anchor.timestampSec : min),
    anchors[0]!.timestampSec,
  );
  const latest = anchors.reduce(
    (max, anchor) => (anchor.timestampSec > max ? anchor.timestampSec : max),
    anchors[0]!.timestampSec,
  );
  return earliest > required.startSec || latest < required.endSec;
}
export async function reviewHistory(options: HistoryOptions) {
  const { fromBlock, toBlock, config, assets } = options;
  if (fromBlock < 0n || toBlock > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ConfigError('History requires safe block bounds');
  if (fromBlock > toBlock) throw new ConfigError('History requires ordered block bounds');
  const out = resolve(options.outputDirectory, 'history-' + randomUUID());
  mkdirSync(resolve(options.outputDirectory), { recursive: true });
  mkdirSync(out);
  const databasePath = options.studyDatabasePath
    ? resolve(options.studyDatabasePath)
    : resolve(out, 'review.sqlite');
  // A prepared job owns a frozen study database. Re-creating it from a live
  // source would silently replace the fixed input with today's evidence.
  if (options.studyDatabasePath !== undefined && !existsSync(databasePath))
    throw new ConfigError('History study database is missing; prepare the job first');
  if (options.studyDatabasePath === undefined && existsSync(options.databasePath)) {
    const source = openDatabase(options.databasePath, { readonly: true });
    try {
      await source.backup(databasePath);
    } finally {
      source.close();
    }
  }
  const db = openDatabase(databasePath);
  const deployments = { v3Factory: config.v3Factory, v4Manager: config.v4Manager };
  const scopeId = computeWatchScopeId(assets, 'operations', deployments);
  const registryScopeId = computeWatchScopeId(assets, 'discovery-only', deployments);
  const store = new SqliteRangeStore(db);
  const acquired: { mode: string; fromBlock: bigint; toBlock: bigint; complete: boolean }[] = [];
  const unavailable: string[] = [];
  let reader: ReturnType<typeof createChainReader> | undefined;
  let rpcSummary: ReturnType<ReturnType<typeof createChainReader>['meter']['summary']> | null =
    null;
  let floor = recordedFloor(db, scopeId, config);
  const discoveryCoverage = () =>
    acceptedCoverage(db, registryScopeId, (batch) =>
      buildDiscoveryFilterPlan(
        assets,
        deployments,
        batch.fromBlock,
        batch.toBlock,
        config.maxFilterValues,
      ),
    );
  const readRegistry = () => {
    const covered = discoveryCoverage();
    const logs = store
      .activeLogs(registryScopeId)
      .filter(
        (log) =>
          log.blockNumber <= toBlock &&
          covered.some(([from, to]) => log.blockNumber >= from && log.blockNumber <= to),
      );
    const registrations: ReturnType<PoolRegistry['snapshot']>[number][] = [];
    const decodeMissing: BlockInterval[] = [];
    for (const log of logs) {
      try {
        registrations.push(
          ...(log.address.toLowerCase() === config.v3Factory
            ? discoverV3([log], assets.version)
            : discoverV4([log], assets.version)),
        );
      } catch {
        decodeMissing.push([log.blockNumber, log.blockNumber]);
      }
    }
    return {
      registry: new PoolRegistry(registrations),
      missing: [...missingIntervals(floor, toBlock, covered), ...decodeMissing],
    };
  };
  const operationCoverage = () => {
    const registry = readRegistry().registry.snapshot();
    return acceptedCoverage(db, scopeId, (batch) => [
      ...buildDiscoveryFilterPlan(
        assets,
        deployments,
        batch.fromBlock,
        batch.toBlock,
        config.maxFilterValues,
      ),
      ...buildOperationFilterPlan(
        registry.filter((p) => p.discoveredAt.blockNumber <= batch.toBlock),
        deployments,
        batch.fromBlock,
        batch.toBlock,
        config.maxFilterValues,
      ),
    ]);
  };
  const unresolvedTimeLogs = () => {
    const times = store.logTimes(scopeId);
    return store
      .activeLogs(scopeId)
      .filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)
      .filter((log) => {
        const time = times.get(rawLogKey(log));
        return time === undefined || time.minuteStartSec === null;
      });
  };
  const endpointAnchorsMissing = (): bigint[] => {
    if (!options.requiredContext) return [];
    const recorded = new Set(
      store.anchors(scopeId, { fromBlock, toBlock }).map((anchor) => anchor.number.toString()),
    );
    return [fromBlock, toBlock].filter(
      (block) =>
        !recorded.has(block.toString()) &&
        store.anchors(scopeId, { fromBlock: block, toBlock: block }).length === 0,
    );
  };
  const localGaps = () => ({
    operation: missingIntervals(fromBlock, toBlock, operationCoverage()),
    registry: readRegistry().missing,
    time: unresolvedTimeLogs().length > 0,
    context: options.requiredContext
      ? contextUnproven(store, scopeId, fromBlock, toBlock, options.requiredContext)
      : false,
  });
  const reconciledBranches: string[] = [];
  let localMissing: BlockInterval[] = [];
  let localRegistryMissing: BlockInterval[] = [];
  try {
    const initialGaps = localGaps();
    localMissing = initialGaps.operation;
    localRegistryMissing = initialGaps.registry;
    if (
      options.targetAnchor !== undefined ||
      initialGaps.operation.length > 0 ||
      initialGaps.registry.length > 0 ||
      initialGaps.time ||
      initialGaps.context
    ) {
      try {
        reader = (options.readerFactory ?? createChainReader)(
          loadEnv(options.environment ?? process.env),
          {
            maxCalls: options.maxCalls ?? config.recorderMaxRpcCalls,
            perSecond: config.rpcPerSecond,
            timeoutMs: config.timeoutMs,
            maxRetries: config.maxRetries,
            deadlineMs: options.deadlineMs,
            evidenceFile: resolve(out, 'requests.jsonl'),
            evidenceMode: 'full',
          },
        );
        const head = await reader.getAnchor('latest');
        if (toBlock > head.number) throw new ConfigError('History range exceeds available head');
        // Reusing a recorded prefix is only valid while the fixed target still
        // exists on this branch. A stale target must not trigger a refetch loop.
        if (options.targetAnchor) {
          const chainTarget = await reader.getAnchor(options.targetAnchor.block);
          if (
            chainTarget.number !== options.targetAnchor.block ||
            chainTarget.hash.toLowerCase() !== options.targetAnchor.hash.toLowerCase()
          ) {
            unavailable.push(
              'target-anchor-mismatch: fixed target block ' +
                options.targetAnchor.block +
                ' is no longer ' +
                options.targetAnchor.hash.toLowerCase(),
            );
            throw new FixedTargetStale();
          }
        }
        const identity = await verifyIdentity(reader, config, head);
        if (!identity.requiredPassed) throw new Error('identity-unverified');
        const deploymentsIdentity = [
          identity.deployments.v3Factory,
          identity.deployments.v4Manager,
        ];
        floor = deploymentsIdentity.every((d) => d.firstCodeBlock !== null)
          ? deploymentsIdentity.reduce(
              (min, d) => (d.firstCodeBlock! < min ? d.firstCodeBlock! : min),
              toBlock,
            )
          : 0n;
        store.recordRun({
          id: 'history-identity-' + randomUUID(),
          scopeId,
          startedAtMs: Date.now(),
          finishedAtMs: Date.now(),
          status: 'verified',
          payload: { configurationHash: digest(config), identity },
        });
        /** Every recorded anchor is a possible common ancestor; checkpoints alone
         * are too sparse to avoid discarding provable coverage below the fork. */
        const branchCandidates = (scope: string, tip: BlockAnchor): BlockAnchor[] => {
          const byNumber = new Map<string, BlockAnchor>();
          for (const anchor of [
            ...store.checkpoints(scope),
            ...store.anchors(scope, { fromBlock: 0n, toBlock: tip.number }),
          ]) {
            if (anchor.number > tip.number) continue;
            const key = anchor.number.toString();
            const existing = byNumber.get(key);
            if (!existing || anchor.timestampSec >= existing.timestampSec)
              byNumber.set(key, anchor);
          }
          return [...byNumber.values()].sort((left, right) =>
            left.number < right.number ? -1 : left.number > right.number ? 1 : 0,
          );
        };
        /** Two local scopes can agree with each other and still hold a superseded
         * branch. Verify each accepted tip against the chain and rewind stale
         * evidence to its last matching ancestor before it is reused. */
        for (const scope of [scopeId, registryScopeId]) {
          const tip = store.acceptedTip(scope);
          if (!tip) continue;
          const current = await reader.getAnchor(tip.number);
          if (
            current.hash.toLowerCase() === tip.hash.toLowerCase() &&
            current.timestampSec === tip.timestampSec
          )
            continue;
          const match = await findMatchingCheckpoint(reader, branchCandidates(scope, tip));
          if (match) {
            store.invalidateAfter(scope, match);
            reconciledBranches.push(`${scope} rewound after block ${match.number}`);
          } else {
            store.resetForWarmup(scope);
            reconciledBranches.push(`${scope} reset without a matching checkpoint`);
          }
        }
        const acquire = async (mode: 'discovery-only' | 'operations', gaps: BlockInterval[]) => {
          const scope = mode === 'operations' ? scopeId : registryScopeId;
          const size = BigInt(
            mode === 'operations' ? config.maxRangeBlocks : config.discoveryMaxRangeBlocks,
          );
          for (const [start, stop] of gaps)
            for (let from = start; from <= stop; from += size) {
              const to = from + size - 1n < stop ? from + size - 1n : stop;
              const end = await reader!.getAnchor(to);
              const batch = await fetchRange(reader!, {
                mode,
                fromBlock: from,
                toBlock: to,
                end,
                previous: null,
                assets,
                pools: readRegistry().registry,
                ...deployments,
                maxRangeBlocks: config.maxRangeBlocks,
                discoveryMaxRangeBlocks: config.discoveryMaxRangeBlocks,
                maxFilterValues: config.maxFilterValues,
                maxLogsPerResponse: config.maxLogsPerResponse,
                logResponseGuard: config.logResponseGuard,
                observedAtMs: Date.now(),
                captureMode: 'backfill',
              });
              store.saveRaw(batch, { compact: true });
              const complete = batch.completeness === 'complete';
              acquired.push({ mode, fromBlock: from, toBlock: to, complete });
              if (!complete) continue;
              const resolution = await resolveLogTimes(reader!, batch.logs, from, end);
              const timed: RecordedRangeBatch = {
                ...batch,
                anchors: resolution.queriedAnchors,
                boundaries: resolution.boundaries,
                logTimes: batch.logs.map((log) => ({
                  ref: log,
                  time: resolution.times.get(rawLogKey(log))!,
                })),
              };
              await reader!.flush?.();
              // A review merges disjoint intervals. Its cursor is not a follow cursor.
              db.transaction(() => {
                db.prepare('delete from scope_cursors where scope_id=?').run(scope);
                store.acceptRange(timed);
              })();
            }
        };
        /** Existing accepted logs can lack minute evidence for several reasons: an
         * earlier provider outage, a partially resolved batch, or a review that ran
         * before boundary support existed. Repair reuses stored raw logs and shares
         * the run's RPC budget instead of requiring a new batch. */
        const repairLogTimes = async (): Promise<void> => {
          for (let pass = 0; pass < 4; pass++) {
            const logs = unresolvedTimeLogs();
            if (logs.length === 0) return;
            const end =
              store
                .anchors(scopeId, { fromBlock: toBlock, toBlock, includeBrackets: true })
                .find((anchor) => anchor.number === toBlock) ?? store.acceptedTip(scopeId);
            if (!end) {
              unavailable.push('time-repair: no stored endpoint anchor');
              return;
            }
            const first = logs.reduce(
              (min, log) => (log.blockNumber < min ? log.blockNumber : min),
              logs[0]!.blockNumber,
            );
            const resolution = await resolveLogTimes(
              reader!,
              logs,
              first,
              end,
              store.anchors(scopeId, {
                fromBlock: first,
                toBlock: end.number,
                includeBrackets: true,
              }),
              store.boundaries(scopeId, {
                sinceSec: 0,
                untilSec: end.timestampSec,
                includeBrackets: true,
              }),
            );
            const wrote = store.recordLogTimes(scopeId, {
              anchors: resolution.queriedAnchors,
              boundaries: resolution.boundaries,
              logTimes: logs.map((log) => ({
                ref: log,
                time: resolution.times.get(rawLogKey(log))!,
              })),
            });
            if (resolution.failures.length > 0)
              unavailable.push(
                'time-repair: ' + (resolution.failures[0]?.reason ?? 'boundary-unavailable'),
              );
            if (wrote === 0) return;
          }
          if (unresolvedTimeLogs().length > 0)
            unavailable.push('time-repair: unresolved time evidence remains');
        };
        await acquire('discovery-only', readRegistry().missing);
        if (readRegistry().missing.length === 0)
          await acquire('operations', missingIntervals(fromBlock, toBlock, operationCoverage()));
        else
          unavailable.push(
            'discovery-incomplete: operation gaps were not fetched with an incomplete pool registry',
          );
        await repairLogTimes();
        // The plan allows run to supplement the endpoint anchors the fixed range
        // needs; the offline window check remains the authority afterwards.
        for (const block of endpointAnchorsMissing()) {
          const anchor = await reader!.getAnchor(block);
          store.recordLogTimes(scopeId, { anchors: [anchor] });
        }
        if (
          options.requiredContext &&
          contextUnproven(store, scopeId, fromBlock, toBlock, options.requiredContext)
        )
          unavailable.push(
            'analysis-window-unproven: recorded anchors do not contain the analysis period and its context',
          );
      } catch (error) {
        if (!(error instanceof FixedTargetStale)) {
          const classified = classifyRpcError(error);
          unavailable.push(
            error instanceof ConfigError
              ? error.message
              : 'Historical acquisition ' + classified.kind + '; see request evidence',
          );
        }
      } finally {
        if (reader) rpcSummary = reader.meter.summary();
        try {
          await reader?.close?.();
        } catch {
          unavailable.push('Request evidence close failed');
        }
        reader = undefined;
      }
    }
    const missing = missingIntervals(fromBlock, toBlock, operationCoverage());
    const registryState = readRegistry();
    const registryMissing = registryState.missing;
    const coveredRanges = missingIntervals(fromBlock, toBlock, missing);
    const logs = store
      .activeLogs(scopeId)
      .filter(
        (log) =>
          log.blockNumber >= fromBlock &&
          log.blockNumber <= toBlock &&
          !missing.some(([from, to]) => log.blockNumber >= from && log.blockNumber <= to),
      );
    const times = store.logTimes(scopeId);
    const registry = registryState.registry;
    const end =
      store.anchors(scopeId).find((a) => a.number === toBlock) ??
      store.anchors(registryScopeId).find((a) => a.number === toBlock) ??
      null;
    // projectRange's end is metadata; an unknown endpoint must remain explicit in the report.
    const projectionAnchor = end ?? store.acceptedTip(scopeId);
    const projection = projectionAnchor
      ? projectRange(
          { id: 'history', scopeId, end: projectionAnchor, completeness: 'complete' },
          logs,
          times,
          registry,
        )
      : null;
    const metadataCheck = reconcileMetricMetadata(
      readCachedMetricMetadata(
        db,
        options.metadata ?? loadMetricMetadata('config/metric-metadata.json'),
      ),
      [
        ...store.anchors(scopeId),
        ...store.anchors(registryScopeId),
        ...logs.map((l) => ({ number: l.blockNumber, hash: l.blockHash })),
      ],
    );
    const valuations: SwapValuation[] = [];
    const valuedByRwa = new Map<string, SwapValuation[]>();
    const quotes = createQuoteIndex();
    const registrations = registry.snapshot();
    for (const event of projection?.events ?? []) {
      if (event.kind !== 'swap') continue;
      const registration = registrations.find(
        (p) => poolRegistrationId(p) === poolRegistrationId(event),
      );
      if (!registration) continue;
      const related = assets.addresses.filter(
        (a) => a === registration.token0 || a === registration.token1,
      );
      let canonical: SwapValuation | null = null;
      for (const rwa of related) {
        const token = (address: Address) => ({
          address,
          decimals: decimalsAt(metadataCheck.metadata, address, event.ref.blockNumber),
          role:
            address === config.tokens.USDG
              ? ('usdg' as const)
              : assets.has(address)
                ? ('rwa' as const)
                : ('other' as const),
        });
        const metadata: SwapValuationMetadata = {
          token0: token(registration.token0),
          token1: token(registration.token1),
          rwa,
          usdg: config.tokens.USDG,
          usdgDecimals: decimalsAt(
            metadataCheck.metadata,
            config.tokens.USDG,
            event.ref.blockNumber,
          ),
          maxQuoteAgeSec: 60,
        };
        const side = valueSwap(event, metadata, quotes);
        valuedByRwa.set(rwa, [...(valuedByRwa.get(rwa) ?? []), side]);
        if (!canonical || (canonical.usdMicros === null && side.usdMicros !== null))
          canonical = side;
        const quote = quoteFromRwaUsdgSwap(event, metadata);
        if (quote) addQuote(quotes, quote);
      }
      if (canonical) valuations.push(canonical);
    }
    const activity = assets.assets.map((asset) => {
      const observed = aggregateRwa(valuedByRwa.get(asset.address) ?? []);
      const intervalComplete =
        missing.length === 0 &&
        registryMissing.length === 0 &&
        projection !== null &&
        !projection.qualityErrors.some((e) => e.code !== 'unresolved-time');
      return {
        asset,
        intervalComplete,
        coveredSubset:
          coveredRanges.length > 0 && registryMissing.length === 0 && projection !== null
            ? { ranges: coveredRanges, activity: observed }
            : null,
        intervalTotal: intervalComplete ? observed : null,
      };
    });
    const report = {
      valuations,
      activity,
      metadataConflicts: metadataCheck.conflicts,
      version: 'history-v2',
      sourceDatabase: resolve(options.databasePath),
      databasePath,
      scopeId,
      registryScopeId,
      fromBlock,
      toBlock,
      sourceHash: digest({
        metadata: metadataCheck.metadata,
        metadataConflicts: metadataCheck.conflicts,
        logs,
        times: logs.map((l) => times.get(rawLogKey(l)) ?? null),
        registry: registry.snapshot(),
        registryFromBlock: floor,
        registryMissing,
        missing,
      }),
      localMissing,
      localRegistryMissing,
      registryFromBlock: floor,
      registryMissing,
      missing,
      acquired,
      unavailable,
      reconciled: reconciledBranches,
      rpc: rpcSummary,
      complete: missing.length === 0 && registryMissing.length === 0,
      requiredContext: options.requiredContext ?? null,
      contextProven:
        options.requiredContext === undefined
          ? null
          : !contextUnproven(store, scopeId, fromBlock, toBlock, options.requiredContext),
      end,
      projection,
      rawLogs: projection ? undefined : logs,
      context: {
        chainCanonicality:
          'Recorded evidence snapshot; complete local ranges are not revalidated by RPC',
        window:
          'Inclusive block interval; first/last minutes may be partial. Events outside the interval are excluded.',
        valuation:
          'Same valueSwap and aggregateRwa units as live metrics: native raw tokens, USDG raw and USD micros (USDG=1 USD assumption). Metadata is carried forward only from its observed block; missing/conflicting metadata stays unpriced. Quotes only use preceding swaps inside this interval; no pre-range quote warmup.',
        poolRegistry:
          'Registry is reconstructed from accepted discovery logs from recorded verified deployment floor through to-block. Discovery gaps are independently incomplete. Operation selector coverage is revalidated against that registry; newly discovered pools invalidate previously narrower operation coverage.',
        projectionAnchor:
          'Projection end metadata uses the recorded scope tip when the requested endpoint anchor is unknown; it is not interval-end evidence.',
        endpoint: end
          ? 'recorded-anchor'
          : 'unknown: no stored anchor exactly at to-block; raw interval evidence is retained',
      },
    };
    saveJson(resolve(out, 'history-report.json'), report, out);
    return report;
  } finally {
    db.close();
  }
}
