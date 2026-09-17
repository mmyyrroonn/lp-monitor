import { countWork } from '../ops/work-counters.js';
/** Internal tags preserve bigint amounts without guessing from numeric strings. */
export function encodeSignalState(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? { $bigint: item.toString() } : item,
  );
}
export function decodeSignalState<T>(value: string): T {
  // JSON.parse's reviver crosses the native/JS boundary for every scalar as well as every
  // container. Cached metrics have many scalars but only a few tagged bigint objects.
  return reviveContainers(JSON.parse(value)) as T;
}
function reviveContainers(item: unknown): unknown {
  countWork('signalDecodeVisits');
  if (item === null || typeof item !== 'object') return item;
  if (Array.isArray(item)) {
    for (let i = 0; i < item.length; i++)
      if (item[i] !== null && typeof item[i] === 'object') item[i] = reviveContainers(item[i]);
    return item;
  }
  const record = item as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const key of keys)
    if (record[key] !== null && typeof record[key] === 'object')
      record[key] = reviveContainers(record[key]);
  if ('$bigint' in record && keys.length === 1 && typeof record.$bigint === 'string') {
    if (!/^-?\d+$/.test(record.$bigint)) throw new Error('Invalid persisted signal bigint');
    return BigInt(record.$bigint);
  }
  return record;
}
