import type Database from 'better-sqlite3';

export interface RetentionPolicy {
  scopeId: string;
  registryScopeId: string;
  rawRetentionSec: number | null;
  liveRetentionSec: number;
  requiredLookbackSec: number;
  overlapBlocks: number;
}

export function registerRetentionConsumer(db: Database.Database, policy: RetentionPolicy): void {
  if (!policy.scopeId.trim() || !policy.registryScopeId.trim())
    throw new RangeError('Retention scope is required');
  for (const value of [
    policy.rawRetentionSec,
    policy.liveRetentionSec,
    policy.requiredLookbackSec,
    policy.overlapBlocks,
  ])
    if (value !== null && (!Number.isSafeInteger(value) || value < 0))
      throw new RangeError('Invalid retention policy');
  if (
    policy.liveRetentionSec < policy.requiredLookbackSec ||
    (policy.rawRetentionSec !== null && policy.rawRetentionSec < policy.requiredLookbackSec)
  )
    throw new RangeError('Retention policy is shorter than its required lookback');
  db.prepare(
    `insert into retention_consumers values(?,?,?,?,?,?)
    on conflict(scope_id) do update set registry_scope_id=excluded.registry_scope_id,
    raw_retention_sec=excluded.raw_retention_sec,live_retention_sec=excluded.live_retention_sec,
    required_lookback_sec=excluded.required_lookback_sec,overlap_blocks=excluded.overlap_blocks`,
  ).run(
    policy.scopeId,
    policy.registryScopeId,
    policy.rawRetentionSec,
    policy.liveRetentionSec,
    policy.requiredLookbackSec,
    policy.overlapBlocks,
  );
}

export function pinRetention(db: Database.Database, id: string, kind: 'history' | 'replay'): void {
  if (!id.trim()) throw new RangeError('Retention pin id is required');
  db.prepare(
    `insert into retention_pins values(?,?,'active',?)
    on conflict(id) do update set status='active'`,
  ).run(id, kind, Date.now());
}

export function releaseRetentionPin(db: Database.Database, id: string): boolean {
  return (
    db.prepare("update retention_pins set status='released' where id=? and status='active'").run(id)
      .changes === 1
  );
}

function hasRetentionSchema(db: Database.Database): boolean {
  return !!db
    .prepare("select 1 from sqlite_master where type='table' and name='retention_consumers'")
    .get();
}

export interface RetentionScopeSafety {
  scopeId: string;
  rawCutoffSec: number | null;
  liveCutoffSec: number | null;
  beforeBlock: number | null;
  blockers: string[];
}
export interface RetentionSafety {
  scopes: RetentionScopeSafety[];
  pins: { id: string; kind: string }[];
  blockers: string[];
  rawCutoffSec: number | null;
  beforeBlock: number | null;
}

/** All known scopes participate, including registry scopes and dormant consumers.
 * Stale cursors never advance from wall time. Unknown policies fail closed. */
