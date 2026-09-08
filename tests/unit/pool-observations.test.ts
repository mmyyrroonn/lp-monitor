import { expect, test } from 'vitest';
import { toHex } from 'viem';
import type { PoolObservation, Swap, LiquidityChange } from '../../src/domain/types.js';
import { observePool, observationFreshness } from '../../src/state/observations.js';
const pool = { chainId: 4663, protocol: 'v3', address: toHex(1, { size: 20 }) } as const;
const ref = (n: number) => ({
  blockNumber: BigInt(n),
  blockHash: toHex(n, { size: 32 }),
  transactionHash: toHex(n, { size: 32 }),
  transactionIndex: 0,
  logIndex: 0,
});
const time = { minuteStartSec: 120, exactTimestampSec: null, source: 'minute-boundary' } as const;
const empty = (): PoolObservation => ({ pool, lastSwap: null, lastLiquidityAction: null });
const swap = (n: number, l = 1000n): Swap => ({
  kind: 'swap',
  pool,
  ref: ref(n),
  time,
  rawAmount0: 100n,
  rawAmount1: -90n,
  tokenIn: pool.address,
  tokenOut: toHex(2, { size: 20 }),
  amountIn: 100n,
  amountOut: 90n,
  sqrtPriceX96After: 2n ** 96n,
  liquidityAfter: l,
  tickAfter: 0,
  effectiveSwapFeePips: 3000,
});
const burn = (n: number): LiquidityChange => ({
  kind: 'liquidity',
  pool,
  ref: ref(n),
  time,
  tickLower: -10,
  tickUpper: 10,
  delta: -100n,
  actor: pool.address,
  salt: null,
});
test('Burn preserves last Swap L and explicitly marks its older observation', () => {
  const initial = observePool(empty(), swap(1));
  const after = observePool(initial, burn(2));
  expect(after.lastSwap?.liquidityAfter).toBe(1000n);
  expect(observationFreshness(after)).toBe('before-last-liquidity-action');
  expect(initial.lastLiquidityAction).toBeNull();
  const latest = observePool(after, swap(3, 700n));
  expect(latest.lastSwap?.liquidityAfter).toBe(700n);
  expect(observationFreshness(latest)).toBe('at-last-swap');
});
test('old pool needs no historical state, and Burn alone leaves lastSwap null', () => {
  expect(observePool(empty(), swap(1)).lastSwap).toEqual(swap(1));
  const onlyBurn = observePool(empty(), burn(2));
  expect(onlyBurn.lastSwap).toBeNull();
  expect(observationFreshness(onlyBurn)).toBe('unobserved');
});
test('out of order events cannot replace newer observations; positions order same block', () => {
  const latest = observePool(empty(), swap(2));
  expect(observePool(latest, swap(1))).toEqual(latest);
  const later = { ...burn(2), ref: { ...ref(2), logIndex: 1 } };
  expect(observationFreshness(observePool(latest, later))).toBe('before-last-liquidity-action');
});
test('cross-pool observations and same-position conflicting histories are rejected', () => {
  expect(() =>
    observePool(empty(), { ...swap(1), pool: { ...pool, address: toHex(2, { size: 20 }) } }),
  ).toThrow(/pool/i);
  expect(() =>
    observePool(observePool(empty(), swap(1)), {
      ...swap(1),
      ref: { ...ref(1), blockHash: toHex(99, { size: 32 }) },
    }),
  ).toThrow(/rebuild/i);
});

test('same block fork with earlier logIndex is rejected before ordering early return', () => {
  const original = { ...swap(2), ref: { ...ref(2), logIndex: 10 } };
  const conflicting = {
    ...swap(2),
    ref: { ...ref(2), logIndex: 5, blockHash: toHex(999, { size: 32 }) },
  };
  expect(() => observePool(observePool(empty(), original), conflicting)).toThrow(
    /Conflicting history/,
  );
});
test('manager-wide ancillary event leaves pool observation unchanged', () => {
  const previous = observePool(empty(), swap(2));
  expect(
    observePool(previous, {
      kind: 'other',
      pool: null,
      ref: ref(3),
      time,
      decoded: { eventName: 'Transfer' },
    }),
  ).toBe(previous);
});
