export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2);
}
export function checkedNumber(value: bigint, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  if (value < BigInt(min) || value > BigInt(max)) throw new RangeError('Integer outside safe field range');
  return Number(value);
}
