import {
  buildRollingMetrics,
  ROLLING_DURATIONS,
  inRollingWindow,
  rollingCoverage,
  type RollingWindowName,
} from '../metrics/rolling.js';
import { readCachedMetricMetadata } from './token-metadata.js';
import { CHAIN_ID } from '../domain/chain.js';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { Address } from 'viem';
import type { AssetRegistry } from '../registry/assets.js';
import { PoolRegistry, poolRegistrationId, type PoolRegistration } from '../registry/pools.js';
import { SqliteRangeStore } from './raw-store.js';
import { SqliteProjectionStore, type StoredProjection } from './projection-store.js';
import { LiveProjectionStore, type LiveProjectionChanges } from './live-projection.js';
import type { RegistryView } from './registry-cache.js';
import type { LiveEventIndex } from './live-event-index.js';
import { LiveMetricCache } from './live-metric-cache.js';
import { encodeJson } from '../domain/json.js';
import type { LiquidityChange, PoolEvent, QuoteObservation, Swap } from '../domain/types.js';
import { comparePosition } from '../state/observations.js';
import { rawLogKey } from './manifest.js';
import { readMetricCoverage } from '../metrics/coverage.js';
import { decimalsAt, reconcileMetricMetadata, type MetricMetadata } from '../metrics/metadata.js';
import { valueSwap, type SwapValuationMetadata, type SwapValuation } from '../metrics/notional.js';
import { findPrecedingQuote, quoteFromRwaUsdgSwap } from '../metrics/price.js';
import { aggregateRwa } from '../metrics/rwa-aggregate.js';
import { buildMinuteMetrics, type MetricEvent } from '../metrics/windows.js';
import { summarizeLiquidityActions, annotateLatestSwapLiquidity } from '../metrics/liquidity.js';
import { estimateGrossSwapFee } from '../metrics/fees.js';
import { measureStage, type BatchTimings } from '../ops/batch-timings.js';
import { valuationIndexFor, valuationKey } from '../metrics/valuation-index.js';

export const METRIC_VERSION = 'rolling-v1';
export class StaleMetricProjectionError extends Error {
  constructor() {
    super('P2 projection is stale or missing; run project --rebuild');
    this.name = 'StaleMetricProjectionError';
  }
}
export interface MetricInput {
  scopeId: string;
  registryScopeId: string;
  configVersion: string;
  assets: AssetRegistry;
  usdg: Address;
  metadata: MetricMetadata;
}
export type MetricsReport = ReturnType<typeof buildMetricsReport>;

/** What one report covers: the whole catalogue, or the pools a bounded live round selected. */
export type MetricSelection = { kind: 'all' } | { kind: 'pools'; poolIds: readonly string[] };

/** The bounded context a selected round reads through, resolved once so the build reads plainly. */
type WorksetContext = {
  /** The requested pools, sorted and deduplicated, exactly as the report names them. */
  poolIds: readonly string[];
  /** The same pools as a lookup, which is how every event is checked against the selection. */
  index: ReadonlySet<string>;
  registry: RegistryView;
  eventIndex: LiveEventIndex;
  /** What the round that accepted this batch did to the window, when the caller has it. */
  changes: LiveProjectionChanges | undefined;
};

/**
 * The workset a live round evaluates, or null for the full catalogue.
 *
 * A selection is meaningless without the state it was selected against: the registry says what the
 * selected pools are, and the event index is the window those pools' valuations read. Both are
 * required together, and neither is read for a full round — which is what keeps an offline reader
 * and the audit path on exactly the path they had.
 */
function resolveWorkset(live: MetricBuildOptions['live']): WorksetContext | null {
  const requested = live?.poolIds;
  if (requested === undefined) return null;
  if (!live?.registry || !live.eventIndex)
    throw new Error('A pool selection needs the registry view and the event index that own it');
  return {
    poolIds: [...requested].sort(),
    index: new Set(requested),
    registry: live.registry,
    eventIndex: live.eventIndex,
    changes: live.changes,
  };
}

/** A single SQLite read snapshot covers freshness, decoded input, registration and
 * minute evidence. Consumers never read naked projected_events or cached metrics. */
