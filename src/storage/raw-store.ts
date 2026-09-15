import type Database from 'better-sqlite3';
import type { Address, Hex } from 'viem';
import { CHAIN_ID } from '../domain/chain.js';
import { decodeCheckedInteger, encodeCheckedInteger } from '../domain/codec.js';
import type {
  BlockAnchor,
  LogRef,
  LogTime,
  MinuteBoundary,
  RangeChangeSet,
  RawLog,
  WatchScopeId,
} from '../domain/types.js';
import { verifySuccessfulShardCoverage } from '../ingest/completeness.js';
import { countWork } from '../ops/work-counters.js';
import { readBatch, writeCompactBatch } from './payload-store.js';
import {
  rawLogKey,
  type FetchShardManifest,
  type PersistedPoolRegistration,
  type RecordedRangeBatch,
  type RangeInvalidationRecord,
  type RunRecord,
} from './manifest.js';

type AnchorRow = { block_number: number; block_hash: string; timestamp_sec: number };
type RawRow = {
  id: number;
  block_hash: string;
  block_number: number;
  transaction_hash: string;
  transaction_index: number;
  log_index: number;
  address: string;
  topics_json: string;
  data: string;
  raw_block_timestamp: string | null;
};
type TimeRow = RawRow & {
  minute_start_sec: number | null;
  exact_timestamp_sec: number | null;
  source: LogTime['source'];
};
type BoundaryRow = {
  timestamp_sec: number;
  first_block: number;
  before_number: number;
  before_hash: string;
  before_timestamp_sec: number;
  at_number: number;
  at_hash: string;
  at_timestamp_sec: number;
};

export type RawReadBounds = {
  fromBlock?: bigint;
  toBlock?: bigint;
  sinceSec?: number;
};
export type BoundaryReadBounds = {
  sinceSec?: number;
  untilSec?: number;
  includeBrackets?: boolean;
};
export type BlockReadBounds = {
  fromBlock: bigint;
  toBlock: bigint;
  includeBrackets?: boolean;
};

export class SqliteRangeStore {
  constructor(private readonly database: Database.Database) {}

  saveRaw(batch: RecordedRangeBatch, options: { compact?: boolean } = {}): void {
    if (options.compact) {
      writeCompactBatch(this.database, batch);
      return;
    }
    this.database.transaction(() => this.persistTransport(batch)).immediate();
  }

  saveCompact(batch: RecordedRangeBatch): void {
    writeCompactBatch(this.database, batch);
  }

  acceptedTip(scopeId: WatchScopeId): BlockAnchor | null {
    const row = this.database
      .prepare(
        'select block_number, block_hash, timestamp_sec from scope_cursors where scope_id = ?',
      )
      .get(scopeId) as AnchorRow | undefined;
    return row === undefined ? null : anchorFromRow(row);
  }

  acceptRange(
    batch: RecordedRangeBatch,
    options: { startNewSegment?: boolean } = {},
  ): RangeChangeSet {
    const shards = verifySuccessfulShardCoverage(batch);
    return this.database
      .transaction(() => {
        const current = this.acceptedTip(batch.scopeId);
        if (current !== null) {
          if (
            batch.previous === null ||
            batch.previous.number !== current.number ||
            normalizeHex(batch.previous.hash) !== normalizeHex(current.hash)
          )
            throw new Error('Stale range: previous anchor does not match accepted tip');
          // A latest-start segment records only its actual bounds; the skipped interval stays uncovered.
          if (batch.fromBlock > current.number + 1n && !options.startNewSegment)
            throw new Error('Range gap would advance the accepted cursor');
        }

        const bounds = { fromBlock: batch.fromBlock, toBlock: batch.toBlock };
        const explicitRefs = (batch.logTimes ?? []).map((assignment) => assignment.ref);
        const before = this.activeMap(batch.scopeId, bounds, explicitRefs);
        const beforeTimes = this.activeTimeMap(batch.scopeId, bounds, explicitRefs);
        this.persistTransport(batch);
        this.reconcileActive(batch, shards);
        this.reconcilePools(batch, shards);
        this.persistDerived(batch, shards);
        this.persistAcceptedRanges(batch, shards);
        this.persistCheckpoint(batch.scopeId, batch.end, batch.id);
        if (current === null || batch.end.number >= current.number)
          this.persistCursor(batch.scopeId, batch.end);

        const after = this.activeMap(batch.scopeId, bounds, explicitRefs);
        const afterTimes = this.activeTimeMap(batch.scopeId, bounds, explicitRefs);
        return changeSet(before, after, beforeTimes, afterTimes, batch.fromBlock);
      })
      .immediate();
  }

