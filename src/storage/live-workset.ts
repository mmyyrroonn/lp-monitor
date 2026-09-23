import type Database from 'better-sqlite3';
import { countWork } from '../ops/work-counters.js';
import { decodeSignalState } from '../signals/codec.js';
import { initialSignalSnapshot } from '../signals/engine.js';
import type { SignalSnapshot } from '../signals/types.js';
import type { EventWindowBounds, LiveEventIndexStore } from './live-event-index.js';

export type WorksetInput = {
  changedPoolIds: ReadonlySet<string>;
  dependencyPoolIds: ReadonlySet<string>;
  watermarkSec: number;
  coverageChanged: boolean;
  /** The window this round reads. Advancing it is part of selecting, never a separate step. */
  bounds: EventWindowBounds;
};

export interface LiveWorkset {
  select(input: WorksetInput): ReadonlySet<string>;
  /** The watermark this round selected against, claimed only once the round is durable. */
  arm(watermarkSec: number | null): void;
  commit(): void;
}

/**
 * The signal fields that are memory: the state machine's own state, and everything it reads back to
 * keep it. This list is the whole of the test below — a field that is not here cannot hold a pool
 * in the workset.
 *
 * Two fields of `SignalSnapshot` are deliberately absent. `configVersion` is a stamp
 * `evaluateSignal` writes on every snapshot it touches, and `lastFiveEndSec` is the 5m watermark it
 * advances on every round that closes a bucket; both are written by the act of evaluating rather
 * than by a decision, so counting either one would keep every pool ever evaluated in the workset
 * for good — the catalogue this table exists to bound. The row keeps both, so a pool that is
 * selected again reads its watermark back exactly as it left it.
 */
const MEMORY_FIELDS = [
  'state',
  'episodeId',
  'lastAlertSec',
  'lastAlertVolume',
  'lastAlertScale',
  'lastAlertKind',
  'lowBuckets',
  'entryThreshold',
  'candidateMinuteStartSec',
  'candidateFingerprint',
  'lastHeatSec',
] as const;

/**
 * Whether a stored signal still carries something the initial snapshot does not.
 *
 * This is the only test that may retire a pool from the workset, and it is a whitelist: a snapshot
 * that differs from `initialSignalSnapshot()` in any field the state machine reads back — a live
 * state, an episode, an alert, a cooldown, a candidate fingerprint, a heat mark, an entry threshold
 * — keeps its pool in the workset. Inventing a shorter memory than the one the state machine
 * actually keeps would drop a pool mid-cooldown, so a field added to `SignalSnapshot` belongs in
 * `MEMORY_FIELDS` the moment the state machine starts reading it back.
 */
export function snapshotHasMemory(snapshot: SignalSnapshot): boolean {
  const initial = initialSignalSnapshot() as unknown as Record<string, unknown>;
  const stored = snapshot as unknown as Record<string, unknown>;
  for (const key of MEMORY_FIELDS)
    if ((stored[key] ?? null) !== (initial[key] ?? null)) return true;
  return false;
}

/**
 * The pools one live round has to evaluate.
 *
 * The workset is what keeps live cost proportional to activity rather than to the catalogue: it is
 * the pools with windowed events, the pools that just lost their last one, the pools this round
 * revised or that a valuation dependency moved, and — whenever the chain advanced or coverage
 * moved under a standing watermark — every pool with signal memory. A catalogue of eighty thousand
 * registrations contributes to none of those unless it is actually active.
 *
 * `select` is a once-per-round operation, and the watermark it answers for becomes the standing one
 * only when the caller says the round committed — that standing watermark is what decides whether
 * the memory-bearing pools have to be reconsidered at all. See `commit`.
 */
export class LiveWorksetStore implements LiveWorkset {
  #lastWatermarkSec: number | null = null;
  #armedWatermarkSec: number | null = null;
  #generation = -1;

  constructor(
    private readonly db: Database.Database,
    private readonly scopeId: string,
    private readonly events: LiveEventIndexStore,
  ) {}

  /**
   * Answer for one round. Pools with signal memory are reconsidered when the chain advanced, when
   * coverage moved under a standing watermark, and on the first round of a process — a restart has
   * to restore cooling and candidate state from the snapshots it finds.
   *
   * Advancing the window is the first thing a round does, so it is the first thing this does: a
   * caller cannot select against one window and evaluate against another. Nothing here is durable
   * except through the event index's own expiration, which rolls back with the caller's
   * transaction; the round's watermark moves only when the caller calls `commit`.
   */
  select(input: WorksetInput): ReadonlySet<string> {
    const expired = this.events.expire(input.bounds);
    // A window that had to be derived again is a window the previous round did not have, and no
    // standing watermark may be assumed to have been evaluated against it.
    if (this.events.generation !== this.#generation) {
      this.#generation = this.events.generation;
      this.#lastWatermarkSec = null;
    }
    const selected = new Set<string>(this.events.pools());
    for (const poolId of expired) selected.add(poolId);
    for (const poolId of input.changedPoolIds) selected.add(poolId);
    for (const poolId of input.dependencyPoolIds) selected.add(poolId);
    const standing =
      this.#lastWatermarkSec !== null && input.watermarkSec === this.#lastWatermarkSec;
    if (!standing || input.coverageChanged)
      for (const poolId of this.members()) selected.add(poolId);
    countWork('evaluatedWorksetPools', selected.size);
    return selected;
  }