export interface MetricBuildOptions {
  /** Reproduce the explicitly selected legacy minute-close replay format. */
  legacyWindows?: boolean;
  /** Read-model evidence for independent stock-side aggregation. */
  includeAssetValuations?: boolean;
  live?: {
    historyMinutes: number;
    /**
     * The pools this round evaluates. Absent evaluates every registered pool, which is what an
     * offline reader does; a set evaluates exactly those pools plus the windowed swaps that price
     * them, and reports for them exactly what the full read would.
     */
    poolIds?: ReadonlySet<string>;
    registry?: RegistryView;
    eventIndex?: LiveEventIndex;
    /**
     * What the round that accepted this batch did to the window. The sync inside this build is one
     * the caller already ran, so its own delta is empty by proof and the caller's is the one that
     * names what moved.
     */
    changes?: LiveProjectionChanges;
  };
  projection?: StoredProjection;
  /** Present only for a timed live batch; offline readers pass nothing. */
  timings?: BatchTimings;
}
export function buildMetricsReport(
  db: Database.Database,
  input: MetricInput,
  options: MetricBuildOptions = {},
) {
  return db.transaction(() => {
    input = { ...input, metadata: readCachedMetricMetadata(db, input.metadata) };
    // Live recording has its own cursor. Legacy offline databases keep their strict
    // explicit-project freshness contract; readonly CLI inspection never writes.
    if (
      !options.live &&
      !options.projection &&
      db
        .prepare(
          "select 1 from sqlite_master where type='table' and name='live_projection_cursors'",
        )
        .get() &&
      db.prepare('select 1 from live_projection_cursors where scope_id=?').get(input.scopeId)
    )
      options = { ...options, live: { historyMinutes: 180 } };
    const raw = new SqliteRangeStore(db);
    const tip = raw.acceptedTip(input.scopeId);
    const workset = resolveWorkset(options.live);
    const selection: MetricSelection = workset
      ? { kind: 'pools', poolIds: workset.poolIds }
      : { kind: 'all' };
    const historyMinutes = options.live?.historyMinutes ?? 180;
    if (!Number.isSafeInteger(historyMinutes) || historyMinutes < 65 || historyMinutes > 10080)
      throw new RangeError('Metric horizon must be 65..10080 minutes');
    const sinceSec =
      options.live && tip ? Math.floor(tip.timestampSec / 60) * 60 - historyMinutes * 60 : null;
    const liveStore = options.live ? new LiveProjectionStore(db) : null;
    let synced: LiveProjectionChanges | null = null;
    if (liveStore && !db.readonly)
      synced = measureStage(options.timings, 'projection', () =>
        liveStore.sync(input.scopeId, input.registryScopeId, input.configVersion),
      );
    const changes = workset?.changes ?? synced;
    const projection = measureStage(
      options.timings,
      'projection',
      () =>
        options.projection ??
        (liveStore
          ? workset
            ? liveStore.readSelected(
                input.scopeId,
                input.registryScopeId,
                input.configVersion,
                sinceSec! - 120,
                {
                  pools: workset.index,
                  tokens: workset.poolIds.flatMap((poolId) => {
                    const registration = workset.registry.get(poolId);
                    return registration ? [registration.token0, registration.token1] : [];
                  }),
                  index: workset.eventIndex,
                },
              )
            : liveStore.read(
                input.scopeId,
                input.registryScopeId,
                input.configVersion,
                sinceSec! - 120,
              )
          : new SqliteProjectionStore(db).read(
              input.scopeId,
              input.registryScopeId,
              input.configVersion,
            )),
    );
    if (!projection) throw new StaleMetricProjectionError();
    const cache = options.live && !db.readonly ? new LiveMetricCache(db, input.scopeId) : null;
    const metadataAnchors = options.live
      ? input.metadata.entries.flatMap((entry) => {
          const height = Number(entry.observedAtBlock);
          if (!Number.isSafeInteger(height)) return [];
          return (
            db
              .prepare(
                'select block_number,block_hash from anchors where scope_id in (?,?) and block_number=? union select r.block_number,r.block_hash from raw_logs r where r.block_number=? and exists (select 1 from active_logs a where a.raw_log_id=r.id and a.scope_id=?)',
              )
              .all(input.scopeId, input.registryScopeId, height, height, input.scopeId) as {
              block_number: number;
              block_hash: string;
            }[]
          ).map((row) => ({ number: BigInt(row.block_number), hash: row.block_hash as Address }));
        })
      : [
          ...raw.anchors(input.scopeId),
          ...raw.anchors(input.registryScopeId),
          ...projection.events.map((e) => ({ number: e.ref.blockNumber, hash: e.ref.blockHash })),
        ];
    const metadataCheck = reconcileMetricMetadata(input.metadata, metadataAnchors);
    const metricMetadata = metadataCheck.metadata;
    // A selected round already holds the catalogue it selected from; reading `pools` again would be
    // the catalogue read the workset exists to avoid. A full round reads it exactly as before.
    const registrations: readonly PoolRegistration[] = workset
      ? workset.poolIds.flatMap((poolId) => {
          const registration = workset.registry.get(poolId);
          return registration === undefined ? [] : [registration];
        })
      : measureStage(
          options.timings,
          'registry',
          () =>
            new PoolRegistry([...raw.pools(input.registryScopeId), ...raw.pools(input.scopeId)]),
        ).snapshot();
    const absentPoolIds = workset
      ? workset.poolIds.filter((poolId) => workset.registry.get(poolId) === undefined)
      : [];
    const byId = new Map(registrations.map((r) => [poolRegistrationId(r), r]));
    /** The registration of an event: the workset's own view for a pool it did not select. */
    const registrationFor = (event: Swap): PoolRegistration | undefined => {
      const id = poolRegistrationId(event);
      return byId.get(id) ?? workset?.registry.get(id);
    };
    /** Whether this round reports the event at all — every event, unless a workset bounds it. */
    const inSelection = (event: PoolEvent): boolean => {
      if (workset === null) return true;
      // An ancillary event that names no pool belongs to no selected pool either.
      if (event.pool === null) return false;
      return workset.index.has(poolRegistrationId({ pool: event.pool }));
    };
    // A bounded round is the round that repeats: the same pools, valued again one batch later. The
    // index holds what that round already computed, so the work a bounded round removes is not
    // replaced by re-serializing and re-decoding the same valuation from the durable cache.
    const valuationIndex = workset ? valuationIndexFor(db, input.scopeId) : null;
    if (valuationIndex) {
      // A quote that was deleted is named by the valuations that used it, so a key cannot see its
      // disappearance, and a reader with no journal to read cannot see the arrival of one either.
      // Both cases hand the index back empty; only a round that knows exactly which swaps moved
      // keeps what it held.
      if (!changes || changes.eventDelta === undefined || changes.eventDelta.deletedKeys.length > 0)
        valuationIndex.clear();
      else
        for (const upsert of changes.eventDelta.upserts)
          if (upsert.kind === 'swap')
            valuationIndex.invalidateQuotesAfter([upsert.tokenIn, upsert.tokenOut], upsert.ref);
      // The window only ever moves forward, so an event the reader did not read this round is an
      // event no later round can ask about either. Expiring to the read's own lower bound — not to
      // `sinceSec` — is what keeps the two minutes of margin the read buys: a swap just below
      // `sinceSec` is not reported, but it is still read, and it still prices what is.
      if (sinceSec !== null)
        valuationIndex.expireOutside({ sinceSec: sinceSec - 120, sinceBlock: null });
    }
    const rawCoverage = measureStage(options.timings, 'coverage', () =>
      readMetricCoverage(
        db,
        input.scopeId,
        projection.qualityErrors,
        projection.end,
        historyMinutes,
        !!options.live,
      ),
    );
    const coverage = projection.windowContextIncomplete
      ? rawCoverage.map((c) => ({
          ...c,
          complete: false,
          reasons: [...c.reasons, 'unknown-time-window-boundary'],
        }))
      : rawCoverage;
    const retained = options.live
      ? {
          fromBlock: coverage.find((c) => c.fromBlock !== null)?.fromBlock ?? null,
          toBlock: projection.end.number,
        }
      : (db
          .prepare(
            'select min(from_block) as fromBlock,max(to_block) as toBlock from accepted_ranges where scope_id=?',
          )
          .safeIntegers(true)
          .get(input.scopeId) as { fromBlock: bigint | null; toBlock: bigint | null });
    if (!options.live)
      for (const event of projection.events) {
        const block = event.ref.blockNumber;
        if (retained.fromBlock === null || block < retained.fromBlock) retained.fromBlock = block;
        if (retained.toBlock === null || block > retained.toBlock) retained.toBlock = block;
      }
    const quotes: QuoteObservation[] = [];
    const valuations: SwapValuation[] = [];
    const metricEvents: MetricEvent[] = [];
    const valuedByRwa = new Map<string, SwapValuation[]>();
    // One measured leaf around swap valuation; the projections read above and the
    // window assembly below are measured separately, so no interval is counted twice.
    measureStage(options.timings, 'valuation', () => {
      for (const event of [...projection.events].sort((a, b) => comparePosition(a.ref, b.ref))) {
        const selected = inSelection(event);
        let valuation: SwapValuation | null = null;
        if (event.kind === 'swap') {
          const registration = registrationFor(event);
          if (!registration) throw new Error('Projected swap lacks registration');
          const related = input.assets.assets.filter(
            (a) => a.address === registration.token0 || a.address === registration.token1,
          );
          const inWindow =
            sinceSec === null ||
            event.time.minuteStartSec === null ||
            event.time.minuteStartSec >= sinceSec;
          for (const asset of related) {
            const token = (address: Address) => ({
              address,
              decimals: decimalsAt(metricMetadata, address, event.ref.blockNumber),
              role:
                address === input.usdg
                  ? ('usdg' as const)
                  : input.assets.has(address)
                    ? ('rwa' as const)
                    : ('other' as const),
            });
            const metadata: SwapValuationMetadata = {
              token0: token(registration.token0),
              token1: token(registration.token1),
              rwa: asset.address,
              usdg: input.usdg,
              usdgDecimals: decimalsAt(metricMetadata, input.usdg, event.ref.blockNumber),
              maxQuoteAgeSec: 60,
            };
            // A pool the round did not select is in the walk for one reason only: a selected pool
            // reads its quote. It publishes that quote at this point in the order and nothing else
            // about it enters the report — no valuation, no window, no count.
            if (!selected) {
              const quote = quoteFromRwaUsdgSwap(event, metadata);
              if (quote) quotes.push(quote);
              continue;
            }
            const hasUsdg =
              registration.token0 === input.usdg || registration.token1 === input.usdg;
            const preceding = hasUsdg
              ? null
              : findPrecedingQuote(event, asset.address, input.usdg, quotes, 60);
            // The durable cache survives a restart; the index sits in front of it so a round that
            // values the same window again does not re-serialize the input and decode the payload.
            const compute = () =>
              cache
                ? cache.memo(
                    'valuation:' + rawLogKey(event.ref) + ':' + asset.address,
                    event.time.minuteStartSec ?? Math.floor(projection.end.timestampSec / 60) * 60,
                    { event, metadata, preceding },
                    () => valueSwap(event, metadata, preceding ? [preceding] : []),
                  )
                : valueSwap(event, metadata, quotes);
            const side = valuationIndex
              ? valuationIndex.lookup(
                  valuationKey({
                    eventId: rawLogKey(event.ref),
                    event,
                    metadata,
                    preceding,
                  }),
                  [asset.address],
                  event,
                  compute,
                )
              : compute();
            if (inWindow) {
              const group = valuedByRwa.get(asset.address) ?? [];
              group.push(side);
              valuedByRwa.set(asset.address, group);
            }
            // One pool contribution, preferring the first priced stock in stable address order.
            // Stock aggregates retain each side's own raw amount and as-of valuation.
            if (!valuation || (valuation.usdMicros === null && side.usdMicros !== null))
              valuation = side;
            const quote = quoteFromRwaUsdgSwap(event, metadata);
            if (quote) quotes.push(quote);
          }
          if (selected && inWindow && valuation) valuations.push(valuation);
        }
        if (!selected) {
          // A liquidity change of a pool outside the selection counts towards nothing above.
          continue;
        }
        metricEvents.push({
          event,
          scopeId: input.scopeId,
          usdMicros: valuation?.usdMicros ?? null,
          usdgNotionalRaw: valuation?.usdgNotionalRaw ?? null,
          rawNotional: valuation
            ? { token: valuation.nativeToken, raw: valuation.nativeAmountRaw }
            : null,
        });
      }
    });
    const windows = measureStage(options.timings, 'windows', () =>
      (options.legacyWindows ? buildMinuteMetrics : buildRollingMetrics)(
        sinceSec === null
          ? metricEvents
          : metricEvents.filter(
              (m) =>
                m.event.time.minuteStartSec === null || m.event.time.minuteStartSec >= sinceSec,
            ),
        coverage,
        projection.end,
        {
          memo: cache
            ? (key, at, value, compute) => cache.memo(key, at, value, compute)
            : undefined,
          pools: registrations.map((r) => ({
            pool: r.pool,
            discoveredAtBlock: r.source === 'seed-config' ? null : r.discoveredAt.blockNumber,
            rawToken:
              r.token0 === input.usdg || r.token1 === input.usdg
                ? input.usdg
                : (input.assets.addresses.find((a) => a === r.token0 || a === r.token1) ?? null),
          })),
        },
      ),
    );
    const current = Math.floor(projection.end.timestampSec / 60) * 60;
    const rwa = input.assets.assets.map((asset) => {
      const swaps = valuedByRwa.get(asset.address) ?? [];
      return {
        asset,
        valuations: options.includeAssetValuations ? swaps : undefined,
        poolIds: registrations
          .filter((r) => r.token0 === asset.address || r.token1 === asset.address)
          .map(poolRegistrationId),
        blockRangeActivity: {
          ...aggregateRwa(swaps),
          ...retained,
          coverageVerified: false as const,
        },
        rolling: Object.fromEntries(
          Object.entries(ROLLING_DURATIONS).map(([name, duration]) => {
            const endSec = projection.end.timestampSec,
              startSec = endSec - duration;
            const reasons = rollingCoverage(coverage, startSec, endSec, endSec);
            const selected = swaps.filter((s) => {
              const inside = inRollingWindow(s.time, startSec, endSec, true);
              if (inside === null) reasons.push('boundary-time-unknown');
              return inside === true;
            });
            const available = reasons.length === 0;
            return [
              name,
              {
                startSec,
                endSec,
                available,
                reasons: [...new Set(reasons)],
                activity: available ? aggregateRwa(selected) : null,
              },
            ];
          }),
        ) as Record<
          RollingWindowName,
          {
            startSec: number;
            endSec: number;
            available: boolean;
            reasons: string[];
            activity: ReturnType<typeof aggregateRwa> | null;
          }
        >,
      };
    });
    const observationByPool = new Map<string, (typeof projection.observations)[number]>();
    for (const observation of projection.observations) {
      const poolId = poolRegistrationId(observation);
      if (!observationByPool.has(poolId)) observationByPool.set(poolId, observation);
    }
    const recentLiquidityByPool = new Map<string, LiquidityChange[]>();
    for (const event of projection.events) {
      if (
        !inSelection(event) ||
        event.kind !== 'liquidity' ||
        event.time.minuteStartSec === null ||
        event.time.minuteStartSec < current - 300 ||
        event.time.minuteStartSec > current
      )
        continue;
      const poolId = poolRegistrationId(event);
      const actions = recentLiquidityByPool.get(poolId) ?? [];
      actions.push(event);
      recentLiquidityByPool.set(poolId, actions);
    }
    const startBoundary = coverage.find((c) => c.minuteStartSec === current - 300)?.fromBlock;
    const annotations = windows.map((w) => {
      const registration = byId.get(w.poolId)!;
      const observation = observationByPool.get(w.poolId)!;
      const actions = recentLiquidityByPool.get(w.poolId) ?? [];
      const isNewPool =
        registration.source === 'seed-config' ||
        startBoundary === null ||
        startBoundary === undefined
          ? null
          : registration.discoveredAt.blockNumber >= startBoundary;
      const recent = w.minutes.filter(
        (m) => m.minuteStartSec >= current - 360 && m.minuteStartSec < current,
      );
      const observedReheat =
        recent.length === 6 && recent.every((m) => m.status === 'closed')
          ? recent.at(-1)!.swapCount! > 0 &&
            recent.slice(-4, -1).every((m) => m.swapCount === 0) &&
            w.minutes.some(
              (m) =>
                m.minuteStartSec < current - 240 && m.status === 'closed' && (m.swapCount ?? 0) > 0,
            )
          : null;
      return {
        poolId: w.poolId,
        pair: { token0: registration.token0, token1: registration.token1 },
        isNewPool,
        observedReheat,
        tagDefinition:
          'new: discovery in last 5 closed minutes; reheat: activity after 3 closed quiet minutes with earlier observed activity; descriptive only',
        actionWindow: { startSec: current - 300, endSec: current + 60, includesPartial: true },
        liquidity: summarizeLiquidityActions(actions),
        lastSwap: annotateLatestSwapLiquidity(observation, projection.end),
      };
    });
    const metricVersion = options.legacyWindows ? 'p3-v4-legacy' : METRIC_VERSION;
    const sourceHash = createHash('sha256')
      .update(
        encodeJson({
          version: metricVersion,
          projectionSourceHash: projection.sourceHash,
          usdg: input.usdg,
          assets: input.assets.assets,
          coverage,
          metadata: metricMetadata,
          metadataConflicts: metadataCheck.conflicts,
          // Naming the selection keeps a bounded round's identity apart from the full report's: the
          // two carry different windows, and a stored hash may not claim they are the same report.
          ...(workset ? { selection: workset.poolIds } : {}),
        }),
      )
      .digest('hex');
    if (cache && sinceSec !== null) cache.expireBefore(sinceSec - 120);
    return {
      liveSinceSec: sinceSec,
      windowContextIncomplete: projection.windowContextIncomplete === true,
      version: metricVersion,
      chainId: CHAIN_ID,
      scopeId: input.scopeId,
      registryScopeId: input.registryScopeId,
      configVersion: input.configVersion,
      assetVersion: input.assets.version,
      selection,
      sourceHash,
      projectionSourceHash: projection.sourceHash,
      metadata: metricMetadata,
      metadataConflicts: metadataCheck.conflicts,
      at: projection.end,
      finality: 'provisional' as const,
      timing: 'minute or verified second; unknown exact seconds remain null',
      qualityErrors: projection.qualityErrors,
      coverage,
      windows,
      rwa,
      annotations,
      valuations,
      quotes,
      grossFees: projection.events
        .filter(inSelection)
        .filter(
          (e) =>
            sinceSec === null ||
            e.time.minuteStartSec === null ||
            e.time.minuteStartSec >= sinceSec,
        )
        .filter((e) => e.kind === 'swap')
        .map((s) => ({
          eventId: rawLogKey(s.ref),
          estimate: estimateGrossSwapFee(
            s.amountIn,
            s.effectiveSwapFeePips,
            s.tokenIn,
            'raw token units',
          ),
        })),
      notes: [
        ...(options.live
          ? [
              'Realtime report retains only the configured baseline horizon; blockRangeActivity describes this hot window, not lifetime activity.',
            ]
          : []),
        'USDG = USD is a display assumption, not a verified dollar peg.',
        'Cached decimals are carried forward from their recorded identity anchor; unknown tokens and earlier history remain unpriced.',
        'Pool activity sums count each pool Swap once; multi-hop activity is not unique-user volume.',
        'Shared stock pools count once in each stock aggregate with independent raw amounts and quotes; summing stock aggregates is not deduplicated market volume.',
        'Co-occurrence is only same-transaction evidence, not a complete route or user count.',
        'Fees are gross trade estimates; current pool L, dollar withdrawals and LP net return are unknown.',
        ...(workset
          ? [
              'Selected-pool report: stock aggregates, pool counts and market totals cover only the pools named in selection, not the full catalogue.',
              ...(absentPoolIds.length > 0
                ? [
                    `Selected-pool report: ${absentPoolIds.length} of ${workset.poolIds.length} requested pools are absent from the registry and contribute no window.`,
                  ]
                : []),
            ]
          : []),
      ],
    };
  })();
}

