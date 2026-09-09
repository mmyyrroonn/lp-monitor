import { CHAIN_ID } from '../domain/chain.js';
import { ConfigError } from '../config/env.js';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { Address } from 'viem';
import type { AssetRegistry } from '../registry/assets.js';
import { PoolRegistry, poolRegistrationId } from '../registry/pools.js';
import { SqliteRangeStore } from './raw-store.js';
import { SqliteProjectionStore } from './projection-store.js';
import { encodeJson } from '../domain/json.js';
import type { LiquidityChange, QuoteObservation } from '../domain/types.js';
import { comparePosition } from '../state/observations.js';
import { rawLogKey } from './manifest.js';
import { readMetricCoverage } from '../metrics/coverage.js';
import { decimalsAt, reconcileMetricMetadata, type MetricMetadata } from '../metrics/metadata.js';
import { valueSwap, type SwapValuationMetadata, type SwapValuation } from '../metrics/notional.js';
import { quoteFromRwaUsdgSwap } from '../metrics/price.js';
import { aggregateRwa } from '../metrics/rwa-aggregate.js';
import { buildMinuteMetrics, type MetricEvent } from '../metrics/windows.js';
import { summarizeLiquidityActions, annotateLatestSwapLiquidity } from '../metrics/liquidity.js';
import { estimateGrossSwapFee } from '../metrics/fees.js';

export const METRIC_VERSION = 'p3-v2';
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

/** A single SQLite read snapshot covers freshness, decoded input, registration and
 * minute evidence. Consumers never read naked projected_events or cached metrics. */
