import type Database from 'better-sqlite3';
import { encodeJson } from '../domain/json.js';
import { countWork } from '../ops/work-counters.js';
import type { PoolRegistration } from '../registry/pools.js';
import { mergeRegistration, poolRegistrationId, registrationsEqual } from '../registry/pools.js';
import { decodeStoredRegistration } from './registration-codec.js';
import { registerRollbackInvalidation } from './commit-boundary.js';
import {
  registryChangesAfter,
  registryJournalAvailable,
  registryRevision,
  type RegistryChange,
} from './registry-changes.js';

/** Read-only registry lookup surface handed to the batch that prepared it. */
export interface RegistryView {
  get(poolId: string): PoolRegistration | undefined;
  isDiscoveryRef(rawLogKey: string): boolean;
  getByV3Address(address: string): PoolRegistration | undefined;
  getByV4Id(manager: string, poolId: string): PoolRegistration | undefined;
  forAsset(address: string): Iterable<PoolRegistration>;
  all(): Iterable<PoolRegistration>;
  /** Journal position this view was built from; changes whenever the registry moved. */
  readonly revisionKey: string;
}

/** One uncommitted view of the registry plus the identities that really moved before it. */
export type PreparedRegistry = {
  view: RegistryView;
  /**
   * Stable identity of the scope pair this context follows. Two contexts over different scopes can
   * report the same revision key — the legacy path reports `legacy` for every one of them — so a
   * holder that caches anything derived from this view has to compare this first.
   */
  scopeKey: string;
  changedPoolIds: ReadonlySet<string>;
  /** Uncommitted registrations this batch discovered; `publish` folds them in, `discard` drops them. */
  stage(registrations: readonly PoolRegistration[]): void;
  /** Fold the staged work into the shared cache. Only legal with no transaction open. */
  publish(): void;
  /** Drop the staged work; the shared cache keeps whatever was already committed. */
  discard(): void;
  /**
   * Whether this view can stand in for the registry at `position`.
   *
   * True when the two are the same position, or when every journal row written since belongs to a
   * registration staged through this view — which is exactly the accepting batch writing its own
   * discoveries inside its transaction. Any other row is a write this view never saw, and the
   * caller has to take the catalogue again rather than project from an incomplete registry.
   */
  covers(position: RegistryPosition): boolean;
};

/** The journal position of both catalogues one live reader follows. */
export type RegistryPosition = {
  registryScopeId: string;
  operationScopeId: string;
  registrySeq: number;
  operationSeq: number;
};

function v4Key(manager: string, poolId: string): string {
  return `${manager.toLowerCase()}:${poolId.toLowerCase()}`;
}

/** The `rawLogKey` of the log a pool was discovered at. */
function discoveryKey(record: PoolRegistration): string {
  const ref = record.discoveredAt;
  return `${record.pool.chainId}:${ref.blockHash.toLowerCase()}:${ref.transactionHash.toLowerCase()}:${ref.logIndex}`;
}

function tokensOf(record: PoolRegistration): readonly string[] {
  return [record.token0.toLowerCase(), record.token1.toLowerCase()];
}

/**
 * Secondary indexes over one registry state. The records themselves live in `byId`; every other
 * map holds a pool id, so a removal cannot leave a second copy of a record behind.
 */
class RegistryIndexes {
  readonly byId = new Map<string, PoolRegistration>();
  readonly byV3Address = new Map<string, string>();
  readonly byV4Id = new Map<string, string>();
  readonly byAsset = new Map<string, Set<string>>();
  readonly discoveryRefs = new Map<string, number>();

  clear(): void {
    this.byId.clear();
    this.byV3Address.clear();
    this.byV4Id.clear();
    this.byAsset.clear();
    this.discoveryRefs.clear();
  }

