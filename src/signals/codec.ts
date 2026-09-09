/** Internal tags preserve bigint amounts without guessing from numeric strings. */
export function encodeSignalState(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? { $bigint: item.toString() } : item,
  );
}
export function decodeSignalState<T>(value: string): T {
  return JSON.parse(value, (_key, item: unknown) => {
    if (
      item &&
      typeof item === 'object' &&
      '$bigint' in item &&
      Object.keys(item).length === 1 &&
      typeof item.$bigint === 'string'
    ) {
      if (!/^-?\d+$/.test(item.$bigint)) throw new Error('Invalid persisted signal bigint');
      return BigInt(item.$bigint);
    }
    return item;
  }) as T;
}
