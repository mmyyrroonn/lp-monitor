import { expect, test } from 'vitest';
import { encodeJson, checkedNumber } from '../../src/domain/json.js';
test('uint256 never traverses number', () => {
  const value = (1n << 256n) - 1n;
  expect(JSON.parse(encodeJson({ value })).value).toBe(value.toString());
});
test('bounded numeric fields reject overflow', () => {
  expect(() => checkedNumber(1n << 80n)).toThrow();
  expect(() => checkedNumber(-1n, 0, 255)).toThrow();
  expect(checkedNumber(18n, 0, 255)).toBe(18);
});
