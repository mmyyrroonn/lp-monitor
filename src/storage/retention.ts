import type Database from 'better-sqlite3';
import { readRetentionSafety, recordRetentionExpiration } from './retention-state.js';

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
  if (!Number.isSafeInteger(max) || max < 1)
    throw new RangeError(`${name} must be a positive safe integer`);
  return max;
}

function selectedBatches(
  db: Database.Database,
  scopeId: string,
  cutoffSec: number,
  max: number,
): string[] {
  const safety = readRetentionSafety(db);
  if (safety.rawCutoffSec === null || safety.beforeBlock === null) return [];
  return db
    .prepare(
      `select id from ingest_batches where scope_id=? and end_timestamp_sec<? and to_block<?
    order by end_timestamp_sec,id limit ?`,
    )
    .pluck()
    .all(scopeId, Math.min(cutoffSec, safety.rawCutoffSec), safety.beforeBlock, max) as string[];
}

function selectedRawLogs(db: Database.Database, beforeBlock: number, max: number): number[] {
  const safety = readRetentionSafety(db);
  if (safety.beforeBlock === null) return [];
  // Even an unaccepted/failed transport may reconstruct itself from these raw facts.
  return db
    .prepare(
      `select r.id from raw_logs r where r.block_number<?
    and not exists(select 1 from pools p where p.discovered_raw_log_id=r.id)
    and not exists(select 1 from ingest_batches b where b.chain_id=r.chain_id and b.from_block<=r.block_number and b.to_block>=r.block_number)
    and not exists(select 1 from batch_coverage_dependencies d where d.raw_log_id=r.id)
    and not exists(select 1 from accepted_ranges a where a.from_block<=r.block_number and a.to_block>=r.block_number)
    order by r.block_number,r.id limit ?`,
    )
    .pluck()
    .all(Math.min(beforeBlock, safety.beforeBlock), max) as number[];
}

/** The bounded global raw-log set can invalidate availability in several scopes. */
function rawRetentionOwners(db: Database.Database, rawLogIds: number[]) {
  if (rawLogIds.length === 0) return [];
  return db
    .prepare(
      `with doomed(id) as (select value from json_each(?))
    select owned.scope_id,max(r.block_number) as block,max(coalesce(t.minute_start_sec,0)) as minute from (
      select scope_id,raw_log_id from active_logs where raw_log_id in (select id from doomed)
      union select scope_id,raw_log_id from log_times where raw_log_id in (select id from doomed)
      union select scope_id,raw_log_id from live_events where raw_log_id in (select id from doomed)
      union select scope_id,raw_log_id from live_quality_errors where raw_log_id in (select id from doomed)
      union select scope_id,raw_log_id from live_inputs where raw_log_id in (select id from doomed)
    ) owned join raw_logs r on r.id=owned.raw_log_id left join log_times t on t.raw_log_id=r.id and t.scope_id=owned.scope_id
    group by owned.scope_id`,
    )
    .all(JSON.stringify(rawLogIds)) as { scope_id: string; block: number; minute: number }[];
}

/** Same selectors as the physical passes, under one read snapshot. Raw-log counts
 * describe this pass; transports removed now can release more logs on the next pass. */
