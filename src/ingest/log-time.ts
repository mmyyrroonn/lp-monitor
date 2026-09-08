import type {
  BlockAnchor,
  ChainReader,
  LogRef,
  LogTime,
  MinuteBoundary,
  RawLog,
} from '../domain/types.js';
import { rawLogKey } from '../storage/manifest.js';
import { resolveMinuteBoundary, sortedAnchors } from './time-index.js';

const UNRESOLVED: LogTime = {
  minuteStartSec: null,
  exactTimestampSec: null,
  source: 'unresolved',
};

export type LogTimeFailure = {
  timestampSec: number | null;
  fromBlock: bigint;
  toBlock: bigint;
  reason: string;
};

export type LogTimeResolution = {
  times: ReadonlyMap<string, LogTime>;
  queriedAnchors: readonly BlockAnchor[];
  boundaries: readonly MinuteBoundary[];
  failures: readonly LogTimeFailure[];
};

export const logTimeKey = (log: RawLog | LogRef): string => rawLogKey(log);

function minuteTime(timestampSec: number): LogTime {
  return {
    minuteStartSec: Math.floor(timestampSec / 60) * 60,
    exactTimestampSec: null,
    source: 'minute-boundary',
  };
}

function boundaryIsValid(boundary: MinuteBoundary): boolean {
  return (
    Number.isSafeInteger(boundary.timestampSec) &&
    boundary.timestampSec > 0 &&
    boundary.firstBlock === boundary.at.number &&
    boundary.before.number + 1n === boundary.at.number &&
    boundary.before.timestampSec < boundary.timestampSec &&
    boundary.at.timestampSec >= boundary.timestampSec
  );
}

/** Assigns minute buckets using sparse anchor evidence; never provider log timestamps. */
export function assignLogMinutes(
  logs: readonly RawLog[],
  anchors: Iterable<BlockAnchor>,
  boundaries: Iterable<MinuteBoundary>,
): ReadonlyMap<string, LogTime> {
  let anchorsByBlock: Map<bigint, BlockAnchor>;
  try {
    anchorsByBlock = new Map(sortedAnchors(anchors).map((anchor) => [anchor.number, anchor]));
  } catch {
    return new Map(logs.map((log) => [logTimeKey(log), UNRESOLVED]));
  }
  const usable = [...boundaries]
    .filter(boundaryIsValid)
    .sort((left, right) =>
      left.firstBlock < right.firstBlock ? -1 : left.firstBlock > right.firstBlock ? 1 : 0,
    );
  const result = new Map<string, LogTime>();
  for (const log of logs) {
    const sampled = anchorsByBlock.get(log.blockNumber);
    if (sampled && sampled.hash !== log.blockHash) {
      result.set(logTimeKey(log), UNRESOLVED);
      continue;
    }
    if (sampled) {
      result.set(logTimeKey(log), minuteTime(sampled.timestampSec));
      continue;
    }
    let lower: BlockAnchor | undefined;
    let upper: BlockAnchor | undefined;
    for (const anchor of anchorsByBlock.values()) {
      if (anchor.number < log.blockNumber && (!lower || anchor.number > lower.number))
        lower = anchor;
      if (anchor.number > log.blockNumber && (!upper || anchor.number < upper.number))
        upper = anchor;
    }
    if (
      lower &&
      upper &&
      Math.floor(lower.timestampSec / 60) === Math.floor(upper.timestampSec / 60)
    ) {
      result.set(logTimeKey(log), minuteTime(lower.timestampSec));
      continue;
    }
    let prior: MinuteBoundary | undefined;
    let next: MinuteBoundary | undefined;
    for (const boundary of usable) {
      if (boundary.firstBlock <= log.blockNumber) prior = boundary;
      else {
        next = boundary;
        break;
      }
    }

    if (prior && next && prior.timestampSec + 60 === next.timestampSec)
      result.set(logTimeKey(log), minuteTime(prior.timestampSec));
    else if (prior) {
      let upper: BlockAnchor | undefined;
      for (const anchor of anchorsByBlock.values()) {
        if (anchor.number >= log.blockNumber && (!upper || anchor.number < upper.number))
          upper = anchor;
      }
      if (upper && upper.timestampSec < prior.timestampSec + 60)
        result.set(logTimeKey(log), minuteTime(prior.timestampSec));
      else result.set(logTimeKey(log), UNRESOLVED);
    } else result.set(logTimeKey(log), UNRESOLVED);
  }
  return result;
}

function cacheAnchor(cache: Map<bigint, BlockAnchor>, anchor: BlockAnchor): void {
  const existing = cache.get(anchor.number);
  if (existing && (existing.hash !== anchor.hash || existing.timestampSec !== anchor.timestampSec))
    throw new Error(`Conflicting block anchor for block ${anchor.number}`);
  cache.set(anchor.number, anchor);
}

