import { expect, test } from 'vitest';
import { decodeSignalState, encodeSignalState } from '../../src/signals/codec.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';

test('cached metrics decode tags without a recursive callback for every scalar field', () => {
  const text = JSON.stringify({
    values: Array.from({ length: 10000 }, (_, i) => i),
    amount: { $bigint: '9007199254740993' },
  });
  const work = openWorkCounts();
  try {
    expect(decodeSignalState(text)).toEqual({
      values: Array.from({ length: 10000 }, (_, i) => i),
      amount: 9007199254740993n,
    });
    expect(work.counts.signalDecodeVisits).toBeLessThanOrEqual(4);
  } finally {
    work.close();
  }
});

test('nested tagged values preserve ordinary strings, extra keys and own __proto__ data', () => {
  const text =
    '{"values":[{"$bigint":"-00012"},null,"123",{"$bigint":5},{"$bigint":"9","extra":true}],"__proto__":{"amount":{"$bigint":"7"}},"nested":{"$bigint":{"$bigint":"8"}}}';
  const result = decodeSignalState<Record<string, unknown>>(text);
  expect(result.values).toEqual([-12n, null, '123', { $bigint: 5 }, { $bigint: '9', extra: true }]);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.hasOwn(result, '__proto__')).toBe(true);
  expect(result.__proto__).toEqual({ amount: 7n });
  expect(result.nested).toEqual({ $bigint: 8n });
  expect(decodeSignalState(encodeSignalState([0n, -(2n ** 255n), 2n ** 255n]))).toEqual([
    0n,
    -(2n ** 255n),
    2n ** 255n,
  ]);
});

test.each(['', '+1', '1.5', '1e3', ' 1', '1n'])(
  'rejects malformed persisted bigint %s',
  (value) => {
    expect(() => decodeSignalState(JSON.stringify({ nested: [{ $bigint: value }] }))).toThrow(
      'Invalid persisted signal bigint',
    );
  },
);
