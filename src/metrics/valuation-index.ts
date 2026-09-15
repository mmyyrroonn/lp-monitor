import type Database from 'better-sqlite3';
import type { LogRef, LogTime, PoolRef, QuoteObservation, Swap } from '../domain/types.js';
import { comparePosition } from '../state/observations.js';
import type { SwapValuation, SwapValuationMetadata, ValuationTokenMetadata } from './notional.js';

/**
 * The valuation rule these keys are valid for. A change to what `valueSwap` reads or returns has to
 * change this string: without it an entry computed by the old rule would still be served under the
 * new one, and nothing else in the key would differ.
 */
export const VALUATION_RULE_VERSION = 'valuation-v1';

/** Field separator. Every part below is an address, a count or a decimal, so none of them carry it. */
const SEPARATOR = '';

function part(value: unknown): string {
  if (value === null) return 'n';
  if (value === undefined) return 'u';
  return String(value);
}
function join(parts: readonly unknown[]): string {
  return parts.map(part).join(SEPARATOR);
}
function poolPart(pool: PoolRef): string {
  return pool.protocol === 'v3'
    ? join([pool.chainId, 'v3', pool.address])
    : join([pool.chainId, 'v4', pool.manager, pool.poolId]);
}
function refPart(ref: LogRef): string {
  return join([
    ref.blockNumber,
    ref.blockHash,
    ref.transactionHash,
    ref.transactionIndex,
    ref.logIndex,
  ]);
}
function timePart(time: LogTime): string {
  return join([time.source, time.minuteStartSec, time.exactTimestampSec]);
}
function tokenPart(token: ValuationTokenMetadata): string {
  return join([token.address, token.decimals, token.role]);
}

/**
 * Everything a valuation reads off the swap, written out field by field.
 *
 * The revision is a deliberate superset of what `valueSwap` consumes: a field that only travels
 * into the result counts too, because two events that differ anywhere in this string may not share
 * a held result. Case is preserved so a differently-cased address is a different revision, exactly
 * as the returned `pool` and `transactionHash` would differ.
 */
export function eventRevision(event: Swap): string {
  return join([
    event.tokenIn,
    event.tokenOut,
    event.rawAmount0,
    event.rawAmount1,
    event.amountIn,
    event.amountOut,
    event.sqrtPriceX96After,
    event.liquidityAfter,
    event.tickAfter,
    event.effectiveSwapFeePips,
    poolPart(event.pool),
    refPart(event.ref),
    timePart(event.time),
  ]);
}

/** The token metadata a valuation reads: both sides, the priced asset, the quote token and the age limit. */
export function metadataRevision(metadata: SwapValuationMetadata): string {
  return join([
    tokenPart(metadata.token0),
    tokenPart(metadata.token1),
    metadata.rwa,
    metadata.usdg,
    metadata.usdgDecimals,
    metadata.maxQuoteAgeSec,
  ]);
}

/** The identity and content of the quote a valuation used, or the fact that it found none. */
export function quoteRevision(quote: QuoteObservation | null): string {
  if (quote === null) return 'none';
  return join([
    quote.token,
    quote.quote,
    quote.numerator,
    quote.denominator,
    refPart(quote.effectiveAt),
    timePart(quote.time),
    quote.source,
    quote.maxAgeSec,
  ]);
}

/**
 * The identity of one `valueSwap` call.
 *
 * Every input the call can read is in here — the rule version, the event's own log key and content,
 * the token metadata, and the quote the call actually used. So two lookups with the same key return
 * the same value by construction, and a caller never has to serialize the event, the whole metadata
 * set or the quote array to find that out.
 */
export function valuationKey(parts: {
  eventId: string;
  event: Swap;
  metadata: SwapValuationMetadata;
  preceding: QuoteObservation | null;
}): string {
  return join([
    VALUATION_RULE_VERSION,
    parts.eventId,
    eventRevision(parts.event),
    metadataRevision(parts.metadata),
    quoteRevision(parts.preceding),
  ]);
}

/** What a held valuation is, and what it takes to decide whether it is still in the window. */
type Held = {
  value: SwapValuation;
  ref: LogRef;
  minuteStartSec: number | null;
  blockNumber: bigint;
  /** Tokens whose quotes this valuation reads; a quote change under one of them invalidates it. */
  tokens: readonly string[];
};

/**
 * The valuations one scope already computed, in memory, keyed by everything they depend on.
 *
 * The durable `live_metric_cache` stays the recovery layer: it survives a restart and reuses a
 * contribution whose input hash matches. This index sits in front of it so a round that values the
 * same window again does not re-serialize the input and decode the payload for every event — which
 * is the work a bounded live round would otherwise repeat every batch.
 *
 * Correctness rests on the key, not on the invalidations below. A caller finds its preceding quote
 * and passes `quoteRevision` of *that* quote into the key, so a valuation whose quote changed is a
 * miss by construction rather than by invalidation — and one whose quote left the window is never
 * looked up again. The invalidations are therefore only ever a drop, and a drop is recomputed from
 * the same complete key; they exist to keep what is held bounded to the window and to the tokens
 * that moved, which is what a long-running round needs and what a caller with a repair to apply
 * asks for.
 */