function brackets(
  anchors: Iterable<BlockAnchor>,
  timestampSec: number,
): { lo?: BlockAnchor; hi?: BlockAnchor } {
  let lo: BlockAnchor | undefined;
  let hi: BlockAnchor | undefined;
  for (const anchor of anchors) {
    if (anchor.timestampSec < timestampSec && (!lo || anchor.number > lo.number)) lo = anchor;
    if (anchor.timestampSec >= timestampSec && (!hi || anchor.number < hi.number)) hi = anchor;
  }
  return { lo, hi };
}

async function lowerAnchor(
  reader: Pick<ChainReader, 'getAnchor'>,
  cache: Map<bigint, BlockAnchor>,
  target: number,
): Promise<BlockAnchor> {
  const existing = brackets(cache.values(), target).lo;
  if (existing) return existing;
  const genesis = cache.get(0n) ?? (await reader.getAnchor(0n));
  if (genesis.number !== 0n) throw new Error('Block anchor mismatch: requested 0');
  cacheAnchor(cache, genesis);
  if (genesis.timestampSec >= target)
    throw new Error('Target timestamp is outside the chain range');
  return genesis;
}

export async function resolveLogTimes(
  reader: Pick<ChainReader, 'getAnchor'>,
  logs: readonly RawLog[],
  fromBlock: bigint,
  end: BlockAnchor,
  cachedAnchors: Iterable<BlockAnchor> = [],
  cachedBoundaries: Iterable<MinuteBoundary> = [],
): Promise<LogTimeResolution> {
  const cache = new Map<bigint, BlockAnchor>();
  const boundaries = new Map<number, MinuteBoundary>();
  const failures: LogTimeFailure[] = [];
  try {
    if (fromBlock < 0n || end.number < fromBlock) throw new Error('Invalid range bounds');
    for (const anchor of cachedAnchors) cacheAnchor(cache, anchor);
    cacheAnchor(cache, end);
    for (const boundary of cachedBoundaries) {
      if (!boundaryIsValid(boundary)) continue;
      cacheAnchor(cache, boundary.before);
      cacheAnchor(cache, boundary.at);
      boundaries.set(boundary.timestampSec, boundary);
    }
    let from = cache.get(fromBlock);
    if (!from) {
      from = await reader.getAnchor(fromBlock);
      if (from.number !== fromBlock)
        throw new Error(`Block anchor mismatch: requested ${fromBlock}`);
      cacheAnchor(cache, from);
    }
    if (from.timestampSec > end.timestampSec) throw new Error('Nonmonotonic range endpoints');

    const firstTarget = Math.floor(from.timestampSec / 60) * 60 + 60;
    const lastTarget = Math.floor(end.timestampSec / 60) * 60;
    for (let target = firstTarget; target <= lastTarget; target += 60) {
      if (target <= 0 || boundaries.has(target)) continue;
      try {
        const lo = await lowerAnchor(reader, cache, target);
        const hi = brackets(cache.values(), target).hi;
        if (!hi) throw new Error('Target timestamp is outside the chain range');
        boundaries.set(target, await resolveMinuteBoundary(reader, target, lo, hi, cache));
      } catch (error) {
        failures.push({
          timestampSec: target,
          fromBlock,
          toBlock: end.number,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    failures.push({
      timestampSec: null,
      fromBlock,
      toBlock: end.number,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  let sorted: BlockAnchor[];
  try {
    sorted = sortedAnchors(cache.values());
  } catch (error) {
    failures.push({
      timestampSec: null,
      fromBlock,
      toBlock: end.number,
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      times: new Map(logs.map((log) => [logTimeKey(log), UNRESOLVED])),
      queriedAnchors: [],
      boundaries: [],
      failures,
    };
  }
  const resolvedBoundaries = [...boundaries.values()].sort(
    (left, right) => left.timestampSec - right.timestampSec,
  );
  const times = new Map(assignLogMinutes(logs, sorted, resolvedBoundaries));
  const fromMinute = Math.floor((cache.get(fromBlock)?.timestampSec ?? -1) / 60) * 60;
  const endMinute = Math.floor(end.timestampSec / 60) * 60;
  if (failures.length === 0 && fromMinute === endMinute) {
    for (const log of logs) {
      if (log.blockNumber < fromBlock || log.blockNumber > end.number) continue;
      const sampled = cache.get(log.blockNumber);
      if (sampled && sampled.hash !== log.blockHash) continue;
      times.set(logTimeKey(log), minuteTime(fromMinute));
    }
  }
  return { times, queriedAnchors: sorted, boundaries: resolvedBoundaries, failures };
}
