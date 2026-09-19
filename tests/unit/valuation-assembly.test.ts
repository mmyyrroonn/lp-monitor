import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  applyAssemblyDelta,
  createAssemblyCache,
  type EventContribution,
} from '../../src/metrics/valuation-assembly.js';
import type { SwapValuation } from '../../src/metrics/notional.js';
import type { MetricEvent } from '../../src/metrics/windows.js';
import type { LogRef, LogTime, QuoteObservation, Swap } from '../../src/domain/types.js';

const hex = (n: bigint | number): Hex => ('0x' + n.toString(16).padStart(64, '0')) as Hex;
const addressOf = (hexChar: string): Address => ('0x' + hexChar.repeat(40)) as Address;
const ref = (blockNumber: bigint, logIndex = 0): LogRef => ({
  blockNumber,
  blockHash: hex(blockNumber),
  transactionHash: hex(blockNumber),
  transactionIndex: 0,
  logIndex,
});
const time = (ts: number): LogTime => ({
  source: 'log-verified',
  minuteStartSec: ts,
  exactTimestampSec: ts,
});

const USDG = addressOf('d');

const quoteOf = (blockNumber: bigint, token: Address): QuoteObservation => ({
  token,
  quote: USDG,
  numerator: 1n,
  denominator: 1n,
  effectiveAt: ref(blockNumber),
  time: time(Number(blockNumber) * 10),
  source: 'rwa-usdg-swap',
  maxAgeSec: 60,
});

const swapAt = (blockNumber: bigint, token: Address): Swap => ({
  kind: 'swap',
  ref: ref(blockNumber),
  time: time(Number(blockNumber) * 10),
  tokenIn: token,
  tokenOut: USDG,
  rawAmount0: -1n,
  rawAmount1: 1n,
  amountIn: 1n,
  amountOut: 1n,
  sqrtPriceX96After: 1n,
  liquidityAfter: 1n,
  tickAfter: 0,
  effectiveSwapFeePips: 0,
  pool: { chainId: 4663, protocol: 'v3', address: addressOf('0') },
});

const valuationOf = (blockNumber: bigint, token: Address): SwapValuation => ({
  ref: ref(blockNumber),
  eventId: 'event:' + blockNumber.toString(),
  time: time(Number(blockNumber) * 10),
  pool: { chainId: 4663, protocol: 'v3', address: addressOf('0') },
  transactionHash: ref(blockNumber).transactionHash,
  nativeToken: token,
  nativeAmountRaw: 1_000_000n,
  nativeDecimals: 6,
  nativeSide: 'token0',
  usdgNotionalRaw: 1_000_000n,
  usdMicros: 1_000_000n,
  pricingSide: 'rwa-quote',
  quoteEvidence: null,
  quality: 'usd-estimate',
});

const metricEventOf = (blockNumber: bigint, token: Address): MetricEvent => ({
  event: swapAt(blockNumber, token),
  usdMicros: 1_000_000n,
  usdgNotionalRaw: 1_000_000n,
  rawNotional: { token, raw: 1_000_000n },
});

const contribution = (blockNumber: bigint, token: Address): EventContribution => {
  const valuation = valuationOf(blockNumber, token);
  return {
    ref: ref(blockNumber),
    quote: quoteOf(blockNumber, token),
    valuation,
    metricEvent: metricEventOf(blockNumber, token),
    assetValuations: [[token, valuation]],
  };
};

const pairKey = (token: Address): string => token.toLowerCase() + '|' + USDG.toLowerCase();

