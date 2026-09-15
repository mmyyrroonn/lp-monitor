import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Address } from 'viem';

/**
 * The token-metadata demand queue, and the metadata revision readers follow instead of hashing.
 *
 * The queue answers "which addresses still need a decimals observation in this scope". A row
 * exists only while its demand is unresolved, so a `resolve` that covers the demanded height
 * deletes it: the presence of a row *is* the demand, and a satisfied row left behind would have to
 * be filtered out again by every later round.
 *
 * Every method here runs inside the caller's transaction and never opens one of its own. A lease
 * is taken in a short transaction at a safe point of the ingest loop, and the result is applied
 * inside the accepted batch's transaction; a nested transaction would either commit half of that
 * batch or leave a lease the recovering process can no longer see. For the same reason `settle`
 * reads the leased row and then writes it as two statements: they are one atomic unit only because
 * the caller's transaction makes them so.
 *
 * A lease is a promise that only its holder may settle. `lease` stamps a fresh `leaseId` every
 * time, and `settle` refuses an id that is not the row's current one, so a crashed holder that
 * comes back late cannot overwrite the answer of the lease that replaced it.
 */

/** How long one lease is held before its row becomes leasable again. */
export const METADATA_LEASE_MS = 30_000;

/** How many revisions of address changes the journal retains; older positions cannot be answered. */
export const METADATA_REVISION_JOURNAL_LIMIT = 256;

/**
 * The address a change that SQL cannot name is journaled under. Dropping an invalid anchor makes
 * the *seed file's* entries at that height usable again, and the seed file is not a table, so the
 * addresses it affects are unknown to the trigger. A reader that sees this marker has to rebuild
 * everything it derived from metadata rather than trust a list of addresses.
 */
const UNNAMED_CHANGE = '*';

/** One address that still needs a decimals observation, and the height that observation is for. */
export type MetadataDemand = { address: Address; blockNumber: bigint; priority: 0 | 1 | 2 };

/** One demand handed to a worker for a bounded time, identified by the lease it was handed under. */
export type MetadataLease = {
  scopeId: string;
  leaseId: string;
  owner: string;
  expiresAtMs: number;
  demand: MetadataDemand;
};

/** What a worker learned while holding a lease. */
export type MetadataSettle =
  /** The height the result was actually read at; decimals carry forward from there. */
  | { kind: 'resolved'; anchorBlock: bigint }
  | { kind: 'failed'; retryAtMs: number }
  /** The scope or the branch moved: throw this lease away and ask again when it is leasable. */
  | { kind: 'requeue' };

export interface MetadataQueue {
  enqueue(scopeId: string, demands: readonly MetadataDemand[], nowMs: number): void;
  lease(scopeId: string, nowMs: number, owner: string): MetadataLease | null;
  /**
   * Whether this address's demand is still held under this lease id.
   *
   * The gate a late result passes before it may write anything: a lease that expired, was re-leased
   * by another holder or was re-queued carries a different id, and a result that no longer matches
   * the row describes a holder that lost its turn. Asked before the write rather than after it,
   * because `settle` refusing the result does not unwrite the observation it already stored.
   */
  holdsLease(scopeId: string, address: string, leaseId: string): boolean;
  /**
   * How many demands the scope holds at priority 0 — the valuations a live round is still missing.
   *
   * The queue's other three counts are about a lookahead's state; this one is about urgency, and it
   * is the count a run reporting "metadata is still missing" has to answer with rather than the
   * number of addresses that have ever failed.
   */
  activeMissing(scopeId: string): number;
  stats(
    scopeId: string,
    nowMs: number,
  ): { eligible: number; retryWaiting: number; inflight: number };
  settle(
    scopeId: string,
    leaseId: string,
    nowMs: number,
    outcome: MetadataSettle,
  ): MetadataDemand | null;
}

type DemandRow = { address: string; needed_block: number; priority: number };

