import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { BlockAnchor, MinuteBoundary } from '../domain/types.js';
import type { ProjectionQualityError } from '../state/project-range.js';
import { verifySuccessfulShardCoverage } from '../ingest/completeness.js';
import { rawLogKey, type RecordedRangeBatch } from '../storage/manifest.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { readBatch } from '../storage/payload-store.js';

export interface MetricCoverage {
  scopeId: string;
  minuteStartSec: number;
  fromBlock: bigint | null;
  toBlock: bigint | null;
  complete: boolean;
  reasons: string[];
}
type Interval = { fromBlock: bigint; toBlock: bigint };
type RangeRow = { batch_id: string; filter_id: string; from_block: number; to_block: number };
type CachedBatch = { fromBlock: bigint; toBlock: bigint; filters: string[] } | null;
const caches = new WeakMap<
  Database.Database,
  Map<string, { signature: string; value: CachedBatch }>
>();
const CACHE_LIMIT = 2048;

function covers(ranges: readonly Interval[], from: bigint, to: bigint): boolean {
  if (to < from) return true;
  let next = from;
  for (const range of [...ranges].sort((a, b) =>
    a.fromBlock < b.fromBlock ? -1 : a.fromBlock > b.fromBlock ? 1 : 0,
  )) {
    if (range.fromBlock > next) return false;
    if (range.toBlock >= next) next = range.toBlock + 1n;
    if (next > to) return true;
  }
  return false;
}

// P1 transport retains decimal strings. Revive the narrow batch contract used by
// the same successful-shard validator that guards acceptRange.
function completePartitions(batch: RecordedRangeBatch): boolean {
  const partitions = new Map<string, Interval[]>();
  // Expand each concrete address/topic alternative. A shorter successful scan
  // of address B must not borrow address A's block coverage under the same family.
  for (const shard of batch.manifest.shards) {
    let selectors: (string | null)[][] = shard.request.address.map((a) => [a.toLowerCase()]);
    for (const topic of shard.request.topics) {
      const alternatives =
        topic === null
          ? [null]
          : typeof topic === 'string'
            ? [topic.toLowerCase()]
            : topic.map((t) => t.toLowerCase());
      if (selectors.length * alternatives.length > 100000) return false;
      selectors = selectors.flatMap((prefix) => alternatives.map((t) => [...prefix, t]));
    }
    for (const selector of selectors) {
      const key = JSON.stringify([shard.filterId, ...selector]);
      const intervals = partitions.get(key) ?? [];
      intervals.push({ fromBlock: shard.request.fromBlock, toBlock: shard.request.toBlock });
      partitions.set(key, intervals);
    }
  }
  return (
    partitions.size > 0 &&
    [...partitions.values()].every((ranges) => covers(ranges, batch.fromBlock, batch.toBlock))
  );
}
/** Only current accepted ranges count. Failed raw attempts are historical evidence,
 * and cannot create either a complete minute or erase prior accepted coverage. */
