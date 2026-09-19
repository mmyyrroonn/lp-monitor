import type { Address } from 'viem';
import type { PoolEvent, Swap } from '../domain/types.js';
import type { AssetRegistration, AssetRegistry } from '../registry/assets.js';
import { poolRegistrationId, type PoolRegistration } from '../registry/pools.js';
import type { RegistryView } from '../storage/registry-cache.js';
import type { LiveMetricCache } from '../storage/live-metric-cache.js';
import { rawLogKey } from '../storage/manifest.js';
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
}): ValuationAssembly {
  const quotes = createQuoteIndex();
  const valuations: SwapValuation[] = [];
  const metricEvents: MetricEvent[] = [];
  const valuedByRwa = new Map<string, SwapValuation[]>();
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