class DemandQueue implements MetadataQueue {
  constructor(private readonly database: Database.Database) {}

  enqueue(scopeId: string, demands: readonly MetadataDemand[], nowMs: number): void {
    const failed = this.database.prepare(
      'select next_retry_ms from token_metadata_failures where address = ?',
    );
    // An address is one demand per scope, whatever case the caller holds it in. The conflict
    // branch merges into the earliest unresolved demand and touches nothing else: a repeated
    // enqueue must not clear a backoff the failure path just set, nor wake a lease a worker is
    // still holding. `min` on the priority keeps 0 (the most urgent) once it has been asked for.
    const upsert = this.database.prepare(
      `insert into metadata_demand(scope_id,address,needed_block,priority,next_retry_ms,updated_at_ms)
       values(?,?,?,?,?,?)
       on conflict(scope_id,address) do update set
         needed_block = min(metadata_demand.needed_block, excluded.needed_block),
         priority = min(metadata_demand.priority, excluded.priority),
         updated_at_ms = excluded.updated_at_ms`,
    );
    for (const demand of demands) {
      const address = demand.address.toLowerCase();
      // The failures table is a backoff input, never a queue: only the addresses a caller really
      // demands are inserted, and each one is asked for on demand. Copying it wholesale would fill
      // the queue with every address that ever failed, which is not this scope's work.
      const previous = failed.get(address) as { next_retry_ms: number } | undefined;
      upsert.run(
        scopeId,
        address,
        Number(demand.blockNumber),
        demand.priority,
        previous?.next_retry_ms ?? nowMs,
        nowMs,
      );
    }
  }

  lease(scopeId: string, nowMs: number, owner: string): MetadataLease | null {
    const leaseId = randomUUID();
    const expiresAtMs = nowMs + METADATA_LEASE_MS;
    // The row is picked and stamped in one statement, so two processes leasing at the same instant
    // cannot both walk away with the same demand: the subquery and the update it feeds are one
    // write, and the row is already leased by the time the other process reads it.
    //
    // The order is `(scope_id, priority, next_retry_ms)` — the queue's index — plus the height and
    // the address to break ties. The deadline has to come before the height: a demand that was
    // never attempted carries the `nowMs` it was enqueued at, and one that just failed carries a
    // deadline pushed at least a minute forward, so the untouched demand is leased first and a
    // handful of failures cannot monopolize a slow worker.
    const row = this.database
      .prepare(
        `update metadata_demand
         set lease_id = ?, lease_owner = ?, lease_until_ms = ?, updated_at_ms = ?
         where rowid = (
           select rowid from metadata_demand
           where scope_id = ? and next_retry_ms <= ?
             and (lease_until_ms is null or lease_until_ms <= ?)
           order by priority, next_retry_ms, needed_block, address
           limit 1
         )
         returning address, needed_block, priority`,
      )
      .get(leaseId, owner, expiresAtMs, nowMs, scopeId, nowMs, nowMs) as DemandRow | undefined;
    if (row === undefined) return null;
    return { scopeId, leaseId, owner, expiresAtMs, demand: demandOf(row) };
  }

  holdsLease(scopeId: string, address: string, leaseId: string): boolean {
    const row = this.database
      .prepare('select lease_id from metadata_demand where scope_id = ? and address = ?')
      .get(scopeId, address.toLowerCase()) as { lease_id: string | null } | undefined;
    return row?.lease_id === leaseId;
  }

  activeMissing(scopeId: string): number {
    const row = this.database
      .prepare('select count(*) as n from metadata_demand where scope_id = ? and priority = 0')
      .get(scopeId) as { n: number };
    return row.n;
  }

