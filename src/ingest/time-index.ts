import type { BlockAnchor, ChainReader, MinuteBoundary } from '../domain/types.js';
import { bracketBlockRate, interpolateProbe, validateTimeAnchor } from '../rpc/resolve-time.js';

function addAnchor(cache: Map<bigint, BlockAnchor>, anchor: BlockAnchor): void {
  validateTimeAnchor(anchor, cache.values());
  const existing = cache.get(anchor.number);
  if (existing && (existing.hash !== anchor.hash || existing.timestampSec !== anchor.timestampSec))
    throw new Error(`Conflicting block anchor for block ${anchor.number}`);
  cache.set(anchor.number, anchor);
}

async function getAnchor(
  reader: Pick<ChainReader, 'getAnchor'>,
  cache: Map<bigint, BlockAnchor>,
  number: bigint,
): Promise<BlockAnchor> {
  const cached = cache.get(number);
  if (cached) return cached;
  const anchor = await reader.getAnchor(number);
  if (anchor.number !== number)
    throw new Error(`Block anchor mismatch: requested ${number}, received ${anchor.number}`);
  addAnchor(cache, anchor);
  return anchor;
}

/** Finds the first block whose timestamp is at least the requested minute. */
export async function resolveMinuteBoundary(
  reader: Pick<ChainReader, 'getAnchor'>,
  timestampSec: number,
  lo: BlockAnchor,
  hi: BlockAnchor,
  cache: Map<bigint, BlockAnchor> = new Map(),
): Promise<MinuteBoundary> {
  if (!Number.isSafeInteger(timestampSec) || timestampSec <= 0)
    throw new Error('timestampSec must be a positive safe integer');
  addAnchor(cache, lo);
  addAnchor(cache, hi);
  if (lo.number >= hi.number || lo.timestampSec >= timestampSec || hi.timestampSec < timestampSec)
    throw new Error('Minute boundary requires lo.timestampSec < target <= hi.timestampSec');

  let before = lo;
  let at = hi;
  // The rate over the widest bracket is what the flat-run step in the probe needs; it stays fixed
  // for the search because every narrower bracket is a worse estimate of the same local rate.
  const blockRate = bracketBlockRate(lo.number, lo.timestampSec, hi.number, hi.timestampSec);
  while (at.number - before.number > 1n) {
    const middle = interpolateProbe(
      before.number,
      before.timestampSec,
      at.number,
      at.timestampSec,
      timestampSec,
      blockRate,
    );
    const sampled = await getAnchor(reader, cache, middle);
    if (sampled.timestampSec >= timestampSec) at = sampled;
    else before = sampled;
  }
  if (before.timestampSec >= timestampSec || at.timestampSec < timestampSec)
    throw new Error('Minute boundary proof failed');
  return { timestampSec, firstBlock: at.number, before, at };
}

export function sortedAnchors(anchors: Iterable<BlockAnchor>): BlockAnchor[] {
  const cache = new Map<bigint, BlockAnchor>();
  for (const anchor of anchors) addAnchor(cache, anchor);
  return [...cache.values()].sort((left, right) =>
    left.number < right.number ? -1 : left.number > right.number ? 1 : 0,
  );
}