export function buildMetricsReport(db: Database.Database, input: MetricInput) {
  return db.transaction(() => {
    const projection = new SqliteProjectionStore(db).read(
      input.scopeId,
      input.registryScopeId,
      input.configVersion,
    );
    if (!projection) throw new StaleMetricProjectionError();
    const raw = new SqliteRangeStore(db);
    const metadataCheck = reconcileMetricMetadata(input.metadata, [
      ...raw.anchors(input.scopeId),
      ...raw.anchors(input.registryScopeId),
      ...projection.events.map((e) => ({ number: e.ref.blockNumber, hash: e.ref.blockHash })),
    ]);
    const metricMetadata = metadataCheck.metadata;
    const registry = new PoolRegistry([
      ...raw.pools(input.registryScopeId),
      ...raw.pools(input.scopeId),
    ]);
    const registrations = registry.snapshot();
    // Multi-asset watchlists are supported; a shared RWA/RWA pool needs an
    // explicit attribution contract before its activity can be published.
    for (const registration of registrations) {
      const related = input.assets.addresses.filter(
        (address) => address === registration.token0 || address === registration.token1,
      );
      if (related.length > 1)
        throw new ConfigError(
          `Multiple watched RWA assets in pool ${poolRegistrationId(registration)} are unsupported`,
        );
    }
    const byId = new Map(registrations.map((r) => [poolRegistrationId(r), r]));
    const retained = db
      .prepare(
        'select min(from_block) as fromBlock, max(to_block) as toBlock from accepted_ranges where scope_id=?',
      )
      .safeIntegers(true)
      .get(input.scopeId) as { fromBlock: bigint | null; toBlock: bigint | null };
    // Invalidation can remove a whole accepted interval while retaining earlier
    // active events. Bounds describe the retained envelope, not proven coverage.
    for (const event of projection.events) {
      const block = event.ref.blockNumber;
      if (retained.fromBlock === null || block < retained.fromBlock) retained.fromBlock = block;
      if (retained.toBlock === null || block > retained.toBlock) retained.toBlock = block;
    }
    const coverage = readMetricCoverage(
      db,
      input.scopeId,
      projection.qualityErrors,
      projection.end,
    );
    const quotes: QuoteObservation[] = [];
    const valuations: SwapValuation[] = [];
    const metricEvents: MetricEvent[] = [];
    const valuedByRwa = new Map<string, SwapValuation[]>();
    for (const event of [...projection.events].sort((a, b) => comparePosition(a.ref, b.ref))) {
      let valuation: SwapValuation | null = null;
      if (event.kind === 'swap') {
        const registration = byId.get(poolRegistrationId(event));
        if (!registration) throw new Error('Projected swap lacks registration');
        const related = input.assets.assets.filter(
          (a) => a.address === registration.token0 || a.address === registration.token1,
        );
        const rwa = related[0]?.address;
        if (rwa) {
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
            rwa,
            usdg: input.usdg,
            usdgDecimals: decimalsAt(metricMetadata, input.usdg, event.ref.blockNumber),
            maxQuoteAgeSec: 60,
          };
          valuation = valueSwap(event, metadata, quotes);
          valuations.push(valuation);
          for (const asset of related) {
            const group = valuedByRwa.get(asset.address) ?? [];
            group.push(valuation);
            valuedByRwa.set(asset.address, group);
          }
          // Appending after valuation makes as-of order explicit even though the
          // price helper also enforces it. No source event is retimestamped.
          const quote = quoteFromRwaUsdgSwap(event, metadata);
          if (quote) quotes.push(quote);
        }
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
    const windows = buildMinuteMetrics(metricEvents, coverage, projection.end, {
      pools: registrations.map((r) => ({
        pool: r.pool,
        discoveredAtBlock: r.source === 'seed-config' ? null : r.discoveredAt.blockNumber,
        rawToken:
          r.token0 === input.usdg || r.token1 === input.usdg
            ? input.usdg
            : (input.assets.addresses.find((a) => a === r.token0 || a === r.token1) ?? null),
      })),
    });
    const current = Math.floor(projection.end.timestampSec / 60) * 60;
    const lastFive = coverage.filter(
      (c) => c.minuteStartSec >= current - 300 && c.minuteStartSec < current,
    );
    const closedFive = lastFive.length === 5 && lastFive.every((c) => c.complete);
    const prefix = coverage.find((c) => c.minuteStartSec === current);
    const prefixAvailable =
      prefix !== undefined &&
      prefix.fromBlock !== null &&
      prefix.toBlock !== null &&
      prefix.reasons.every((r) => r === 'watermark-partial');
    const rwa = input.assets.assets.map((asset) => {
      const swaps = valuedByRwa.get(asset.address) ?? [];
      const recent = swaps.filter(
        (s) =>
          s.time.minuteStartSec !== null &&
          s.time.minuteStartSec >= current - 300 &&
          s.time.minuteStartSec < current,
      );
      return {
        asset,
        poolIds: registrations
          .filter((r) => r.token0 === asset.address || r.token1 === asset.address)
          .map(poolRegistrationId),
        blockRangeActivity: {
          ...aggregateRwa(swaps),
          ...retained,
          coverageVerified: false as const,
        },
        closed5m: {
          startSec: current - 300,
          endSec: current,
          available: closedFive,
          activity: closedFive ? aggregateRwa(recent) : null,
        },
        partialCurrent: {
          startSec: current,
          endSec: current + 60,
          available: prefixAvailable,
          activity: prefixAvailable
            ? aggregateRwa(swaps.filter((s) => s.time.minuteStartSec === current))
            : null,
        },
      };
    });
    const annotations = windows.map((w) => {
      const registration = byId.get(w.poolId)!;
      const observation = projection.observations.find((o) => poolRegistrationId(o) === w.poolId)!;
      const actions = projection.events.filter(
        (e): e is LiquidityChange =>
          e.kind === 'liquidity' &&
          poolRegistrationId(e) === w.poolId &&
          e.time.minuteStartSec !== null &&
          e.time.minuteStartSec >= current - 300 &&
          e.time.minuteStartSec <= current,
      );
      const startBoundary = coverage.find((c) => c.minuteStartSec === current - 300)?.fromBlock;
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
    const sourceHash = createHash('sha256')
      .update(
        encodeJson({
          version: METRIC_VERSION,
          projectionSourceHash: projection.sourceHash,
          usdg: input.usdg,
          assets: input.assets.assets,
          coverage,
          metadata: metricMetadata,
          metadataConflicts: metadataCheck.conflicts,
        }),
      )
      .digest('hex');
    return {
      version: METRIC_VERSION,
      chainId: CHAIN_ID,
      scopeId: input.scopeId,
      registryScopeId: input.registryScopeId,
      configVersion: input.configVersion,
      assetVersion: input.assets.version,
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
        'USDG = USD is a display assumption, not a verified dollar peg.',
        'Cached decimals are carried forward from their recorded identity anchor; unknown tokens and earlier history remain unpriced.',
        'Pool activity sums count each pool Swap once; multi-hop activity is not unique-user volume.',
        'Co-occurrence is only same-transaction evidence, not a complete route or user count.',
        'Fees are gross trade estimates; current pool L, dollar withdrawals and LP net return are unknown.',
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