  stats(
    scopeId: string,
    nowMs: number,
  ): { eligible: number; retryWaiting: number; inflight: number } {
    // The three counts partition the scope's rows exactly: a live lease is never eligible and never
    // waiting, whatever its retry deadline says. `coalesce` is what keeps an empty scope at three
    // zeros instead of three NULLs.
    return this.database
      .prepare(
        `select
           coalesce(sum(case when next_retry_ms <= @now
             and (lease_until_ms is null or lease_until_ms <= @now) then 1 else 0 end), 0) as eligible,
           coalesce(sum(case when next_retry_ms > @now
             and (lease_until_ms is null or lease_until_ms <= @now) then 1 else 0 end), 0) as retryWaiting,
           coalesce(sum(case when lease_until_ms > @now then 1 else 0 end), 0) as inflight
         from metadata_demand where scope_id = @scopeId`,
      )
      .get({ scopeId, now: nowMs }) as { eligible: number; retryWaiting: number; inflight: number };
  }

  settle(
    scopeId: string,
    leaseId: string,
    nowMs: number,
    outcome: MetadataSettle,
  ): MetadataDemand | null {
    // Matching on the current lease id is the whole safety of a late result: a lease that expired,
    // was re-queued or was taken over has a different id, so its old holder settles nothing.
    const row = this.database
      .prepare(
        'select address, needed_block, priority from metadata_demand where scope_id = ? and lease_id = ?',
      )
      .get(scopeId, leaseId) as DemandRow | undefined;
    if (row === undefined) return null;
    // Every write below clears the three lease columns, and none of them touches `needed_block` or
    // `priority`: what is left is the demand the next lease has to answer.
    if (outcome.kind === 'resolved') {
      // Decimals carry forward: a reading taken at `anchorBlock` is the last observation at or below
      // every height from there on, so it answers this demand whenever the demanded height is at or
      // above the anchor. A demand *below* the anchor is not answered by it — `decimalsAt` finds no
      // anchor at or below that height — and that is the demand a concurrent earlier observation
      // merges in while this lease is out, so it has to stay queued rather than be deleted by the
      // result for a height it was never read at. Only the covered row goes; an address is never
      // deleted because some result mentioned it.
      if (row.needed_block >= Number(outcome.anchorBlock))
        this.database
          .prepare('delete from metadata_demand where scope_id = ? and address = ?')
          .run(scopeId, row.address);
      // A row that survived is leasable at once: its retry deadline is already in the past, since
      // nothing is leased while it is still waiting.
      else
        this.database
          .prepare(
            `update metadata_demand
             set lease_id = null, lease_owner = null, lease_until_ms = null, updated_at_ms = ?
             where scope_id = ? and address = ?`,
          )
          .run(nowMs, scopeId, row.address);
      return demandOf(row);
    }
    if (outcome.kind === 'failed') {
      // A failed lookup waits out its deadline even at priority 0: retrying at once would spend the
      // request budget the rest of the scope is waiting for. The deadline only ever moves forward.
      this.database
        .prepare(
          `update metadata_demand
           set lease_id = null, lease_owner = null, lease_until_ms = null,
             next_retry_ms = max(next_retry_ms, ?), updated_at_ms = ?
           where scope_id = ? and address = ?`,
        )
        .run(outcome.retryAtMs, nowMs, scopeId, row.address);
      return demandOf(row);
    }
    this.database
      .prepare(
        `update metadata_demand
         set lease_id = null, lease_owner = null, lease_until_ms = null, next_retry_ms = 0,
           updated_at_ms = ?
         where scope_id = ? and address = ?`,
      )
      .run(nowMs, scopeId, row.address);
    return demandOf(row);
  }
}

function demandOf(row: DemandRow): MetadataDemand {
  return {
    address: row.address as Address,
    blockNumber: BigInt(row.needed_block),
    priority: row.priority as 0 | 1 | 2,
  };
}

/** The queues this process already holds, keyed by the database they write through. */
const sharedQueues = new WeakMap<Database.Database, MetadataQueue>();

