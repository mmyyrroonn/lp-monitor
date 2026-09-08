import type { LogRef, PoolEvent, PoolObservation } from '../domain/types.js';
import { poolRegistrationId } from '../registry/pools.js';

export function comparePosition(a: LogRef, b: LogRef): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex;
}

/** Event observations only: liquidity actions never extrapolate the latest pool L. */
export function observePool(previous: PoolObservation, event: PoolEvent): PoolObservation {
  if (!event.pool || poolRegistrationId(previous) !== poolRegistrationId({ pool: event.pool }))
    throw new Error('Observation pool mismatch');
  const field =
    event.kind === 'swap' ? 'lastSwap' : event.kind === 'liquidity' ? 'lastLiquidityAction' : null;
  if (!field) return previous;
  const old = previous[field];
  if (old && comparePosition(event.ref, old.ref) < 0) return previous;
  for (const prior of [previous.lastSwap, previous.lastLiquidityAction]) {
    if (
      prior &&
      prior.ref.blockNumber === event.ref.blockNumber &&
      prior.ref.blockHash.toLowerCase() !== event.ref.blockHash.toLowerCase()
    )
      throw new Error('Conflicting history: rebuild observations from active logs');
  }
  return event.kind === 'swap'
    ? { ...previous, lastSwap: event }
    : event.kind === 'liquidity'
      ? { ...previous, lastLiquidityAction: event }
      : previous;
}

export function observationFreshness(
  observation: PoolObservation,
): 'unobserved' | 'at-last-swap' | 'before-last-liquidity-action' {
  if (!observation.lastSwap) return 'unobserved';
  return observation.lastLiquidityAction &&
    comparePosition(observation.lastSwap.ref, observation.lastLiquidityAction.ref) < 0
    ? 'before-last-liquidity-action'
    : 'at-last-swap';
}