  invalidateAfter(scopeId: WatchScopeId, anchor: BlockAnchor): RangeChangeSet {
    const anchorNumber = checkedHeight(anchor.number);
    checkedTimestamp(anchor.timestampSec);
    const current = this.acceptedTip(scopeId);
    if (current !== null && anchor.number > current.number)
      throw new Error('Invalidation cannot advance the accepted cursor');
    return this.database
      .transaction(() => {
        const before = this.activeMap(scopeId);
        const beforeTimes = this.activeTimeMap(scopeId);
        if (current !== null && anchor.number < current.number)
          this.persistInvalidation(scopeId, anchor.number + 1n, current.number, 'reorg');
        const normalizedHash = normalizeHex(anchor.hash);
        const invalidBoundaryRows = this.database
          .prepare(
            `select timestamp_sec from minute_boundaries
             where scope_id = ? and (
               before_number > ? or at_number > ? or
               (before_number = ? and lower(before_hash) <> ?) or
               (at_number = ? and lower(at_hash) <> ?)
             )`,
          )
          .all(
            scopeId,
            anchorNumber,
            anchorNumber,
            anchorNumber,
            normalizedHash,
            anchorNumber,
            normalizedHash,
          ) as { timestamp_sec: number }[];
        const deleteTimesForBoundary = this.database.prepare(
          `delete from log_times where scope_id = ? and (
             boundary_timestamp_sec = ? or
             (source = 'minute-boundary' and minute_start_sec in (?, ?))
           )`,
        );
        for (const row of invalidBoundaryRows)
          deleteTimesForBoundary.run(
            scopeId,
            row.timestamp_sec,
            row.timestamp_sec - 60,
            row.timestamp_sec,
          );

        this.database
          .prepare(
            `delete from log_times where scope_id = ? and raw_log_id in (
               select id from raw_logs where block_number > ? or
                 (block_number = ? and lower(block_hash) <> ?)
             )`,
          )
          .run(scopeId, anchorNumber, anchorNumber, normalizedHash);
        this.database
          .prepare(
            `delete from active_logs where scope_id = ? and raw_log_id in (
               select id from raw_logs where block_number > ? or
                 (block_number = ? and lower(block_hash) <> ?)
             )`,
          )
          .run(scopeId, anchorNumber, anchorNumber, normalizedHash);
        this.database
          .prepare(
            `delete from pools where scope_id = ? and (
               discovered_block_number > ? or
               (discovered_block_number = ? and lower(discovered_block_hash) <> ?)
             )`,
          )
          .run(scopeId, anchorNumber, anchorNumber, normalizedHash);
        this.database
          .prepare(
            `delete from minute_boundaries where scope_id = ? and (
               before_number > ? or at_number > ? or
               (before_number = ? and lower(before_hash) <> ?) or
               (at_number = ? and lower(at_hash) <> ?)
             )`,
          )
          .run(
            scopeId,
            anchorNumber,
            anchorNumber,
            anchorNumber,
            normalizedHash,
            anchorNumber,
            normalizedHash,
          );
        this.database
          .prepare(
            `delete from anchors where scope_id = ? and (
               block_number > ? or (block_number = ? and lower(block_hash) <> ?)
             )`,
          )
          .run(scopeId, anchorNumber, anchorNumber, normalizedHash);
        this.database
          .prepare('delete from checkpoints where scope_id = ? and block_number > ?')
          .run(scopeId, anchorNumber);
        this.database
          .prepare('delete from accepted_ranges where scope_id = ? and to_block > ?')
          .run(scopeId, anchorNumber);
        this.persistAnchor(scopeId, anchor);
        this.persistCheckpoint(scopeId, anchor, null);
        this.persistCursor(scopeId, anchor);

        const after = this.activeMap(scopeId);
        const afterTimes = this.activeTimeMap(scopeId);
        return changeSet(before, after, beforeTimes, afterTimes, anchor.number + 1n);
      })
      .immediate();
  }

  activeLogs(scopeId: WatchScopeId, bounds: RawReadBounds = {}): readonly RawLog[] {
    const clauses = ['a.scope_id = ?'];
    const parameters: unknown[] = [scopeId];
    if (bounds.fromBlock !== undefined) {
      clauses.push('r.block_number >= ?');
      parameters.push(checkedHeight(bounds.fromBlock));
    }
    if (bounds.toBlock !== undefined) {
      clauses.push('r.block_number <= ?');
      parameters.push(checkedHeight(bounds.toBlock));
    }
    let timeJoin = '';
    if (bounds.sinceSec !== undefined) {
      checkedTimestamp(bounds.sinceSec);
      timeJoin = 'join log_times t on t.scope_id = a.scope_id and t.raw_log_id = a.raw_log_id';
      clauses.push('(t.minute_start_sec >= ? or t.exact_timestamp_sec >= ?)');
      parameters.push(bounds.sinceSec, bounds.sinceSec);
    }
    const blockBounded =
      bounds.sinceSec === undefined &&
      (bounds.fromBlock !== undefined || bounds.toBlock !== undefined);
    if (blockBounded) {
      const blockClauses: string[] = [];
      const blockParameters: unknown[] = [];
      if (bounds.fromBlock !== undefined) {
        blockClauses.push('r.block_number >= ?');
        blockParameters.push(checkedHeight(bounds.fromBlock));
      }
      if (bounds.toBlock !== undefined) {
        blockClauses.push('r.block_number <= ?');
        blockParameters.push(checkedHeight(bounds.toBlock));
      }
      blockParameters.push(scopeId);
      return (
        this.database
          .prepare(
            `select r.* from raw_logs r indexed by raw_logs_height
             where ${blockClauses.join(' and ')}
               and exists (
                 select 1 from active_logs a indexed by active_logs_scope
                 where a.scope_id = ? and a.raw_log_id = r.id
               )
             order by r.block_number, r.transaction_index, r.log_index`,
          )
          .all(...blockParameters) as RawRow[]
      ).map(rawLogFromRow);
    }
    return (
      this.database
        .prepare(
          `select distinct r.* from active_logs a
           join raw_logs r on r.id = a.raw_log_id
           ${timeJoin}
           where ${clauses.join(' and ')}
           order by r.block_number, r.transaction_index, r.log_index`,
        )
        .all(...parameters) as RawRow[]
    ).map(rawLogFromRow);
  }

  checkpoints(scopeId: WatchScopeId, order: 'asc' | 'desc' = 'asc'): readonly BlockAnchor[] {
    const direction = order === 'desc' ? 'desc' : 'asc';
    return (
      this.database
        .prepare(
          `select block_number, block_hash, timestamp_sec from checkpoints
           where scope_id = ? order by block_number ${direction}`,
        )
        .all(scopeId) as AnchorRow[]
    ).map(anchorFromRow);
  }

