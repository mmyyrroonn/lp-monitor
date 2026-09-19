import type { BlockAnchor, ChainReader, MinuteBoundary } from '../domain/types.js';

export type BlockSearchBounds = { fromBlock: bigint; toBlock: bigint };

/**
 * Where to look next for the first block at or after `target`.
 *
 * Both ends are already sampled anchors bracketing the target in a monotone chain time. Over a
 * bracket the chain time is close to linear in block number, so the secant estimate usually lands
 * within a few blocks of the answer — the minute-boundary search measured ~9.3 probes per boundary
 * with bisection. The estimate only chooses a probe: the caller keeps the bracket invariant and
 * samples the block, so a bad estimate costs a request rather than a wrong answer.
 *
 * One case does not converge by secant alone: timestamps are flat across the run of blocks inside
 * a single second, and whenever the upper anchor already sits in the target second the secant has
 * no signal left inside that run. `blockRate` (blocks per second measured over the widest bracket)
 * steps back one second's worth of blocks there, after which the run is a small interval.
 */
export function interpolateProbe(
  beforeNumber: bigint,
  beforeTimestampSec: number,
  atNumber: bigint,
  atTimestampSec: number,
  target: number,
  blockRate: number,
): bigint {
  const span = atNumber - beforeNumber;
  if (span <= 1n) return beforeNumber;
  const seconds = atTimestampSec - beforeTimestampSec,
    elapsed = target - beforeTimestampSec;
  if (seconds <= 0 || elapsed <= 0) return beforeNumber + span / 2n;
  if (elapsed >= seconds) {
    const step = Number.isFinite(blockRate) && blockRate >= 1 ? BigInt(Math.round(blockRate)) : 1n;
    const guess = atNumber - step;
    return guess <= beforeNumber ? beforeNumber + span / 2n : guess;
  }
  const offset = (span * BigInt(elapsed)) / BigInt(seconds);
  return beforeNumber + (offset < 1n ? 1n : offset >= span ? span - 1n : offset);
}
/** Blocks per second a bracket measured, or 0 when its anchors share one timestamp. */
export function bracketBlockRate(
  beforeNumber: bigint,
  beforeTimestampSec: number,
  atNumber: bigint,
  atTimestampSec: number,
): number {
  const seconds = atTimestampSec - beforeTimestampSec;
  return seconds > 0 ? Number(atNumber - beforeNumber) / seconds : 0;
}
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
  onAnchor?: (anchor: BlockAnchor) => void,
): TimeResolver {
  let validatedInitialCache = false;
  async function query(block: bigint | 'latest'): Promise<BlockAnchor> {
    if (!validatedInitialCache) {
      const initial = [...cache.values()].sort((a, b) =>
        a.number < b.number ? -1 : a.number > b.number ? 1 : 0,
      );
      for (const [index, anchor] of initial.entries())
        validateTimeAnchor(anchor, index ? [initial[index - 1]!] : []);
      validatedInitialCache = true;
    }
    if (block !== 'latest') {
      const cached = cache.get(block);
      if (cached) {
        validateTimeAnchor(cached);
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
        onAnchor?.(anchor);
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
    onAnchor?.(anchor);
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

    // Only sampled timestamps can establish safe bounds; a deployment candidate alone cannot.
    let cachedLower: BlockAnchor | undefined;
    let cachedUpper: BlockAnchor | undefined;
    if (!bounds)
      for (const sampled of cache.values()) {
        if (
          sampled.timestampSec < timestampSec &&
          (!cachedLower || sampled.number > cachedLower.number)
        )
          cachedLower = sampled;
        if (
          sampled.timestampSec >= timestampSec &&
          (!cachedUpper || sampled.number < cachedUpper.number)
        )
          cachedUpper = sampled;
      }
    const fromBlock = bounds?.fromBlock ?? cachedLower?.number ?? 0n;
    const toAnchor = bounds
      ? await query(bounds.toBlock)
      : cachedUpper
        ? await query(cachedUpper.number)
        : await query('latest');
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
      if (sampled.timestampSec < timestampSec)
        low = low > sampled.number + 1n ? low : sampled.number + 1n;
      else high = high < sampled.number ? high : sampled.number;
    }
    // The closest sampled anchors on either side of the target choose each next probe; they stay
    // consistent with the low/high bounds as the loop samples, so an interpolated guess never
    // leaves the bracket the bounds prove.
    let lower: BlockAnchor | undefined, upper: BlockAnchor | undefined;
    for (const sampled of cache.values()) {
      if (sampled.number < fromBlock || sampled.number > toAnchor.number) continue;
      if (sampled.timestampSec < timestampSec) {
        if (!lower || sampled.number > lower.number) lower = sampled;
      } else if (!upper || sampled.number < upper.number) upper = sampled;
    }
    const blockRate = bracketBlockRate(
      fromAnchor.number,
      fromAnchor.timestampSec,
      toAnchor.number,
      toAnchor.timestampSec,
    );
    while (low < high) {
      const guess =
        lower && upper && upper.number - lower.number > 1n
          ? interpolateProbe(
              lower.number,
              lower.timestampSec,
              upper.number,
              upper.timestampSec,
              timestampSec,
              blockRate,
            )
          : low + (high - low) / 2n;
      const middle = guess < low ? low : guess > high - 1n ? high - 1n : guess;
      const sampled = await query(middle);
      if (sampled.timestampSec < timestampSec) {
        low = middle + 1n;
        lower = sampled;
      } else {
        high = middle;
        upper = sampled;
      }
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
