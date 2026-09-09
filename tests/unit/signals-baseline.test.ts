import { expect, it } from 'vitest';
import { signalBaseline, meetsMultiple } from '../../src/signals/baseline.js';
it('uses only closed past same scale and returns null on insufficient and zero', () => {
  const sample = (
    startSec: number,
    value: bigint | null,
    status = 'closed',
    unit = 'usdMicros',
  ) => ({ startSec, endSec: startSec + 60, status, value, unit });
  const current = sample(120, 50n, 'partial');
  const mixed = [
    sample(0, 10n),
    sample(60, 10n, 'gap'),
    sample(60, 999n, 'closed', 'raw:T'),
    sample(120, 99n),
  ];
  expect(signalBaseline(current, mixed, 2).status).toBe('warming');
  expect(signalBaseline(current, [sample(0, 0n), sample(60, 0n)], 2).status).toBe('zero-baseline');
  expect(signalBaseline(current, [sample(0, 10n), sample(60, 10n)], 2).multiplier).toBe(5);
});
it('exact half median comparison above Number precision', () => {
  const n = 10n ** 30n;
  const b = signalBaseline(
    { startSec: 120, endSec: 180, status: 'partial', value: 5n * n + 2n, unit: 'usdMicros' },
    [
      { startSec: 0, endSec: 60, status: 'closed', value: n, unit: 'usdMicros' },
      { startSec: 60, endSec: 120, status: 'closed', value: n + 1n, unit: 'usdMicros' },
    ],
    2,
  );
  expect(meetsMultiple(5n * n + 2n, b, 5)).toBe(false);
  expect(meetsMultiple(5n * n + 3n, b, 5)).toBe(true);
});
it('rejects negative volume, invalid minimum, and wrong duration', () => {
  expect(() =>
    signalBaseline(
      { startSec: 0, endSec: 60, status: 'partial', value: -1n, unit: 'usdMicros' },
      [],
      60,
    ),
  ).toThrow();
  expect(() =>
    signalBaseline(
      { startSec: 0, endSec: 60, status: 'partial', value: 1n, unit: 'usdMicros' },
      [],
      0,
    ),
  ).toThrow();
  expect(
    signalBaseline(
      { startSec: 600, endSec: 660, status: 'partial', value: 1n, unit: 'usdMicros' },
      [{ startSec: 0, endSec: 300, status: 'closed', value: 1n, unit: 'usdMicros' }],
      1,
    ).status,
  ).toBe('warming');
});
