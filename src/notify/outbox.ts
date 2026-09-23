import type Database from 'better-sqlite3';
import type { AlertRecord } from '../signals/types.js';
import { decodeSignalState, encodeSignalState } from '../signals/codec.js';
import { readDeliveryPolicy } from './delivery-policy.js';

export type CaptureMode = 'live' | 'backfill' | 'synthetic';
export type AlertSink = (alert: AlertRecord) => void | Promise<void>;
export type DeliverySummary = { sent: number; failed: number };
/** Ordinary opportunities that waited this long are expired instead of announced late. */
export const ORDINARY_DELIVERY_MAX_AGE_MS = 15 * 60_000;
const draining = new WeakSet<Database.Database>();

export interface DeliverOptions {
  /** Claim at most this many rows in one pass, so a backlog is not copied into memory at once. */
  limit?: number;
  /** Ordinary (non-withdrawal) alerts older than this are expired rather than delivered. */
  maxAgeMs?: number;
  nowMs?: number;
}

export class AlertOutbox {
  private readonly statements = new Map<string, Database.Statement>();
  constructor(private readonly db: Database.Database) {}
  private prepare(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  /**
   * Record one revision of an alert as an intent to deliver it, under the scope's policy.
   *
   * Saving the authoritative record and deciding whether it may be delivered are two decisions: a
   * `none` scope still writes the ledger row and still supersedes older intents, but the row lands
   * terminal with `delivery-disabled` so nothing accumulates as deliverable. Outside any policy row
   * the historical `local` behaviour is kept.
   */
  enqueue(scopeId: string, alert: AlertRecord, mode: CaptureMode): void {
    const policy = readDeliveryPolicy(this.db, scopeId);
    // A silent scope lands the row terminal with an auditable reason: the ledger still records the
    // revision and older intents still lose eligibility, but nothing accumulates as deliverable.
    // A non-live row stays pending under local policy exactly as it always did; the delivery scan
    // filters it out by capture mode.
    const silent = policy?.mode === 'none';
    this.db.transaction(() => {
      this.prepare(
        `insert into alert_outbox
      (scope_id,alert_id,revision,capture_mode,status,last_error,payload_json)
      values(?,?,?,?,?,?,?) on conflict(scope_id,alert_id,revision) do nothing`,
      ).run(
        scopeId,
        alert.id,
        alert.revision,
        mode,
        silent ? 'superseded' : 'pending',
        silent ? 'delivery-disabled' : null,
        encodeSignalState(alert),
      );
      this.prepare(
        `update alert_outbox set status='superseded',last_error='newer-revision'
      where scope_id=? and alert_id=? and capture_mode=? and status in ('pending','failed') and revision <
      (select max(revision) from alert_outbox where scope_id=? and alert_id=? and capture_mode=?)`,
      ).run(scopeId, alert.id, mode, scopeId, alert.id, mode);
    })();
  }
  /** How many rows would be claimed by a pass right now, without claiming any. */
  pendingCount(scopeId: string): number {
    return Number(
      this.prepare(
        `select count(*) from alert_outbox o
         left join delivery_policy p on p.scope_id=o.scope_id
         where o.capture_mode='live' and o.status in ('pending','failed')
           and o.scope_id=? and (p.mode is null or p.mode='local')`,
      )
        .pluck()
        .get(scopeId),
    );
  }
  async deliverPending(
    sink: AlertSink,
    scopeId?: string,
    kind?: 'retracted',
    options: DeliverOptions = {},
  ): Promise<DeliverySummary> {
    if (this.db.inTransaction) throw new Error('Cannot deliver inside a transaction');
    if (draining.has(this.db)) throw new Error('Outbox already has an active delivery');
    const maxAgeMs = options.maxAgeMs ?? ORDINARY_DELIVERY_MAX_AGE_MS;
    const nowMs = options.nowMs ?? Date.now();
    draining.add(this.db);
    const summary = { sent: 0, failed: 0 };
    try {
      const rows = this.prepare(
        `select o.sequence,o.scope_id,o.alert_id,o.revision,o.payload_json from alert_outbox o
        left join delivery_policy p on p.scope_id=o.scope_id
        where o.capture_mode='live' and o.status in ('pending','failed')
        and (p.mode is null or p.mode='local')
        ${scopeId === undefined ? '' : 'and o.scope_id=?'}
        ${kind === undefined ? '' : "and json_extract(o.payload_json,'$.kind')=?"} order by o.sequence
        ${options.limit === undefined ? '' : 'limit ?'}`,
      ).all(
        ...(scopeId === undefined ? [] : [scopeId]),
        ...(kind === undefined ? [] : [kind]),
        ...(options.limit === undefined ? [] : [options.limit]),
      ) as {
        sequence: number;
        scope_id: string;
        alert_id: string;
        revision: number;
        payload_json: string;
      }[];
      const blocked = new Set<string>();
      const terminal = this.prepare(
        `update alert_outbox set status='superseded',last_error=?
         where sequence=? and status in ('pending','failed')`,
      );
      for (const row of rows) {
        const key = JSON.stringify([row.scope_id, row.alert_id]);
        if (blocked.has(key)) continue;
        const current = this.prepare('select status from alert_outbox where sequence=?').get(
          row.sequence,
        ) as { status: string } | undefined;
        if (current?.status !== 'pending' && current?.status !== 'failed') continue;
        const ineligible = this.eligibility(row, nowMs, maxAgeMs);
        if (ineligible !== null) {
          terminal.run(ineligible, row.sequence);
          continue;
        }
        this.prepare('update alert_outbox set attempts=attempts+1 where sequence=?').run(
          row.sequence,
        );
        try {
          await sink(decodeSignalState<AlertRecord>(row.payload_json));
          this.prepare(
            "update alert_outbox set status='sent',last_error=null where sequence=? and status in ('pending','failed')",
          ).run(row.sequence);
          summary.sent++;
        } catch {
          // Arbitrary sink exception text may contain local paths or credentials.
          this.prepare(
            "update alert_outbox set status='failed',last_error='local-delivery-failed' where sequence=? and status in ('pending','failed')",
          ).run(row.sequence);
          summary.failed++;
          // Do not let a retraction overtake a failed earlier revision.
          blocked.add(key);
        }
      }
      return summary;
    } finally {
      draining.delete(this.db);
    }
  }
  /**
   * Whether the authoritative ledger still allows this row to be delivered.
   *
   * A row whose alert moved on is not announced — the newer revision already supersedes it. An
   * ordinary opportunity waits only so long: data age is re-checked at claim time, not at enqueue
   * time, so a backlog that survived a restart cannot surface old chances. A withdrawal uses its
   * own rule — it stays deliverable as long as it is the identity's current revision — because
   * announcing `retracted` late is the correction the identity is owed, while a late opportunity
   * is simply a bad trade.
   *
   * Rows written through the bare outbox (no ledger row) keep the historical behaviour; in
   * production `saveRecord` writes the ledger row in the same transaction as the intent.
   */
  private eligibility(
    row: { scope_id: string; alert_id: string; revision: number; payload_json: string },
    nowMs: number,
    maxAgeMs: number,
  ): string | null {
    const authority = this.prepare(
      'select revision,active,capture_mode from alerts where scope_id=? and id=?',
    ).get(row.scope_id, row.alert_id) as
      { revision: number; active: number; capture_mode: CaptureMode } | undefined;
    if (authority === undefined) return null;
    if (authority.capture_mode !== 'live') return 'not-live';
    if (authority.revision !== row.revision) return 'stale-revision';
    const alert = decodeSignalState<AlertRecord>(row.payload_json);
    if (alert.kind === 'retracted') return authority.active === 0 ? null : 'not-retracted';
    if (authority.active === 0) return 'inactive';
    const observedAtMs = Number(alert.observedAtMs);
    if (Number.isSafeInteger(observedAtMs) && nowMs - observedAtMs > maxAgeMs) return 'expired';
    return null;
  }
}
