import { afterEach, expect, test } from 'vitest';
import { toHex, type Address } from 'viem';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import type { LogRef, LogTime, PoolRef, QuoteObservation, Swap } from '../../src/domain/types.js';
import type { SwapValuation, SwapValuationMetadata } from '../../src/metrics/notional.js';
import {
  VALUATION_RULE_VERSION,
  ValuationIndex,
  valuationIndexFor,
  valuationKey,
} from '../../src/metrics/valuation-index.js';

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const SEPARATOR = '';
const RWA = toHex(0x11, { size: 20 });
const USDG = toHex(3, { size: 20 });
const OTHER = toHex(0x22, { size: 20 });
const POOL = toHex(0x101, { size: 20 });
const hash = (n: number) => toHex(n, { size: 32 });
const POOL_REF: PoolRef = { chainId: 4663, protocol: 'v3', address: POOL };
const ref = (block: number): LogRef => ({
  blockNumber: BigInt(block),
  blockHash: hash(block),
  transactionHash: hash(block + 1000),
  transactionIndex: 0,
  logIndex: 0,
});
const at = (block: number): LogTime => ({
  minuteStartSec: Math.floor((block + 60) / 60) * 60,
  exactTimestampSec: block + 60,
  source: 'log-verified',
});
const swap = (block: number): Swap => ({
  kind: 'swap',
  ref: ref(block),
  time: at(block),
  pool: POOL_REF,
  rawAmount0: 1_000_000n,
  rawAmount1: -2_000_000n,
  tokenIn: RWA,
  amountIn: 1_000_000n,
  tokenOut: USDG,
  amountOut: 2_000_000n,
  sqrtPriceX96After: 2n ** 96n,
  liquidityAfter: 1_000n,
  tickAfter: 0,
  effectiveSwapFeePips: 3000,
});
const metadata = (rwa: Address = RWA): SwapValuationMetadata => ({
  token0: { address: rwa, decimals: 6, role: 'rwa' },
  token1: { address: USDG, decimals: 6, role: 'usdg' },
  rwa,
  usdg: USDG,
  usdgDecimals: 6,
  maxQuoteAgeSec: 60,
});
const QUOTE: QuoteObservation = {
  token: RWA,
  quote: USDG,
  numerator: 2_000_000n * 10n ** 6n,
  denominator: 1_000_000n * 10n ** 6n,
  effectiveAt: ref(99),
  time: at(99),
  source: 'rwa-usdg-swap',
  maxAgeSec: 60,
};
const EVENT = swap(100);
const keyOf = (parts: Partial<Parameters<typeof valuationKey>[0]> = {}): string =>
  valuationKey({ eventId: 'id', event: EVENT, metadata: metadata(), preceding: QUOTE, ...parts });
/** Only the identity matters here: the index never reads inside a valuation. */
const valued = (marker: string): SwapValuation => ({ marker }) as unknown as SwapValuation;

/** Counts the computations a `lookup` delegated, so a hit shows up as a call that never happened. */
function counter() {
  let computes = 0;
  return {
    get computes() {
      return computes;
    },
    compute:
      <T>(value: T) =>
      () => {
        computes += 1;
        return value;
      },
  };
}

