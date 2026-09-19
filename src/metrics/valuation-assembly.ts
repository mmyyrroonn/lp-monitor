import type Database from 'better-sqlite3';
import type { Address } from 'viem';
import type { LogRef, PoolEvent, QuoteObservation, Swap } from '../domain/types.js';
import type { AssetRegistration, AssetRegistry } from '../registry/assets.js';
import { poolRegistrationId, type PoolRegistration } from '../registry/pools.js';
import type { RegistryView } from '../storage/registry-cache.js';
import type { LiveMetricCache } from '../storage/live-metric-cache.js';
import { rawLogKey } from '../storage/manifest.js';
import { comparePosition } from '../state/observations.js';
import { decimalsAt, type MetricMetadata } from './metadata.js';
import { valueSwap, type SwapValuationMetadata, type SwapValuation } from './notional.js';
import {
  addQuote,
  createQuoteIndex,
  findPrecedingQuote,
  quoteFromRwaUsdgSwap,
  type QuoteIndex,
} from './price.js';
import type { MetricEvent } from './windows.js';
import { valuationKey, type ValuationIndex } from './valuation-index.js';

export type ValuationAssembly = {
  quotes: QuoteIndex;
  valuations: SwapValuation[];
  metricEvents: MetricEvent[];
  valuedByRwa: Map<string, SwapValuation[]>;
};

/**
 * The valuation pass, extracted from `buildMetricsReport`. It walks the already-sorted events once
 * and produces the four outputs the report reads — the flat quote index, the per-swap valuations,
 * the minute metric events, and the per-RWA valuation buckets. Pure in every input it reads, so a
 * caller can run it over a subset of events and merge the result with a previous round's.
 */