describe('assembly cache', () => {
  it('appends contributions to the four outputs in order', () => {
    const cache = createAssemblyCache();
    const A = addressOf('a');
    const B = addressOf('b');
    applyAssemblyDelta(cache, {
      appended: [contribution(5n, A), contribution(6n, B)],
      truncateAfter: null,
      expireBefore: null,
    });

    expect(cache.orderedRefs.map((r) => r.blockNumber)).toEqual([5n, 6n]);
    expect(cache.valuations.map((v) => v.ref.blockNumber)).toEqual([5n, 6n]);
    expect(cache.metricEvents.map((m) => m.event.ref.blockNumber)).toEqual([5n, 6n]);
    expect(cache.quotes.all.map((q) => q.effectiveAt.blockNumber)).toEqual([5n, 6n]);
    expect(cache.valuedByRwa.get(A)?.map((v) => v.ref.blockNumber)).toEqual([5n]);
    expect(cache.valuedByRwa.get(B)?.map((v) => v.ref.blockNumber)).toEqual([6n]);
    expect(cache.quotes.byPair.get(pairKey(A))?.map((q) => q.effectiveAt.blockNumber)).toEqual([
      5n,
    ]);
    expect(cache.quotes.byPair.get(pairKey(B))?.map((q) => q.effectiveAt.blockNumber)).toEqual([
      6n,
    ]);
  });

  it('truncateAfter drops a suffix and its outputs, keeping the head', () => {
    const cache = createAssemblyCache();
    const A = addressOf('a');
    applyAssemblyDelta(cache, {
      appended: [contribution(5n, A), contribution(6n, A), contribution(7n, A)],
      truncateAfter: null,
      expireBefore: null,
    });
    applyAssemblyDelta(cache, {
      appended: [],
      truncateAfter: ref(6n),
      expireBefore: null,
    });

    expect(cache.orderedRefs.map((r) => r.blockNumber)).toEqual([5n]);
    expect(cache.valuations.map((v) => v.ref.blockNumber)).toEqual([5n]);
    expect(cache.metricEvents.map((m) => m.event.ref.blockNumber)).toEqual([5n]);
    expect(cache.quotes.all.map((q) => q.effectiveAt.blockNumber)).toEqual([5n]);
    expect(cache.valuedByRwa.get(A)?.map((v) => v.ref.blockNumber)).toEqual([5n]);
    expect(cache.quotes.byPair.get(pairKey(A))?.map((q) => q.effectiveAt.blockNumber)).toEqual([
      5n,
    ]);
  });

  it('expireBefore drops a head and its outputs, keeping the tail', () => {
    const cache = createAssemblyCache();
    const A = addressOf('a');
    applyAssemblyDelta(cache, {
      appended: [contribution(5n, A), contribution(6n, A), contribution(7n, A)],
      truncateAfter: null,
      expireBefore: null,
    });
    applyAssemblyDelta(cache, {
      appended: [],
      truncateAfter: null,
      expireBefore: ref(6n),
    });

    expect(cache.orderedRefs.map((r) => r.blockNumber)).toEqual([6n, 7n]);
    expect(cache.valuations.map((v) => v.ref.blockNumber)).toEqual([6n, 7n]);
    expect(cache.metricEvents.map((m) => m.event.ref.blockNumber)).toEqual([6n, 7n]);
    expect(cache.quotes.all.map((q) => q.effectiveAt.blockNumber)).toEqual([6n, 7n]);
    expect(cache.valuedByRwa.get(A)?.map((v) => v.ref.blockNumber)).toEqual([6n, 7n]);
    expect(cache.quotes.byPair.get(pairKey(A))?.map((q) => q.effectiveAt.blockNumber)).toEqual([
      6n,
      7n,
    ]);
  });

  it('truncate then append keeps the retained head plus the new entries (reorg shape)', () => {
    const cache = createAssemblyCache();
    const A = addressOf('a');
    const B = addressOf('b');
    applyAssemblyDelta(cache, {
      appended: [contribution(5n, A), contribution(6n, A), contribution(7n, A)],
      truncateAfter: null,
      expireBefore: null,
    });
    applyAssemblyDelta(cache, {
      appended: [contribution(6n, B), contribution(7n, B)],
      truncateAfter: ref(6n),
      expireBefore: null,
    });

    expect(cache.orderedRefs.map((r) => r.blockNumber)).toEqual([5n, 6n, 7n]);
    expect(cache.valuations.map((v) => [v.ref.blockNumber, v.nativeToken])).toEqual([
      [5n, A],
      [6n, B],
      [7n, B],
    ]);
    expect(cache.metricEvents.map((m) => m.event.ref.blockNumber)).toEqual([5n, 6n, 7n]);
    expect(cache.quotes.all.map((q) => q.effectiveAt.blockNumber)).toEqual([5n, 6n, 7n]);
    expect(cache.valuedByRwa.get(A)?.map((v) => v.ref.blockNumber)).toEqual([5n]);
    expect(cache.valuedByRwa.get(B)?.map((v) => v.ref.blockNumber)).toEqual([6n, 7n]);
  });
});