  anchors(scopeId: WatchScopeId, bounds?: BlockReadBounds): readonly BlockAnchor[] {
    if (bounds === undefined)
      return (
        this.database
          .prepare(
            `select block_number, block_hash, timestamp_sec from anchors
             where scope_id = ? order by block_number, block_hash`,
          )
          .all(scopeId) as AnchorRow[]
      ).map(anchorFromRow);
    const from = checkedHeight(bounds.fromBlock);
    const to = checkedHeight(bounds.toBlock);
    if (to < from) throw new RangeError('Anchor bounds must be ordered');
    const bracket = bounds.includeBrackets
      ? (this.database
          .prepare(
            `select
               (select max(block_number) from anchors where scope_id=? and block_number<?) before,
               (select min(block_number) from anchors where scope_id=? and block_number>?) after`,
          )
          .get(scopeId, from, scopeId, to) as {
          before: number | null;
          after: number | null;
        })
      : { before: null, after: null };
    return (
      this.database
        .prepare(
          `select block_number, block_hash, timestamp_sec from anchors
           where scope_id = ? and block_number between ? and ?
           order by block_number, block_hash`,
        )
        .all(scopeId, bracket.before ?? from, bracket.after ?? to) as AnchorRow[]
    ).map(anchorFromRow);
  }
  boundaries(
    scopeId: WatchScopeId,
    bounds?: number | BoundaryReadBounds,
  ): readonly MinuteBoundary[] {
    if (bounds === undefined || typeof bounds === 'number') {
      const sinceSec = bounds;
      if (sinceSec !== undefined) checkedTimestamp(sinceSec);
      return (
        this.database
          .prepare(
            `select * from minute_boundaries where scope_id = ?
             ${sinceSec === undefined ? '' : 'and timestamp_sec >= ?'} order by timestamp_sec`,
          )
          .all(...(sinceSec === undefined ? [scopeId] : [scopeId, sinceSec])) as BoundaryRow[]
      ).map(boundaryFromRow);
    }
    const since = bounds.sinceSec ?? 0;
    const until = bounds.untilSec ?? Number.MAX_SAFE_INTEGER;
    checkedTimestamp(since);
    checkedTimestamp(until);
    if (until < since) throw new RangeError('Boundary bounds must be ordered');
    const bracket = bounds.includeBrackets
      ? (this.database
          .prepare(
            `select
               (select max(timestamp_sec) from minute_boundaries where scope_id=? and timestamp_sec<?) before,
               (select min(timestamp_sec) from minute_boundaries where scope_id=? and timestamp_sec>?) after`,
          )
          .get(scopeId, since, scopeId, until) as {
          before: number | null;
          after: number | null;
        })
      : { before: null, after: null };
    return (
      this.database
        .prepare(
          `select * from minute_boundaries
           where scope_id = ? and timestamp_sec between ? and ?
           order by timestamp_sec`,
        )
        .all(scopeId, bracket.before ?? since, bracket.after ?? until) as BoundaryRow[]
    ).map(boundaryFromRow);
  }
  logTimes(scopeId: WatchScopeId, bounds: RawReadBounds = {}): ReadonlyMap<string, LogTime> {
    const clauses = ['t.scope_id = ?'];
    const parameters: unknown[] = [scopeId];
    if (bounds.fromBlock !== undefined) {
      clauses.push('r.block_number >= ?');
      parameters.push(checkedHeight(bounds.fromBlock));
    }
    if (bounds.toBlock !== undefined) {
      clauses.push('r.block_number <= ?');
      parameters.push(checkedHeight(bounds.toBlock));
    }
    if (bounds.sinceSec !== undefined) {
      checkedTimestamp(bounds.sinceSec);
      clauses.push('(t.minute_start_sec >= ? or t.exact_timestamp_sec >= ?)');
      parameters.push(bounds.sinceSec, bounds.sinceSec);
    }
    const blockBounded =
      bounds.sinceSec === undefined &&
      (bounds.fromBlock !== undefined || bounds.toBlock !== undefined);
    const rows = blockBounded
      ? (this.database
          .prepare(
            `select r.*, t.minute_start_sec, t.exact_timestamp_sec, t.source
             from raw_logs r indexed by raw_logs_height
             join log_times t on t.raw_log_id = r.id and t.scope_id = ?
             where ${[
               bounds.fromBlock === undefined ? null : 'r.block_number >= ?',
               bounds.toBlock === undefined ? null : 'r.block_number <= ?',
             ]
               .filter((item): item is string => item !== null)
               .join(' and ')}
             order by r.block_number, r.transaction_index, r.log_index`,
          )
          .all(
            scopeId,
            ...(bounds.fromBlock === undefined ? [] : [checkedHeight(bounds.fromBlock)]),
            ...(bounds.toBlock === undefined ? [] : [checkedHeight(bounds.toBlock)]),
          ) as TimeRow[])
      : (this.database
          .prepare(
            `select r.*, t.minute_start_sec, t.exact_timestamp_sec, t.source
             from log_times t join raw_logs r on r.id = t.raw_log_id
             where ${clauses.join(' and ')}
             order by r.block_number, r.transaction_index, r.log_index`,
          )
          .all(...parameters) as TimeRow[]);
    return new Map(
      rows.map((row) => [
        rawLogKey(rawLogFromRow(row)),
        {
          minuteStartSec: row.minute_start_sec,
          exactTimestampSec: row.exact_timestamp_sec,
          source: row.source,
        },
      ]),
    );
  }

