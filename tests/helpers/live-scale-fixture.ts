import type { Address } from 'viem';
import type { BlockAnchor, LogRef, PoolRef, Swap } from '../../src/domain/types.js';
import type { MetricEvent, MinuteCoverage } from '../../src/metrics/windows.js';
import type { PoolRegistration } from '../../src/registry/pools.js';
import { addr, hash } from './alert-fixture.js';

/** Deterministic, legal-shape fixtures for the 2026-09-15 live runtime scale review. */
export const SCALE_CHAIN_ID = 4663 as const;
export const SCALE_SCOPE_ID = 'scale';
/** Review scale: 194 stocks, ~400 active pools, 181 covered minutes. */
export const SCALE_WATERMARK_SEC = 1_800_000_000;
export const SCALE_WATERMARK_BLOCK = 64_000_000n;
const SECONDS_PER_BLOCK = 12;
const BLOCKS_PER_MINUTE = BigInt(60 / SECONDS_PER_BLOCK);
const V3_POOL_BASE = 0x100000;
const ASSET_BASE = 0x200000;
const USDG_INDEX = 0xffff01;
const MANAGER_INDEX = 0xffff02;
/** Pools born inside the covered window, kept separate from the pre-window birth population. */
const BIRTHS_IN_WINDOW = 5;

export const SCALE_USDG: Address = addr(USDG_INDEX);
export const SCALE_MANAGER: Address = addr(MANAGER_INDEX);

export type ScaleOptions = {
  poolCount: number;
  activePoolCount: number;
  assetCount: number;
  historyMinutes: number;
};

export type ScaleData = {
  registrations: PoolRegistration[];
  events: MetricEvent[];
  coverage: MinuteCoverage[];
  watermark: BlockAnchor;
};

/** Structural work counters filled in by production entry points (default off). */
export type { WorkCounts } from '../../src/ops/work-counters.js';

export function scaleAssetAddress(index: number): Address {
  if (!Number.isInteger(index) || index < 0) throw new Error('asset index must be non-negative');
  return addr(ASSET_BASE + index);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function blockForSecondsAgo(secondsAgo: number): bigint {
  return SCALE_WATERMARK_BLOCK - BigInt(Math.floor(secondsAgo / SECONDS_PER_BLOCK));
}

function birthBlock(index: number, windowStart: bigint, poolCount: number): bigint {
  const bornInWindow = poolCount - 1 - index;
  if (bornInWindow < BIRTHS_IN_WINDOW && index < poolCount)
    return SCALE_WATERMARK_BLOCK - BigInt(bornInWindow);
  return windowStart - 1n - BigInt(index * 7);
}

function registrationAt(
  index: number,
  options: ScaleOptions,
  windowStart: bigint,
): PoolRegistration {
  const pool: PoolRef =
    index % 40 === 39
      ? { chainId: SCALE_CHAIN_ID, protocol: 'v3', address: addr(V3_POOL_BASE + index) }
      : {
          chainId: SCALE_CHAIN_ID,
          protocol: 'v4',
          manager: SCALE_MANAGER,
          poolId: hash(index + 1),
        };
  // Index 0 is the stock co-pool: both sides are watchlist assets rather than the USDG quote.
  const coPool = index === 0;
  const token0 = coPool
    ? scaleAssetAddress(1)
    : scaleAssetAddress(index % Math.max(1, options.assetCount));
  const token1 = coPool ? scaleAssetAddress(0) : SCALE_USDG;
  const blockNumber = birthBlock(index, windowStart, options.poolCount);
  return {
    pool,
    token0,
    token1,
    feePips: 3000,
    tickSpacing: 60,
    hooks: addr(0),
    discoveredAt: {
      blockNumber,
      blockHash: hash(Number(blockNumber % 1_000_000_000n)),
      transactionHash: hash(3_000_000_000 + index),
      transactionIndex: 0,
      logIndex: index % 64,
    },
    assetVersion: 'scale-v1',
    source: 'synthetic',
  };
}

function swapAt(
  index: number,
  registration: PoolRegistration,
  secondsAgo: number,
  raw: bigint,
): MetricEvent {
  const blockNumber = blockForSecondsAgo(secondsAgo);
  const exactTimestampSec = SCALE_WATERMARK_SEC - secondsAgo;
  const ref: LogRef = {
    blockNumber,
    blockHash: hash(Number(blockNumber % 1_000_000_000n)),
    transactionHash: hash(1_000_000_000 + index),
    transactionIndex: 0,
    logIndex: index % 128,
  };
  const event: Swap = {
    kind: 'swap',
    ref,
    time: {
      minuteStartSec: Math.floor(exactTimestampSec / 60) * 60,
      exactTimestampSec,
      source: 'log-verified',
    },
    pool: registration.pool,
    rawAmount0: raw,
    rawAmount1: -raw,
    tokenIn: registration.token0,
    amountIn: raw,
    tokenOut: registration.token1,
    amountOut: raw,
    sqrtPriceX96After: 2n ** 96n,
    liquidityAfter: 1_000_000n,
    tickAfter: 0,
    effectiveSwapFeePips: 3000,
  };
  return {
    event,
    usdMicros: raw,
    usdgNotionalRaw: raw,
    rawNotional: { token: registration.token0, raw },
    scopeId: SCALE_SCOPE_ID,
  };
}

export function makeScaleData(options: ScaleOptions): ScaleData {
  positiveInteger(options.poolCount, 'poolCount');
  positiveInteger(options.activePoolCount, 'activePoolCount');
  positiveInteger(options.assetCount, 'assetCount');
  positiveInteger(options.historyMinutes, 'historyMinutes');
  if (options.activePoolCount > options.poolCount)
    throw new Error('activePoolCount must not exceed poolCount');
  if (options.assetCount < 2) throw new Error('assetCount must cover the stock co-pool');

  const watermark: BlockAnchor = {
    number: SCALE_WATERMARK_BLOCK,
    hash: hash(Number(SCALE_WATERMARK_BLOCK % 1_000_000_000n)),
    timestampSec: SCALE_WATERMARK_SEC,
  };
  const coverage: MinuteCoverage[] = Array.from(
    { length: options.historyMinutes + 1 },
    (_, minute) => {
      const fromBlock =
        SCALE_WATERMARK_BLOCK -
        BigInt((options.historyMinutes - minute) * Number(BLOCKS_PER_MINUTE)) -
        BLOCKS_PER_MINUTE +
        1n;
      return {
        scopeId: SCALE_SCOPE_ID,
        minuteStartSec: SCALE_WATERMARK_SEC - (options.historyMinutes - minute) * 60,
        fromBlock,
        toBlock: fromBlock + BLOCKS_PER_MINUTE - 1n,
        complete: true,
        reasons: [],
      };
    },
  );
  const windowStart = coverage[0]!.fromBlock!;
  const registrations = Array.from({ length: options.poolCount }, (_, index) =>
    registrationAt(index, options, windowStart),
  );
  const events: MetricEvent[] = [];
  for (let index = 0; index < options.activePoolCount; index += 1) {
    const registration = registrations[index]!;
    // One event inside the current minute and one a few minutes back, both inside the window.
    events.push(swapAt(index * 2, registration, 30 + (index % 30), 1_000_000n + BigInt(index)));
    events.push(
      swapAt(index * 2 + 1, registration, 600 + (index % 300), 2_000_000n + BigInt(index)),
    );
  }
  return { registrations, events, coverage, watermark };
}
