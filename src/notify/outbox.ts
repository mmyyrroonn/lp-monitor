import type Database from 'better-sqlite3';
import type { AlertRecord } from '../signals/types.js';
import { decodeSignalState, encodeSignalState } from '../signals/codec.js';

export type CaptureMode = 'live' | 'backfill' | 'synthetic';
export type AlertSink = (alert: AlertRecord) => void | Promise<void>;
export type DeliverySummary = { sent: number; failed: number };
const draining = new WeakSet<Database.Database>();
export class AlertOutbox {
  constructor(private readonly db: Database.Database) {}
  enqueue(scopeId: string, alert: AlertRecord, mode: CaptureMode): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `insert into alert_outbox
      (scope_id,alert_id,revision,capture_mode,status,payload_json)
      values(?,?,?,?,'pending',?) on conflict(scope_id,alert_id,revision) do nothing`,
        )
        .run(scopeId, alert.id, alert.revision, mode, encodeSignalState(alert));
      this.db
        .prepare(
          `update alert_outbox set status='superseded',last_error='newer-revision'
      where scope_id=? and alert_id=? and status in ('pending','failed') and revision <
      (select max(revision) from alert_outbox where scope_id=? and alert_id=?)`,
        )
        .run(scopeId, alert.id, scopeId, alert.id);
    })();
  }
  async deliverPending(
    sink: AlertSink,
    scopeId?: string,
    kind?: 'retracted',
  ): Promise<DeliverySummary> {
    if (this.db.inTransaction) throw new Error('Cannot deliver inside a transaction');
    if (draining.has(this.db)) throw new Error('Outbox already has an active delivery');
    draining.add(this.db);
    const summary = { sent: 0, failed: 0 };
    try {
      const rows = this.db
        .prepare(
          `select sequence,payload_json from alert_outbox
        where capture_mode='live' and status in ('pending','failed')
        ${scopeId === undefined ? '' : 'and scope_id=?'}
        ${kind === undefined ? '' : "and json_extract(payload_json,'$.kind')=?"} order by sequence`,
        )
        .all(
          ...(scopeId === undefined ? [] : [scopeId]),
          ...(kind === undefined ? [] : [kind]),
        ) as {
        sequence: number;
        payload_json: string;
      }[];
      for (const row of rows) {
        const current = this.db
          .prepare('select status from alert_outbox where sequence=?')
          .get(row.sequence) as { status: string } | undefined;
        if (current?.status !== 'pending' && current?.status !== 'failed') continue;
        this.db
          .prepare('update alert_outbox set attempts=attempts+1 where sequence=?')
          .run(row.sequence);
        try {
          await sink(decodeSignalState<AlertRecord>(row.payload_json));
          this.db
            .prepare(
              "update alert_outbox set status='sent',last_error=null where sequence=? and status in ('pending','failed')",
            )
            .run(row.sequence);
          summary.sent++;
        } catch {
          // Arbitrary sink exception text may contain local paths or credentials.
          this.db
            .prepare(
              "update alert_outbox set status='failed',last_error='local-delivery-failed' where sequence=? and status in ('pending','failed')",
            )
            .run(row.sequence);
          summary.failed++;
          // Do not let a retraction overtake a failed earlier revision.
          break;
        }
      }
      return summary;
    } finally {
      draining.delete(this.db);
    }
  }
}
