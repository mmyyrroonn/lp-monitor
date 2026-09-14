import { expect, test } from 'vitest';
import type { PoolRef } from '../../src/domain/types.js';
import type { MetricEvent, MinuteCoverage } from '../../src/metrics/windows.js';
import { evaluateStudyOutcomeWindows } from '../../src/replay/study-run.js';
import { swap } from '../helpers/alert-fixture.js';

const pool: PoolRef = {
  chainId: 4663,
  protocol: 'v3',
  address: ('0x' + '11'.repeat(20)) as `0x${string}`,
};

function metricEvent(
  index: number,
  exactTimestampSec: number | null,
  minuteStartSec: number | null,
  usdUnits: number,
): MetricEvent {
  const log = swap(100 + index, usdUnits);
  return {
    event: {
      kind: 'swap',
      ref: { ...log, logIndex: index },
      time: { exactTimestampSec, minuteStartSec, source: 'synthetic' },
      pool,
    },
    usdMicros: BigInt(usdUnits) * 1_000_000n,
    usdgNotionalRaw: BigInt(usdUnits) * 1_000_000n,
    rawNotional: null,
  } as unknown as MetricEvent;
}

function coverage(fromSec: number, toSec: number): MinuteCoverage[] {
  const minutes: MinuteCoverage[] = [];
  for (let sec = fromSec; sec < toSec; sec += 60)
    minutes.push({
      scopeId: 's',
      minuteStartSec: sec,
      fromBlock: null,
      toBlock: null,
      complete: true,
      reasons: [],
    });
  return minutes;
}

function windowAt(triggerSec: number, delay: 0 | 1 | 5, events: MetricEvent[], endSec = 60_000) {
  return evaluateStudyOutcomeWindows(triggerSec, pool, delay, events, {
    minutes: coverage(0, endSec),
    scopeId: 's',
    endSec,
    integrityComplete: true,
  });
}

test('outcome windows start at the trigger second instead of the minute start', () => {
  // Only trade is 30 seconds before the 6050 trigger; the report must not count it.
  const before = metricEvent(0, 6_020, 6_000, 30_000);
  const after = metricEvent(1, 6_110, 6_060, 5_000);
  const result = windowAt(6_050, 0, [before, after]);
  const fifteen = result.find((window) => window.horizonMinutes === 15)!;
  expect(fifteen.startSec).toBe(6_050);
  expect(fifteen.status).toBe('complete');
  expect(fifteen.swapCount).toBe(1);
  expect(fifteen.usdMicros).toBe(5_000_000_000n);
  const withoutAfter = windowAt(6_050, 0, [before]);
  expect(withoutAfter.find((window) => window.horizonMinutes === 15)!.swapCount).toBe(0);
  expect(withoutAfter.find((window) => window.horizonMinutes === 15)!.usdMicros).toBe(0n);
});

test('reaction delays shift the start second and keep delayed trades out', () => {
  const event = metricEvent(0, 6_070, 6_060, 5_000);
  const immediate = windowAt(6_050, 0, [event]);
  expect(immediate.find((window) => window.horizonMinutes === 15)!.swapCount).toBe(1);
  const delayed = windowAt(6_050, 1, [event]);
  const fifteen = delayed.find((window) => window.horizonMinutes === 15)!;
  expect(fifteen.startSec).toBe(6_110);
  expect(fifteen.swapCount).toBe(0);
  expect(fifteen.usdMicros).toBe(0n);
});

test('minute-only events that straddle the trigger stay unknown', () => {
  // The event's minute spans the trigger second, so its side is not provable.
  const straddling = metricEvent(0, null, 6_000, 30_000);
  const result = windowAt(6_050, 0, [straddling]);
  const fifteen = result.find((window) => window.horizonMinutes === 15)!;
  expect(fifteen.status).toBe('incomplete');
  expect(fifteen.reasons).toContain('unresolved-event-time');
  expect(fifteen.usdMicros).toBeNull();
  const earlierMinute = windowAt(6_050, 0, [metricEvent(1, null, 5_940, 30_000)]);
  const clean = earlierMinute.find((window) => window.horizonMinutes === 15)!;
  expect(clean.status).toBe('complete');
  expect(clean.swapCount).toBe(0);
});

test('minute-only events that straddle the right edge stay unknown', () => {
  // The 6900 minute overlaps the [6050,6950) end; the trade could be after 6950.
  const straddling = metricEvent(0, null, 6_900, 5_000);
  const result = windowAt(6_050, 0, [straddling]);
  const fifteen = result.find((window) => window.horizonMinutes === 15)!;
  expect(fifteen.status).toBe('incomplete');
  expect(fifteen.reasons).toContain('unresolved-event-time');
  expect(fifteen.swapCount).toBeNull();
  expect(fifteen.usdMicros).toBeNull();
  const beforeEdge = windowAt(6_050, 0, [metricEvent(1, null, 6_840, 5_000)]);
  const clean = beforeEdge.find((window) => window.horizonMinutes === 15)!;
  expect(clean.status).toBe('complete');
  expect(clean.swapCount).toBe(1);
});

test('a window without its last intersecting minute is not a complete zero', () => {
  const minutes = coverage(0, 6_960).filter((item) => item.minuteStartSec !== 6_900);
  const result = evaluateStudyOutcomeWindows(6_050, pool, 0, [], {
    minutes,
    scopeId: 's',
    endSec: 6_950,
    integrityComplete: true,
  });
  const fifteen = result.find((window) => window.horizonMinutes === 15)!;
  expect(fifteen.status).toBe('incomplete');
  expect(fifteen.expectedMinutes).toBe(16);
  expect(fifteen.coveredMinutes).toBe(15);
  expect(fifteen.reasons).toContain('missing-minute');
  expect(fifteen.swapCount).toBeNull();
  expect(fifteen.usdMicros).toBeNull();
});

test('active run statistics include the last intersecting minute', () => {
  const event = metricEvent(0, 6_920, 6_900, 5_000);
  const result = windowAt(6_050, 0, [event]);
  const fifteen = result.find((window) => window.horizonMinutes === 15)!;
  expect(fifteen.activeMinutes).toBe(1);
  expect(fifteen.longestActiveRunMinutes).toBe(1);
});

test('the baseline window gives a relative multiple for the forward result', () => {
  const baseline = metricEvent(0, 5_200, 5_160, 1_000);
  const forward = metricEvent(1, 6_100, 6_060, 5_000);
  const result = windowAt(6_050, 0, [baseline, forward]);
  const fifteen = result.find((window) => window.horizonMinutes === 15)!;
  expect(fifteen.usdMicros).toBe(5_000_000_000n);
  expect(fifteen.baselineUsdMicros).toBe(1_000_000_000n);
  expect(fifteen.relativeMultiple).toBe(5);
  const noBaseline = windowAt(6_050, 0, [forward]).find((window) => window.horizonMinutes === 15)!;
  expect(noBaseline.baselineUsdMicros).toBe(0n);
  expect(noBaseline.relativeMultiple).toBeNull();
});

test('windows beyond the proven coverage stay censored with no totals', () => {
  const result = evaluateStudyOutcomeWindows(4_800, pool, 0, [], {
    minutes: coverage(0, 4_860),
    scopeId: 's',
    endSec: 4_860,
    integrityComplete: true,
  });
  const fifteen = result.find((window) => window.horizonMinutes === 15)!;
  expect(fifteen.censored).toBe(true);
  expect(fifteen.status).toBe('censored');
  expect(fifteen.usdMicros).toBeNull();
  const hour = result.find((window) => window.horizonMinutes === 60)!;
  expect(hour.status).toBe('censored');
});