  liveTimeContext(
    scopeId: WatchScopeId,
    batchFrom: bigint,
    end: BlockAnchor,
    historyMinutes = 180,
  ): {
    retryFromBlock: bigint;
    unresolved: readonly RawLog[];
    anchors: readonly BlockAnchor[];
    boundaries: readonly MinuteBoundary[];
  } {
    if (!Number.isSafeInteger(historyMinutes) || historyMinutes < 1 || historyMinutes > 10080)
      throw new RangeError('Live time horizon must be 1..10080 minutes');
    const sinceSec = Math.max(0, end.timestampSec - historyMinutes * 60);
    const proofMinute = Math.floor(sinceSec / 60) * 60;
    const proof =
      sinceSec === 0
        ? undefined
        : this.boundaries(scopeId, { sinceSec: proofMinute, untilSec: proofMinute })[0];
    const retryFromBlock = sinceSec === 0 ? 0n : (proof?.firstBlock ?? batchFrom);
    const boundedFrom = retryFromBlock > end.number ? batchFrom : retryFromBlock;
    const readBounds = { fromBlock: boundedFrom, toBlock: end.number };
    const priorTimes = this.logTimes(scopeId, readBounds);
    const unresolved = this.activeLogs(scopeId, readBounds).filter((log) => {
      const prior = priorTimes.get(rawLogKey(log));
      return prior === undefined || prior.source === 'unresolved';
    });
    return {
      retryFromBlock: boundedFrom,
      unresolved,
      anchors: this.anchors(scopeId, {
        fromBlock: boundedFrom,
        toBlock: end.number,
        includeBrackets: true,
      }),
      boundaries: this.boundaries(scopeId, {
        sinceSec: proofMinute,
        untilSec: Math.floor(end.timestampSec / 60) * 60,
        includeBrackets: true,
      }),
    };
  }
  pools(scopeId: WatchScopeId): readonly PersistedPoolRegistration[] {
    const rows = this.database
      .prepare(
        'select payload_json from pools where scope_id = ? order by discovered_block_number, pool_key',
      )
      .all(scopeId) as { payload_json: string }[];
    countWork('registryRowsRead', rows.length);
    return rows.map((row) => decodePoolRegistration(row.payload_json));
  }

  resetForWarmup(scopeId: WatchScopeId): RangeChangeSet {
    return this.database
      .transaction(() => {
        const before = this.activeMap(scopeId);
        const covered = this.database
          .prepare(
            'select min(from_block) as from_block, max(to_block) as to_block from accepted_ranges where scope_id = ?',
          )
          .get(scopeId) as { from_block: number | null; to_block: number | null };
        if (covered.from_block !== null && covered.to_block !== null)
          this.persistInvalidation(
            scopeId,
            decodedHeight(covered.from_block),
            decodedHeight(covered.to_block),
            'warmup-rechecking',
          );
        for (const table of [
          'active_logs',
          'accepted_ranges',
          'log_times',
          'minute_boundaries',
          'anchors',
          'pools',
          'checkpoints',
          'scope_cursors',
        ])
          this.database.prepare(`delete from ${table} where scope_id = ?`).run(scopeId);
        const removed = [...before.values()];
        return {
          added: [],
          removed,
          retimed: [],
          affectedFromBlock: minimumBlock(removed, 0n),
        };
      })
      .immediate();
  }

  invalidations(scopeId: WatchScopeId): readonly RangeInvalidationRecord[] {
    const rows = this.database
      .prepare(
        'select from_block, to_block, reason from range_invalidations where scope_id = ? order by sequence',
      )
      .all(scopeId) as {
      from_block: number;
      to_block: number;
      reason: RangeInvalidationRecord['reason'];
    }[];
    return rows.map((row) => ({
      fromBlock: decodedHeight(row.from_block),
      toBlock: decodedHeight(row.to_block),
      reason: row.reason,
    }));
  }

  private persistInvalidation(
    scopeId: WatchScopeId,
    fromBlock: bigint,
    toBlock: bigint,
    reason: RangeInvalidationRecord['reason'],
  ): void {
    this.database
      .prepare(
        'insert or ignore into range_invalidations(scope_id, from_block, to_block, reason) values (?, ?, ?, ?)',
      )
      .run(scopeId, checkedHeight(fromBlock), checkedHeight(toBlock), reason);
  }

  pruneCheckpoints(scopeId: WatchScopeId, minTimestampSec: number): number {
    checkedTimestamp(minTimestampSec);
    return this.database
      .prepare('delete from checkpoints where scope_id = ? and timestamp_sec < ?')
      .run(scopeId, minTimestampSec).changes;
  }

  recordRun(run: RunRecord): void {
    checkedTimestamp(run.startedAtMs);
    if (run.finishedAtMs !== null) checkedTimestamp(run.finishedAtMs);
    const payloadJson = losslessJson(run.payload);
    const recordJson = losslessJson(run);
    this.database
      .transaction(() => {
        this.database
          .prepare(
            `insert into runs(id, scope_id, started_at_ms, finished_at_ms, status, payload_json, record_json)
             values (?, ?, ?, ?, ?, ?, ?)
             on conflict(id) do update set
               scope_id=excluded.scope_id, started_at_ms=excluded.started_at_ms,
               finished_at_ms=excluded.finished_at_ms, status=excluded.status,
               payload_json=excluded.payload_json, record_json=excluded.record_json`,
          )
          .run(
            run.id,
            run.scopeId,
            run.startedAtMs,
            run.finishedAtMs,
            run.status,
            payloadJson,
            recordJson,
          );
      })
      .immediate();
  }