/** The queue one database is written and read through, shared per database. */
export function metadataQueueFor(db: Database.Database): MetadataQueue {
  let queue = sharedQueues.get(db);
  if (!queue) {
    queue = new DemandQueue(db);
    sharedQueues.set(db, queue);
  }
  return queue;
}

/** Whether this database carries the metadata journal at all. */
const journalSupport = new WeakMap<Database.Database, boolean>();

/**
 * Whether `sqlite_master` lists both revision tables.
 *
 * A readonly handle may be an older schema that predates the migration, and asking it for the
 * tables on every read would be a query per call for an answer that cannot change while the handle
 * is open. The answer is remembered per database rather than per module, because two handles on two
 * files have two schemas.
 */
function hasMetadataJournal(db: Database.Database): boolean {
  const known = journalSupport.get(db);
  if (known !== undefined) return known;
  const row = db
    .prepare(
      `select count(*) as present from sqlite_master where type = 'table'
       and name in ('metadata_revision','metadata_address_changes')`,
    )
    .get() as { present: number };
  const present = row.present === 2;
  journalSupport.set(db, present);
  return present;
}

/** The durable metadata revision. 0 when this database predates the migration. */
export function metadataRevision(db: Database.Database): number {
  if (!hasMetadataJournal(db)) return 0;
  const row = db.prepare('select revision from metadata_revision where id = 0').get() as
    { revision: number } | undefined;
  return row?.revision ?? 0;
}

/**
 * Whether this database carries the journal at all.
 *
 * `metadataRevision` answers 0 both for a schema that predates the migration and for a migrated one
 * that has not changed yet, and the two mean opposite things to a reader that memoizes on the
 * revision: one can never report a change, the other is simply still. Exported for exactly that
 * caller, which has to skip the memo rather than pin it to a zero that cannot move.
 */
export function metadataJournalPresent(db: Database.Database): boolean {
  return hasMetadataJournal(db);
}

/**
 * Drop all but the newest `METADATA_REVISION_JOURNAL_LIMIT` revisions.
 *
 * Housekeeping is not worth turning a reader into a writer inside the caller's transaction:
 * upgrading a read snapshot to a write is exactly what makes a deferred transaction fail with
 * SQLITE_BUSY_SNAPSHOT, and a readonly handle has no business deleting anything. A reader outside a
 * transaction still prunes, which is the shape every caller of this function has.
 */
function pruneJournal(db: Database.Database, windowStart: number): void {
  if (windowStart <= 0 || db.readonly || db.inTransaction) return;
  db.prepare(
    `delete from metadata_address_changes where revision <= (
       select revision from metadata_address_changes group by revision order by revision desc
       limit 1 offset ?
     )`,
  ).run(METADATA_REVISION_JOURNAL_LIMIT);
}

/**
 * Addresses whose durable metadata changed after `sinceRevision`.
 *
 * `null` when `sinceRevision` has fallen out of the retained journal window: the rows that would
 * name the changes are gone, and a caller must rebuild everything instead of trusting a short list.
 * `complete: false` when at least one change could have affected any address — a change the
 * triggers could not name, so a caller cannot narrow the rebuild to the addresses returned.
 * Addresses are lowercase.
 */
export function metadataAddressChanges(
  db: Database.Database,
  sinceRevision: number,
): { revision: number; addresses: readonly string[]; complete: boolean } | null {
  if (!hasMetadataJournal(db)) return null;
  const revision = metadataRevision(db);
  const windowStart = revision - METADATA_REVISION_JOURNAL_LIMIT;
  pruneJournal(db, windowStart);
  if (sinceRevision < windowStart) return null;
  const rows = db
    .prepare(
      'select address from metadata_address_changes where revision > ? order by revision, address',
    )
    .all(sinceRevision) as { address: string }[];
  const addresses = new Set<string>();
  let complete = true;
  for (const row of rows) {
    if (row.address === UNNAMED_CHANGE) complete = false;
    else addresses.add(row.address);
  }
  return { revision, addresses: [...addresses], complete };
}
