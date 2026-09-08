import type { BlockAnchor, ChainReader } from '../domain/types.js';

export type BlockSearchBounds = { fromBlock: bigint; toBlock: bigint };

export interface TimeResolver {
  readonly queriedAnchors: readonly BlockAnchor[];
  resolveBlockAtOrAfter(timestampSec: number, bounds?: BlockSearchBounds): Promise<BlockAnchor>;
}

export function createTimeResolver(reader: ChainReader): TimeResolver {
  const cache = new Map<bigint, BlockAnchor>();

  async function query(block: bigint | 'latest'): Promise<BlockAnchor> {
    if (block !== 'latest') {
      const cached = cache.get(block);
      if (cached) return cached;
    }

    const anchor = await reader.getAnchor(block);
    if (
      anchor.number < 0n
      || !Number.isSafeInteger(anchor.timestampSec)
      || anchor.timestampSec < 0
      || (anchor.timestampSec === 0 && anchor.number !== 0n)
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
        (sampled.number < anchor.number && sampled.timestampSec > anchor.timestampSec)
        || (sampled.number > anchor.number && sampled.timestampSec < anchor.timestampSec)
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
        throw new Error('Block bounds do not include the first block at or after the target timestamp');
      }
    }
    return result;
  }

  return {
    get queriedAnchors() {
      return [...cache.values()].sort((left, right) => left.number < right.number ? -1 : left.number > right.number ? 1 : 0);
    },
    resolveBlockAtOrAfter,
  };
}
