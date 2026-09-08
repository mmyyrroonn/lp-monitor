import { checkedNumber } from './json.js';
/** Canonical decimal TEXT preserves signed quantities without JSON/SQLite rounding. */
export function encodeBigIntText(value: bigint): string {
  if (typeof value !== 'bigint') throw new TypeError('Expected bigint');
  return value.toString(10);
}
export function decodeBigIntText(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|-?[1-9][0-9]*)$/.test(value))
    throw new TypeError('Expected canonical decimal TEXT');
  return BigInt(value);
}
function validateBounds(min: number, max: number): void {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max)
    throw new RangeError('Invalid integer bounds');
}
export function encodeCheckedInteger(
  value: bigint,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): number {
  validateBounds(min, max);
  if (typeof value !== 'bigint') throw new TypeError('Expected bigint');
  return checkedNumber(value, min, max);
}
export function decodeCheckedInteger(
  value: unknown,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): bigint {
  validateBounds(min, max);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError('Expected safe INTEGER within field bounds');
  return BigInt(value);
}
