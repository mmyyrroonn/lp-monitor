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
import { openDatabase } from '../storage/database.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { rawLogKey, type RecordedRangeBatch } from '../storage/manifest.js';
import { projectRange } from '../state/project-range.js';
import { encodeJson } from '../domain/json.js';
import { createChainReader } from '../rpc/client.js';
import { saveJson } from './files.js';
import {
  loadMetricMetadata,
  reconcileMetricMetadata,
  decimalsAt,
  type MetricMetadata,
} from '../metrics/metadata.js';
import { valueSwap, type SwapValuation, type SwapValuationMetadata } from '../metrics/notional.js';
import { quoteFromRwaUsdgSwap } from '../metrics/price.js';
import { aggregateRwa } from '../metrics/rwa-aggregate.js';
import type { QuoteObservation } from '../domain/types.js';
import type { Address } from 'viem';

export type BlockInterval = [bigint, bigint];
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
function reviveBatch(text: string): RecordedRangeBatch {
  return JSON.parse(text, (key, value: unknown) =>
    ['fromBlock', 'toBlock', 'blockNumber', 'number'].includes(key) &&
    typeof value === 'string' &&
    /^\d+$/.test(value)
      ? BigInt(value)
      : value,
  ) as RecordedRangeBatch;
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
function acceptedCoverage(
  db: Database.Database,
  scope: string,
  plans?: (batch: RecordedRangeBatch) => readonly PlannedFilter[],
): BlockInterval[] {
  const batches = db
    .prepare(
      'select distinct b.payload_json from ingest_batches b join accepted_ranges a on a.batch_id=b.id where a.scope_id=?',
    )
    .all(scope) as { payload_json: string }[];
  const result: BlockInterval[] = [];
  for (const row of batches) {
    try {
      const batch = reviveBatch(row.payload_json);
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
  outputDirectory: string;
  fromBlock: bigint;
  toBlock: bigint;
  config: ChainConfig;
  assets: AssetRegistry;
  environment?: NodeJS.ProcessEnv;
  readerFactory?: typeof createChainReader;
  maxCalls?: number;
  metadata?: MetricMetadata;
}
export async function reviewHistory(options: HistoryOptions) {
  const { fromBlock, toBlock, config, assets } = options;
  if (fromBlock < 0n || toBlock > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ConfigError('History requires safe block bounds');
  if (fromBlock > toBlock) throw new ConfigError('History requires ordered block bounds');
  const out = resolve(options.outputDirectory, 'history-' + randomUUID());
  mkdirSync(resolve(options.outputDirectory), { recursive: true });
  mkdirSync(out);
  const databasePath = resolve(out, 'review.sqlite');
  if (existsSync(options.databasePath)) {
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
  try {
    const localMissing = missingIntervals(fromBlock, toBlock, operationCoverage());
    const localRegistryMissing = readRegistry().missing;
    if (localMissing.length > 0 || localRegistryMissing.length > 0) {
      try {
        reader = (options.readerFactory ?? createChainReader)(
          loadEnv(options.environment ?? process.env),
          {
            maxCalls: options.maxCalls ?? config.recorderMaxRpcCalls,
            perSecond: config.rpcPerSecond,
            timeoutMs: config.timeoutMs,
            maxRetries: config.maxRetries,
            evidenceFile: resolve(out, 'requests.jsonl'),
            evidenceMode: 'full',
          },
        );
        const head = await reader.getAnchor('latest');
        if (toBlock > head.number) throw new ConfigError('History range exceeds available head');
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
              store.saveRaw(batch);
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
        await acquire('discovery-only', readRegistry().missing);
        if (readRegistry().missing.length === 0)
          await acquire('operations', missingIntervals(fromBlock, toBlock, operationCoverage()));
        else
          unavailable.push(
            'discovery-incomplete: operation gaps were not fetched with an incomplete pool registry',
          );
      } catch (error) {
        unavailable.push(
          error instanceof ConfigError
            ? error.message
            : 'Historical acquisition unavailable or incomplete; see request evidence',
        );
      } finally {
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
    const quotes: QuoteObservation[] = [];
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
        if (quote) quotes.push(quote);
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
      complete: missing.length === 0 && registryMissing.length === 0,
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