  /** Store a record as the current one for its identity, replacing any previous copy. */
  add(record: PoolRegistration): void {
    const id = poolRegistrationId(record);
    if (this.byId.has(id)) this.delete(id);
    this.byId.set(id, record);
    if (record.pool.protocol === 'v3') this.byV3Address.set(record.pool.address.toLowerCase(), id);
    else this.byV4Id.set(v4Key(record.pool.manager, record.pool.poolId), id);
    // Both sides of a stock pool are attributed, exactly like `stockPoolAttributions`.
    for (const token of tokensOf(record)) {
      const members = this.byAsset.get(token) ?? new Set<string>();
      members.add(id);
      this.byAsset.set(token, members);
    }
    const discovery = discoveryKey(record);
    this.discoveryRefs.set(discovery, (this.discoveryRefs.get(discovery) ?? 0) + 1);
  }

  delete(poolId: string): boolean {
    const record = this.byId.get(poolId);
    if (record === undefined) return false;
    this.byId.delete(poolId);
    if (record.pool.protocol === 'v3') this.byV3Address.delete(record.pool.address.toLowerCase());
    else this.byV4Id.delete(v4Key(record.pool.manager, record.pool.poolId));
    for (const token of tokensOf(record)) {
      const members = this.byAsset.get(token);
      if (members === undefined) continue;
      members.delete(poolId);
      if (members.size === 0) this.byAsset.delete(token);
    }
    const discovery = discoveryKey(record);
    const count = this.discoveryRefs.get(discovery) ?? 0;
    if (count <= 1) this.discoveryRefs.delete(discovery);
    else this.discoveryRefs.set(discovery, count - 1);
    return true;
  }
}

type PreparedState = { changedPoolIds: Set<string>; revisionKey: string };

/**
 * The live registry: one indexed state advanced by the `registry_changes` journal instead of by
 * re-reading every `pools` row.
 *
 * The first reader of a database loads the two catalogues once and remembers the journal position
 * it read them at. Every later reader asks only for the two revisions and replays whatever landed
 * after them, so a batch that touches two pools costs two journal rows rather than eighty thousand
 * catalogue rows. A database without the journal (an old file) keeps the full-read behaviour, and
 * says so through `revisionKey`.
 */
export class RegistryCache {
  readonly #indexes = new RegistryIndexes();
  readonly #overlay = new Map<string, PoolRegistration>();
  readonly #deleted = new Set<string>();
  readonly #scopeKey: string;
  #loaded = false;
  #journalChecked = false;
  #journalAvailable = true;
  #registryRevision = 0;
  #operationRevision = 0;

  constructor(
    private readonly database: Database.Database,
    private readonly registryScopeId: string,
    private readonly operationScopeId: string,
  ) {
    this.#scopeKey = encodeJson([registryScopeId, operationScopeId]);
  }

  /** Forget everything remembered; the next `prepare` reads the catalogue again. */
  invalidate(): void {
    this.#loaded = false;
    this.#overlay.clear();
    this.#deleted.clear();
  }