test('the rule version names the key, and every input the valuation reads changes it', () => {
  const key = keyOf();
  expect(key.split(SEPARATOR)[0]).toBe(VALUATION_RULE_VERSION);

  const token = metadata().token0;
  const variants: readonly [string, string][] = [
    ['event id', keyOf({ eventId: 'other' })],
    ['tokenIn', keyOf({ event: { ...EVENT, tokenIn: OTHER } })],
    ['tokenOut', keyOf({ event: { ...EVENT, tokenOut: OTHER } })],
    ['rawAmount0', keyOf({ event: { ...EVENT, rawAmount0: 1_000_001n } })],
    ['rawAmount1', keyOf({ event: { ...EVENT, rawAmount1: -2_000_001n } })],
    ['amountIn', keyOf({ event: { ...EVENT, amountIn: 1_000_001n } })],
    ['amountOut', keyOf({ event: { ...EVENT, amountOut: 2_000_001n } })],
    ['sqrtPriceX96After', keyOf({ event: { ...EVENT, sqrtPriceX96After: 2n ** 96n + 1n } })],
    ['liquidityAfter', keyOf({ event: { ...EVENT, liquidityAfter: 1_001n } })],
    ['tickAfter', keyOf({ event: { ...EVENT, tickAfter: 1 } })],
    ['effectiveSwapFeePips', keyOf({ event: { ...EVENT, effectiveSwapFeePips: 500 } })],
    ['pool address', keyOf({ event: { ...EVENT, pool: { ...POOL_REF, address: OTHER } } })],
    [
      'pool protocol',
      keyOf({
        event: {
          ...EVENT,
          pool: { chainId: 4663, protocol: 'v4', manager: POOL, poolId: hash(1) },
        },
      }),
    ],
    ['ref height', keyOf({ event: { ...EVENT, ref: { ...EVENT.ref, blockNumber: 101n } } })],
    ['ref hash', keyOf({ event: { ...EVENT, ref: { ...EVENT.ref, blockHash: hash(7) } } })],
    ['ref tx', keyOf({ event: { ...EVENT, ref: { ...EVENT.ref, transactionHash: hash(7) } } })],
    ['ref position', keyOf({ event: { ...EVENT, ref: { ...EVENT.ref, logIndex: 1 } } })],
    [
      'exact second',
      keyOf({ event: { ...EVENT, time: { ...EVENT.time, exactTimestampSec: 161 } } }),
    ],
    ['minute', keyOf({ event: { ...EVENT, time: { ...EVENT.time, minuteStartSec: 180 } } })],
    ['time source', keyOf({ event: { ...EVENT, time: { ...EVENT.time, source: 'unresolved' } } })],
    [
      'token0 address',
      keyOf({ metadata: { ...metadata(), token0: { ...token, address: OTHER } } }),
    ],
    ['token0 decimals', keyOf({ metadata: { ...metadata(), token0: { ...token, decimals: 18 } } })],
    ['token0 role', keyOf({ metadata: { ...metadata(), token0: { ...token, role: 'other' } } })],
    [
      'token1',
      keyOf({ metadata: { ...metadata(), token1: { ...metadata().token1, address: OTHER } } }),
    ],
    ['rwa', keyOf({ metadata: { ...metadata(), rwa: OTHER } })],
    ['usdg', keyOf({ metadata: { ...metadata(), usdg: OTHER } })],
    ['usdgDecimals', keyOf({ metadata: { ...metadata(), usdgDecimals: 18 } })],
    ['maxQuoteAgeSec', keyOf({ metadata: { ...metadata(), maxQuoteAgeSec: 30 } })],
    ['quote token', keyOf({ preceding: { ...QUOTE, token: OTHER } })],
    ['quote of', keyOf({ preceding: { ...QUOTE, quote: OTHER } })],
    ['quote numerator', keyOf({ preceding: { ...QUOTE, numerator: QUOTE.numerator + 1n } })],
    ['quote denominator', keyOf({ preceding: { ...QUOTE, denominator: QUOTE.denominator + 1n } })],
    ['quote ref', keyOf({ preceding: { ...QUOTE, effectiveAt: ref(98) } })],
    ['quote time', keyOf({ preceding: { ...QUOTE, time: at(98) } })],
    ['quote source', keyOf({ preceding: { ...QUOTE, source: 'other' } })],
    ['quote max age', keyOf({ preceding: { ...QUOTE, maxAgeSec: 30 } })],
    ['no quote at all', keyOf({ preceding: null })],
  ];
  expect(variants.filter(([, variant]) => variant === key).map(([label]) => label)).toEqual([]);
});

test('a held key is computed once, and a different key is computed again', () => {
  const index = new ValuationIndex();
  const work = counter();
  const key = keyOf({ preceding: null });
  const other = keyOf({ eventId: 'id2', event: swap(101), preceding: null });

  expect(index.lookup(key, [RWA], EVENT, work.compute(valued('one')))).toEqual(valued('one'));
  expect(work.computes).toBe(1);
  expect(index.size).toBe(1);

  expect(index.lookup(key, [RWA], EVENT, work.compute(valued('two')))).toEqual(valued('one'));
  expect(work.computes).toBe(1);
  expect(index.lookup(other, [RWA], swap(101), work.compute(valued('two')))).toEqual(valued('two'));
  expect(work.computes).toBe(2);
  expect(index.size).toBe(2);
});

/** One held valuation per (block, token) pair: the token is not in the key, only in the index. */
function tokenIndex() {
  const index = new ValuationIndex();
  const work = counter();
  const keyFor = (block: number, token: Address): string =>
    keyOf({ eventId: `id${block}:${token}`, event: swap(block), preceding: null });
  return {
    index,
    work,
    keyFor,
    hold: (block: number, token: Address): SwapValuation =>
      index.lookup(keyFor(block, token), [token], swap(block), work.compute(valued(`v${block}`))),
    expectHeld: (block: number, token: Address): void => {
      const before = work.computes;
      expect(
        index.lookup(keyFor(block, token), [token], swap(block), work.compute(valued('never'))),
      ).toEqual(valued(`v${block}`));
      expect(work.computes).toBe(before);
    },
  };
}

