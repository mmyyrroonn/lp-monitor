import { expect, test } from 'vitest';
import {
  encodeBigIntText,
  decodeBigIntText,
  encodeCheckedInteger,
  decodeCheckedInteger,
} from '../../src/domain/codec.js';
test.each([0n, -1n, 2n ** 255n, -(2n ** 255n)])('round trips bigint TEXT %s', (value) => {
  expect(decodeBigIntText(encodeBigIntText(value))).toBe(value);
});
test.each(['', '01', '-0', '1.0', '0xff', 1, null])('rejects noncanonical TEXT %s', (value) => {
  expect(() => decodeBigIntText(value)).toThrow();
});
test('round trips safe INTEGER and rejects unsafe values', () => {
  expect(decodeCheckedInteger(encodeCheckedInteger(123n))).toBe(123n);
  expect(() => encodeCheckedInteger(2n ** 53n)).toThrow();
  expect(() => decodeCheckedInteger(1.5)).toThrow();
  expect(() => decodeCheckedInteger('123')).toThrow();
  expect(() => encodeCheckedInteger(11n, 0, 10)).toThrow();
});