export class ValuationIndex {
  readonly #byKey = new Map<string, Held>();
  readonly #keysByToken = new Map<string, Set<string>>();

  /** How many valuations are held, for benchmarks and for tests that assert an input stayed cached. */
  get size(): number {
    return this.#byKey.size;
  }

  /**
   * The valuation of this key, computed by `compute` when it is not held yet.
   *
   * `tokens` are the quote tokens this valuation reads. `event` only supplies the window facts
   * `expireOutside` needs to drop what the live window no longer covers.
   */
  lookup(
    key: string,
    tokens: readonly string[],
    event: Swap,
    compute: () => SwapValuation,
  ): SwapValuation {
    const held = this.#byKey.get(key);
    if (held !== undefined) return held.value;
    const value = compute();
    this.#hold(key, {
      value,
      ref: event.ref,
      minuteStartSec: event.time.minuteStartSec,
      blockNumber: event.ref.blockNumber,
      tokens: tokens.map((token) => token.toLowerCase()),
    });
    return value;
  }

  /**
   * Drop every held valuation of an event strictly after `ref`, for the tokens that changed.
   *
   * A quote can only be used by a swap that comes after it, so a swap added or revised at `ref`
   * cannot change the valuation of anything at or before `ref`. That bound is what keeps this cheap
   * without being wrong in either direction: an event whose preceding quote was missing and now
   * exists is dropped like any other, which is exactly the case an input hash alone cannot see.
   */
  invalidateQuotesAfter(tokens: Iterable<string>, ref: LogRef): void {
    for (const token of tokens) {
      const keys = this.#keysByToken.get(token.toLowerCase());
      if (keys === undefined) continue;
      for (const key of [...keys]) {
        const held = this.#byKey.get(key);
        if (held !== undefined && comparePosition(held.ref, ref) > 0) this.#drop(key);
      }
    }
  }

  /**
   * Drop everything held.
   *
   * A round that deleted an event deleted a quote with it, and a key cannot see an input that no
   * longer exists: the valuation that used it still names it in its own key. Deletions are reorgs
   * and rebuilds, not window movement, so discarding the whole index here costs a revaluation of
   * the window in a round that already rewrote it.
   */
  clear(): void {
    this.#byKey.clear();
    this.#keysByToken.clear();
  }

  /**
   * Drop the valuations of events that left the window. Nothing here changes a result — a swap
   * keeps every quote inside its age limit for as long as the swap itself is in the window, which
   * is what the read's own 120-second margin buys — so this only bounds what is held.
   */
  expireOutside(bounds: { sinceSec: number; sinceBlock: bigint | null }): void {
    for (const [key, held] of [...this.#byKey]) {
      if (held.minuteStartSec !== null) {
        if (held.minuteStartSec < bounds.sinceSec) this.#drop(key);
        continue;
      }
      if (bounds.sinceBlock !== null && held.blockNumber < bounds.sinceBlock) this.#drop(key);
    }
  }

  #hold(key: string, held: Held): void {
    this.#byKey.set(key, held);
    for (const token of held.tokens) {
      const keys = this.#keysByToken.get(token) ?? new Set<string>();
      keys.add(key);
      this.#keysByToken.set(token, keys);
    }
  }

  #drop(key: string): void {
    const held = this.#byKey.get(key);
    if (held === undefined) return;
    this.#byKey.delete(key);
    for (const token of held.tokens) {
      const keys = this.#keysByToken.get(token);
      if (keys === undefined) continue;
      keys.delete(key);
      if (keys.size === 0) this.#keysByToken.delete(token);
    }
  }
}

const sharedIndexes = new WeakMap<Database.Database, Map<string, ValuationIndex>>();

/**
 * The valuation index one scope of one database is evaluated through. Two builds over the same
 * database share it, so the round that valued a window is the round the next build reads, and a
 * read-only database — a distinct handle on the file — keeps a memory-only index of its own that
 * can never reach a write path.
 */
export function valuationIndexFor(db: Database.Database, scopeId: string): ValuationIndex {
  let byScope = sharedIndexes.get(db);
  if (!byScope) {
    byScope = new Map();
    sharedIndexes.set(db, byScope);
  }
  let index = byScope.get(scopeId);
  if (!index) {
    index = new ValuationIndex();
    byScope.set(scopeId, index);
  }
  return index;
}