test('a revision drops only what comes after it, and only for the tokens it names', () => {
  const { index, work, keyFor, hold, expectHeld } = tokenIndex();
  hold(100, RWA);
  hold(150, RWA);
  hold(200, RWA);
  hold(150, OTHER);
  hold(150, USDG);
  expect(index.size).toBe(5);
  expect(work.computes).toBe(5);

  // A quote at 150 can only be read by a swap after it, and only by the token it prices.
  index.invalidateQuotesAfter([RWA.toUpperCase()], ref(150));
  expect(index.size).toBe(4);
  expectHeld(100, RWA);
  expectHeld(150, RWA);
  expectHeld(150, OTHER);
  expectHeld(150, USDG);

  // The dropped one is recomputed from the same key, so a revision only ever makes it newer.
  expect(
    index.lookup(keyFor(200, RWA), [RWA], swap(200), work.compute(valued('recomputed'))),
  ).toEqual(valued('recomputed'));
  expect(work.computes).toBe(6);
});

test('a dropped entry is recomputed, so an invalidation can only ever make a value newer', () => {
  const index = new ValuationIndex();
  const work = counter();
  const key = keyOf({ preceding: null });
  let price = valued('unpriced');

  expect(index.lookup(key, [RWA], EVENT, work.compute(price))).toEqual(valued('unpriced'));
  expect(index.lookup(key, [RWA], EVENT, work.compute(price))).toEqual(valued('unpriced'));
  expect(work.computes).toBe(1);

  // The caller's input for this key changed under it, which a real caller prevents by naming the
  // quote it used in the key. Whatever the reason for the drop, the next lookup is the new value
  // and not the held one: this is the invariant every invalidation below relies on.
  index.invalidateQuotesAfter([RWA], ref(99));
  expect(index.size).toBe(0);
  price = valued('priced');
  expect(index.lookup(key, [RWA], EVENT, work.compute(price))).toEqual(valued('priced'));
  expect(work.computes).toBe(2);
});

test('a window that moves drops what left it and changes no value it keeps', () => {
  const index = new ValuationIndex();
  const work = counter();
  const keyFor = (block: number) =>
    keyOf({ eventId: `id${block}`, event: swap(block), preceding: null });
  const hold = (block: number): SwapValuation =>
    index.lookup(keyFor(block), [RWA], swap(block), work.compute(valued(`v${block}`)));
  hold(100);
  hold(200);
  expect(index.size).toBe(2);

  // The first event's minute is 120; a window that starts at 180 no longer covers it.
  index.expireOutside({ sinceSec: 180, sinceBlock: null });
  expect(index.size).toBe(1);
  const before = work.computes;
  expect(index.lookup(keyFor(200), [RWA], swap(200), work.compute(valued('never')))).toEqual(
    valued('v200'),
  );
  expect(work.computes).toBe(before);

  // An event with no resolved minute is bounded by height instead, and stays while no bound exists.
  const unknown: LogTime = { minuteStartSec: null, exactTimestampSec: null, source: 'unresolved' };
  index.lookup(
    keyOf({ eventId: 'idUnknown', preceding: null }),
    [RWA],
    { ...EVENT, time: unknown },
    work.compute(valued('unknown')),
  );
  index.expireOutside({ sinceSec: 180, sinceBlock: null });
  expect(index.size).toBe(2);
  index.expireOutside({ sinceSec: 180, sinceBlock: 150n });
  expect(index.size).toBe(1);
});

test('clearing drops every held valuation', () => {
  const index = new ValuationIndex();
  const work = counter();
  const key = keyOf({ preceding: null });
  expect(index.lookup(key, [RWA], EVENT, work.compute(valued('one')))).toEqual(valued('one'));
  expect(index.size).toBe(1);
  index.clear();
  expect(index.size).toBe(0);
  expect(index.lookup(key, [RWA], EVENT, work.compute(valued('two')))).toEqual(valued('two'));
  expect(work.computes).toBe(2);
});

test('one scope of one database holds one index, and another scope holds its own', () => {
  const db = openDatabase(':memory:');
  const other = openDatabase(':memory:');
  dbs.push(db, other);
  const first = valuationIndexFor(db, 'scope');
  expect(valuationIndexFor(db, 'scope')).toBe(first);
  expect(valuationIndexFor(db, 'other')).not.toBe(first);
  expect(valuationIndexFor(other, 'scope')).not.toBe(first);
});

test('the rule version is pinned, so changing the valuation rule has to change it', () => {
  expect(VALUATION_RULE_VERSION).toBe('valuation-v1');
});
