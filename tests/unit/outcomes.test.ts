import { expect, it } from 'vitest';
import { evaluateOutcomes } from '../../src/replay/outcomes.js';
import type { MetricEvent, MinuteCoverage } from '../../src/metrics/windows.js';
import { registration, swap } from '../helpers/alert-fixture.js';
const pool = registration.pool;
const coverage = (end = 181 * 60, gap?: number): MinuteCoverage[] =>
  Array.from({ length: end / 60 }, (_, i) => ({
    scopeId: 's',
    minuteStartSec: i * 60,
    fromBlock: BigInt(i * 60),
    toBlock: BigInt(i * 60 + 59),
    complete: i * 60 !== gap,
    reasons: i * 60 === gap ? ['missing-shard'] : [],
  }));
function event(minute: number, id: number, usd: bigint | null = 10n): MetricEvent {
  const raw = swap(minute + 1);
  return {
    event: {
      kind: 'swap',
      pool,
      ref: { ...raw, logIndex: id },
      time: { minuteStartSec: minute, exactTimestampSec: null, source: 'minute-boundary' },
      rawAmount0: 1n,
      rawAmount1: -1n,
      tokenIn: registration.token0,
      amountIn: 1n,
      tokenOut: registration.token1,
      amountOut: 1n,
      sqrtPriceX96After: 1n,
      liquidityAfter: 1n,
      tickAfter: 0,
      effectiveSwapFeePips: null,
    },
    usdMicros: usd,
    usdgNotionalRaw: 10n,
    scopeId: 's',
  };
}
const alert = { pool, triggerMinuteStartSec: 0 };
it('excludes the entire trigger minute and counts target pool swaps and distinct transactions', () => {
  const events = [event(0, 0, 1000n), event(60, 0), event(60, 1), event(120, 0)];
  const result = evaluateOutcomes(alert, [...events, events[1]!], {
    minutes: coverage(),
    endSec: 181 * 60,
    scopeId: 's',
  });
  expect(result.windows[0]).toMatchObject({
    horizonMinutes: 15,
    status: 'complete',
    usdMicros: 30n,
    swapCount: 3,
    txCount: 2,
    activeMinutes: 2,
    longestActiveRunMinutes: 2,
  });
  expect(result.windows.map((w) => w.horizonMinutes)).toEqual([15, 60, 180]);
});
it('keeps gaps null, distinguishes missing valuations from missing swaps, and marks right censoring', () => {
  const result = evaluateOutcomes(alert, [event(60, 0, null)], {
    minutes: coverage(120 * 60, 180),
    endSec: 120 * 60,
    scopeId: 's',
  });
  expect(result.windows[0]).toMatchObject({
    status: 'incomplete',
    usdMicros: null,
    swapCount: null,
  });
  expect(result.windows[2]).toMatchObject({
    status: 'incomplete',
    censored: true,
    incomplete: true,
  });
  const unpriced = evaluateOutcomes(alert, [event(60, 0, null)], {
    minutes: coverage(),
    endSec: 181 * 60,
    scopeId: 's',
  });
  expect(unpriced.windows[0]).toMatchObject({
    status: 'complete',
    usdMicros: null,
    swapCount: 1,
    valuationComplete: false,
  });
});
it('proven empty windows are zero, missing minutes are not zero', () => {
  expect(
    evaluateOutcomes(alert, [], { minutes: coverage(), endSec: 181 * 60, scopeId: 's' }).windows[0],
  ).toMatchObject({ status: 'complete', swapCount: 0, usdMicros: 0n, activeMinutes: 0 });
  expect(
    evaluateOutcomes(alert, [], { minutes: [], endSec: 181 * 60, scopeId: 's' }).windows[0],
  ).toMatchObject({ status: 'incomplete', swapCount: null, usdMicros: null });
});
it('evaluates 0/1/5 minute reaction delays from the next minute without lookahead', () => {
  const result = evaluateOutcomes(
    { ...alert, reactionDelayMinutes: 1 },
    [event(60, 0, 100n), event(120, 0, 20n)],
    { minutes: coverage(), endSec: 181 * 60, scopeId: 's' },
  );
  expect(result.windows[0]).toMatchObject({ startSec: 120, usdMicros: 20n });
  expect(result.windows[2]!.censored).toBe(true);
});
it('unresolved time within the outcome block envelope makes counts incomplete', () => {
  const unresolved = event(60, 0);
  unresolved.event.time = { minuteStartSec: null, exactTimestampSec: null, source: 'unresolved' };
  expect(
    evaluateOutcomes(alert, [unresolved], { minutes: coverage(), endSec: 181 * 60, scopeId: 's' })
      .windows[0],
  ).toMatchObject({ incomplete: true, swapCount: null });
});

it('never counts an event after the observed end as part of a censored observed prefix', () => {
  const result = evaluateOutcomes(alert, [event(60, 0), event(600, 0)], {
    minutes: coverage(120),
    endSec: 120,
    scopeId: 's',
  });
  expect(result.windows[0]).toMatchObject({
    censored: true,
    observedSwapCount: 1,
    observedTxCount: 1,
  });
});
