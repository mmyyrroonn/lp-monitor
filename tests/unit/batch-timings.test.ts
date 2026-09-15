import { expect, test } from 'vitest';
import { BatchTimings } from '../../src/ops/batch-timings.js';

test('measure accumulates thrown work in finally and returns the untouched result', () => {
  let now = 0;
  const timings = new BatchTimings(() => now);
  expect(() =>
    timings.measure('projection', () => {
      now = 7;
      throw Error('x');
    }),
  ).toThrow('x');
  expect(timings.snapshot().projection).toBe(7);

  const value = timings.measure('registry', () => {
    now = 9;
    return 'rows';
  });
  expect(value).toBe('rows');
  expect(timings.snapshot()).toEqual({ projection: 7, registry: 2 });
});

test('repeated visits to one stage add up while distinct stages stay separate', () => {
  let now = 0;
  const timings = new BatchTimings(() => now);
  timings.measure('registry', () => {
    now += 3;
  });
  timings.measure('registry', () => {
    now += 4;
  });
  timings.measure('windows', () => {
    now += 5;
  });
  expect(timings.snapshot()).toEqual({ registry: 7, windows: 5 });
});

test('measureAsync accumulates both fulfilled and rejected work', async () => {
  let now = 0;
  const timings = new BatchTimings(() => now);
  await expect(
    timings.measureAsync('notify', async () => {
      now += 4;
      return 'sent';
    }),
  ).resolves.toBe('sent');
  await expect(
    timings.measureAsync('notify', async () => {
      now += 6;
      throw Error('down');
    }),
  ).rejects.toThrow('down');
  expect(timings.snapshot()).toEqual({ notify: 10 });
});

test('stages that never ran stay absent instead of reporting zero', () => {
  const timings = new BatchTimings();
  expect(timings.snapshot()).toEqual({});
  const started = performance.now();
  timings.measure('rpcAcquisition', () => {
    while (performance.now() - started < 5) {
      // A real wait is the only way to prove the default clock measures wall time.
    }
  });
  const snapshot = timings.snapshot();
  expect(Object.keys(snapshot)).toEqual(['rpcAcquisition']);
  expect(snapshot.rpcAcquisition).toBeGreaterThan(0);
  expect(snapshot.commitOther).toBeUndefined();
});
