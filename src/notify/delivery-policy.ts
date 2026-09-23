import type Database from 'better-sqlite3';

export type DeliveryMode = 'none' | 'local';

export interface DeliveryPolicy {
  mode: DeliveryMode;
  /** Incremented every time delivery is enabled after being off. */
  generation: number;
  enabledAtMs: number | null;
  disabledAtMs: number | null;
}

const statements = new WeakMap<Database.Database, Map<string, Database.Statement>>();
function statement(db: Database.Database, sql: string): Database.Statement {
  let cache = statements.get(db);
  if (!cache) {
    cache = new Map();
    statements.set(db, cache);
  }
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    cache.set(sql, prepared);
  }
  return prepared;
}

/**
 * The delivery policy a scope runs under, or null when none was ever recorded.
 *
 * A database that predates the policy table is treated as `local` by the delivery paths: that is
 * exactly how it behaved, and silently stopping its withdrawals would be the larger change.
 * `runRecorder` writes the explicit row before any signal work starts.
 */
export function readDeliveryPolicy(db: Database.Database, scopeId: string): DeliveryPolicy | null {
  const row = statement(
    db,
    'select mode,generation,enabled_at_ms,disabled_at_ms from delivery_policy where scope_id=?',
  ).get(scopeId) as
    | {
        mode: DeliveryMode;
        generation: number;
        enabled_at_ms: number | null;
        disabled_at_ms: number | null;
      }
    | undefined;
  return row === undefined
    ? null
    : {
        mode: row.mode,
        generation: row.generation,
        enabledAtMs: row.enabled_at_ms,
        disabledAtMs: row.disabled_at_ms,
      };
}

/**
 * Record the mode a scope is starting in and settle the intents the transition implies.
 *
 * - Entering `none` suppresses every undelivered intent with an auditable terminal reason. They
 *   are not deleted and not faked as sent; the alert ledger keeps the authoritative revisions.
 * - Entering `local` from `none` promotes only the withdrawals owed to identities that were
 *   actually sent live: ordinary silent-period opportunities stay suppressed and are never
 *   replayed. A normal restart under an already-`local` policy promotes nothing and only the
 *   still-valid pending rows are retried.
 */
export function setDeliveryMode(
  db: Database.Database,
  scopeId: string,
  mode: DeliveryMode,
  nowMs: number,
): {
  policy: DeliveryPolicy;
  transitioned: boolean;
  suppressed: number;
  promoted: number;
} {
  return db.transaction(() => {
    const current = readDeliveryPolicy(db, scopeId);
    if (current?.mode === mode)
      return { policy: current, transitioned: false, suppressed: 0, promoted: 0 };
    if (mode === 'none') {
      const policy: DeliveryPolicy = {
        mode,
        generation: current?.generation ?? 0,
        enabledAtMs: current?.enabledAtMs ?? null,
        disabledAtMs: nowMs,
      };
      statement(
        db,
        `insert into delivery_policy(scope_id,mode,generation,enabled_at_ms,disabled_at_ms)
         values(?,?,?,?,?)
         on conflict(scope_id) do update set mode=excluded.mode,generation=excluded.generation,
           enabled_at_ms=excluded.enabled_at_ms,disabled_at_ms=excluded.disabled_at_ms`,
      ).run(scopeId, policy.mode, policy.generation, policy.enabledAtMs, policy.disabledAtMs);
      const suppressed = statement(
        db,
        `update alert_outbox set status='superseded', last_error='delivery-disabled'
         where scope_id=? and status in ('pending','failed')`,
      ).run(scopeId).changes;
      return { policy, transitioned: true, suppressed, promoted: 0 };
    }
    const policy: DeliveryPolicy = {
      mode,
      generation: (current?.generation ?? 0) + 1,
      enabledAtMs: nowMs,
      disabledAtMs: current?.disabledAtMs ?? null,
    };
    statement(
      db,
      `insert into delivery_policy(scope_id,mode,generation,enabled_at_ms,disabled_at_ms)
       values(?,?,?,?,?)
       on conflict(scope_id) do update set mode=excluded.mode,generation=excluded.generation,
         enabled_at_ms=excluded.enabled_at_ms,disabled_at_ms=excluded.disabled_at_ms`,
    ).run(scopeId, policy.mode, policy.generation, policy.enabledAtMs, policy.disabledAtMs);
    const promoted = statement(
      db,
      `update alert_outbox set status='pending', last_error=null
       where sequence in (
         select o.sequence from alert_outbox o
         join alerts a on a.scope_id=o.scope_id and a.id=o.alert_id
         where o.scope_id=?
           and o.capture_mode='live'
           and o.status='superseded'
           and o.last_error='delivery-disabled'
           and a.active=0
           and a.revision=o.revision
           and json_extract(o.payload_json,'$.kind')='retracted'
           and o.revision=(
             select max(x.revision) from alert_outbox x
             where x.scope_id=o.scope_id and x.alert_id=o.alert_id
           )
           and o.revision>coalesce((
             select max(s.revision) from alert_outbox s
             where s.scope_id=o.scope_id and s.alert_id=o.alert_id and s.status='sent'
           ),0)
       )`,
    ).run(scopeId).changes;
    return { policy, transitioned: true, suppressed: 0, promoted };
  })();
}
