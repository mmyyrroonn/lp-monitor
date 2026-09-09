import type {
  BlockAnchor,
  LiquidityChange,
  LogRef,
  LogTime,
  PoolObservation,
} from '../domain/types.js';
import { observationFreshness } from '../state/observations.js';

export type LiquidityActionKind = 'add' | 'remove' | 'zero-delta';
export type LiquidityActionAnnotation = {
  action: LiquidityActionKind;
  delta: bigint;
  tickInterval: { lower: number; upper: number };
  ref: LogRef;
};
export type LiquidityActionSummary = {
  counts: { add: number; remove: number; zeroDelta: number };
  actions: readonly LiquidityActionAnnotation[];
  interpretation: string;
};

export function summarizeLiquidityActions(
  changes: readonly LiquidityChange[],
): LiquidityActionSummary {
  let add = 0;
  let remove = 0;
  let zeroDelta = 0;
  const actions = changes.map((change): LiquidityActionAnnotation => {
    if (change.tickLower >= change.tickUpper) throw new RangeError('invalid tick interval');
    const action = change.delta > 0n ? 'add' : change.delta < 0n ? 'remove' : 'zero-delta';
    if (action === 'add') add++;
    else if (action === 'remove') remove++;
    else zeroDelta++;
    return {
      action,
      delta: change.delta,
      tickInterval: { lower: change.tickLower, upper: change.tickUpper },
      ref: change.ref,
    };
  });
  return {
    counts: { add, remove, zeroDelta },
    actions,
    interpretation:
      'Liquidity deltas are protocol L actions, not verified dollar deposits or withdrawals.',
  };
}

export type AgeIntervalSec = { min: number; max: number };
export type SwapLiquidityAnnotation = {
  liquidityRaw: bigint;
  tick: number;
  observedAt: LogRef;
  anchor: BlockAnchor;
  ageSecInterval: AgeIntervalSec | null;
  freshness: ReturnType<typeof observationFreshness>;
  interpretation: string;
};

function observationAge(time: LogTime, anchorTimestampSec: number): AgeIntervalSec | null {
  if (time.source === 'unresolved') return null;
  if (time.exactTimestampSec !== null) {
    const age = anchorTimestampSec - time.exactTimestampSec;
    return age < 0 ? null : { min: age, max: age };
  }
  if (time.minuteStartSec === null) return null;
  const max = anchorTimestampSec - time.minuteStartSec;
  const min = anchorTimestampSec - (time.minuteStartSec + 59);
  return max < 0 ? null : { min: Math.max(0, min), max };
}

/** Reports only the L carried by the latest Swap; later liquidity actions do not mutate it. */
export function annotateLatestSwapLiquidity(
  observation: PoolObservation,
  anchor: BlockAnchor,
): SwapLiquidityAnnotation | null {
  const swap = observation.lastSwap;
  if (!swap) return null;
  if (swap.ref.blockNumber > anchor.number)
    throw new Error('Cannot annotate a Swap from a block after the anchor');
  if (
    swap.ref.blockNumber === anchor.number &&
    swap.ref.blockHash.toLowerCase() !== anchor.hash.toLowerCase()
  )
    throw new Error('Cannot annotate a same-height Swap with an anchor block hash mismatch');
  const freshness = observationFreshness(observation);
  return {
    liquidityRaw: swap.liquidityAfter,
    tick: swap.tickAfter,
    observedAt: swap.ref,
    anchor,
    ageSecInterval: observationAge(swap.time, anchor.timestampSec),
    freshness,
    interpretation:
      freshness === 'before-last-liquidity-action'
        ? 'L is from the last Swap before a later liquidity action; it is not proof of a withdrawal or current L.'
        : 'L is observed at the last Swap and is not verified current L or a dollar liquidity value.',
  };
}