export function readRetentionSafety(db: Database.Database): RetentionSafety {
  if (!hasRetentionSchema(db))
    return {
      scopes: [],
      pins: [],
      blockers: ['retention-schema-missing'],
      rawCutoffSec: null,
      beforeBlock: null,
    };
  const ids = db
    .prepare(
      `select scope_id from scope_cursors union select scope_id from ingest_batches
    union select scope_id from active_logs union select scope_id from log_times
    union select scope_id from pools union select scope_id from accepted_ranges
    union select scope_id from live_events union select scope_id from live_inputs
    union select scope_id from live_quality_errors union select scope_id from checkpoints
    union select scope_id from retention_consumers union select registry_scope_id from retention_consumers
    union select scope_id from projection_cursors union select registry_scope_id from projection_cursors
    union select scope_id from live_projection_cursors union select registry_scope_id from live_projection_cursors
    order by scope_id`,
    )
    .pluck()
    .all() as string[];
  const pins = db
    .prepare("select id,kind from retention_pins where status='active' order by id")
    .all() as { id: string; kind: string }[];
  const scopes = ids.map((scopeId): RetentionScopeSafety => {
    const policy = db.prepare('select * from retention_consumers where scope_id=?').get(scopeId) as
      | {
          raw_retention_sec: number | null;
          live_retention_sec: number;
          required_lookback_sec: number;
          overlap_blocks: number;
        }
      | undefined;
    const tip = db
      .prepare('select block_number,timestamp_sec from scope_cursors where scope_id=?')
      .get(scopeId) as { block_number: number; timestamp_sec: number } | undefined;
    const blockers: string[] = [];
    if (!policy) blockers.push('policy-missing');
    if (!tip) blockers.push('progress-missing');
    if (!policy || !tip)
      return { scopeId, rawCutoffSec: null, liveCutoffSec: null, beforeBlock: null, blockers };
    const timestamp = Math.floor(tip.timestamp_sec / 60) * 60;
    const liveCutoffSec = Math.max(
      0,
      timestamp - Math.max(policy.live_retention_sec, policy.required_lookback_sec),
    );
    if (policy.raw_retention_sec === null)
      return {
        scopeId,
        rawCutoffSec: null,
        liveCutoffSec,
        beforeBlock: null,
        blockers: ['keep-raw-forever'],
      };
    const rawCutoffSec = Math.max(
      0,
      timestamp - Math.max(policy.raw_retention_sec, policy.required_lookback_sec),
    );
    const anchor = db
      .prepare('select max(block_number) as n from anchors where scope_id=? and timestamp_sec<=?')
      .get(scopeId, rawCutoffSec) as { n: number | null };
    const checkpoint = db
      .prepare('select min(block_number) as n from checkpoints where scope_id=?')
      .get(scopeId) as { n: number | null };
    if (anchor.n === null) blockers.push('cutoff-anchor-missing');
    const beforeBlock =
      anchor.n === null
        ? null
        : Math.max(
            0,
            Math.min(
              anchor.n,
              tip.block_number - policy.overlap_blocks,
              checkpoint.n ?? tip.block_number,
            ),
          );
    return { scopeId, rawCutoffSec, liveCutoffSec, beforeBlock, blockers };
  });
  const blockers = [
    ...scopes.flatMap((scope) => scope.blockers.map((reason) => `${scope.scopeId}:${reason}`)),
    ...pins.map((pin) => `pin:${pin.kind}:${pin.id}`),
  ];
  if (scopes.length === 0) blockers.push('consumer-missing');
  return {
    scopes,
    pins,
    blockers,
    rawCutoffSec: blockers.length ? null : Math.min(...scopes.map((scope) => scope.rawCutoffSec!)),
    beforeBlock: blockers.length ? null : Math.min(...scopes.map((scope) => scope.beforeBlock!)),
  };
}

export function readRetentionExpiration(
  db: Database.Database,
  scopeId: string,
):
  | {
      raw_before_block: number;
      raw_before_sec: number;
      live_before_sec: number;
    }
  | undefined {
  if (!hasRetentionSchema(db)) return undefined;
  return db
    .prepare(
      'select raw_before_block,raw_before_sec,live_before_sec from retention_expirations where scope_id=?',
    )
    .get(scopeId) as
    | {
        raw_before_block: number;
        raw_before_sec: number;
        live_before_sec: number;
      }
    | undefined;
}

export function recordRetentionExpiration(
  db: Database.Database,
  scopeId: string,
  rawBlock = 0,
  rawSec = 0,
  liveSec = 0,
): void {
  db.prepare(
    `insert into retention_expirations values(?,?,?,?) on conflict(scope_id) do update set
    raw_before_block=max(raw_before_block,excluded.raw_before_block),
    raw_before_sec=max(raw_before_sec,excluded.raw_before_sec),
    live_before_sec=max(live_before_sec,excluded.live_before_sec)`,
  ).run(scopeId, rawBlock, rawSec, liveSec);
}
