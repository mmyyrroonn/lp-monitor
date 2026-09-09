import { expect, test } from 'vitest';
import { toHex } from 'viem';
import type {
  BlockAnchor,
  LiquidityChange,
  PoolObservation,
  Swap,
} from '../../src/domain/types.js';
import { estimateGrossSwapFee } from '../../src/metrics/fees.js';
import { formatBigIntUnits, formatLabeledAmount } from '../../src/metrics/format.js';
import {
  annotateLatestSwapLiquidity,
  summarizeLiquidityActions,
} from '../../src/metrics/liquidity.js';

const pool = { chainId: 4663, protocol: 'v3', address: toHex(1, { size: 20 }) } as const;
const ref = (blockNumber: number, logIndex = 0) => ({
  blockNumber: BigInt(blockNumber),
  blockHash: toHex(blockNumber, { size: 32 }),
  transactionHash: toHex(blockNumber * 10 + logIndex, { size: 32 }),
  transactionIndex: 0,
  logIndex,
});
const change = (delta: bigint, tickLower: number, tickUpper: number): LiquidityChange => ({
  kind: 'liquidity',
  ref: ref(Number(delta < 0n ? -delta : delta) + 1),
  time: { minuteStartSec: 120, exactTimestampSec: null, source: 'minute-boundary' },
  pool,
  tickLower,
  tickUpper,
  delta,
  actor: pool.address,
  salt: null,
});
const swap = (time: Swap['time']): Swap => ({
  kind: 'swap',
  ref: ref(10),
  time,
  pool,
  rawAmount0: 1_000_000n,
  rawAmount1: -999_000n,
  tokenIn: pool.address,
  amountIn: 1_000_000n,
  tokenOut: toHex(2, { size: 20 }),
  amountOut: 999_000n,
  sqrtPriceX96After: 2n ** 96n,
  liquidityAfter: 987_654_321_012_345_678_901n,
  tickAfter: 42,
  effectiveSwapFeePips: 3000,
});
const anchor: BlockAnchor = { number: 12n, hash: toHex(12, { size: 32 }), timestampSec: 200 };

test('liquidity actions count add, remove, and zero separately and retain tick intervals', () => {
  const summary = summarizeLiquidityActions([
    change(10n, -120, 120),
    change(-4n, 0, 60),
    change(0n, -10, 10),
  ]);

  expect(summary.counts).toEqual({ add: 1, remove: 1, zeroDelta: 1 });
  expect(summary.actions.map(({ action, tickInterval }) => ({ action, tickInterval }))).toEqual([
    { action: 'add', tickInterval: { lower: -120, upper: 120 } },
    { action: 'remove', tickInterval: { lower: 0, upper: 60 } },
    { action: 'zero-delta', tickInterval: { lower: -10, upper: 10 } },
  ]);
  expect(summary.interpretation).toMatch(/not.*dollar|不.*美元/i);
});

test('latest Swap L age is exact only against an explicit timestamped anchor', () => {
  const observation: PoolObservation = {
    pool,
    lastSwap: swap({ minuteStartSec: 180, exactTimestampSec: 185, source: 'log-verified' }),
    lastLiquidityAction: null,
  };
  const annotation = annotateLatestSwapLiquidity(observation, anchor);

  expect(annotation).toMatchObject({
    liquidityRaw: 987_654_321_012_345_678_901n,
    tick: 42,
    ageSecInterval: { min: 15, max: 15 },
    freshness: 'at-last-swap',
  });
});

test('minute timing yields an age interval, while unresolved time yields null', () => {
  const minuteSwap = swap({
    minuteStartSec: 120,
    exactTimestampSec: null,
    source: 'minute-boundary',
  });
  const unresolvedSwap = swap({
    minuteStartSec: 120,
    exactTimestampSec: 185,
    source: 'unresolved',
  });
  expect(
    annotateLatestSwapLiquidity({ pool, lastSwap: minuteSwap, lastLiquidityAction: null }, anchor)
      ?.ageSecInterval,
  ).toEqual({ min: 21, max: 80 });
  expect(
    annotateLatestSwapLiquidity(
      { pool, lastSwap: unresolvedSwap, lastLiquidityAction: null },
      anchor,
    )?.ageSecInterval,
  ).toBeNull();
});

test('latest Swap L rejects an observation from a block after the anchor', () => {
  const futureSwap = {
    ...swap({ minuteStartSec: 180, exactTimestampSec: 185, source: 'log-verified' }),
    ref: ref(13),
  };

  expect(() =>
    annotateLatestSwapLiquidity({ pool, lastSwap: futureSwap, lastLiquidityAction: null }, anchor),
  ).toThrow(/after.*anchor|future/i);
});

test('latest Swap L rejects a same-height observation from another block hash', () => {
  const forkSwap = {
    ...swap({ minuteStartSec: 180, exactTimestampSec: 185, source: 'log-verified' }),
    ref: { ...ref(12), blockHash: toHex(99, { size: 32 }) },
  };

  expect(() =>
    annotateLatestSwapLiquidity({ pool, lastSwap: forkSwap, lastLiquidityAction: null }, anchor),
  ).toThrow(/hash|fork/i);
});

test('a later Burn does not update Swap L or assert dollar withdrawals', () => {
  const lastSwap = swap({ minuteStartSec: 180, exactTimestampSec: 185, source: 'log-verified' });
  const annotation = annotateLatestSwapLiquidity(
    { pool, lastSwap, lastLiquidityAction: { ...change(-500n, -50, 50), ref: ref(11) } },
    anchor,
  );

  expect(annotation?.liquidityRaw).toBe(lastSwap.liquidityAfter);
  expect(annotation?.freshness).toBe('before-last-liquidity-action');
  expect(annotation?.interpretation).toMatch(/last Swap|最近.*Swap/i);
  expect(annotation?.interpretation).toMatch(/not.*withdraw|不.*提款|不.*撤资/i);
  expect(
    annotateLatestSwapLiquidity(
      { pool, lastSwap: null, lastLiquidityAction: change(-1n, 0, 1) },
      anchor,
    ),
  ).toBeNull();
});

test('gross swap fee estimate is optional, integer-safe, and explicitly not LP net fee', () => {
  expect(estimateGrossSwapFee(1_000_001n, 3000, 'USDC', 'raw token units')).toEqual({
    amountRaw: 3000n,
    token: 'USDC',
    unit: 'raw token units',
    label: 'estimated gross swap fee (not LP net fee)',
  });
  expect(estimateGrossSwapFee(1_000_001n, null, 'USDC', 'raw token units')).toBeNull();
  expect(() => estimateGrossSwapFee(1n, 1_000_001, 'USDC', 'raw token units')).toThrow(/fee/i);
});

test('bigint formatting never loses precision and keeps the explanatory label and unit', () => {
  expect(formatBigIntUnits(12_345_678_901_234_567_890_123n, 6)).toBe('12345678901234567.890123');
  expect(formatBigIntUnits(-1n, 6)).toBe('-0.000001');
  expect(formatLabeledAmount(3_000n, 3, 'estimated gross swap fee', 'USDC')).toBe(
    'estimated gross swap fee: 3 USDC',
  );
});
