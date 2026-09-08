import type { BlockAnchor, ChainReader, MinuteBoundary } from '../domain/types.js';

export type BlockSearchBounds = { fromBlock: bigint; toBlock: bigint };

export interface TimeResolver {
  readonly queriedAnchors: readonly BlockAnchor[];
  resolveMinuteBoundary(timestampSec: number, bounds?: BlockSearchBounds): Promise<MinuteBoundary>;
  resolveBlockAtOrAfter(timestampSec: number, bounds?: BlockSearchBounds): Promise<BlockAnchor>;
}

export function validateTimeAnchor(
  anchor: BlockAnchor,
  sampledAnchors: Iterable<BlockAnchor> = [],
): void {
  if (
    anchor.number < 0n ||
    !Number.isSafeInteger(anchor.timestampSec) ||
    anchor.timestampSec < 0 ||
    (anchor.timestampSec === 0 && anchor.number !== 0n)
  ) {
    throw new Error('Invalid block anchor');
  }
  for (const sampled of sampledAnchors) {
    if (
      (sampled.number < anchor.number && sampled.timestampSec > anchor.timestampSec) ||
      (sampled.number > anchor.number && sampled.timestampSec < anchor.timestampSec)
    )
      throw new Error('Nonmonotonic sampled anchors');
  }
}
export function createTimeResolver(
  reader: ChainReader,
  cache: Map<bigint, BlockAnchor> = new Map(),
): TimeResolver {
  async function query(block: bigint | 'latest'): Promise<BlockAnchor> {
    if (block !== 'latest') {
      const cached = cache.get(block);
      if (cached) {
        validateTimeAnchor(cached, cache.values());
        return cached;
      }
    }

    const anchor = await reader.getAnchor(block);
    if (
      anchor.number < 0n ||
      !Number.isSafeInteger(anchor.timestampSec) ||
      anchor.timestampSec < 0 ||
      (anchor.timestampSec === 0 && anchor.number !== 0n)
    ) {
      throw new Error(`Invalid block anchor returned for ${String(block)}`);
    }
    if (block !== 'latest' && anchor.number !== block) {
      throw new Error(`Block anchor mismatch: requested ${block}, received ${anchor.number}`);
    }

    const existing = cache.get(anchor.number);
    if (existing) {
      if (existing.hash !== anchor.hash || existing.timestampSec !== anchor.timestampSec) {
        throw new Error(`Conflicting block anchor for block ${anchor.number}`);
      }
      return existing;
    }

    for (const sampled of cache.values()) {
      if (
        (sampled.number < anchor.number && sampled.timestampSec > anchor.timestampSec) ||
        (sampled.number > anchor.number && sampled.timestampSec < anchor.timestampSec)
      ) {
        throw new Error(
          `Nonmonotonic sampled anchors at blocks ${sampled.number} and ${anchor.number}`,
        );
      }
    }
    cache.set(anchor.number, anchor);
    return anchor;
  }

  async function resolveBlockAtOrAfter(
    timestampSec: number,
    bounds?: BlockSearchBounds,
  ): Promise<BlockAnchor> {
    if (!Number.isSafeInteger(timestampSec) || timestampSec <= 0) {
      throw new Error('timestampSec must be a positive safe integer');
    }
    if (bounds && (bounds.fromBlock < 0n || bounds.toBlock < bounds.fromBlock)) {
      throw new Error('Block bounds must be nonnegative and ordered');
    }

    const fromBlock = bounds?.fromBlock ?? 0n;
    const toAnchor = bounds ? await query(bounds.toBlock) : await query('latest');
    if (toAnchor.number < fromBlock) {
      throw new Error('Block bounds must be nonnegative and ordered');
    }
    const fromAnchor = await query(fromBlock);

    if (timestampSec < fromAnchor.timestampSec || timestampSec > toAnchor.timestampSec) {
      throw new Error('Target timestamp is outside the chain range');
    }

    let low = fromBlock;
    let high = toAnchor.number;
    // Existing sparse anchors narrow subsequent seed/minute searches.
    for (const sampled of cache.values()) {
      if (sampled.number < low || sampled.number > high) continue;
      if (sampled.timestampSec < timestampSec) low = sampled.number + 1n;
      else high = sampled.number;
    }
    while (low < high) {
      const middle = low + (high - low) / 2n;
      const sampled = await query(middle);
      if (sampled.timestampSec < timestampSec) low = middle + 1n;
      else high = middle;
    }

    const result = await query(low);
    if (result.timestampSec < timestampSec) {
      throw new Error('Target timestamp is outside the chain range');
    }
    if (result.number > 0n) {
      const predecessor = await query(result.number - 1n);
      if (predecessor.timestampSec >= timestampSec) {
        throw new Error(
          'Block bounds do not include the first block at or after the target timestamp',
        );
      }
    }
    return result;
  }

  return {
    get queriedAnchors() {
      return [...cache.values()].sort((left, right) =>
        left.number < right.number ? -1 : left.number > right.number ? 1 : 0,
      );
    },
    async resolveMinuteBoundary(timestampSec, bounds) {
      const at = await resolveBlockAtOrAfter(timestampSec, bounds);
      if (at.number === 0n) throw new Error('Minute boundary has no predecessor before genesis');
      return { timestampSec, firstBlock: at.number, at, before: await query(at.number - 1n) };
    },
    resolveBlockAtOrAfter,
  };
}
