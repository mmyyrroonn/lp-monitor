import type { Address } from 'viem';
import type { LogRef, LogTime, QuoteObservation, Swap } from '../domain/types.js';
import type { SwapValuationMetadata } from './notional.js';

const sameAddress = (left: Address, right: Address): boolean =>
  left.toLowerCase() === right.toLowerCase();
const pow10 = (decimals: number): bigint => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    throw new RangeError('decimals must be an integer from 0 through 255');
  return 10n ** BigInt(decimals);
};
function validateRatio(raw: bigint, denominator: bigint): void {
  if (raw < 0n) throw new RangeError('raw amount must be non-negative');
  if (denominator <= 0n) throw new RangeError('price denominator must be positive');
}

export function quoteRawToMicros(
  raw: bigint,
  decimals: number,
  priceNumerator: bigint,
  priceDenominator: bigint,
): bigint {
  validateRatio(raw, priceDenominator);
  if (priceNumerator < 0n) throw new RangeError('price numerator must be non-negative');
  return (raw * priceNumerator * 1_000_000n) / (pow10(decimals) * priceDenominator);
}

export function quoteRawToRaw(
  raw: bigint,
  decimals: number,
  priceNumerator: bigint,
  priceDenominator: bigint,
  quoteDecimals: number,
): bigint {
  validateRatio(raw, priceDenominator);
  if (priceNumerator < 0n) throw new RangeError('price numerator must be non-negative');
  return (raw * priceNumerator * pow10(quoteDecimals)) / (pow10(decimals) * priceDenominator);
}

function compareRef(left: LogRef, right: LogRef): number {
  if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
  if (left.transactionIndex !== right.transactionIndex)
    return left.transactionIndex - right.transactionIndex;
  return left.logIndex - right.logIndex;
}
function interval(time: LogTime): readonly [number, number] | null {
  if (time.source === 'unresolved') return null;
  if (time.exactTimestampSec !== null) return [time.exactTimestampSec, time.exactTimestampSec];
  if (time.minuteStartSec !== null && time.source === 'minute-boundary')
    return [time.minuteStartSec, time.minuteStartSec + 59];
  return null;
}
function upperAgeSec(eventTime: LogTime, quoteTime: LogTime): number | null {
  const event = interval(eventTime);
  const quote = interval(quoteTime);
  if (event === null || quote === null) return null;
  return event[1] - quote[0];
}

export function findPrecedingQuote(
  swap: Swap,
  token: Address,
  quoteToken: Address,
  quotes: readonly QuoteObservation[],
  maxQuoteAgeSec: number,
): QuoteObservation | null {
  if (!Number.isInteger(maxQuoteAgeSec) || maxQuoteAgeSec < 0)
    throw new RangeError('maxQuoteAgeSec must be a non-negative integer');
  let selected: QuoteObservation | null = null;
  for (const candidate of quotes) {
    if (!sameAddress(candidate.token, token) || !sameAddress(candidate.quote, quoteToken)) continue;
    if (candidate.denominator <= 0n || candidate.numerator < 0n) continue;
    if (compareRef(candidate.effectiveAt, swap.ref) >= 0) continue;
    const age = upperAgeSec(swap.time, candidate.time);
    const allowedAge = Math.min(maxQuoteAgeSec, candidate.maxAgeSec);
    if (age === null || age < 0 || age > allowedAge) continue;
    if (selected === null || compareRef(selected.effectiveAt, candidate.effectiveAt) < 0)
      selected = candidate;
  }
  return selected;
}

export function quoteFromRwaUsdgSwap(
  swap: Swap,
  metadata: SwapValuationMetadata,
): QuoteObservation | null {
  const token0 = metadata.token0;
  const token1 = metadata.token1;
  const rwaSide = sameAddress(token0.address, metadata.rwa)
    ? token0
    : sameAddress(token1.address, metadata.rwa)
      ? token1
      : null;
  const usdgSide = sameAddress(token0.address, metadata.usdg)
    ? token0
    : sameAddress(token1.address, metadata.usdg)
      ? token1
      : null;
  if (rwaSide === null || usdgSide === null) return null;
  if (rwaSide.decimals === null || usdgSide.decimals === null) return null;
  const rwaRaw = sameAddress(token0.address, metadata.rwa) ? swap.rawAmount0 : swap.rawAmount1;
  const usdgRaw = sameAddress(token0.address, metadata.usdg) ? swap.rawAmount0 : swap.rawAmount1;
  const rwaAmount = rwaRaw < 0n ? -rwaRaw : rwaRaw;
  const usdgAmount = usdgRaw < 0n ? -usdgRaw : usdgRaw;
  if (rwaAmount <= 0n || usdgAmount < 0n)
    throw new RangeError('RWA quote denominator amount must be positive');
  return {
    token: metadata.rwa,
    quote: metadata.usdg,
    numerator: usdgAmount * pow10(rwaSide.decimals),
    denominator: rwaAmount * pow10(usdgSide.decimals),
    effectiveAt: swap.ref,
    time: swap.time,
    source: 'rwa-usdg-swap',
    maxAgeSec: metadata.maxQuoteAgeSec ?? 60,
  };
}
