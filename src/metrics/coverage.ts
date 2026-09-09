import type Database from 'better-sqlite3';
import type { BlockAnchor, MinuteBoundary } from '../domain/types.js';
import type { ProjectionQualityError } from '../state/project-range.js';
import { verifySuccessfulShardCoverage } from '../ingest/completeness.js';
import type { RecordedRangeBatch } from '../storage/manifest.js';
import { SqliteRangeStore } from '../storage/raw-store.js';

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
function decodeBatch(text: string): RecordedRangeBatch {
  const b = JSON.parse(text) as RecordedRangeBatch;
  b.fromBlock = BigInt(b.fromBlock);
  b.toBlock = BigInt(b.toBlock);
  b.end.number = BigInt(b.end.number);
  if (b.previous) b.previous.number = BigInt(b.previous.number);
  for (const log of b.logs) log.blockNumber = BigInt(log.blockNumber);
  for (const shard of b.manifest.shards) {
    shard.request.fromBlock = BigInt(shard.request.fromBlock);
    shard.request.toBlock = BigInt(shard.request.toBlock);
  }
  return b;
}

/** Only current accepted ranges count. Failed raw attempts are historical evidence,
 * and cannot create either a complete minute or erase prior accepted coverage. */
export function acceptedMetricRanges(db: Database.Database, scopeId: string): Interval[] {
  const rows = db
    .prepare('select batch_id,filter_id,from_block,to_block from accepted_ranges where scope_id=?')
    .all(scopeId) as RangeRow[];
  const groups = new Map<string, RangeRow[]>();
  for (const row of rows) {
    const group = groups.get(row.batch_id) ?? [];
    group.push(row);
    groups.set(row.batch_id, group);
  }
  const result: Interval[] = [];
  for (const [batchId, accepted] of groups) {
    const row = db
      .prepare('select payload_json from ingest_batches where id=? and scope_id=?')
      .get(batchId, scopeId) as { payload_json: string } | undefined;
    if (!row) continue;
    const batch = decodeBatch(row.payload_json);
    if (batch.scopeId !== scopeId) continue;
    try {
      verifySuccessfulShardCoverage(batch);
    } catch {
      continue;
    }
    const stored = db
      .prepare(
        'select shard_id,status,response_hash,log_count,error from fetch_shards where batch_id=?',
      )
      .all(batchId) as {
      shard_id: string;
      status: string;
      response_hash: string | null;
      log_count: number;
      error: string | null;
    }[];
    if (
      stored.length !== batch.manifest.expectedShardIds.length ||
      batch.manifest.shards.some(
        (s) =>
          !stored.some(
            (r) =>
              r.shard_id === s.shardId &&
              r.status === 'success' &&
              r.response_hash === s.responseHash &&
              r.log_count === s.logCount &&
              r.error === null,
          ),
      )
    )
      continue;
    if (!completePartitions(batch)) continue;
    const filters = [...new Set(batch.manifest.shards.map((s) => s.filterId))];
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
): MetricCoverage[] {
  if (!Number.isSafeInteger(historyMinutes) || historyMinutes < 65 || historyMinutes > 10080)
    throw new RangeError('Metric horizon must be 65..10080 minutes');
  const raw = new SqliteRangeStore(db),
    boundaries = raw.boundaries(scopeId);
  const ranges = acceptedMetricRanges(db, scopeId);
  const current = Math.floor(watermark.timestampSec / 60) * 60;
  const first = Math.max(boundaries[0]?.timestampSec ?? current, current - historyMinutes * 60);
  const map = new Map(boundaries.map((b) => [b.timestampSec, b]));
  const times = raw.logTimes(scopeId);
  const logs = raw.activeLogs(scopeId);
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
          const time = times.get(
            `4663:${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`,
          );
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