/** Persist audit material atomically. Public reads recompute from a fresh P2
 * snapshot, so old table rows cannot accidentally become current heat. */
export class SqliteMetricStore {
  constructor(private readonly db: Database.Database) {}
  replace(report: MetricsReport): void {
    this.db
      .transaction(() => {
        this.db.prepare('delete from metric_windows where scope_id=?').run(report.scopeId);
        const insert = this.db.prepare(
          'insert into metric_windows(scope_id,pool_id,minute_start_sec,source_hash,payload_json) values(?,?,?,?,?)',
        );
        for (const window of report.windows)
          for (const minute of window.minutes)
            insert.run(
              report.scopeId,
              window.poolId,
              minute.minuteStartSec,
              report.sourceHash,
              encodeJson(minute),
            );
        this.db
          .prepare(
            `insert into metric_cursors(scope_id,version,source_hash,projection_source_hash,block_number,block_hash,payload_json) values(?,?,?,?,?,?,?) on conflict(scope_id) do update set version=excluded.version,source_hash=excluded.source_hash,projection_source_hash=excluded.projection_source_hash,block_number=excluded.block_number,block_hash=excluded.block_hash,payload_json=excluded.payload_json`,
          )
          .run(
            report.scopeId,
            report.version,
            report.sourceHash,
            report.projectionSourceHash,
            report.at.number.toString(),
            report.at.hash,
            encodeJson(report),
          );
      })
      .immediate();
  }
}
