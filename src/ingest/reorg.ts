import type { BlockAnchor, ChainReader } from '../domain/types.js';

/** Search sparse retained evidence; RPC failure is not evidence of a fork. */
export async function findMatchingCheckpoint(
  reader: Pick<ChainReader, 'getAnchor'>,
  checkpoints: readonly BlockAnchor[],
  maxCalls = 32,
): Promise<BlockAnchor | null> {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 32)
    throw new RangeError('Checkpoint search budget must be between 0 and 32');
  const ordered = [...checkpoints].sort((a, b) =>
    a.number < b.number ? -1 : a.number > b.number ? 1 : 0,
  );
  if (!ordered.length || !maxCalls) return null;
  let calls = 0;
  const cache = new Map<number, boolean>();
  async function matches(index: number): Promise<boolean | null> {
    if (cache.has(index)) return cache.get(index)!;
    if (calls >= maxCalls) return null;
    calls++;
    const saved = ordered[index]!;
    const current = await reader.getAnchor(saved.number);
    if (current.number !== saved.number) throw new Error('Checkpoint response height mismatch');
    const match =
      current.hash.toLowerCase() === saved.hash.toLowerCase() &&
      current.timestampSec === saved.timestampSec;
    cache.set(index, match);
    return match;
  }
  const last = ordered.length - 1;
  if (await matches(last)) return ordered[last]!;
  let failed = last;
  for (let step = 1; ; step *= 2) {
    const index = Math.max(0, last - step);
    const match = await matches(index);
    if (match === null) return null;
    if (match) {
      let lo = index;
      let hi = failed;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const found = await matches(mid);
        if (found === null) return null;
        if (found) lo = mid;
        else hi = mid;
      }
      return ordered[lo]!;
    }
    if (index === 0) return null;
    failed = index;
  }
}
