import type Database from 'better-sqlite3';

/**
 * Physical retention for the live window and the raw tier.
 *
 * The live projection keeps every derived event on disk (the rolling window is only the in-memory
 * read index), and the ingest layer keeps every batch transport and raw log forever. These passes
 * are what stop those tables growing without bound on a long-running recorder. They delete only
 * rows older than a caller-supplied cutoff, in bounded batches, so a backlog drains over several
 * poll gaps instead of in one transaction that would hold the writer and grow the WAL by the pages
 * it touches.
 *
 * Deleted rows free pages for reuse by new writes; the file itself only shrinks when it is
 * rewritten (see `storage compact`). Retention therefore bounds steady-state size rather than
 * shrinking an existing file.
 */

function checkedSince(sinceSec: number, name: string): void {
  if (!Number.isSafeInteger(sinceSec) || sinceSec < 0)
    throw new RangeError(`${name} must be a non-negative safe integer`);
}

function checkedBatch(max: number, name: string): number {
  if (max !== -1 && (!Number.isSafeInteger(max) || max < 1))
    throw new RangeError(`${name} must be a positive safe integer`);
  return max;
}

/**
 * Retire live window rows whose resolved minute is before `sinceSec`, together with the
 * projection-input snapshot rows they pin.
 *
 * `live_inputs` carries no timestamp of its own; its rows mirror `live_events` /
 * `live_quality_errors` by `raw_log_id`, so an input whose event and error have both left the
 * window is dead weight and is removed once those rows are gone. Unresolved rows
 * (`minute_start_sec IS NULL`) are left for the projection's own boundary logic and are bounded
 * by the raw retention below.
 */
export function pruneLiveWindow(
  db: Database.Database,
  scopeId: string,
  sinceSec: number,
  options: { maxRows?: number } = {},
): { liveEvents: number; qualityErrors: number; liveInputs: number } {
  checkedSince(sinceSec, 'sinceSec');
  const maxRows = checkedBatch(options.maxRows ?? -1, 'maxRows');
  return db.transaction(() => {
    const liveEvents = db
      .prepare(
        `delete from live_events where rowid in (
           select rowid from live_events
           where scope_id=? and minute_start_sec is not null and minute_start_sec < ?
           order by rowid limit ?)`,
      )
      .run(scopeId, sinceSec, maxRows).changes;
    const qualityErrors = db
      .prepare(
        `delete from live_quality_errors where rowid in (
           select rowid from live_quality_errors
           where scope_id=? and minute_start_sec is not null and minute_start_sec < ?
           order by rowid limit ?)`,
      )
      .run(scopeId, sinceSec, maxRows).changes;
    const liveInputs = db
      .prepare(
        `delete from live_inputs where rowid in (
           select rowid from live_inputs where scope_id=? and raw_log_id not in (
             select raw_log_id from live_events where scope_id=?
             union
             select raw_log_id from live_quality_errors where scope_id=?
           ) order by rowid limit ?)`,
      )
      .run(scopeId, scopeId, scopeId, maxRows).changes;
    return { liveEvents, qualityErrors, liveInputs };
  })();
}

/**
 * Retire ingest batch transports older than `cutoffSec`.
 *
 * `fetch_shards` and `batch_coverage_proofs` cascade with the batch; `accepted_ranges` holds a
 * plain reference and is deleted first so the foreign key never fires. The orphaned content
 * addressed payload objects are collected by `reclaimPayloadObjects` once the rows have stopped
 * moving, exactly as the signal-evaluation retention does.
 */
export function pruneRawBatches(
  db: Database.Database,
  scopeId: string,
  cutoffSec: number,
  options: { maxBatches?: number } = {},
): { batches: number; acceptedRanges: number } {
  checkedSince(cutoffSec, 'cutoffSec');
  const maxBatches = checkedBatch(options.maxBatches ?? -1, 'maxBatches');
  return db.transaction(() => {
    const acceptedRanges = db
      .prepare(
        `delete from accepted_ranges where scope_id=? and batch_id in (
           select id from ingest_batches where scope_id=? and end_timestamp_sec < ?
           order by id limit ?)`,
      )
      .run(scopeId, scopeId, cutoffSec, maxBatches).changes;
    const batches = db
      .prepare(
        `delete from ingest_batches where rowid in (
           select rowid from ingest_batches where scope_id=? and end_timestamp_sec < ?
           order by rowid limit ?)`,
      )
      .run(scopeId, cutoffSec, maxBatches).changes;
    return { batches, acceptedRanges };
  })();
}

/**
 * Retire raw logs older than `beforeBlock` that are not pinned by the pool registry, together with
 * their active/time rows and the live rows they derived.
 *
 * Discovery logs (`pools.discovered_raw_log_id`) stay: the registry needs them to keep naming the
 * pools its events reference. Old operation logs are deletable because the live recorder reads
 * `raw_logs` only for reorg/registry repair within the recent window, never for the full history.
 *
 * `raw_logs` is global (not scoped), so the reference rows are removed scope-agnostically; the
 * active/time deletions fire the live-dirty triggers and bump the source revision, so the next
 * projection sync reconciles the window against the rows that survive. The dirty marks for the
 * deleted ids are cleared here because their raw rows are gone.
 */
export function pruneRawLogs(
  db: Database.Database,
  beforeBlock: number,
  options: { maxRows?: number } = {},
): {
  rawLogs: number;
  activeLogs: number;
  logTimes: number;
  liveEvents: number;
  liveInputs: number;
  qualityErrors: number;
} {
  if (!Number.isSafeInteger(beforeBlock) || beforeBlock < 0)
    throw new RangeError('beforeBlock must be a non-negative safe integer');
  const maxRows = checkedBatch(options.maxRows ?? -1, 'maxRows');
  return db.transaction(() => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS doomed_raw(id INTEGER PRIMARY KEY)');
    db.prepare('delete from doomed_raw').run();
    db.prepare(
      `insert into doomed_raw(id)
       select id from raw_logs
       where block_number < ? and id not in (select discovered_raw_log_id from pools)
       order by id limit ?`,
    ).run(beforeBlock, maxRows);
    const activeLogs = db
      .prepare('delete from active_logs where raw_log_id in (select id from doomed_raw)')
      .run().changes;
    const logTimes = db
      .prepare('delete from log_times where raw_log_id in (select id from doomed_raw)')
      .run().changes;
    const liveEvents = db
      .prepare('delete from live_events where raw_log_id in (select id from doomed_raw)')
      .run().changes;
    const qualityErrors = db
      .prepare('delete from live_quality_errors where raw_log_id in (select id from doomed_raw)')
      .run().changes;
    const liveInputs = db
      .prepare('delete from live_inputs where raw_log_id in (select id from doomed_raw)')
      .run().changes;
    const rawLogs = db.prepare('delete from raw_logs where id in (select id from doomed_raw)').run().changes;
    // The active/time triggers already marked these ids dirty; their raw rows are gone, so the mark
    // would only make the next sync re-read a missing row.
    db.prepare('delete from live_dirty_logs where raw_log_id in (select id from doomed_raw)').run();
    return { rawLogs, activeLogs, logTimes, liveEvents, liveInputs, qualityErrors };
  })();
}
