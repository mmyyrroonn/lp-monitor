import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { addQuote, createQuoteIndex, findPrecedingQuote } from '../../src/metrics/price.js';
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
const swapAt = (blockNumber: bigint, tokenIn: Address, tokenOut: Address): Swap => ({
  kind: 'swap',
  ref: ref(blockNumber),
  time: time(Number(blockNumber) * 10),
  tokenIn,
  tokenOut,
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
const quote = (blockNumber: bigint, token: Address, quoteToken: Address): QuoteObservation => ({
  token,
  quote: quoteToken,
  numerator: 1n,
  denominator: 1n,
  effectiveAt: ref(blockNumber),
  time: time(Number(blockNumber) * 10),
  source: 'rwa-usdg-swap',
  maxAgeSec: 60,
});

describe('quote index', () => {
  it('finds the latest preceding quote for the matching pair only', () => {
    const idx = createQuoteIndex();
    const TOKEN_A = addressOf('a');
    const TOKEN_B = addressOf('b');
    const USDG = addressOf('d');
    addQuote(idx, quote(5n, TOKEN_A, USDG));
    addQuote(idx, quote(10n, TOKEN_A, USDG));
    addQuote(idx, quote(7n, TOKEN_B, USDG)); // different pair, must be ignored
    const found = findPrecedingQuote(swapAt(12n, TOKEN_A, TOKEN_B), TOKEN_A, USDG, idx, 60);
    expect(found?.effectiveAt.blockNumber).toBe(10n);
  });
  it('rejects quotes that are too old', () => {
    const idx = createQuoteIndex();
    const TOKEN_A = addressOf('a');
    const USDG = addressOf('d');
    addQuote(idx, quote(1n, TOKEN_A, USDG)); // effectiveAt block 1, time 10
    const swap = swapAt(1000n, TOKEN_A, addressOf('e')); // time 10000
    expect(findPrecedingQuote(swap, TOKEN_A, USDG, idx, 60)).toBeNull();
  });
  it('keeps the flat all[] array in insertion order for the report', () => {
    const idx = createQuoteIndex();
    addQuote(idx, quote(5n, addressOf('a'), addressOf('d')));
    addQuote(idx, quote(6n, addressOf('b'), addressOf('d')));
    expect(idx.all.map((q) => q.effectiveAt.blockNumber)).toEqual([5n, 6n]);
  });
});