  private persistTransport(batch: RecordedRangeBatch): void {
    checkedHeight(batch.fromBlock);
    checkedHeight(batch.toBlock);
    checkedHeight(batch.end.number);
    checkedTimestamp(batch.end.timestampSec);
    checkedTimestamp(batch.observedAtMs);
    const payloadJson = transportJson(batch);
    const existing = this.database
      .prepare('select payload_json from ingest_batches where id = ?')
      .get(batch.id) as { payload_json: string } | undefined;
    if (existing !== undefined) {
      if (existing.payload_json !== payloadJson) {
        let same = false;
        try {
          same = transportJson(readBatch(this.database, batch.id)) === payloadJson;
        } catch {
          same = false;
        }
        if (!same) throw new Error('Ingest batch transport payload is immutable');
      }
    } else {
      this.database
        .prepare(
          `insert into ingest_batches(
             id, scope_id, chain_id, from_block, to_block, end_hash, end_timestamp_sec,
             observed_at_ms, capture_mode, filter_plan_hash, manifest_hash, completeness, payload_json
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          batch.id,
          batch.scopeId,
          CHAIN_ID,
          checkedHeight(batch.fromBlock),
          checkedHeight(batch.toBlock),
          normalizeHex(batch.end.hash),
          batch.end.timestampSec,
          batch.observedAtMs,
          batch.captureMode,
          batch.filterPlanHash,
          batch.manifestHash,
          batch.completeness,
          payloadJson,
        );
      const insertShard = this.database.prepare(
        `insert into fetch_shards(
           batch_id, shard_id, filter_id, from_block, to_block, request_json,
           status, response_hash, log_count, error
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const shard of batch.manifest.shards)
        insertShard.run(
          batch.id,
          shard.shardId,
          shard.filterId,
          checkedHeight(shard.request.fromBlock),
          checkedHeight(shard.request.toBlock),
          losslessJson(normalizeRequest(shard)),
          shard.status,
          shard.responseHash,
          shard.logCount,
          shard.error,
        );
    }
    for (const log of batch.logs) this.persistRawLog(log);
  }

  private persistRawLog(log: RawLog): number {
    const payloadJson = losslessJson(normalizeRawLog(log));
    const key = rawLogKey(log);
    const existing = this.database
      .prepare('select id, payload_json from raw_logs where raw_key = ?')
      .get(key) as { id: number; payload_json: string } | undefined;
    if (existing !== undefined) {
      // rawBlockTimestamp is an untrusted provider annotation and may drift across
      // overlapping fetches. Keep the first raw row byte-for-byte; each ingest batch
      // still preserves the exact annotation observed in its transport payload.
      if (canonicalRawLogPayload(existing.payload_json) !== canonicalRawLogPayload(payloadJson))
        throw new Error('Raw log payload is immutable');
      return existing.id;
    }
    const result = this.database
      .prepare(
        `insert into raw_logs(
           raw_key, chain_id, block_hash, block_number, transaction_hash, transaction_index,
           log_index, address, topics_json, data, raw_block_timestamp, payload_json
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        CHAIN_ID,
        normalizeHex(log.blockHash),
        checkedHeight(log.blockNumber),
        normalizeHex(log.transactionHash),
        checkedIndex(log.transactionIndex),
        checkedIndex(log.logIndex),
        normalizeHex(log.address),
        losslessJson(log.topics.map(normalizeHex)),
        normalizeHex(log.data),
        log.rawBlockTimestamp === null ? null : normalizeHex(log.rawBlockTimestamp),
        payloadJson,
      );
    return Number(result.lastInsertRowid);
  }

  private reconcileActive(batch: RecordedRangeBatch, shards: readonly FetchShardManifest[]): void {
    const byFilter = new Map<string, Set<string>>();
    for (const shard of shards) {
      const keys = byFilter.get(shard.filterId) ?? new Set<string>();
      for (const key of shard.logKeys) keys.add(key);
      byFilter.set(shard.filterId, keys);
    }
    const deleteCovered = this.database.prepare(
      `delete from active_logs where scope_id = ? and filter_id = ? and raw_log_id in (
         select id from raw_logs where block_number between ? and ?
       )`,
    );
    const insertActive = this.database.prepare(
      'insert or ignore into active_logs(scope_id, filter_id, raw_log_id) values (?, ?, ?)',
    );
    for (const [filterId, keys] of byFilter) {
      deleteCovered.run(
        batch.scopeId,
        filterId,
        checkedHeight(batch.fromBlock),
        checkedHeight(batch.toBlock),
      );
      for (const key of keys) insertActive.run(batch.scopeId, filterId, this.rawId(key));
    }
  }

  private reconcilePools(batch: RecordedRangeBatch, shards: readonly FetchShardManifest[]): void {
    const families = new Set(shards.map((shard) => shard.filterId));
    const removeMissing = this.database.prepare(
      `delete from pools where scope_id = ? and protocol = ?
       and discovered_block_number between ? and ?
       and not exists (
         select 1 from active_logs
         where active_logs.scope_id = pools.scope_id
           and active_logs.filter_id = ?
           and active_logs.raw_log_id = pools.discovered_raw_log_id
       )`,
    );
    for (const [protocol, family] of [
      ['v3', 'discovery-v3'],
      ['v4', 'discovery-v4'],
    ] as const) {
      if (families.has(family))
        removeMissing.run(
          batch.scopeId,
          protocol,
          checkedHeight(batch.fromBlock),
          checkedHeight(batch.toBlock),
          family,
        );
    }
  }

  /** Merge resolved minute evidence for already-recorded logs without re-fetching
   * raw ranges. Unresolved assignments never overwrite known evidence. */
  recordLogTimes(
    scopeId: WatchScopeId,
    resolution: {
      anchors?: readonly BlockAnchor[];
      boundaries?: readonly MinuteBoundary[];
      logTimes?: readonly { ref: LogRef; time: LogTime }[];
    },
  ): number {
    return this.database
      .transaction(() => {
        const anchors = [...(resolution.anchors ?? [])];
        for (const boundary of resolution.boundaries ?? [])
          anchors.push(boundary.before, boundary.at);
        for (const anchor of anchors) this.persistAnchor(scopeId, anchor);
        this.persistBoundaries(scopeId, resolution.boundaries ?? []);
        let updated = 0;
        for (const assignment of resolution.logTimes ?? []) {
          const time = assignment.time;
          if (time.minuteStartSec === null && time.exactTimestampSec === null) continue;
          if (time.minuteStartSec !== null) checkedTimestamp(time.minuteStartSec);
          if (time.exactTimestampSec !== null) checkedTimestamp(time.exactTimestampSec);
          const rawId = this.rawId(rawLogKey(assignment.ref));
          this.upsertLogTime(scopeId, rawId, time);
          updated++;
        }
        return updated;
      })
      .immediate();
  }

  private persistBoundaries(scopeId: WatchScopeId, boundaries: readonly MinuteBoundary[]): void {
    const insertBoundary = this.database.prepare(
      `insert into minute_boundaries(
         scope_id, timestamp_sec, first_block, before_number, before_hash,
         before_timestamp_sec, at_number, at_hash, at_timestamp_sec
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(scope_id, timestamp_sec) do update set
         first_block=excluded.first_block, before_number=excluded.before_number,
         before_hash=excluded.before_hash, before_timestamp_sec=excluded.before_timestamp_sec,
         at_number=excluded.at_number, at_hash=excluded.at_hash,
         at_timestamp_sec=excluded.at_timestamp_sec`,
    );
    for (const boundary of boundaries) {
      checkedTimestamp(boundary.timestampSec);
      insertBoundary.run(
        scopeId,
        boundary.timestampSec,
        checkedHeight(boundary.firstBlock),
        checkedHeight(boundary.before.number),
        normalizeHex(boundary.before.hash),
        checkedTimestamp(boundary.before.timestampSec),
        checkedHeight(boundary.at.number),
        normalizeHex(boundary.at.hash),
        checkedTimestamp(boundary.at.timestampSec),
      );
    }
  }

  private upsertLogTime(scopeId: WatchScopeId, rawId: number, time: LogTime): void {
    this.database
      .prepare(
        `insert into log_times(
           scope_id, raw_log_id, minute_start_sec, exact_timestamp_sec, source, boundary_timestamp_sec
         ) values (?, ?, ?, ?, ?, ?)
         on conflict(scope_id, raw_log_id) do update set
           minute_start_sec=excluded.minute_start_sec,
           exact_timestamp_sec=excluded.exact_timestamp_sec,
           source=excluded.source,
           boundary_timestamp_sec=excluded.boundary_timestamp_sec`,
      )
      .run(
        scopeId,
        rawId,
        time.minuteStartSec,
        time.exactTimestampSec,
        time.source,
        time.source === 'minute-boundary' && time.minuteStartSec !== null
          ? time.minuteStartSec + 60
          : null,
      );
  }

  private persistDerived(batch: RecordedRangeBatch, shards: readonly FetchShardManifest[]): void {
    const anchors = [batch.previous, batch.end, ...(batch.anchors ?? [])].filter(
      (item): item is BlockAnchor => item !== null,
    );
    for (const boundary of batch.boundaries ?? []) anchors.push(boundary.before, boundary.at);
    for (const anchor of anchors) this.persistAnchor(batch.scopeId, anchor);

    this.persistBoundaries(batch.scopeId, batch.boundaries ?? []);

    for (const assignment of batch.logTimes ?? []) {
      const rawId = this.rawId(rawLogKey(assignment.ref));
      const time = assignment.time;
      if (time.minuteStartSec !== null) checkedTimestamp(time.minuteStartSec);
      if (time.exactTimestampSec !== null) checkedTimestamp(time.exactTimestampSec);
      this.upsertLogTime(batch.scopeId, rawId, time);
    }

    const insertPool = this.database.prepare(
      `insert or ignore into pools(
         scope_id, pool_key, protocol, discovered_raw_log_id, discovered_block_number,
         discovered_block_hash, payload_json
       ) values (?, ?, ?, ?, ?, ?, ?)`,
    );
    const coveredFamilies = new Set(shards.map((shard) => shard.filterId));
    for (const registration of batch.poolRegistrations ?? []) {
      const discoveredRawId = this.rawId(rawLogKey(registration.discoveredAt));
      const family = `discovery-${registration.pool.protocol}`;
      const discoveryInsideBatch =
        registration.discoveredAt.blockNumber >= batch.fromBlock &&
        registration.discoveredAt.blockNumber <= batch.toBlock;
      if (discoveryInsideBatch && coveredFamilies.has(family)) {
        const active = this.database
          .prepare(
            'select 1 from active_logs where scope_id = ? and filter_id = ? and raw_log_id = ?',
          )
          .get(batch.scopeId, family, discoveredRawId);
        if (active === undefined) continue;
      }
      insertPool.run(
        batch.scopeId,
        poolKey(registration),
        registration.pool.protocol,
        discoveredRawId,
        checkedHeight(registration.discoveredAt.blockNumber),
        normalizeHex(registration.discoveredAt.blockHash),
        losslessJson(normalizePoolRegistration(registration)),
      );
    }
  }

  private persistAcceptedRanges(
    batch: RecordedRangeBatch,
    shards: readonly FetchShardManifest[],
  ): void {
    const insert = this.database.prepare(
      `insert or ignore into accepted_ranges(
         scope_id, batch_id, filter_id, from_block, to_block, accepted_at_ms
       ) values (?, ?, ?, ?, ?, ?)`,
    );
    for (const shard of shards)
      insert.run(
        batch.scopeId,
        batch.id,
        shard.filterId,
        checkedHeight(shard.request.fromBlock),
        checkedHeight(shard.request.toBlock),
        checkedTimestamp(batch.observedAtMs),
      );
  }

  private persistAnchor(scopeId: WatchScopeId, anchor: BlockAnchor): void {
    this.database
      .prepare(
        `insert into anchors(scope_id, block_number, block_hash, timestamp_sec)
         values (?, ?, ?, ?)
         on conflict(scope_id, block_number, block_hash) do update set
           timestamp_sec=excluded.timestamp_sec`,
      )
      .run(
        scopeId,
        checkedHeight(anchor.number),
        normalizeHex(anchor.hash),
        checkedTimestamp(anchor.timestampSec),
      );
  }

  private persistCheckpoint(
    scopeId: WatchScopeId,
    anchor: BlockAnchor,
    batchId: string | null,
  ): void {
    this.database
      .prepare(
        `insert into checkpoints(scope_id, block_number, block_hash, timestamp_sec, batch_id)
         values (?, ?, ?, ?, ?)
         on conflict(scope_id, block_number) do update set
           block_hash=excluded.block_hash, timestamp_sec=excluded.timestamp_sec,
           batch_id=excluded.batch_id`,
      )
      .run(
        scopeId,
        checkedHeight(anchor.number),
        normalizeHex(anchor.hash),
        checkedTimestamp(anchor.timestampSec),
        batchId,
      );
  }

  private persistCursor(scopeId: WatchScopeId, anchor: BlockAnchor): void {
    this.database
      .prepare(
        `insert into scope_cursors(scope_id, block_number, block_hash, timestamp_sec)
         values (?, ?, ?, ?)
         on conflict(scope_id) do update set
           block_number=excluded.block_number, block_hash=excluded.block_hash,
           timestamp_sec=excluded.timestamp_sec`,
      )
      .run(
        scopeId,
        checkedHeight(anchor.number),
        normalizeHex(anchor.hash),
        checkedTimestamp(anchor.timestampSec),
      );
  }

  private rawId(key: string): number {
    const row = this.database.prepare('select id from raw_logs where raw_key = ?').get(key) as
      { id: number } | undefined;
    if (row === undefined) throw new Error(`Raw log is not persisted: ${key}`);
    return row.id;
  }

  private activeMap(
    scopeId: WatchScopeId,
    bounds: RawReadBounds = {},
    explicitRefs: readonly LogRef[] = [],
  ): Map<string, RawLog> {
    const result = new Map(
      this.activeLogs(scopeId, bounds).map((log) => [rawLogKey(log), log] as const),
    );
    if (explicitRefs.length > 0) {
      const keysJson = losslessJson([...new Set(explicitRefs.map(rawLogKey))]);
      const rows = this.database
        .prepare(
          `select distinct r.* from active_logs a join raw_logs r on r.id = a.raw_log_id
           where a.scope_id = ? and r.raw_key in (select value from json_each(?))`,
        )
        .all(scopeId, keysJson) as RawRow[];
      for (const row of rows) {
        const log = rawLogFromRow(row);
        result.set(rawLogKey(log), log);
      }
    }
    return result;
  }

  private activeTimeMap(
    scopeId: WatchScopeId,
    bounds: RawReadBounds = {},
    explicitRefs: readonly LogRef[] = [],
  ): Map<string, string> {
    const result = new Map(
      [...this.logTimes(scopeId, bounds)].map(([key, time]) => [key, losslessJson(time)]),
    );
    const readExplicit = this.database.prepare(
      `select t.minute_start_sec, t.exact_timestamp_sec, t.source
       from log_times t join raw_logs r on r.id = t.raw_log_id
       where t.scope_id = ? and r.raw_key = ?`,
    );
    for (const ref of explicitRefs) {
      const key = rawLogKey(ref);
      const row = readExplicit.get(scopeId, key) as
        Pick<TimeRow, 'minute_start_sec' | 'exact_timestamp_sec' | 'source'> | undefined;
      if (row !== undefined)
        result.set(
          key,
          losslessJson({
            minuteStartSec: row.minute_start_sec,
            exactTimestampSec: row.exact_timestamp_sec,
            source: row.source,
          }),
        );
    }
    return result;
  }
}

function checkedHeight(value: bigint): number {
  return encodeCheckedInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function decodedHeight(value: number): bigint {
  return decodeCheckedInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function checkedIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('Index outside safe INTEGER range');
  return value;
}

function checkedTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('Timestamp outside safe INTEGER range');
  return value;
}

function normalizeHex<T extends string>(value: T): T {
  return value.toLowerCase() as T;
}

function normalizeRawLog(log: RawLog): object {
  return {
    blockHash: normalizeHex(log.blockHash),
    blockNumber: log.blockNumber,
    transactionHash: normalizeHex(log.transactionHash),
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    address: normalizeHex(log.address),
    topics: log.topics.map(normalizeHex),
    data: normalizeHex(log.data),
    rawBlockTimestamp: log.rawBlockTimestamp === null ? null : normalizeHex(log.rawBlockTimestamp),
  };
}

function canonicalRawLogPayload(payloadJson: string): string {
  const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
  const { rawBlockTimestamp: _providerAnnotation, ...canonical } = parsed;
  return losslessJson(canonical);
}

function normalizeRequest(shard: FetchShardManifest): object {
  return {
    fromBlock: shard.request.fromBlock,
    toBlock: shard.request.toBlock,
    address: shard.request.address.map(normalizeHex),
    topics: shard.request.topics.map((topic) =>
      typeof topic === 'string'
        ? normalizeHex(topic)
        : topic === null
          ? null
          : topic.map(normalizeHex),
    ),
  };
}

function transportJson(batch: RecordedRangeBatch): string {
  return losslessJson({
    id: batch.id,
    scopeId: batch.scopeId,
    fromBlock: batch.fromBlock,
    toBlock: batch.toBlock,
    end: { ...batch.end, hash: normalizeHex(batch.end.hash) },
    previous:
      batch.previous === null
        ? null
        : { ...batch.previous, hash: normalizeHex(batch.previous.hash) },
    logs: batch.logs.map(normalizeRawLog),
    observedAtMs: batch.observedAtMs,
    captureMode: batch.captureMode,
    filterPlanHash: batch.filterPlanHash,
    manifestHash: batch.manifestHash,
    completeness: batch.completeness,
    manifest: {
      ...batch.manifest,
      shards: batch.manifest.shards.map((shard) => ({
        ...shard,
        request: normalizeRequest(shard),
      })),
    },
  });
}

function losslessJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString(10) : item,
  );
}

function rawLogFromRow(row: RawRow): RawLog {
  return {
    blockHash: row.block_hash as Hex,
    blockNumber: decodedHeight(row.block_number),
    transactionHash: row.transaction_hash as Hex,
    transactionIndex: row.transaction_index,
    logIndex: row.log_index,
    address: row.address as Address,
    topics: JSON.parse(row.topics_json) as Hex[],
    data: row.data as Hex,
    rawBlockTimestamp: row.raw_block_timestamp as Hex | null,
  };
}

function anchorFromRow(row: AnchorRow): BlockAnchor {
  return {
    number: decodedHeight(row.block_number),
    hash: row.block_hash as Hex,
    timestampSec: row.timestamp_sec,
  };
}

function boundaryFromRow(row: BoundaryRow): MinuteBoundary {
  return {
    timestampSec: row.timestamp_sec,
    firstBlock: decodedHeight(row.first_block),
    before: {
      number: decodedHeight(row.before_number),
      hash: row.before_hash as Hex,
      timestampSec: row.before_timestamp_sec,
    },
    at: {
      number: decodedHeight(row.at_number),
      hash: row.at_hash as Hex,
      timestampSec: row.at_timestamp_sec,
    },
  };
}

function changeSet(
  before: ReadonlyMap<string, RawLog>,
  after: ReadonlyMap<string, RawLog>,
  beforeTimes: ReadonlyMap<string, string>,
  afterTimes: ReadonlyMap<string, string>,
  fallback: bigint,
): RangeChangeSet {
  const added = [...after].filter(([key]) => !before.has(key)).map(([, log]) => log);
  const removed = [...before].filter(([key]) => !after.has(key)).map(([, log]) => log);
  const retimed = [...after]
    .filter(([key]) => before.has(key) && beforeTimes.get(key) !== afterTimes.get(key))
    .map(([, log]) => log);
  return {
    added,
    removed,
    retimed,
    affectedFromBlock: minimumBlock([...added, ...removed, ...retimed], fallback),
  };
}

function minimumBlock(refs: readonly LogRef[], fallback: bigint): bigint {
  return refs.reduce(
    (minimum, ref) => (ref.blockNumber < minimum ? ref.blockNumber : minimum),
    refs.length === 0 ? fallback : refs[0]!.blockNumber,
  );
}

function poolKey(registration: PersistedPoolRegistration): string {
  return losslessJson(
    registration.pool.protocol === 'v3'
      ? {
          chainId: registration.pool.chainId,
          protocol: registration.pool.protocol,
          address: normalizeHex(registration.pool.address),
        }
      : {
          chainId: registration.pool.chainId,
          protocol: registration.pool.protocol,
          manager: normalizeHex(registration.pool.manager),
          poolId: normalizeHex(registration.pool.poolId),
        },
  );
}

function normalizePoolRegistration(registration: PersistedPoolRegistration): object {
  const pool =
    registration.pool.protocol === 'v3'
      ? { ...registration.pool, address: normalizeHex(registration.pool.address) }
      : {
          ...registration.pool,
          manager: normalizeHex(registration.pool.manager),
          poolId: normalizeHex(registration.pool.poolId),
        };
  return {
    ...registration,
    pool,
    token0: normalizeHex(registration.token0),
    token1: normalizeHex(registration.token1),
    hooks: normalizeHex(registration.hooks),
    discoveredAt: {
      ...registration.discoveredAt,
      blockHash: normalizeHex(registration.discoveredAt.blockHash),
      transactionHash: normalizeHex(registration.discoveredAt.transactionHash),
    },
  };
}

function decodePoolRegistration(payloadJson: string): PersistedPoolRegistration {
  const value = JSON.parse(payloadJson) as Record<string, unknown>;
  const discoveredAt = value.discoveredAt as Record<string, unknown>;
  return {
    ...(value as Omit<PersistedPoolRegistration, 'discoveredAt'>),
    discoveredAt: {
      ...(discoveredAt as Omit<LogRef, 'blockNumber'>),
      blockNumber: BigInt(discoveredAt.blockNumber as string),
    },
  };
}
