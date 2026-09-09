import { describe, expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import type { LogTime, QuoteObservation, Swap } from '../../src/domain/types.js';
import { type SwapValuationMetadata, valueSwap } from '../../src/metrics/notional.js';
import { quoteFromRwaUsdgSwap } from '../../src/metrics/price.js';

const RWA = '0x0000000000000000000000000000000000000001' as Address;
const USDG = '0x0000000000000000000000000000000000000002' as Address;
const MEME = '0x0000000000000000000000000000000000000003' as Address;
const HASH = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const exact = (timestampSec: number): LogTime => ({
  minuteStartSec: Math.floor(timestampSec / 60) * 60,
  exactTimestampSec: timestampSec,
  source: 'log-verified',
});
const minute = (minuteStartSec: number): LogTime => ({
  minuteStartSec,
  exactTimestampSec: null,
  source: 'minute-boundary',
});

function swap(overrides: Partial<Swap> = {}): Swap {
  return {
    kind: 'swap',
    ref: {
      blockHash: HASH('a'),
      blockNumber: 10n,
      transactionHash: HASH('b'),
      transactionIndex: 1,
      logIndex: 2,
    },
    time: exact(1_000),
    pool: {
      chainId: 4663,
      protocol: 'v3',
      address: '0x0000000000000000000000000000000000000010',
    },
    rawAmount0: 2_000_000_000_000_000_000n,
    rawAmount1: -5_000_000n,
    tokenIn: RWA,
    amountIn: 2_000_000_000_000_000_000n,
    tokenOut: USDG,
    amountOut: 5_000_000n,
    sqrtPriceX96After: 1n,
    liquidityAfter: 1n,
    tickAfter: 0,
    effectiveSwapFeePips: 3_000,
    ...overrides,
  };
}

function memeSwap(overrides: Partial<Swap> = {}): Swap {
  return swap({
    rawAmount0: 10_000_000_000n,
    rawAmount1: -2_000_000_000_000_000_000n,
    tokenIn: MEME,
    amountIn: 10_000_000_000n,
    tokenOut: RWA,
    amountOut: 2_000_000_000_000_000_000n,
    ...overrides,
  });
}
const directMetadata: SwapValuationMetadata = {
  token0: { address: RWA, decimals: 18, role: 'rwa' },
  token1: { address: USDG, decimals: 6, role: 'usdg' },
  rwa: RWA,
  usdg: USDG,
  usdgDecimals: 6,
};
const memeMetadata: SwapValuationMetadata = {
  token0: { address: MEME, decimals: null, role: 'meme' },
  token1: { address: RWA, decimals: 18, role: 'rwa' },
  rwa: RWA,
  usdg: USDG,
  usdgDecimals: 6,
};

describe('valueSwap', () => {
  test.each([
    {
      metadata: directMetadata,
      event: swap(),
      expectedSide: 'token1',
    },
    {
      metadata: {
        ...directMetadata,
        token0: directMetadata.token1,
        token1: directMetadata.token0,
      },
      event: swap({
        rawAmount0: -5_000_000n,
        rawAmount1: 2_000_000_000_000_000_000n,
        tokenIn: RWA,
        amountIn: 2_000_000_000_000_000_000n,
        tokenOut: USDG,
        amountOut: 5_000_000n,
      }),
      expectedSide: 'token0',
    },
  ])('takes the USDG side once when USDG is $expectedSide', ({ metadata, event, expectedSide }) => {
    const result = valueSwap(event, metadata, []);
    expect(result.nativeSide).toBe(expectedSide);
    expect(result.nativeToken).toBe(USDG);
    expect(result.nativeAmountRaw).toBe(5_000_000n);
    expect(result.usdgNotionalRaw).toBe(5_000_000n);
    expect(result.usdMicros).toBe(5_000_000n);
    expect(result.quality).toBe('usdg-only');
  });

  test('prices an RWA side using a preceding human-unit quote across 18 and 6 decimals', () => {
    const quote: QuoteObservation = {
      token: RWA,
      quote: USDG,
      numerator: 5n,
      denominator: 2n,
      effectiveAt: { ...swap().ref, blockNumber: 9n },
      time: exact(990),
      source: 'rwa-usdg-swap',
      maxAgeSec: 60,
    };
    const event = swap({
      rawAmount0: 10_000_000_000n,
      rawAmount1: -2_000_000_000_000_000_000n,
      tokenIn: MEME,
      amountIn: 10_000_000_000n,
      tokenOut: RWA,
      amountOut: 2_000_000_000_000_000_000n,
    });
    const result = valueSwap(event, memeMetadata, [quote]);
    expect(result.nativeToken).toBe(RWA);
    expect(result.nativeAmountRaw).toBe(2_000_000_000_000_000_000n);
    expect(result.nativeDecimals).toBe(18);
    expect(result.usdgNotionalRaw).toBe(5_000_000n);
    expect(result.usdMicros).toBe(5_000_000n);
    expect(result.quoteEvidence).toBe(quote);
    expect(result.quality).toBe('usd-estimate');
  });

  test('rejects future event-order quotes even if their timestamp is older', () => {
    const event = memeSwap({ time: exact(1_000) });
    const quote: QuoteObservation = {
      token: RWA,
      quote: USDG,
      numerator: 2n,
      denominator: 1n,
      effectiveAt: { ...event.ref, logIndex: event.ref.logIndex + 1 },
      time: exact(999),
      source: 'future-order',
      maxAgeSec: 60,
    };
    expect(valueSwap(event, memeMetadata, [quote]).usdMicros).toBeNull();
  });

  test('rejects exact quotes older than 60 seconds and accepts the boundary', () => {
    const event = memeSwap({ time: exact(1_000) });
    const makeQuote = (timestampSec: number): QuoteObservation => ({
      token: RWA,
      quote: USDG,
      numerator: 2n,
      denominator: 1n,
      effectiveAt: { ...event.ref, blockNumber: 9n },
      time: exact(timestampSec),
      source: 'boundary',
      maxAgeSec: 60,
    });
    expect(valueSwap(event, memeMetadata, [makeQuote(940)]).usdMicros).not.toBeNull();
    expect(valueSwap(event, memeMetadata, [makeQuote(939)]).usdMicros).toBeNull();
  });

  test('uses the conservative minute age upper bound without inventing exact times', () => {
    const event = memeSwap({ time: minute(1_020) });
    const makeQuote = (minuteStartSec: number): QuoteObservation => ({
      token: RWA,
      quote: USDG,
      numerator: 2n,
      denominator: 1n,
      effectiveAt: { ...event.ref, blockNumber: 9n },
      time: minute(minuteStartSec),
      source: 'minute-boundary',
      maxAgeSec: 60,
    });
    expect(valueSwap(event, memeMetadata, [makeQuote(1_020)]).usdMicros).not.toBeNull();
    expect(valueSwap(event, memeMetadata, [makeQuote(960)]).usdMicros).toBeNull();
  });

  test('rejects unresolved quote timing even when an exact timestamp field is populated', () => {
    const event = memeSwap({ time: exact(1_000) });
    const quote: QuoteObservation = {
      token: RWA,
      quote: USDG,
      numerator: 2n,
      denominator: 1n,
      effectiveAt: { ...event.ref, blockNumber: 9n },
      time: { minuteStartSec: 960, exactTimestampSec: 990, source: 'unresolved' },
      source: 'unresolved-time',
      maxAgeSec: 60,
    };
    expect(valueSwap(event, memeMetadata, [quote]).usdMicros).toBeNull();
  });
  test('retains native RWA volume and a null valuation when price is missing', () => {
    const result = valueSwap(memeSwap(), memeMetadata, []);
    expect(result.nativeToken).toBe(RWA);
    expect(result.nativeAmountRaw).toBe(2_000_000_000_000_000_000n);
    expect(result.usdgNotionalRaw).toBeNull();
    expect(result.usdMicros).toBeNull();
    expect(result.quality).toBe('unpriced');
  });

  test('validates raw quantities, decimals, and quote denominators', () => {
    expect(() => valueSwap(swap({ rawAmount1: 1n }), directMetadata, [])).toThrow();
    expect(() =>
      valueSwap(
        swap(),
        { ...directMetadata, token1: { ...directMetadata.token1, decimals: 256 } },
        [],
      ),
    ).toThrow(/decimals/i);
    expect(() =>
      quoteFromRwaUsdgSwap(swap({ rawAmount0: 0n, amountIn: 0n }), directMetadata),
    ).toThrow(/denominator|amount/i);
  });
});

test('quoteFromRwaUsdgSwap represents human USDG per human RWA', () => {
  const quote = quoteFromRwaUsdgSwap(swap(), directMetadata);
  expect(quote).not.toBeNull();
  expect(quote!.numerator * 2n).toBe(quote!.denominator * 5n);
  expect(quote!.effectiveAt).toEqual(swap().ref);
});

test('a zero USDG quote cannot replace a preceding positive quote', () => {
  const positive = quoteFromRwaUsdgSwap(
    swap({ ref: { ...swap().ref, blockNumber: 8n }, time: exact(990) }),
    directMetadata,
  )!;
  const zero = {
    ...positive,
    numerator: 0n,
    effectiveAt: { ...positive.effectiveAt, blockNumber: 9n },
  };
  const result = valueSwap(memeSwap(), memeMetadata, [positive, zero]);
  expect(result.quoteEvidence).toEqual(positive);
  expect(result.usdMicros).toBe(5_000_000n);
  expect(valueSwap(memeSwap(), memeMetadata, [zero]).usdMicros).toBeNull();
});
test('quote construction rejects a zero USDG side', () => {
  expect(() =>
    quoteFromRwaUsdgSwap(swap({ rawAmount1: 0n, amountOut: 0n }), directMetadata),
  ).toThrow(/amount/i);
});
