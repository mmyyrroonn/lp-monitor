import type Database from 'better-sqlite3';

/**
 * A cache whose in-memory position must be forgotten if the transaction that advanced it fails.
 *
 * The registry cache is the one such cache today: it follows committed journal rows, but a
 * `prepare()` taken inside an open transaction can consume rows that transaction still has to
 * commit. SQL rollback does not roll an in-memory index back, so the boundary owns that part.
 */
export interface RollbackInvalidatable {
  invalidate(): void;
}

type BoundaryState = {
  /** How many `beginCommitBoundary` calls are open around the same transaction. */
  depth: number;
  /** Set when any level of the boundary rolled back; the outermost level decides on it. */
  failed: boolean;
  caches: Set<RollbackInvalidatable>;
  afterCommit: (() => void)[];
  onRollback: (() => void)[];
};

const boundaries = new WeakMap<Database.Database, BoundaryState>();

/** The handle a transaction body uses to settle effects at the outer boundary. */
export interface CommitBoundary {
  /** Whether this call opened the outermost boundary, rather than joining an open one. */
  readonly outermost: boolean;
  /** Run only if the outermost transaction commits durably. */
  afterCommit(effect: () => void): void;
  /** Run only if the outermost transaction rolls back; the counterpart of `afterCommit`. */
  onRollback(effect: () => void): void;
}

/**
 * Open one level of a commit boundary around a transaction.
 *
 * Nested calls share the outer boundary: an inner body settles nothing on its own, and its effects
 * run when the transaction that actually owns the connection settles. This is what keeps publish
 * work off an inner savepoint, which is durable only if the outer transaction says so.
 */
export function beginCommitBoundary(db: Database.Database): CommitBoundary {
  let state = boundaries.get(db);
  const outermost = state === undefined;
  if (state) state.depth += 1;
  else {
    state = {
      depth: 1,
      failed: false,
      caches: new Set(),
      afterCommit: [],
      onRollback: [],
    };
    boundaries.set(db, state);
  }
  const open = state;
  return {
    outermost,
    afterCommit: (effect) => open.afterCommit.push(effect),
    onRollback: (effect) => open.onRollback.push(effect),
  };
}

/**
 * Close one level of the boundary.
 *
 * `rollback` at any level marks the whole boundary failed, so a nested body that rolled back and
 * was caught by its caller still invalidates the caches it advanced rather than letting them
 * remember rows that are gone. The outermost level then runs the registered effects: after-commit
 * work on success, rollback work and cache invalidation on failure. Effects are synchronous by
 * contract — the transaction is already settled when they run, so nothing may await RPC or a sink
 * while the connection is held open.
 */
export function endCommitBoundary(db: Database.Database, outcome: 'commit' | 'rollback'): void {
  const state = boundaries.get(db);
  if (!state) return;
  if (outcome === 'rollback') state.failed = true;
  state.depth -= 1;
  if (state.depth > 0) return;
  boundaries.delete(db);
  if (state.failed) {
    for (const cache of state.caches) cache.invalidate();
    for (const effect of state.onRollback) effect();
  } else {
    for (const effect of state.afterCommit) effect();
  }
}

/**
 * Register a cache that a transaction advanced. Only meaningful while a boundary is open; a
 * `prepare()` taken before the transaction read committed rows and has nothing to roll back.
 */
export function registerRollbackInvalidation(
  db: Database.Database,
  cache: RollbackInvalidatable,
): void {
  boundaries.get(db)?.caches.add(cache);
}

/**
 * Run one transaction body under a boundary.
 *
 * The body owns the SQL transaction; this only brackets it. A body that throws rolls back and
 * invalidates what it advanced. An after-commit effect that throws propagates after the SQL commit
 * already landed — callers must treat that as a post-commit failure, never as a rolled back batch.
 */
export function withCommitBoundary<T>(db: Database.Database, work: () => T): T {
  const boundary = beginCommitBoundary(db);
  let value: T;
  try {
    value = work();
  } catch (error) {
    endCommitBoundary(db, 'rollback');
    throw error;
  }
  // An outermost boundary that found the connection still inside a transaction belongs to a caller
  // who wrapped this work in a transaction of their own without sharing a boundary: we cannot
  // observe when that transaction settles, so nothing is published as durable. Treating it as a
  // rollback merely disarms and invalidates; the caller's own commit is reflected by the next
  // `prepare`/`select`, which reads the committed rows back.
  endCommitBoundary(db, boundary.outermost && db.inTransaction ? 'rollback' : 'commit');
  return value;
}