export function previewRawRetention(db: Database.Database, maxRows = 50_000) {
  checkedBatch(maxRows, 'maxRows');
  return db.transaction(() => {
    const safety = readRetentionSafety(db);
    const scopes = safety.scopes.map((scope) => ({
      scopeId: scope.scopeId,
      batchIds: selectedBatches(db, scope.scopeId, Number.MAX_SAFE_INTEGER, maxRows),
    }));
    const rawLogIds = selectedRawLogs(db, Number.MAX_SAFE_INTEGER, maxRows);
    const countRanges = db.prepare('select count(*) as n from accepted_ranges where batch_id=?');
    const acceptedRanges = scopes.reduce(
      (total, scope) =>
        total + scope.batchIds.reduce((n, id) => n + (countRanges.get(id) as { n: number }).n, 0),
      0,
    );
    return {
      dryRun: true,
      safety,
      scopes,
      batches: scopes.reduce((n, scope) => n + scope.batchIds.length, 0),
      rawLogs: rawLogIds.length,
      acceptedRanges,
      coverageExpiryScopes: [
        ...new Set([
          ...scopes.filter((scope) => scope.batchIds.length > 0).map((scope) => scope.scopeId),
          ...rawRetentionOwners(db, rawLogIds).map((owner) => owner.scope_id),
        ]),
      ].sort(),
      rawLogIds,
      notes: [
        'Read-only preview. All unknown/dormant consumers and active pins block shared raw expiry.',
        'Raw logs still referenced by any transport remain until a later pass. Expiry makes historical coverage unavailable.',
      ],
    };
  })();
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
  const maxRows = checkedBatch(options.maxRows ?? 50_000, 'maxRows');
  return db
    .transaction(() => {
      const safety = readRetentionSafety(db);
      const scope = safety.scopes.find((item) => item.scopeId === scopeId);
      if (
        safety.pins.length > 0 ||
        scope?.liveCutoffSec === null ||
        scope?.liveCutoffSec === undefined
      )
        return { liveEvents: 0, qualityErrors: 0, liveInputs: 0 };
      sinceSec = Math.min(sinceSec, scope.liveCutoffSec);
      // Materialize the actual bounded rows before recording their availability floor.
      db.exec(
        'CREATE TEMP TABLE IF NOT EXISTS doomed_live_events(id INTEGER PRIMARY KEY); CREATE TEMP TABLE IF NOT EXISTS doomed_live_errors(id INTEGER PRIMARY KEY)',
      );
      db.prepare('delete from doomed_live_events').run();
      db.prepare('delete from doomed_live_errors').run();
      db.prepare(
        `insert into doomed_live_events select rowid from live_events where scope_id=? and minute_start_sec<? order by minute_start_sec,rowid limit ?`,
      ).run(scopeId, sinceSec, maxRows);
      db.prepare(
        `insert into doomed_live_errors select rowid from live_quality_errors where scope_id=? and minute_start_sec<? order by minute_start_sec,rowid limit ?`,
      ).run(scopeId, sinceSec, maxRows);
      const expired = db
        .prepare(
          `select max(minute_start_sec) as minute from (
      select minute_start_sec from live_events where rowid in (select id from doomed_live_events)
      union all select minute_start_sec from live_quality_errors where rowid in (select id from doomed_live_errors))`,
        )
        .get() as { minute: number | null };
      if (expired.minute !== null)
        recordRetentionExpiration(db, scopeId, 0, 0, expired.minute + 60);
      const liveEvents = db
        .prepare('delete from live_events where rowid in (select id from doomed_live_events)')
        .run().changes;
      const qualityErrors = db
        .prepare(
          'delete from live_quality_errors where rowid in (select id from doomed_live_errors)',
        )
        .run().changes;
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
    })
    .immediate();
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
  const maxBatches = checkedBatch(options.maxBatches ?? 50_000, 'maxBatches');
  return db
    .transaction(() => {
      db.exec('CREATE TEMP TABLE IF NOT EXISTS doomed_batches(id TEXT PRIMARY KEY)');
      db.prepare('delete from doomed_batches').run();
      const insert = db.prepare('insert into doomed_batches(id) values(?)');
      for (const id of selectedBatches(db, scopeId, cutoffSec, maxBatches)) insert.run(id);
      const expired = db
        .prepare(
          `select a.scope_id,max(a.to_block) as block,max(b.end_timestamp_sec) as sec
      from accepted_ranges a join ingest_batches b on b.id=a.batch_id
      where b.id in (select id from doomed_batches) group by a.scope_id`,
        )
        .all() as { scope_id: string; block: number; sec: number }[];
      for (const row of expired)
        recordRetentionExpiration(db, row.scope_id, row.block + 1, row.sec);
      const acceptedRanges = db
        .prepare('delete from accepted_ranges where batch_id in (select id from doomed_batches)')
        .run().changes;
      const batches = db
        .prepare('delete from ingest_batches where id in (select id from doomed_batches)')
        .run().changes;
      return { batches, acceptedRanges };
    })
    .immediate();
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
  const maxRows = checkedBatch(options.maxRows ?? 50_000, 'maxRows');
  return db
    .transaction(() => {
      db.exec('CREATE TEMP TABLE IF NOT EXISTS doomed_raw(id INTEGER PRIMARY KEY)');
      db.prepare('delete from doomed_raw').run();
      const insert = db.prepare('insert into doomed_raw(id) values(?)');
      const rawLogIds = selectedRawLogs(db, beforeBlock, maxRows);
      for (const id of rawLogIds) insert.run(id);
      const owners = rawRetentionOwners(db, rawLogIds);
      for (const row of owners)
        recordRetentionExpiration(
          db,
          row.scope_id,
          row.block + 1,
          row.minute > 0 ? row.minute + 60 : 0,
        );
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
      const rawLogs = db
        .prepare('delete from raw_logs where id in (select id from doomed_raw)')
        .run().changes;
      // The active/time triggers already marked these ids dirty; their raw rows are gone, so the mark
      // would only make the next sync re-read a missing row.
      db.prepare(
        'delete from live_dirty_logs where raw_log_id in (select id from doomed_raw)',
      ).run();
      return { rawLogs, activeLogs, logTimes, liveEvents, liveInputs, qualityErrors };
    })
    .immediate();
}
