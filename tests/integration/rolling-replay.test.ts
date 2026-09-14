import { expect, test } from 'vitest';
import { hash, swap } from '../helpers/alert-fixture.js';
import type { MetricEvent } from '../../src/metrics/windows.js';
import { rollingWindow, runRollingReplay } from '../../src/replay/rolling-replay.js';

function event(exactTimestampSec: number | null, minuteStartSec: number | null): MetricEvent {
  return {
    event: {
      kind: 'swap',
      ref: swap(exactTimestampSec ?? minuteStartSec ?? 0),
      time: { exactTimestampSec, minuteStartSec, source: 'synthetic' },
      pool: null,
    },
    usdMicros: 1n,
    usdgNotionalRaw: 1n,
    rawNotional: null,
  } as unknown as MetricEvent;
}

test('rolling windows are left-open and keep uncertain minute edges unknown', () => {
  const selected = event(701, 660);
  const atLeft = event(400, 420);
  const uncertain = event(null, 660);
  const result = rollingWindow([selected, atLeft, uncertain], '5m', 1_000);
  expect(result.fromSec).toBe(700);
  expect(result.selected).toContain(selected);
  expect(result.selected).not.toContain(atLeft);
  expect(result.unknown).toContain(uncertain);
});

test('cadence is honoured from provable chain time and disclosed when it cannot be', () => {
  const minuteWatermarks = Array.from({ length: 5 }, (_, index) => ({
    number: BigInt(10 + index),
    hash: hash(10 + index),
    timestampSec: 600 + index * 60,
  }));
  const unprovable = runRollingReplay({
    events: [],
    coverage: [],
    watermarks: minuteWatermarks,
    cadenceSec: 10,
  });
  expect(unprovable.evaluations).toHaveLength(5);
  expect(unprovable.effectiveCadenceSec).toBe(60);
  expect(unprovable.issues.some((issue) => issue.startsWith('evaluation-cadence-unprovable'))).toBe(
    true,
  );
  const exact = Array.from({ length: 30 }, (_, index) => event(600 + index * 10, 600 + index * 10));
  const proven = runRollingReplay({
    events: exact,
    coverage: [],
    watermarks: [minuteWatermarks[0]!],
    cadenceSec: 10,
  });
  expect(proven.evaluations.length).toBeGreaterThan(20);
  expect(proven.effectiveCadenceSec).toBe(10);
  expect(proven.issues).toEqual([]);
});

test('rolling replay never evaluates an event after the watermark', () => {
  const future = event(1_200, 1_200);
  const current = event(1_000, 960);
  const result = runRollingReplay({
    events: [future, current],
    coverage: [],
    watermarks: [
      { number: 10n, hash: hash(10), timestampSec: 1_000 },
      { number: 20n, hash: hash(20), timestampSec: 1_200 },
    ],
    cadenceSec: 10,
  });
  expect(result.evaluations).toHaveLength(2);
  expect(result.evaluations[0]!.windows).toEqual([]);
  expect(result.evaluations[1]!.windows).toEqual([]);
});
