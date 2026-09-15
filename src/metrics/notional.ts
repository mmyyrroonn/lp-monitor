import type { Address } from 'viem';
import type { LogRef, LogTime, PoolRef, Quality, QuoteObservation, Swap } from '../domain/types.js';
import { countWork } from '../ops/work-counters.js';
import { rawLogKey } from '../storage/manifest.js';
import { findPrecedingQuote, quoteRawToMicros, quoteRawToRaw } from './price.js';

export type TokenRole = 'rwa' | 'usdg' | 'meme' | 'other';
export type ValuationTokenMetadata = {
  address: Address;
  decimals: number | null;
  role: TokenRole;
};
export type SwapValuationMetadata = {
  token0: ValuationTokenMetadata;
  token1: ValuationTokenMetadata;
  rwa: Address;
  usdg: Address;
  usdgDecimals: number | null;
  maxQuoteAgeSec?: number;
};
export type SwapValuation = {
  ref: LogRef;
  eventId: string;
  time: LogTime;
  pool: PoolRef;
  transactionHash: LogRef['transactionHash'];
  nativeToken: Address;
  nativeAmountRaw: bigint;
  nativeDecimals: number | null;
  nativeSide: 'token0' | 'token1';
  usdgNotionalRaw: bigint | null;
  usdMicros: bigint | null;
  pricingSide: 'usdg' | 'rwa-quote';
  quoteEvidence: QuoteObservation | null;
  quality: Quality['valuation'];
};

const sameAddress = (left: Address, right: Address): boolean =>
  left.toLowerCase() === right.toLowerCase();

function checkedDecimals(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError('Token decimals must be an integer from 0 through 255');
  }
  return value;
}

function absoluteRaw(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function validatePair(swap: Swap, metadata: SwapValuationMetadata): void {
  const inputKnown =
    sameAddress(swap.tokenIn, metadata.token0.address) ||
    sameAddress(swap.tokenIn, metadata.token1.address);
  const outputKnown =
    sameAddress(swap.tokenOut, metadata.token0.address) ||
    sameAddress(swap.tokenOut, metadata.token1.address);
  if (!inputKnown || !outputKnown || sameAddress(swap.tokenIn, swap.tokenOut)) {
    throw new Error('Swap token metadata does not match the swap pair');
  }
  if (
    swap.rawAmount0 !== 0n &&
    swap.rawAmount1 !== 0n &&
    swap.rawAmount0 > 0n === swap.rawAmount1 > 0n
  ) {
    throw new RangeError('Swap raw amounts must have opposing directions');
  }
  checkedDecimals(metadata.token0.decimals);
  checkedDecimals(metadata.token1.decimals);
  checkedDecimals(metadata.usdgDecimals);
  if (
    metadata.maxQuoteAgeSec !== undefined &&
    (!Number.isInteger(metadata.maxQuoteAgeSec) || metadata.maxQuoteAgeSec < 0)
  ) {
    throw new RangeError('maxQuoteAgeSec must be a non-negative integer');
  }
}

function sideFor(metadata: SwapValuationMetadata, token: Address): 'token0' | 'token1' {
  if (sameAddress(metadata.token0.address, token)) return 'token0';
  if (sameAddress(metadata.token1.address, token)) return 'token1';
  throw new Error('Selected valuation token is absent from pool metadata');
}

export function valueSwap(
  swap: Swap,
  metadata: SwapValuationMetadata,
  quotes: readonly QuoteObservation[],
): SwapValuation {
  countWork('valuationComputes');
  validatePair(swap, metadata);
  const hasUsdg =
    sameAddress(metadata.token0.address, metadata.usdg) ||
    sameAddress(metadata.token1.address, metadata.usdg);
  const nativeToken = hasUsdg ? metadata.usdg : metadata.rwa;
  const nativeSide = sideFor(metadata, nativeToken);
  const nativeMetadata = nativeSide === 'token0' ? metadata.token0 : metadata.token1;
  const nativeAmountRaw = absoluteRaw(nativeSide === 'token0' ? swap.rawAmount0 : swap.rawAmount1);
  const base = {
    ref: swap.ref,
    eventId: rawLogKey(swap.ref),
    time: swap.time,
    pool: swap.pool,
    transactionHash: swap.ref.transactionHash,
    nativeToken,
    nativeAmountRaw,
    nativeDecimals: nativeMetadata.decimals,
    nativeSide,
  } as const;

  if (hasUsdg) {
    const usdgDecimals = nativeMetadata.decimals;
    if (usdgDecimals === null) {
      return {
        ...base,
        usdgNotionalRaw: null,
        usdMicros: null,
        pricingSide: 'usdg',
        quoteEvidence: null,
        quality: 'unpriced',
      };
    }
    return {
      ...base,
      usdgNotionalRaw: nativeAmountRaw,
      usdMicros: quoteRawToMicros(nativeAmountRaw, usdgDecimals, 1n, 1n),
      pricingSide: 'usdg',
      quoteEvidence: null,
      quality: 'usdg-only',
    };
  }

  const quote = findPrecedingQuote(
    swap,
    metadata.rwa,
    metadata.usdg,
    quotes,
    metadata.maxQuoteAgeSec ?? 60,
  );
  if (quote === null || nativeMetadata.decimals === null || metadata.usdgDecimals === null) {
    return {
      ...base,
      usdgNotionalRaw: null,
      usdMicros: null,
      pricingSide: 'rwa-quote',
      quoteEvidence: null,
      quality: 'unpriced',
    };
  }
  return {
    ...base,
    usdgNotionalRaw: quoteRawToRaw(
      nativeAmountRaw,
      nativeMetadata.decimals,
      quote.numerator,
      quote.denominator,
      metadata.usdgDecimals,
    ),
    usdMicros: quoteRawToMicros(
      nativeAmountRaw,
      nativeMetadata.decimals,
      quote.numerator,
      quote.denominator,
    ),
    pricingSide: 'rwa-quote',
    quoteEvidence: quote,
    quality: 'usd-estimate',
  };
}