export function acceptedMetricRanges(
  db: Database.Database,
  scopeId: string,
  bounds?: Readonly<Interval>,
): Interval[] {
  // Bounds select whole batches, never individual family rows. Invalid or
  // unrepresentable bounds conservatively retain full validation.
  const bounded =
    bounds !== undefined &&
    bounds.fromBlock >= 0n &&
    bounds.toBlock >= bounds.fromBlock &&
    bounds.toBlock <= BigInt(Number.MAX_SAFE_INTEGER);
  // Readonly legacy snapshots are deliberately not migrated. Preserve their
  // offline read path; current writable/live databases have the range index.
  const rangeIndex =
    bounded &&
    db
      .prepare(
        "select 1 from sqlite_master where type='index' and name='accepted_ranges_scope_bounds'",
      )
      .get();
  const rows = (
    bounded
      ? db
          .prepare(
            `select accepted.batch_id,accepted.filter_id,accepted.from_block,accepted.to_block
             from (
               select distinct batch_id from accepted_ranges ${rangeIndex ? 'indexed by accepted_ranges_scope_bounds' : ''}
               where scope_id=? and to_block>=? and from_block<=?
             ) candidate
             join accepted_ranges accepted
               on accepted.scope_id=? and accepted.batch_id=candidate.batch_id`,
          )
          .all(scopeId, Number(bounds.fromBlock), Number(bounds.toBlock), scopeId)
      : db
          .prepare(
            'select batch_id,filter_id,from_block,to_block from accepted_ranges where scope_id=?',
          )
          .all(scopeId)
  ) as RangeRow[];
  const groups = new Map<string, RangeRow[]>();
  for (const row of rows) {
    const group = groups.get(row.batch_id) ?? [];
    group.push(row);
    groups.set(row.batch_id, group);
  }
  const cache = caches.get(db) ?? new Map<string, { signature: string; value: CachedBatch }>();
  caches.set(db, cache);
  const scopePrefix = scopeId + '\0';
  // Release this scope's previous window before admitting the next one. Other
  // scopes remain untouched; full reads retain every currently selected batch.
  for (const key of cache.keys()) {
    if (key.startsWith(scopePrefix) && !groups.has(key.slice(scopePrefix.length)))
      cache.delete(key);
  }
  const result: Interval[] = [];
  for (const [batchId, accepted] of groups) {
    const row = db
      .prepare('select id from ingest_batches where id=? and scope_id=?')
      .get(batchId, scopeId) as { id: string } | undefined;
    if (!row) continue;
    const stored = db
      .prepare(
        'select shard_id,status,response_hash,log_count,error from fetch_shards where batch_id=? order by shard_id',
      )
      .all(batchId) as {
      shard_id: string;
      status: string;
      response_hash: string | null;
      log_count: number;
      error: string | null;
    }[];
    const payloadSignature = db
      .prepare('select payload_json from ingest_batches where id=? and scope_id=?')
      .pluck()
      .get(batchId, scopeId) as string;
    const signature = createHash('sha256')
      .update(payloadSignature)
      .update(JSON.stringify(stored))
      .digest('hex');
    const key = scopeId + '\0' + batchId;
    let value = cache.get(key)?.signature === signature ? cache.get(key)!.value : undefined;
    if (value === undefined) {
      value = null;
      try {
        const decoded = readBatch(db, row.id);
        if (decoded.scopeId === scopeId) {
          verifySuccessfulShardCoverage(decoded);
          const complete =
            stored.length === decoded.manifest.expectedShardIds.length &&
            decoded.manifest.shards.every((shard) =>
              stored.some(
                (item) =>
                  item.shard_id === shard.shardId &&
                  item.status === 'success' &&
                  item.response_hash === shard.responseHash &&
                  item.log_count === shard.logCount &&
                  item.error === null,
              ),
            );
          if (complete && completePartitions(decoded))
            value = {
              fromBlock: decoded.fromBlock,
              toBlock: decoded.toBlock,
              filters: [...new Set(decoded.manifest.shards.map((shard) => shard.filterId))],
            };
        }
      } catch {
        value = null;
      }
      // Saturating admission avoids sequential scans evicting every useful
      // entry once history exceeds capacity. Changed admitted entries still
      // replace their old validation, including failed validation.
      if (cache.has(key) || cache.size < CACHE_LIMIT) cache.set(key, { signature, value });
    }
    if (!value) continue;
    const batch = value;
    const filters = batch.filters;
    // P1 removes whole accepted intervals on invalidation. Intersect surviving
    // family coverage rather than using the original batch bounds after a reorg.
    const points = [
      ...new Set(accepted.flatMap((r) => [BigInt(r.from_block), BigInt(r.to_block) + 1n])),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i + 1 < points.length; i++) {
      const from = points[i]!,
        to = points[i + 1]! - 1n;
      if (from < batch.fromBlock || to > batch.toBlock) continue;
      if (
        filters.every((f) =>
          covers(
            accepted
              .filter((r) => r.filter_id === f)
              .map((r) => ({ fromBlock: BigInt(r.from_block), toBlock: BigInt(r.to_block) })),
            from,
            to,
          ),
        )
      )
        result.push({ fromBlock: from, toBlock: to });
    }
  }
  return result;
}

function validBoundary(b: MinuteBoundary): boolean {
  return (
    Number.isSafeInteger(b.timestampSec) &&
    b.timestampSec > 0 &&
    b.timestampSec % 60 === 0 &&
    b.firstBlock === b.at.number &&
    b.before.number + 1n === b.firstBlock &&
    b.before.timestampSec < b.timestampSec &&
    b.at.timestampSec >= b.timestampSec
  );
}
function compatible(a: MinuteBoundary, b: MinuteBoundary): boolean {
  if (a.firstBlock > b.firstBlock) return false;
  const anchors = [a.before, a.at, b.before, b.at].sort((x, y) =>
    x.number < y.number ? -1 : x.number > y.number ? 1 : 0,
  );
  return anchors.every(
    (v, i) =>
      i === 0 ||
      (v.number === anchors[i - 1]!.number
        ? v.hash === anchors[i - 1]!.hash && v.timestampSec === anchors[i - 1]!.timestampSec
        : v.timestampSec >= anchors[i - 1]!.timestampSec),
  );
}