  /**
   * Say what this round selected against, without claiming the round happened.
   *
   * `null` says the round selected nothing, which is how a round that turned out not to need a
   * selection clears whatever an earlier one left armed.
   */
  arm(watermarkSec: number | null): void {
    this.#armedWatermarkSec = watermarkSec;
  }

  /**
   * The watermark the last durable round selected against, or null before one has committed.
   *
   * Exposed for diagnostics and tests: it is the whole difference between reconsidering every pool
   * with signal memory and reconsidering only what moved.
   */
  get standingWatermarkSec(): number | null {
    return this.#lastWatermarkSec;
  }

  /** The watermark a round has armed but not yet made durable; null when nothing is pending. */
  get armedWatermarkSec(): number | null {
    return this.#armedWatermarkSec;
  }

  /**
   * Forget an armed watermark whose transaction failed.
   *
   * `arm` says what a round selected against; only a durable round may turn that into the standing
   * watermark. A boundary that rolls back calls this so the retry of the same batch sees exactly
   * the state the failed attempt saw, rather than answering for a round that never committed.
   */
  disarm(): void {
    this.#armedWatermarkSec = null;
  }

  /**
   * The round that armed this watermark is durable; it is the standing one from here.
   *
   * This is deliberately neither something `select` nor `arm` does on its own. The standing
   * watermark decides whether the pools with signal memory are reconsidered, so it may only move
   * once the outermost transaction of the round has committed. A round that rolled back evaluated
   * nothing, and a retry of the same batch has to see exactly the state the first attempt saw:
   * without this, the failed attempt would have skipped the cooling and candidate pools on the
   * retry — the one round they were owed — and the retry would not be equivalent to the run that
   * never failed.
   */
  commit(): void {
    if (this.#armedWatermarkSec === null) return;
    this.#lastWatermarkSec = this.#armedWatermarkSec;
    this.#armedWatermarkSec = null;
  }

  /** The pools with signal memory, as the durable table currently holds them. */
  members(): ReadonlySet<string> {
    const rows = this.db
      .prepare('select pool_id from live_signal_workset where scope_id=?')
      .all(this.scopeId) as { pool_id: string }[];
    return new Set(rows.map((row) => row.pool_id));
  }

  /**
   * Make the durable member set exactly this, inside the caller's transaction. A pool leaves only
   * when the caller has established that its snapshot is back to the initial state and it has no
   * window input and nothing was revised — never because a round simply did not reach it.
   */
  retain(poolIds: Iterable<string>): void {
    const next = new Set(poolIds);
    const present = this.members();
    const insert = this.db.prepare(
      'insert into live_signal_workset(scope_id,pool_id) values(?,?) on conflict do nothing',
    );
    const remove = this.db.prepare(
      'delete from live_signal_workset where scope_id=? and pool_id=?',
    );
    for (const poolId of next) if (!present.has(poolId)) insert.run(this.scopeId, poolId);
    for (const poolId of present) if (!next.has(poolId)) remove.run(this.scopeId, poolId);
  }

  /** Whether this scope's workset was ever filled from the snapshots it already had. */
  seeded(): boolean {
    return Boolean(
      this.db.prepare('select 1 from live_workset_state where scope_id=?').get(this.scopeId),
    );
  }

  /**
   * The one-time initialization of a database that recorded signals before this table existed.
   * It scans `signal_snapshots` exactly once and remembers that it did, so a legitimately empty
   * workset is not scanned again on every open.
   */
  seed(nowMs: number): number {
    if (this.seeded()) return 0;
    const rows = this.db
      .prepare('select pool_id,payload_json from signal_snapshots where scope_id=?')
      .all(this.scopeId) as { pool_id: string; payload_json: string }[];
    const remembered = rows.filter((row) =>
      snapshotHasMemory(decodeSignalState<SignalSnapshot>(row.payload_json)),
    );
    const insert = this.db.prepare(
      'insert into live_signal_workset(scope_id,pool_id) values(?,?) on conflict do nothing',
    );
    for (const row of remembered) insert.run(this.scopeId, row.pool_id);
    this.db
      .prepare('insert into live_workset_state(scope_id,seeded_at_ms) values(?,?)')
      .run(this.scopeId, nowMs);
    return remembered.length;
  }
}

const sharedWorksets = new WeakMap<Database.Database, Map<string, LiveWorksetStore>>();

/** The workset one scope of one database is evaluated through, shared like the event index. */
export function liveWorksetFor(
  db: Database.Database,
  scopeId: string,
  events: LiveEventIndexStore,
): LiveWorksetStore {
  let byScope = sharedWorksets.get(db);
  if (!byScope) {
    byScope = new Map();
    sharedWorksets.set(db, byScope);
  }
  let workset = byScope.get(scopeId);
  if (!workset) {
    workset = new LiveWorksetStore(db, scopeId, events);
    byScope.set(scopeId, workset);
  }
  return workset;
}