  prepare(): PreparedRegistry {
    // A context taken inside an open transaction can consume journal rows that transaction still
    // has to commit. SQL rollback will not roll this in-memory advance back, so the transaction's
    // boundary is told to invalidate this context if it fails. Outside a transaction every row read
    // here is already durable, and there is nothing to undo.
    if (this.database.inTransaction) registerRollbackInvalidation(this.database, this);
    // A load and an incremental advance each run inside one SQLite read snapshot, so the revision
    // a reader remembers always belongs to the rows it just read.
    const state = this.database.transaction((): PreparedState => {
      if (!this.journalAvailable()) {
        this.reload();
        return { changedPoolIds: new Set(this.#indexes.byId.keys()), revisionKey: 'legacy' };
      }
      if (!this.#loaded) {
        this.reload();
        // Read the revisions after the rows, in the same snapshot: a write that landed during the
        // load is already in the rows and must not be replayed on top of them.
        this.#registryRevision = registryRevision(this.database, this.registryScopeId);
        this.#operationRevision = registryRevision(this.database, this.operationScopeId);
        return {
          changedPoolIds: new Set(this.#indexes.byId.keys()),
          revisionKey: this.revisionKey(),
        };
      }
      const registry = registryRevision(this.database, this.registryScopeId);
      const operations = registryRevision(this.database, this.operationScopeId);
      if (registry === this.#registryRevision && operations === this.#operationRevision)
        return { changedPoolIds: new Set<string>(), revisionKey: this.revisionKey() };
      // One scope asked for twice is one journal segment, not two: the two positions are equal by
      // construction, and replaying the same rows a second time would settle a fresh insert through
      // the fold path instead of taking it as written.
      const changed = this.applyChanges(
        this.registryScopeId === this.operationScopeId
          ? registryChangesAfter(this.database, this.registryScopeId, this.#registryRevision)
          : [
              ...registryChangesAfter(this.database, this.registryScopeId, this.#registryRevision),
              ...registryChangesAfter(
                this.database,
                this.operationScopeId,
                this.#operationRevision,
              ),
            ],
      );
      this.#registryRevision = registry;
      this.#operationRevision = operations;
      return { changedPoolIds: changed, revisionKey: this.revisionKey() };
    })();

    return {
      view: new CachedView(this.#indexes, this.#overlay, this.#deleted, state.revisionKey),
      scopeKey: this.#scopeKey,
      changedPoolIds: state.changedPoolIds,
      stage: (registrations) => this.stage(registrations),
      publish: () => this.publish(),
      discard: () => this.discard(),
      covers: (position) => this.covers(position),
    };
  }

  covers(position: RegistryPosition): boolean {
    if (
      position.registryScopeId !== this.registryScopeId ||
      position.operationScopeId !== this.operationScopeId
    )
      return false;
    // The rows this context already consumed must be behind the position it is asked to stand in
    // for; a position older than that describes a registry this view is ahead of, not behind.
    if (
      position.registrySeq < this.#registryRevision ||
      position.operationSeq < this.#operationRevision
    )
      return false;
    const gap = this.journalSince();
    if (gap === null) return false;
    return gap.registrySeq <= position.registrySeq && gap.operationSeq <= position.operationSeq;
  }

  /**
   * The journal rows written after the position this context consumed, when every one of them is a
   * registration staged through it — the accepting batch writing its own discoveries.
   *
   * Returns null for any other row: another writer's update, a removal, or a discovery this batch
   * never staged. Such a row is work this view has not seen, and a caller has to replay it rather
   * than step over it. The rows read are the batch's own registrations, never the catalogue.
   */
  private journalSince(): { keys: Set<string>; registrySeq: number; operationSeq: number } | null {
    return this.database.transaction(
      (): {
        keys: Set<string>;
        registrySeq: number;
        operationSeq: number;
      } | null => {
        const registrySeq = registryRevision(this.database, this.registryScopeId);
        const operationSeq = registryRevision(this.database, this.operationScopeId);
        const keys = new Set<string>();
        const consumed = new Map<string, number>([
          [this.registryScopeId, this.#registryRevision],
          [this.operationScopeId, this.#operationRevision],
        ]);
        for (const [scopeId, seq] of consumed)
          for (const change of registryChangesAfter(this.database, scopeId, seq)) {
            if (change.after === null) return null;
            const id = poolRegistrationId(change.after);
            const staged = this.#overlay.get(id);
            if (staged === undefined || !registrationsEqual(staged, change.after)) return null;
            keys.add(change.poolKey);
          }
        return { keys, registrySeq, operationSeq };
      },
    )();
  }

  private revisionKey(): string {
    return `${this.registryScopeId}#${this.#registryRevision}:${this.operationScopeId}#${this.#operationRevision}`;
  }

  private journalAvailable(): boolean {
    if (this.#journalChecked) return this.#journalAvailable;
    this.#journalChecked = true;
    this.#journalAvailable = registryJournalAvailable(this.database);
    return this.#journalAvailable;
  }

  /**
   * Both catalogues, in the order the per-batch preview has always merged them. One scope asked
   * for twice is one catalogue read, not two: the merge is idempotent, so a second pass over the
   * same rows can only cost time.
   */
  private reload(): void {
    this.#indexes.clear();
    for (const scopeId of new Set([this.registryScopeId, this.operationScopeId])) {
      const rows = this.database
        .prepare(
          'select payload_json from pools where scope_id = ? order by discovered_block_number, pool_key',
        )
        .all(scopeId) as { payload_json: string }[];
      countWork('registryRowsRead', rows.length);
      for (const row of rows) {
        const record = decodeStoredRegistration(row.payload_json);
        const decision = mergeRegistration(
          this.#indexes.byId.get(poolRegistrationId(record)),
          record,
        );
        if (decision.changed) this.#indexes.add(decision.record);
      }
    }
    this.#loaded = true;
    this.#overlay.clear();
    this.#deleted.clear();
  }

  /**
   * Replay committed journal rows onto the held state.
   *
   * A pool this cache has never held can have no other row, so an entry that inserts one is taken
   * as written and costs no read at all: a batch that discovers pools never reads the catalogue
   * back. Everything else — an update, a removal, a second discovery row — is settled by folding
   * the rows the pool still has, which is exactly what a catalogue read would have produced. The
   * journal speaks about a row; the registry speaks about a pool.
   */
  private applyChanges(changes: readonly RegistryChange[]): Set<string> {
    const changed = new Set<string>();
    for (const change of changes) {
      const inserted = change.after;
      if (change.before === null && inserted !== null) {
        const insertedId = poolRegistrationId(inserted);
        if (!this.#indexes.byId.has(insertedId)) {
          this.#indexes.add(inserted);
          this.#deleted.delete(insertedId);
          changed.add(insertedId);
          continue;
        }
      }
      const survivor = this.derivePool(change.poolKey);
      const goneId = change.before === null ? null : poolRegistrationId(change.before);
      if (goneId !== null && (survivor === undefined || poolRegistrationId(survivor) !== goneId)) {
        if (this.#indexes.delete(goneId)) changed.add(goneId);
        this.#deleted.add(goneId);
      }
      if (survivor === undefined) continue;
      const id = poolRegistrationId(survivor);
      const current = this.#indexes.byId.get(id);
      if (current !== undefined && registrationsEqual(current, survivor)) continue;
      this.#indexes.add(survivor);
      this.#deleted.delete(id);
      changed.add(id);
    }
    return changed;
  }

  /**
   * The pool one key currently encodes, folded from its surviving rows in the order a catalogue
   * read uses: the registry scope first, oldest discovery first.
   */
  private derivePool(poolKey: string): PoolRegistration | undefined {
    let merged: PoolRegistration | undefined;
    for (const scopeId of [this.registryScopeId, this.operationScopeId]) {
      const rows = this.database
        .prepare(
          `select payload_json from pools where scope_id = ? and pool_key = ?
           order by discovered_block_number, pool_key`,
        )
        .all(scopeId, poolKey) as { payload_json: string }[];
      countWork('registryRowsRead', rows.length);
      for (const row of rows) {
        const decision = mergeRegistration(merged, decodeStoredRegistration(row.payload_json));
        if (decision.changed) merged = decision.record;
      }
    }
    return merged;
  }

  private stage(registrations: readonly PoolRegistration[]): void {
    for (const registration of registrations) {
      const id = poolRegistrationId(registration);
      this.#deleted.delete(id);
      this.#overlay.set(id, registration);
    }
  }

  /**
   * Take the accepted batch's registrations into this context and step over the journal rows that
   * wrote them.
   *
   * The work is settled through `derivePool` in catalogue order, exactly as a later catalogue read
   * would settle it, so the context holds what `pools` holds rather than what the batch staged: a
   * registration the batch declined to persist never becomes a pool this view claims. A row this
   * context never staged stops the step-over; the next reader replays whatever it missed.
   */
  private publish(): void {
    if (this.database.inTransaction)
      throw new Error('Cannot publish a registry view from inside a transaction');
    const gap = this.journalSince();
    if (gap !== null)
      try {
        for (const poolKey of gap.keys) {
          const survivor = this.derivePool(poolKey);
          if (survivor === undefined) continue;
          const id = poolRegistrationId(survivor);
          const current = this.#indexes.byId.get(id);
          if (current !== undefined && registrationsEqual(current, survivor)) continue;
          this.#indexes.add(survivor);
        }
        this.#registryRevision = gap.registrySeq;
        this.#operationRevision = gap.operationSeq;
      } catch {
        // A staged record that conflicts with the one this context holds is a data problem the next
        // reader has to report inside its own transaction; the accepted batch is already durable,
        // and failing here would report it as that batch's failure. The context stays where it was
        // so the next prepare replays the row and raises it there.
      }
    this.#overlay.clear();
    this.#deleted.clear();
  }

  private discard(): void {
    this.#overlay.clear();
    this.#deleted.clear();
  }
}

/** The shared contexts this process already holds, keyed by database and scope pair. */
const sharedCaches = new WeakMap<Database.Database, Map<string, RegistryCache>>();

/**
 * The registry context one database and scope pair shares across its callers. The recorder and
 * the live projection both drive the same registry, so they must advance the same state: a batch
 * that prepared a view, wrote its rows and published is exactly the state the next sync reads, and
 * neither pays for a second catalogue load.
 *
 * A caller whose transaction rolled back must `invalidate()` the context it advanced: the cache
 * follows committed journal rows, and a position remembered over uncommitted ones would hide those
 * identities from every later reader.
 */
export function registryCacheFor(
  database: Database.Database,
  registryScopeId: string,
  operationScopeId: string,
): RegistryCache {
  let byKey = sharedCaches.get(database);
  if (!byKey) {
    byKey = new Map();
    sharedCaches.set(database, byKey);
  }
  const key = encodeJson([registryScopeId, operationScopeId]);
  let cache = byKey.get(key);
  if (!cache) {
    cache = new RegistryCache(database, registryScopeId, operationScopeId);
    byKey.set(key, cache);
  }
  return cache;
}

/** The read side: uncommitted work first, then what this context knows is gone, then the base. */
class CachedView implements RegistryView {
  constructor(
    private readonly indexes: RegistryIndexes,
    private readonly overlay: Map<string, PoolRegistration>,
    private readonly deleted: Set<string>,
    readonly revisionKey: string,
  ) {}

  get(poolId: string): PoolRegistration | undefined {
    const staged = this.overlay.get(poolId);
    if (staged !== undefined) return staged;
    if (this.deleted.has(poolId)) return undefined;
    return this.indexes.byId.get(poolId);
  }

  isDiscoveryRef(rawLogKey: string): boolean {
    const key = rawLogKey.toLowerCase();
    for (const record of this.overlay.values()) {
      if (discoveryKey(record) === key) return true;
    }
    return (this.indexes.discoveryRefs.get(key) ?? 0) > 0;
  }

  getByV3Address(address: string): PoolRegistration | undefined {
    const id = this.indexes.byV3Address.get(address.toLowerCase());
    if (id !== undefined) return this.get(id);
    return this.staged(
      (record) =>
        record.pool.protocol === 'v3' &&
        record.pool.address.toLowerCase() === address.toLowerCase(),
    );
  }

  getByV4Id(manager: string, poolId: string): PoolRegistration | undefined {
    const key = v4Key(manager, poolId);
    const id = this.indexes.byV4Id.get(key);
    if (id !== undefined) return this.get(id);
    return this.staged(
      (record) =>
        record.pool.protocol === 'v4' && v4Key(record.pool.manager, record.pool.poolId) === key,
    );
  }

  *forAsset(address: string): Iterable<PoolRegistration> {
    const token = address.toLowerCase();
    const seen = new Set<string>();
    for (const id of this.indexes.byAsset.get(token) ?? []) {
      seen.add(id);
      const record = this.get(id);
      if (record !== undefined && tokensOf(record).includes(token)) yield record;
    }
    for (const [id, record] of this.overlay) {
      if (seen.has(id)) continue;
      if (tokensOf(record).includes(token)) yield record;
    }
  }

  *all(): Iterable<PoolRegistration> {
    for (const [id, record] of this.indexes.byId) {
      if (this.overlay.has(id) || this.deleted.has(id)) continue;
      yield record;
    }
    for (const record of this.overlay.values()) yield record;
  }

  /** A staged record the base indexes do not know about. */
  private staged(match: (record: PoolRegistration) => boolean): PoolRegistration | undefined {
    for (const record of this.overlay.values()) {
      if (match(record)) return record;
    }
    return undefined;
  }
}
