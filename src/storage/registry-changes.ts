import type Database from 'better-sqlite3';
import { countWork } from '../ops/work-counters.js';
import type { PoolRegistration } from '../registry/pools.js';
import { decodeStoredRegistration } from './registration-codec.js';

/** One committed mutation of a scope's registry, addressed by the sequence it was written at. */
export type RegistryChange = {
  seq: number;
  scopeId: string;
  poolKey: string;
  before: PoolRegistration | null;
  after: PoolRegistration | null;
};

/**
 * Whether this database carries the registry journal at all. An older file has no journal and no
 * way to name what moved, so every reader has to fall back to reading the catalogue and stay there.
 */
export function registryJournalAvailable(database: Database.Database): boolean {
  const row = database
    .prepare(
      "select 1 as present from sqlite_master where type = 'table' and name = 'registry_changes'",
    )
    .get() as { present: number } | undefined;
  return row !== undefined;
}

/**
 * Highest journal sequence for a scope, or 0 when the journal has nothing for it.
 *
 * 0 also means "the journal does not describe this scope's current registry": rows that predate
 * the journal (or that were never written through it) are not replayed, so a first reader has to
 * take the `pools` table as its starting point and follow the journal from there.
 */
export function registryRevision(database: Database.Database, scopeId: string): number {
  const row = database
    .prepare('select max(seq) as seq from registry_changes where scope_id = ?')
    .get(scopeId) as { seq: number | null };
  return row.seq ?? 0;
}

/** Committed changes for one scope with a sequence above `seq`, oldest first. */
export function registryChangesAfter(
  database: Database.Database,
  scopeId: string,
  seq: number,
): RegistryChange[] {
  const rows = database
    .prepare(
      `select seq, scope_id, pool_key, before_json, after_json from registry_changes
       where scope_id = ? and seq > ? order by seq`,
    )
    .all(scopeId, seq) as {
    seq: number;
    scope_id: string;
    pool_key: string;
    before_json: string | null;
    after_json: string | null;
  }[];
  countWork('registryChangesRead', rows.length);
  return rows.map((row) => ({
    seq: row.seq,
    scopeId: row.scope_id,
    poolKey: row.pool_key,
    before: row.before_json === null ? null : decodeStoredRegistration(row.before_json),
    after: row.after_json === null ? null : decodeStoredRegistration(row.after_json),
  }));
}
