import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { BlockAnchor, MinuteBoundary } from '../domain/types.js';
import type { ProjectionQualityError } from '../state/project-range.js';
import {
  completePartitions,
  coversIntervals,
  successfulShardRowsMatch,
  verifySuccessfulShardCoverage,
  type StoredShardRow,
} from '../ingest/completeness.js';
import { BatchCoverageStore, type BatchCoverageProof } from '../storage/batch-coverage.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { countWork } from '../ops/work-counters.js';
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

/** The shard rows a batch's coverage is compared against, in the order both paths read them. */
function shardRows(db: Database.Database, batchId: string): StoredShardRow[] {
  return db
    .prepare(
      'select shard_id,status,response_hash,log_count,error from fetch_shards where batch_id=? order by shard_id',
    )
    .all(batchId) as StoredShardRow[];
}

/** What a decoded verdict depends on: the stored payload text and the batch's shard rows. */
function strictSignature(
  db: Database.Database,
  batchId: string,
  scopeId: string,
  stored: readonly StoredShardRow[],
): string {
  const payload = db
    .prepare('select payload_json from ingest_batches where id=? and scope_id=?')
    .pluck()
    .get(batchId, scopeId) as string;
  return createHash('sha256').update(payload).update(JSON.stringify(stored)).digest('hex');
}

/** What a proof verdict depends on: every fact the proof read validated against current rows. The
 * prefix keeps it distinct from the payload digests above, which are bare hexadecimal. */
function proofSignature(proof: BatchCoverageProof): string {
  return (
    'proof\0' +
    createHash('sha256')
      .update(
        JSON.stringify([
          proof.mutationEpoch,
          proof.manifestHash,
          proof.payloadRefDigest,
          proof.shardDigest,
          proof.fromBlock,
          proof.toBlock,
          proof.filters,
        ]),
      )
      .digest('hex')
  );
}

/** Strict verification: decode the batch and require its stored shards to state its coverage.
 * Every batch without a proof takes this path, and it is the only path that counts a decode. */
function verifiedBatch(
  db: Database.Database,
  batchId: string,
  scopeId: string,
  stored: readonly StoredShardRow[],
): CachedBatch {
  try {
    const decoded = readBatch(db, batchId);
    if (decoded.scopeId !== scopeId) return null;
    verifySuccessfulShardCoverage(decoded);
    if (!successfulShardRowsMatch(stored, decoded) || !completePartitions(decoded)) return null;
    return {
      fromBlock: decoded.fromBlock,
      toBlock: decoded.toBlock,
      filters: [...new Set(decoded.manifest.shards.map((shard) => shard.filterId))],
    };
  } catch {
    return null;
  }
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
  // A coverage proof is the verdict acceptRange reached when it stored this batch, so a reader
  // that finds one skips decoding the batch and reading its stored payload text.
  const proofs = new BatchCoverageStore(db);
  for (const [batchId, accepted] of groups) {
    const row = db
      .prepare('select id from ingest_batches where id=? and scope_id=?')
      .get(batchId, scopeId) as { id: string } | undefined;
    if (!row) continue;
    const proof = proofs.read(batchId);
    const stored = proof === null ? shardRows(db, batchId) : null;
    // One cache entry per batch behind the window, whether its verdict came from a proof or from
    // decoding it: the signature is whatever that verdict was derived from.
    const signature =
      proof === null ? strictSignature(db, batchId, scopeId, stored ?? []) : proofSignature(proof);
    const key = scopeId + '\0' + batchId;
    let value = cache.get(key)?.signature === signature ? cache.get(key)!.value : undefined;
    if (value === undefined) {
      value =
        proof === null
          ? verifiedBatch(db, row.id, scopeId, stored ?? [])
          : {
              fromBlock: BigInt(proof.fromBlock),
              toBlock: BigInt(proof.toBlock),
              filters: [...proof.filters],
            };
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
          coversIntervals(
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
  // Read narrow time evidence once. A minute checks only its actual block interval; the claimed
  // minute's extrema independently detect assignments arriving from outside that interval.
  const claimedBlocks = new Map<number, Interval>();
  const timedLogs = raw
    .activeTimeRows(scopeId, bounded ? { ...bounds, sinceSec: first } : {})
    .map((log) => {
      countWork('coverageLogVisits');
      const { time } = log;
      const claimed = time?.minuteStartSec;
      if (claimed !== undefined && claimed !== null) {
        const prior = claimedBlocks.get(claimed);
        claimedBlocks.set(claimed, {
          fromBlock: prior && prior.fromBlock < log.blockNumber ? prior.fromBlock : log.blockNumber,
          toBlock: prior && prior.toBlock > log.blockNumber ? prior.toBlock : log.blockNumber,
        });
      }
      return { blockNumber: log.blockNumber, time };
    })
    .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
  const hasTimeMismatch = (minute: number, fromBlock: bigint, toBlock: bigint): boolean => {
    const claimed = claimedBlocks.get(minute);
    if (claimed && (claimed.fromBlock < fromBlock || claimed.toBlock > toBlock)) return true;
    let low = 0,
      high = timedLogs.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (timedLogs[mid]!.blockNumber < fromBlock) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < timedLogs.length && timedLogs[i]!.blockNumber <= toBlock; i++) {
      countWork('coverageLogVisits');
      const { time } = timedLogs[i]!;
      if (
        !time ||
        time.source === 'unresolved' ||
        time.minuteStartSec !== minute ||
        (time.exactTimestampSec !== null &&
          (time.exactTimestampSec < minute || time.exactTimestampSec >= minute + 60))
      )
        return true;
    }
    return false;
  };
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
      if (!coversIntervals(ranges, fromBlock, toBlock)) reasons.push('range-gap');
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
      if (hasTimeMismatch(minute, fromBlock, toBlock)) reasons.push('event-time-mismatch');
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
