import type Database from 'better-sqlite3';
import {
  AlertOutbox,
  ORDINARY_DELIVERY_MAX_AGE_MS,
  type AlertSink,
  type DeliverySummary,
} from './outbox.js';
import { readDeliveryPolicy } from './delivery-policy.js';

export interface DispatcherStats extends DeliverySummary {
  status: 'ok' | 'degraded' | 'disabled';
  lastDeliveredAtMs: number | null;
}

export interface AlertDispatcherOptions {
  db: Database.Database;
  outbox: AlertOutbox;
  sink: AlertSink;
  scopeId: string;
  /** Rows claimed per pass; a backlog drains over several passes instead of one array. */
  limit?: number;
  ordinaryMaxAgeMs?: number;
  now?: () => number;
  /** Called after every pass that claimed anything, for run health and the delivery audit line. */
  onPass?: (summary: DeliverySummary) => void;
}

const EMPTY: DeliverySummary = { sent: 0, failed: 0 };
type RequestKind = 'none' | 'retracted' | 'all';

/**
 * The single owner of local delivery, decoupled from acquisition.
 *
 * Acquisition commits an intent and then asks the dispatcher to wake; it never awaits a sink. The
 * dispatcher serializes every drain, claims bounded pages, and settles its own failures, so a slow
 * or failing console/JSONL sink degrades delivery health without failing the batch that produced
 * the intent. Shutdown stops accepting new work, lets the one in-flight drain finish, and only
 * then lets the caller close the database. A sink that cannot be cancelled is waited for, not
 * raced: this class makes no bounded-exit claim a blocking `write` cannot honor.
 */
export class AlertDispatcher {
  readonly #db: Database.Database;
  readonly #outbox: AlertOutbox;
  readonly #sink: AlertSink;
  readonly #scopeId: string;
  readonly #limit: number;
  readonly #ordinaryMaxAgeMs: number;
  readonly #now: () => number;
  readonly #onPass: ((summary: DeliverySummary) => void) | undefined;
  #queue: Promise<void> = Promise.resolve();
  #requested: RequestKind = 'none';
  #stopping = false;
  #lastAttemptAtMs: number | null = null;
  #stats: DispatcherStats = { sent: 0, failed: 0, status: 'ok', lastDeliveredAtMs: null };

  constructor(options: AlertDispatcherOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#sink = options.sink;
    this.#scopeId = options.scopeId;
    this.#limit = options.limit ?? 50;
    this.#ordinaryMaxAgeMs = options.ordinaryMaxAgeMs ?? ORDINARY_DELIVERY_MAX_AGE_MS;
    this.#now = options.now ?? Date.now;
    this.#onPass = options.onPass;
  }

  get stats(): DispatcherStats {
    return { ...this.#stats };
  }

  get pendingCount(): number {
    return this.#outbox.pendingCount(this.#scopeId);
  }

  /**
   * Ask for a drain; returns immediately. Wakeups coalesce while one is already queued.
   *
   * A catch-up batch asks for withdrawals only, so an ordinary backlog cannot be announced before
   * the run has reached the head that makes it current.
   */
  wake(options: { retractionsOnly?: boolean } = {}): void {
    if (this.#stopping) return;
    if (!options.retractionsOnly) this.#requested = 'all';
    else if (this.#requested === 'none') this.#requested = 'retracted';
    this.#schedule(() => this.#pump());
  }

  /**
   * The idle retry schedule. Independent of new blocks and of commits, so a failed sink is retried
   * on the poll cadence without a busy loop; a commit wakeup ignores the interval.
   */
  retryDue(intervalMs: number): void {
    const now = this.#now();
    if (this.#lastAttemptAtMs !== null && now - this.#lastAttemptAtMs < intervalMs) return;
    this.wake();
  }

  /**
   * Drain synchronously for the callers that need withdrawals settled before they continue
   * (startup, recovery). Mid-loop callers use `wake`.
   */
  async drainNow(retractionsOnly = false): Promise<DeliverySummary> {
    let summary: DeliverySummary = EMPTY;
    await this.#schedule(async () => {
      this.#requested = 'none';
      summary = await this.#drainPages(retractionsOnly);
    }).catch(() => undefined);
    return summary;
  }

  /** Wait for the drains already queued to finish without stopping the dispatcher. */
  async settle(): Promise<void> {
    await this.#queue;
  }

  /**
   * Stop accepting work, optionally drain what remains, and wait for the in-flight pass.
   *
   * The wait is what keeps a claimed row's ACK from touching a database the caller closed: a sink
   * already inside `await` cannot be cancelled, so it is allowed to finish first.
   */
  async stop(options: { drain?: boolean } = {}): Promise<void> {
    if (options.drain !== false) await this.drainNow();
    this.#stopping = true;
    await this.#queue;
  }

  /** Drain pages until a pass claimed nothing, sent nothing, or came back short. */
  async #drainPages(retractionsOnly: boolean): Promise<DeliverySummary> {
    const total: DeliverySummary = { sent: 0, failed: 0 };
    for (;;) {
      if (this.#stopping) return total;
      const summary = await this.#pumpOnce(retractionsOnly);
      total.sent += summary.sent;
      total.failed += summary.failed;
      const claimed = summary.sent + summary.failed;
      // No progress ends the pass: a failing sink must not be re-claimed in a tight loop, and a
      // short page means there was nothing more to claim.
      if (summary.sent === 0 || claimed < this.#limit) return total;
    }
  }

  /** One wakeup drains pages until short, or until a newer wakeup asks for another round. */
  async #pump(): Promise<void> {
    let kind: RequestKind = this.#requested;
    this.#requested = 'none';
    for (;;) {
      if (this.#stopping || kind === 'none') return;
      const summary = await this.#pumpOnce(kind === 'retracted');
      if (kind === 'retracted') return;
      // No progress ends the pump: a failing sink must not be re-claimed in a tight loop.
      if (summary.sent === 0) return;
      const claimed = summary.sent + summary.failed;
      if (claimed < this.#limit) {
        kind = this.#requested;
        this.#requested = 'none';
        if (kind === 'none') return;
      }
    }
  }

  /**
   * One bounded claim pass. A `none` policy has no deliverable rows, but the guard is repeated
   * here so a mode flipped by another run cannot be delivered through a stale dispatcher.
   */
  async #pumpOnce(retractionsOnly: boolean): Promise<DeliverySummary> {
    if (this.#stopping) return EMPTY;
    if (readDeliveryPolicy(this.#db, this.#scopeId)?.mode === 'none') return EMPTY;
    this.#lastAttemptAtMs = this.#now();
    const summary = await this.#outbox.deliverPending(
      this.#sink,
      this.#scopeId,
      retractionsOnly ? 'retracted' : undefined,
      { limit: this.#limit, maxAgeMs: this.#ordinaryMaxAgeMs, nowMs: this.#now() },
    );
    this.#stats.sent += summary.sent;
    this.#stats.failed += summary.failed;
    if (summary.sent > 0) {
      this.#stats.status = 'ok';
      this.#stats.lastDeliveredAtMs = this.#now();
    } else if (summary.failed > 0) this.#stats.status = 'degraded';
    if (summary.sent + summary.failed > 0) this.#onPass?.(summary);
    return summary;
  }

  /** Serialize every drain behind one queue; a failed pass never rejects the queue. */
  #schedule(work: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