export function assembleValuations(input: {
  events: readonly PoolEvent[]; // already sorted ascending by ref
  registrations: readonly PoolRegistration[];
  assetsByAddress: Map<string, AssetRegistration>;
  assets: AssetRegistry;
  usdg: Address;
  metadata: MetricMetadata; // reconciled metricMetadata
  sinceSec: number | null;
  inSelection: (event: PoolEvent) => boolean;
  valuationIndex: ValuationIndex | null; // may be null
  cache: LiveMetricCache | null; // durable cache, may be null
  scopeId: string;
  projectionEndTimestampSec: number; // for the cache memo fallback minute
  worksetRegistry?: RegistryView; // the workset's own view, for a pool it did not select
  seed?: ValuationAssembly; // when present, start from it and append the new events
}): ValuationAssembly {
  const quotes = input.seed ? input.seed.quotes : createQuoteIndex();
  const valuations = input.seed ? input.seed.valuations.slice() : [];
  const metricEvents = input.seed ? input.seed.metricEvents.slice() : [];
  const valuedByRwa = input.seed
    ? new Map<string, SwapValuation[]>(
        [...input.seed.valuedByRwa].map(([asset, list]): [string, SwapValuation[]] => [
          asset,
          list.slice(),
        ]),
      )
    : new Map<string, SwapValuation[]>();
  const byId = new Map(input.registrations.map((r) => [poolRegistrationId(r), r]));
  /** The registration of an event: the workset's own view for a pool it did not select. */
  const registrationFor = (event: Swap): PoolRegistration | undefined => {
    const id = poolRegistrationId(event);
    return byId.get(id) ?? input.worksetRegistry?.get(id);
  };
  for (const event of input.events) {
    const selected = input.inSelection(event);
    let valuation: SwapValuation | null = null;
    if (event.kind === 'swap') {
      const registration = registrationFor(event);
      if (!registration) throw new Error('Projected swap lacks registration');
      const related = [
        input.assetsByAddress.get(registration.token0.toLowerCase()),
        input.assetsByAddress.get(registration.token1.toLowerCase()),
      ].filter((a): a is AssetRegistration => a !== undefined);
      const inWindow =
        input.sinceSec === null ||
        event.time.minuteStartSec === null ||
        event.time.minuteStartSec >= input.sinceSec;
      for (const asset of related) {
        const token = (address: Address) => ({
          address,
          decimals: decimalsAt(input.metadata, address, event.ref.blockNumber),
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
          usdgDecimals: decimalsAt(input.metadata, input.usdg, event.ref.blockNumber),
          maxQuoteAgeSec: 60,
        };
        // A pool the round did not select is in the walk for one reason only: a selected pool
        // reads its quote. It publishes that quote at this point in the order and nothing else
        // about it enters the report — no valuation, no window, no count.
        if (!selected) {
          const quote = quoteFromRwaUsdgSwap(event, metadata);
          if (quote) addQuote(quotes, quote);
          continue;
        }
        const hasUsdg = registration.token0 === input.usdg || registration.token1 === input.usdg;
        const preceding = hasUsdg
          ? null
          : findPrecedingQuote(event, asset.address, input.usdg, quotes, 60);
        // The durable cache survives a restart; the index sits in front of it so a round that
        // values the same window again does not re-serialize the input and decode the payload.
        const compute = () =>
          input.cache
            ? input.cache.memo(
                'valuation:' + rawLogKey(event.ref) + ':' + asset.address,
                event.time.minuteStartSec ?? Math.floor(input.projectionEndTimestampSec / 60) * 60,
                { event, metadata, preceding },
                () => {
                  const precedingIndex = createQuoteIndex();
                  if (preceding) addQuote(precedingIndex, preceding);
                  return valueSwap(event, metadata, precedingIndex);
                },
              )
            : valueSwap(event, metadata, quotes);
        const side = input.valuationIndex
          ? input.valuationIndex.lookup(
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
        if (quote) addQuote(quotes, quote);
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
  return { quotes, valuations, metricEvents, valuedByRwa };
}

export type AssemblyCache = {
  quotes: QuoteIndex;
  valuations: SwapValuation[];
  metricEvents: MetricEvent[];
  valuedByRwa: Map<string, SwapValuation[]>;
  /** refs parallel to the event order; used to find the truncation point and expire the head. */
  orderedRefs: LogRef[];
  /** The metadata revision the cached assembly was stamped under; null means the cache is cold. */
  metadataRevision?: number | string | null;
  /** The window lower bound the cached assembly was stamped under; a move means the cache is stale. */
  windowSinceSec?: number | null;
  /** The selection the cached assembly was stamped for (null for the whole catalogue). */
  selectionKey?: string | null;
};

export function createAssemblyCache(): AssemblyCache {
  return {
    quotes: createQuoteIndex(),
    valuations: [],
    metricEvents: [],
    valuedByRwa: new Map(),
    orderedRefs: [],
    metadataRevision: null,
    windowSinceSec: null,
    selectionKey: null,
  };
}

const sharedAssemblyCaches = new WeakMap<Database.Database, Map<string, AssemblyCache>>();

/**
 * The assembly cache one scope of one database is evaluated through. It mirrors the
 * `valuationIndexFor` WeakMap pattern: two builds over the same database share it, so the round
 * that assembled a window is the round the next build updates, and a read-only database — a
 * distinct handle on the same file — keeps a memory-only cache of its own that can never reach a
 * write path.
 */
export function assemblyCacheFor(db: Database.Database, scopeId: string): AssemblyCache {
  let byScope = sharedAssemblyCaches.get(db);
  if (!byScope) {
    byScope = new Map();
    sharedAssemblyCaches.set(db, byScope);
  }
  let cache = byScope.get(scopeId);
  if (!cache) {
    cache = createAssemblyCache();
    byScope.set(scopeId, cache);
  }
  return cache;
}

export type EventContribution = {
  ref: LogRef;
  quote: QuoteObservation | null;
  valuation: SwapValuation | null;
  metricEvent: MetricEvent | null;
  assetValuations: readonly [Address, SwapValuation][];
};

export type AssemblyDelta = {
  /** newly inserted events, ascending by ref (already valued elsewhere). */
  appended: readonly EventContribution[];
  /** reorg point: every cached contribution with ref >= this is dropped. */
  truncateAfter: LogRef | null;
  /** window lower bound: every cached contribution with ref < this is dropped. */
  expireBefore: LogRef | null;
};

/** The same identity `comparePosition` uses, so a dropped ref matches its contribution everywhere. */
function refKey(ref: LogRef): string {
  return `${ref.blockNumber}:${ref.transactionIndex}:${ref.logIndex}`;
}

function dropContributions(cache: AssemblyCache, dropped: ReadonlySet<string>): void {
  const retained = (ref: LogRef): boolean => !dropped.has(refKey(ref));
  cache.valuations = cache.valuations.filter((value) => retained(value.ref));
  cache.metricEvents = cache.metricEvents.filter((value) => retained(value.event.ref));
  for (const [asset, list] of cache.valuedByRwa) {
    const next = list.filter((value) => retained(value.ref));
    if (next.length === 0) cache.valuedByRwa.delete(asset);
    else cache.valuedByRwa.set(asset, next);
  }
  // Truncation/expiry is the reorg and window path, and it is rare. Rather than unpick each
  // dropped quote from `byPair`, rebuild the quote index linearly from the retained quotes — the
  // surviving `quotes.all` entries — so `byPair` and `all` always agree. Append keeps the index in
  // sync through `addQuote`, so only this drop path pays the rebuild.
  const retainedQuotes = cache.quotes.all.filter((quote) => retained(quote.effectiveAt));
  cache.quotes = createQuoteIndex();
  for (const quote of retainedQuotes) addQuote(cache.quotes, quote);
}

export function applyAssemblyDelta(cache: AssemblyCache, delta: AssemblyDelta): void {
  if (delta.expireBefore !== null || delta.truncateAfter !== null) {
    const dropped = new Set<string>();
    // Expire the window head: leading entries strictly before the lower bound leave.
    if (delta.expireBefore !== null) {
      let cut = 0;
      while (
        cut < cache.orderedRefs.length &&
        comparePosition(cache.orderedRefs[cut]!, delta.expireBefore) < 0
      ) {
        dropped.add(refKey(cache.orderedRefs[cut]!));
        cut++;
      }
      if (cut > 0) cache.orderedRefs = cache.orderedRefs.slice(cut);
    }
    // Truncate a reorg suffix: trailing entries at or after the reorg point leave. The spec
    // guarantees the deletion is a contiguous suffix, so walking from the end is exact.
    if (delta.truncateAfter !== null) {
      let cut = cache.orderedRefs.length;
      while (cut > 0 && comparePosition(cache.orderedRefs[cut - 1]!, delta.truncateAfter) >= 0) {
        dropped.add(refKey(cache.orderedRefs[cut - 1]!));
        cut--;
      }
      if (cut < cache.orderedRefs.length) cache.orderedRefs = cache.orderedRefs.slice(0, cut);
    }
    if (dropped.size > 0) dropContributions(cache, dropped);
  }

  for (const contribution of delta.appended) {
    if (contribution.quote) addQuote(cache.quotes, contribution.quote);
    if (contribution.valuation) cache.valuations.push(contribution.valuation);
    if (contribution.metricEvent) cache.metricEvents.push(contribution.metricEvent);
    for (const [asset, valuation] of contribution.assetValuations) {
      const list = cache.valuedByRwa.get(asset) ?? [];
      list.push(valuation);
      cache.valuedByRwa.set(asset, list);
    }
    cache.orderedRefs.push(contribution.ref);
  }
}
