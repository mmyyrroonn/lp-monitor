import { expect, test } from 'vitest';
import { InvalidSwapDirectionError, normalizeCoreDeltas } from '../../src/domain/events.js';

test.each([
  ['v3', 100n, -90n, 0, 100n, 1, 90n],
  ['v4', -100n, 90n, 0, 100n, 1, 90n],
  ['v3', -90n, 100n, 1, 100n, 0, 90n],
  ['v4', 90n, -100n, 1, 100n, 0, 90n],
] as const)('direction %s %s %s', (v, a, b, i, iv, o, ov) => {
  expect(normalizeCoreDeltas(v, a, b)).toEqual({
    inputIndex: i,
    amountIn: iv,
    outputIndex: o,
    amountOut: ov,
  });
});
for (const v of ['v3', 'v4'] as const) {
  test.each([
    [0n, 0n],
    [0n, -1n],
    [1n, 0n],
    [-1n, 0n],
    [0n, 1n],
    [1n, 2n],
    [-1n, -2n],
  ])(`${v} rejects non-trade direction %s %s`, (a, b) => {
    expect(() => normalizeCoreDeltas(v, a, b)).toThrow(InvalidSwapDirectionError);
  });
}
test('normalizes large signed bigint values without precision loss', () => {
  expect(normalizeCoreDeltas('v3', -(1n << 255n), (1n << 255n) - 1n)).toEqual({
    inputIndex: 1,
    amountIn: (1n << 255n) - 1n,
    outputIndex: 0,
    amountOut: 1n << 255n,
  });
});
