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