/** Bounded explicit chain-time horizon includes 60m baselines and current partial.
 * This function makes no RPC calls, no wall-clock guesses and no timestamp interpolation. */
export function readMetricCoverage(
  db: Database.Database,
  scopeId: string,
  errors: readonly ProjectionQualityError[],
  watermark: BlockAnchor,
  historyMinutes = 180,
  bounded = false,
): MetricCoverage[] {
  if (!Number.isSafeInteger(historyMinutes) || historyMinutes < 65 || historyMinutes > 10080)
    throw new RangeError('Metric horizon must be 65..10080 minutes');
  const raw = new SqliteRangeStore(db);
  const current = Math.floor(watermark.timestampSec / 60) * 60;
  const horizonStart = Math.max(0, current - historyMinutes * 60);
  const boundaries = raw.boundaries(scopeId, bounded ? horizonStart : undefined);
  const first = Math.max(boundaries[0]?.timestampSec ?? current, horizonStart);
  const map = new Map(boundaries.map((b) => [b.timestampSec, b]));
  // Match the exact intervals evaluated below, including current prefixes and
  // invalid boundaries. Empty intervals need no accepted blocks; missing bounds
  // are not evaluated. With no nonempty interval, retain the full fallback.
  let bounds: Interval | undefined;
  for (let minute = first; minute <= current; minute += 60) {
    const from = map.get(minute)?.firstBlock;
    const right = map.get(minute + 60);
    const to = minute === current ? watermark.number : right ? right.firstBlock - 1n : undefined;
    if (from === undefined || to === undefined || to < from) continue;
    bounds =
      bounds === undefined
        ? { fromBlock: from, toBlock: to }
        : {
            fromBlock: from < bounds.fromBlock ? from : bounds.fromBlock,
            toBlock: to > bounds.toBlock ? to : bounds.toBlock,
          };
  }
  const ranges = bounded && bounds === undefined ? [] : acceptedMetricRanges(db, scopeId, bounds);
  const timeBounds = { sinceSec: first };
  const times = bounded
    ? new Map([
        ...(bounds === undefined ? [] : raw.logTimes(scopeId, bounds)),
        ...raw.logTimes(scopeId, timeBounds),
      ])
    : raw.logTimes(scopeId);
  const logs = bounded
    ? [
        ...new Map(
          [
            ...(bounds === undefined ? [] : raw.activeLogs(scopeId, bounds)),
            ...raw.activeLogs(scopeId, timeBounds),
          ].map((log) => [rawLogKey(log), log]),
        ).values(),
      ]
    : raw.activeLogs(scopeId);
  const result: MetricCoverage[] = [];
  for (let minute = first; minute <= current; minute += 60) {
    const left = map.get(minute),
      right = map.get(minute + 60);
    const reasons: string[] = [];
    if (!left || (!right && minute !== current)) reasons.push('missing-minute-boundary');
    if ((left && !validBoundary(left)) || (right && !validBoundary(right)))
      reasons.push('invalid-minute-boundary');
    if (left && right && !compatible(left, right)) reasons.push('conflicting-minute-boundaries');
    const fromBlock = left?.firstBlock ?? null,
      toBlock = minute === current ? watermark.number : right ? right.firstBlock - 1n : null;
    if (minute + 60 > watermark.timestampSec || (right && right.at.number > watermark.number))
      reasons.push('watermark-partial');
    if (fromBlock !== null && toBlock !== null) {
      if (!covers(ranges, fromBlock, toBlock)) reasons.push('range-gap');
      if (
        errors.some(
          (e) =>
            (e.raw.blockNumber >= fromBlock && e.raw.blockNumber <= toBlock) ||
            e.time.minuteStartSec === minute,
        )
      )
        reasons.push('projection-quality-error');
      // Both directions matter: a resolved event assigned to the wrong minute
      // invalidates both its claimed bucket and its actual block interval.
      if (
        logs.some((log) => {
          const time = times.get(rawLogKey(log));
          const inside = log.blockNumber >= fromBlock && log.blockNumber <= toBlock;
          return inside
            ? !time ||
                time.source === 'unresolved' ||
                time.minuteStartSec !== minute ||
                (time.exactTimestampSec !== null &&
                  (time.exactTimestampSec < minute || time.exactTimestampSec >= minute + 60))
            : time?.minuteStartSec === minute;
        })
      )
        reasons.push('event-time-mismatch');
    }
    result.push({
      scopeId,
      minuteStartSec: minute,
      fromBlock,
      toBlock,
      complete: reasons.length === 0,
      reasons,
    });
  }
  return result;
}
