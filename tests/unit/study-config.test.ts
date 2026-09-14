import { expect, test } from 'vitest';
import { studySplitAt, validateStudyPeriods } from '../../src/replay/study-config.js';

const periods = {
  train: { startSec: 100, endSec: 200 },
  validation: { startSec: 200, endSec: 300 },
  test: { startSec: 300, endSec: 400 },
};

test('split boundaries are explicit and half-open', () => {
  validateStudyPeriods(periods);
  expect([99, 100, 199, 200, 300, 400].map((t) => studySplitAt(t, periods))).toEqual([
    'outside',
    'train',
    'train',
    'validation',
    'test',
    'outside',
  ]);
});

test('study periods reject overlap and reversed intervals', () => {
  expect(() =>
    validateStudyPeriods({ ...periods, validation: { startSec: 199, endSec: 300 } }),
  ).toThrow(/ordered|non-overlapping/);
  expect(() => validateStudyPeriods({ ...periods, test: { startSec: 300, endSec: 300 } })).toThrow(
    /Invalid study period/,
  );
  expect(() => studySplitAt(1.5, periods)).toThrow(/safe integer/);
});
