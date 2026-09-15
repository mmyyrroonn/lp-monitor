import type Database from 'better-sqlite3';
import type { Hex, Address } from 'viem';
import { encodeJson } from '../domain/json.js';
import type { RawLog, LogTime, PoolEvent, PoolObservation } from '../domain/types.js';
import { countWork } from '../ops/work-counters.js';
import type { PoolRegistration } from '../registry/pools.js';
import { poolRegistrationId } from '../registry/pools.js';
import type { PersistedPoolRegistration } from './manifest.js';
import { rawLogKey } from './manifest.js';
import { comparePosition } from '../state/observations.js';
import { projectRangeSelected, PROJECTION_VERSION } from '../state/project-range.js';
import {
  registryCacheFor,
  type PreparedRegistry,
  type RegistryPosition,
  type RegistryView,
} from './registry-cache.js';
import {
  registryChangesAfter,
  registryJournalAvailable,
  registryRevision,
  type RegistryChange,
} from './registry-changes.js';
import { SqliteRangeStore } from './raw-store.js';
import { NoAcceptedScopeError, type StoredProjection } from './projection-store.js';

type Cursor = {
  registry_scope_id: string;
  config_version: string;
  version: string;
  source_hash: string;
  registry_json: string;
  block_number: number;
};
/**
 * What the cursor remembers about the registry: which journal position it was last reconciled to,
 * never the catalogue itself. The journal is append-only and durable, so the position is enough to
 * name exactly what moved while this process was down; the identities themselves live in `pools`,
 * and their content is read through the registry view rather than re-serialized into the cursor.
 */
type RegistryCursorV1 = {
  format: 'registry-cursor-v1';
  revisionKey: string;
  registryScopeId: string;
  registrySeq: number;
  operationScopeId: string;
  operationSeq: number;
};
/** One identity the journal moved, with the registration it now names. */
export type RegistryEvidenceChange = {
  poolId: string;
  /** Discovery height of the surviving record, which is where a repair of this identity starts. */
  block: bigint;
  /** The registration the registry now holds, or null when the identity is gone. */
  record: PersistedPoolRegistration | null;
};
/** Bounded registry evidence: what moved since the previous window, not the whole catalogue. */
export type RegistryEvidence = {
  revisionKey: string;
  changes: readonly RegistryEvidenceChange[];
};
type JsonRow = { payload_json: string };
type EventRow = JsonRow & { pool_id: string | null; block_number: number };
type RawRow = {
  id: number;
  block_hash: Hex;
  block_number: number;
  transaction_hash: Hex;
  transaction_index: number;
  log_index: number;
  address: Address;
  topics_json: string;
  data: Hex;
  raw_block_timestamp: Hex | null;
  minute_start_sec: number | null;
  exact_timestamp_sec: number | null;
  source: LogTime['source'] | null;
};
export interface LiveProjectionChanges {
  repairFrom: bigint | null;
  affectedPoolIds: string[];
  /** True when this sync compared the legacy full-array cursor once and replaced it with a reference. */
  registryInitialization: boolean;
  /**
   * The registry movement this sync applied. Absent on a database without the journal, where the
   * only way to know the registry is to read it in full, exactly as before.
   */
  registry?: RegistryEvidence;
}
/** One identity the journal moved, paired with the records that describe the move. */
type RegistryMove = {
  poolId: string;
  before: PoolRegistration | null;
  after: PoolRegistration | null;
};
const VERSION = PROJECTION_VERSION + '-incremental-v1';

/** Durable incremental cache. First subscription/version changes replay once; ordinary sync
 * consumes deduplicated dirty IDs. SQL triggers share the source transaction, including rollback.
 * Historical decoded rows stay indexed on disk; only requested window payloads enter memory. */
export class LiveProjectionStore {
  private readonly raw: SqliteRangeStore;
  constructor(private readonly db: Database.Database) {
    this.raw = new SqliteRangeStore(db);
  }
  private token(scopeId: string, registryScopeId: string, configVersion: string): string {
    const get = this.db.prepare('select revision from live_source_revisions where scope_id=?');
    return encodeJson([
      VERSION,
      configVersion,
      scopeId,
      registryScopeId,
      get.get(scopeId) ?? null,
      get.get(registryScopeId) ?? null,
    ]);
  }
  /**
   * The journal position of both catalogues this scope registers into, plus the key that names it.
   * These three reads are the whole "did the registry move" question: two indexed maxima over the
   * append-only journal, and never a row of the catalogue.
   */
  private positions(
    registryScopeId: string,
    operationScopeId: string,
  ): RegistryPosition & {
    revisionKey: string;
  } {
    const registrySeq = registryRevision(this.db, registryScopeId);
    const operationSeq =
      operationScopeId === registryScopeId
        ? registrySeq
        : registryRevision(this.db, operationScopeId);
    return {
      registryScopeId,
      operationScopeId,
      revisionKey: `${registryScopeId}#${registrySeq}:${operationScopeId}#${operationSeq}`,
      registrySeq,
      operationSeq,
    };
  }
  /**
   * The identities the journal moved since a stored position, one entry per pool identity rather
   * than one per row: the journal speaks about rows, the registry speaks about pools.
   */
  private movesAfter(
    registryScopeId: string,
    operationScopeId: string,
    from: { registrySeq: number; operationSeq: number },
  ): Map<string, RegistryMove> {
    const changes: RegistryChange[] = [
      ...registryChangesAfter(this.db, registryScopeId, from.registrySeq),
      ...(operationScopeId === registryScopeId
        ? []
        : registryChangesAfter(this.db, operationScopeId, from.operationSeq)),
    ];
    const moves = new Map<string, RegistryMove>();
    for (const change of changes)
      for (const record of [change.before, change.after]) {
        if (!record) continue;
        const poolId = poolRegistrationId(record);
        const move = moves.get(poolId) ?? { poolId, before: null, after: null };
        if (record === change.before) move.before = record;
        else move.after = record;
        moves.set(poolId, move);
      }
    return moves;
  }
  /** The identities that differ between the legacy full-array cursor and the catalogue it described. */
  private movesSinceArray(
    previous: readonly PersistedPoolRegistration[],
    current: ReadonlyMap<string, PersistedPoolRegistration>,
  ): Map<string, RegistryMove> {
    const prior = new Map(previous.map((r) => [poolRegistrationId(r), r]));
    const moves = new Map<string, RegistryMove>();
    for (const id of new Set([...prior.keys(), ...current.keys()])) {
      const a = prior.get(id),
        b = current.get(id);
      countWork('registryRowsSerialized', (a ? 1 : 0) + (b ? 1 : 0));
      if (encodeJson(a ?? null) === encodeJson(b ?? null)) continue;
      moves.set(id, { poolId: id, before: a ?? null, after: b ?? null });
    }
    return moves;
  }
  sync(
    scopeId: string,
    registryScopeId = scopeId,
    configVersion = 'unspecified',
    prepared?: PreparedRegistry,
  ): LiveProjectionChanges {
    const cache = registryCacheFor(this.db, registryScopeId, scopeId);
    const caller = { used: false };
    try {
      return this.db
        .transaction(() =>
          this.syncOnce(scopeId, registryScopeId, configVersion, prepared, cache, false, caller),
        )
        .immediate();
    } catch (error) {
      // A cache this store prepared itself may have advanced over rows of a transaction that never
      // committed, and would then keep those identities forever; forget it and let the next reader
      // start from the catalogue again. A caller's prepared view is never folded into the shared
      // cache, so there is nothing of ours to forget: the caller discards its own view.
      if (!caller.used) cache.invalidate();
      throw error;
    }
  }
  private syncOnce(
    scopeId: string,
    registryScopeId: string,
    configVersion: string,
    prepared: PreparedRegistry | undefined,
    cache: ReturnType<typeof registryCacheFor>,
    forceRebuild = false,
    caller: { used: boolean } = { used: false },
  ): LiveProjectionChanges {
    const tip = this.raw.acceptedTip(scopeId);
    if (!tip) throw new NoAcceptedScopeError(scopeId);
    const old = this.db
      .prepare('select * from live_projection_cursors where scope_id=?')
      .get(scopeId) as Cursor | undefined;
    const token = this.token(scopeId, registryScopeId, configVersion);
    if (old?.source_hash === token) {
      // An unchanged token proves neither scope's source revision moved, and every write to `pools`
      // moves one of them, so the journal has nothing to report: the delta is empty by proof, not
      // by omission. It is still handed back, because a caller given no registry evidence has to
      // read the whole catalogue for it — which is the cost this path exists to avoid.
      const journaled = registryJournalAvailable(this.db);
      return {
        repairFrom: null,
        affectedPoolIds: [],
        registryInitialization: false,
        ...(journaled
          ? {
              registry: {
                revisionKey: this.positions(registryScopeId, scopeId).revisionKey,
                changes: [],
              },
            }
          : {}),
      };
    }
    const journaled = registryJournalAvailable(this.db);
    const reference = old && journaled ? parseRegistryCursor(old.registry_json) : null;
    const rebuild =
      forceRebuild ||
      !old ||
      old.version !== VERSION ||
      old.registry_scope_id !== registryScopeId ||
      old.config_version !== configVersion;
    // A reference that names other scopes describes a registry this cursor no longer follows, so
    // it is as stale as a version change and the row has to be rebuilt from the catalogue.
    if (
      reference &&
      (reference.registryScopeId !== registryScopeId || reference.operationScopeId !== scopeId)
    )
      return this.syncOnce(scopeId, registryScopeId, configVersion, prepared, cache, true, caller);
    const position = this.positions(registryScopeId, scopeId);
    const stored = rebuild ? null : reference;
    // A caller's prepared view is used only when it provably stands for the registry just read:
    // either its position is the one read, or the only rows written since are the ones it staged
    // itself — the accepting batch, whose discoveries are already in its overlay.
    const context =
      prepared && (prepared.view.revisionKey === position.revisionKey || prepared.covers(position))
        ? prepared
        : cache.prepare();
    caller.used = context === prepared;
    const view: RegistryView = context.view;
    const affected = new Set<string>();
    const dirty = new Set<number>();
    const forced = new Set<number>();
    let registryInitialization = false;
    let registryChanges: RegistryEvidenceChange[] = [];
    let repairFrom: bigint | null = null;
    const repair = (height: number) => {
      if (old && height <= old.block_number && (repairFrom === null || BigInt(height) < repairFrom))
        repairFrom = BigInt(height);
    };
    const coverageRepair = this.db
      .prepare('select min_block from live_dirty_coverage where scope_id=?')
      .get(scopeId) as { min_block: number } | undefined;
    if (coverageRepair) repair(coverageRepair.min_block);
    if (rebuild) {
      for (const row of this.db
        .prepare('select distinct raw_log_id from active_logs where scope_id=?')
        .all(scopeId) as { raw_log_id: number }[])
        dirty.add(row.raw_log_id);
      for (const table of [
        'live_events',
        'live_quality_errors',
        'live_observations',
        'live_inputs',
      ])
        this.db.prepare('delete from ' + table + ' where scope_id=?').run(scopeId);
      for (const record of view.all()) affected.add(poolRegistrationId(record));
      if (old) repairFrom = 0n;
    } else {
      for (const row of this.db
        .prepare('select raw_log_id from live_dirty_logs where scope_id=?')
        .all(scopeId) as { raw_log_id: number }[])
        dirty.add(row.raw_log_id);
      // Only changed identities invalidate their operation/discovery evidence, and the journal
      // already says which ones they are: a batch that touches two pools costs two journal rows,
      // not a comparison of two eighty-thousand-entry catalogues.
      let moves: Map<string, RegistryMove>;
      if (stored === null) {
        // The cursor still holds the legacy full array (or the database has no journal at all).
        // Compare it against the catalogue once and rewrite the cursor as a reference; only the
        // one-time comparison may look at every identity.
        const current = new Map<string, PersistedPoolRegistration>();
        for (const record of view.all()) current.set(poolRegistrationId(record), record);
        moves = this.movesSinceArray(legacyRegistrations(old?.registry_json), current);
        registryInitialization = journaled;
      } else {
        moves = this.movesAfter(registryScopeId, scopeId, stored);
      }
      for (const move of moves.values()) {
        affected.add(move.poolId);
        for (const r of [move.before, move.after])
          if (r) {
            const address = r.pool.protocol === 'v3' ? r.pool.address : r.pool.manager;
            const topic = r.pool.protocol === 'v4' ? r.pool.poolId : null;
            const rows = this.db
              .prepare(
                `select r.id from raw_logs r where lower(r.address)=? and (? is null or lower(json_extract(r.topics_json,'$[1]'))=?) and exists(select 1 from active_logs a where a.scope_id=? and a.raw_log_id=r.id)`,
              )
              .all(address.toLowerCase(), topic, topic?.toLowerCase() ?? null, scopeId) as {
              id: number;
            }[];
            for (const row of rows) {
              dirty.add(row.id);
              forced.add(row.id);
            }
            const discovery = this.db.prepare('select id from raw_logs where raw_key=?').get(
              rawLogKey({
                ...r.discoveredAt,
                blockNumber: BigInt(r.discoveredAt.blockNumber),
              }),
            ) as { id: number } | undefined;
            if (discovery) {
              dirty.add(discovery.id);
              forced.add(discovery.id);
            }
          }
      }
      if (journaled)
        registryChanges = [...moves.values()]
          .map((move): RegistryEvidenceChange => {
            const record = view.get(move.poolId) ?? null;
            return {
              poolId: move.poolId,
              block: BigInt((record ?? move.before ?? move.after)!.discoveredAt.blockNumber),
              record,
            };
          })
          .sort((left, right) => left.poolId.localeCompare(right.poolId));
    }
    const readRaw = this.db.prepare(
      `select r.*,t.minute_start_sec,t.exact_timestamp_sec,t.source from raw_logs r left join log_times t on t.scope_id=? and t.raw_log_id=r.id where r.id=? and exists(select 1 from active_logs a where a.scope_id=? and a.raw_log_id=r.id)`,
    );
    const rows = new Map<number, RawRow>();
    const logs: RawLog[] = [];
    const times = new Map<string, LogTime>();
    const ids = new Map<string, number>();
    for (const id of dirty) {
      const row = readRaw.get(scopeId, id, scopeId) as RawRow | undefined;
      const inputJson = row ? encodeJson(row) : null;
      const previousInput = this.db
        .prepare('select input_json from live_inputs where scope_id=? and raw_log_id=?')
        .get(scopeId, id) as { input_json: string } | undefined;
      if (!rebuild && !forced.has(id) && previousInput?.input_json === inputJson) {
        dirty.delete(id);
        continue;
      }
      if (inputJson === null)
        this.db
          .prepare('delete from live_inputs where scope_id=? and raw_log_id=?')
          .run(scopeId, id);
      else
        this.db
          .prepare(
            'insert into live_inputs values(?,?,?) on conflict(scope_id,raw_log_id) do update set input_json=excluded.input_json',
          )
          .run(scopeId, id, inputJson);
      if (!row) continue;
      rows.set(id, row);
      const log: RawLog = {
        blockNumber: BigInt(row.block_number),
        blockHash: row.block_hash,
        transactionHash: row.transaction_hash,
        transactionIndex: row.transaction_index,
        logIndex: row.log_index,
        address: row.address,
        topics: JSON.parse(row.topics_json),
        data: row.data,
        rawBlockTimestamp: row.raw_block_timestamp,
      };
      logs.push(log);
      ids.set(rawLogKey(log), id);
      times.set(rawLogKey(log), {
        minuteStartSec: row.minute_start_sec,
        exactTimestampSec: row.exact_timestamp_sec,
        source: row.source ?? 'unresolved',
      });
    }
    const result = projectRangeSelected(
      { id: 'live-' + token, scopeId, end: tip, completeness: 'complete' },
      logs,
      times,
      view,
    );
    const newEvents = new Map(result.events.map((e) => [ids.get(rawLogKey(e.ref))!, e]));
    const newErrors = new Map<number, typeof result.qualityErrors>();
    for (const e of result.qualityErrors) {
      const id = ids.get(rawLogKey(e.raw))!;
      newErrors.set(id, [...(newErrors.get(id) ?? []), e]);
    }
    const eventInsert = this.db.prepare('insert into live_events values(?,?,?,?,?,?,?,?,?)');
    const errorInsert = this.db.prepare('insert into live_quality_errors values(?,?,?,?,?,?)');
    for (const id of dirty) {
      const before = this.db
        .prepare(
          'select payload_json,pool_id,block_number from live_events where scope_id=? and raw_log_id=?',
        )
        .get(scopeId, id) as EventRow | undefined;
      const beforeErrors = this.db
        .prepare(
          'select payload_json,block_number from live_quality_errors where scope_id=? and raw_log_id=? order by code',
        )
        .all(scopeId, id) as EventRow[];
      const e = newEvents.get(id);
      const errors = newErrors.get(id) ?? [];
      const eventJson = e ? encodeJson(e) : undefined;
      const errorsJson = errors.map((e) => encodeJson(e)).sort();
      if (
        before?.payload_json === eventJson &&
        encodeJson(beforeErrors.map((e) => e.payload_json).sort()) === encodeJson(errorsJson)
      )
        continue;
      if (before) {
        repair(before.block_number);
        if (before.pool_id) affected.add(before.pool_id);
      }
      for (const error of beforeErrors) repair(error.block_number);
      const raw = rows.get(id);
      if (raw) repair(raw.block_number);
      this.db.prepare('delete from live_events where scope_id=? and raw_log_id=?').run(scopeId, id);
      this.db
        .prepare('delete from live_quality_errors where scope_id=? and raw_log_id=?')
        .run(scopeId, id);
      if (e) {
        const pool = e.pool ? poolRegistrationId({ pool: e.pool }) : null;
        if (pool) affected.add(pool);
        eventInsert.run(
          scopeId,
          id,
          pool,
          e.kind,
          Number(e.ref.blockNumber),
          e.ref.transactionIndex,
          e.ref.logIndex,
          e.time.minuteStartSec,
          eventJson,
        );
      }
      for (const error of errors)
        errorInsert.run(
          scopeId,
          id,
          error.code,
          Number(error.raw.blockNumber),
          error.time.minuteStartSec,
          encodeJson(error),
        );
    }
    for (const event of result.events) {
      if (!event.pool || (event.kind !== 'swap' && event.kind !== 'liquidity')) continue;
      const conflicting = this.db
        .prepare(
          "select count(distinct lower(json_extract(payload_json,'$.ref.blockHash'))) n from live_events where scope_id=? and pool_id=? and block_number=? and kind in ('swap','liquidity')",
        )
        .get(scopeId, poolRegistrationId({ pool: event.pool }), Number(event.ref.blockNumber)) as {
        n: number;
      };
      if (conflicting.n > 1)
        throw new Error('Conflicting history: rebuild observations from active logs');
    }
    for (const poolId of affected) {
      const r = view.get(poolId);
      if (!r) {
        this.db
          .prepare('delete from live_observations where scope_id=? and pool_id=?')
          .run(scopeId, poolId);
        continue;
      }
      const latest = (kind: string) => {
        const row = this.db
          .prepare(
            'select payload_json from live_events where scope_id=? and pool_id=? and kind=? order by block_number desc,transaction_index desc,log_index desc limit 1',
          )
          .get(scopeId, poolId, kind) as JsonRow | undefined;
        return row ? reviveEvent(JSON.parse(row.payload_json) as PoolEvent) : null;
      };
      const observation = {
        pool: r.pool,
        lastSwap: latest('swap'),
        lastLiquidityAction: latest('liquidity'),
      };
      this.db
        .prepare(
          'insert into live_observations values(?,?,?) on conflict(scope_id,pool_id) do update set payload_json=excluded.payload_json',
        )
        .run(scopeId, poolId, encodeJson(observation));
    }
    if (old && Number(tip.number) < old.block_number) repair(Number(tip.number) + 1);
    // The cursor keeps a position, not a catalogue: the identities and their content stay in
    // `pools`, and the journal position says what a later reader still has to replay.
    const registryJson = journaled
      ? encodeJson({
          format: 'registry-cursor-v1',
          revisionKey: position.revisionKey,
          registryScopeId,
          registrySeq: position.registrySeq,
          operationScopeId: scopeId,
          operationSeq: position.operationSeq,
        } satisfies RegistryCursorV1)
      : encodeJson([...view.all()]);
    this.db
      .prepare(
        'insert into live_projection_cursors values(?,?,?,?,?,?,?) on conflict(scope_id) do update set registry_scope_id=excluded.registry_scope_id,config_version=excluded.config_version,version=excluded.version,source_hash=excluded.source_hash,registry_json=excluded.registry_json,block_number=excluded.block_number',
      )
      .run(
        scopeId,
        registryScopeId,
        configVersion,
        VERSION,
        token,
        registryJson,
        Number(tip.number),
      );
    this.db.prepare('delete from live_dirty_logs where scope_id=?').run(scopeId);
    this.db.prepare('delete from live_dirty_coverage where scope_id=?').run(scopeId);
    if (repairFrom !== null)
      this.db
        .prepare(
          'insert into live_pending_signal_repairs(scope_id,min_block) values(?,?) on conflict(scope_id) do update set min_block=min(min_block,excluded.min_block)',
        )
        .run(scopeId, Number(repairFrom));
    return {
      repairFrom,
      affectedPoolIds: [...affected].sort(),
      registryInitialization,
      ...(journaled
        ? { registry: { revisionKey: position.revisionKey, changes: registryChanges } }
        : {}),
    };
  }
  read(
    scopeId: string,
    registryScopeId = scopeId,
    configVersion = 'unspecified',
    sinceSec = 0,
  ): StoredProjection | null {
    return this.db.transaction(() => {
      const cursor = this.db
        .prepare('select * from live_projection_cursors where scope_id=?')
        .get(scopeId) as Cursor | undefined;
      const tip = this.raw.acceptedTip(scopeId);
      if (
        !cursor ||
        !tip ||
        cursor.source_hash !== this.token(scopeId, registryScopeId, configVersion)
      )
        return null;
      // Require a boundary in the requested minute; an ancient boundary cannot bound unknown history.
      const boundary = this.db
        .prepare(
          'select first_block from minute_boundaries where scope_id=? and timestamp_sec>=? and timestamp_sec<=? order by timestamp_sec desc limit 1',
        )
        .get(scopeId, Math.floor(sinceSec / 60) * 60, sinceSec) as
        { first_block: number } | undefined;
      const cutoff = boundary?.first_block ?? 0;
      const unknownUnbounded = sinceSec > 0 && boundary === undefined;
      const windowContextIncomplete =
        unknownUnbounded &&
        ['live_events', 'live_quality_errors'].some((table) =>
          Boolean(
            this.db
              .prepare(
                'select 1 from ' + table + ' where scope_id=? and minute_start_sec is null limit 1',
              )
              .get(scopeId),
          ),
        );
      const select = (table: string): JsonRow[] => {
        const known = this.db
          .prepare(
            'select payload_json from ' + table + ' where scope_id=? and minute_start_sec>=?',
          )
          .all(scopeId, sinceSec) as JsonRow[];
        if (unknownUnbounded) return known;
        const unknown = this.db
          .prepare(
            'select payload_json from ' +
              table +
              ' where scope_id=? and minute_start_sec is null and block_number>=?',
          )
          .all(scopeId, cutoff) as JsonRow[];
        return [...known, ...unknown];
      };
      const events = select('live_events')
        .map((row) => reviveEvent(JSON.parse(row.payload_json) as PoolEvent))
        .sort((a, b) => comparePosition(a.ref, b.ref));
      const qualityErrors = select('live_quality_errors')
        .map((row) => {
          const e = JSON.parse(row.payload_json) as StoredProjection['qualityErrors'][number];
          e.raw.blockNumber = BigInt(e.raw.blockNumber);
          return e;
        })
        .sort(
          (a, b) =>
            comparePosition(a.raw, b.raw) ||
            (a.code === 'unresolved-time'
              ? -1
              : b.code === 'unresolved-time'
                ? 1
                : a.code.localeCompare(b.code)),
        );
      const observations = (
        this.db
          .prepare('select payload_json from live_observations where scope_id=? order by pool_id')
          .all(scopeId) as JsonRow[]
      ).map((row) => {
        const o = JSON.parse(row.payload_json) as PoolObservation;
        if (o.lastSwap) reviveEvent(o.lastSwap);
        if (o.lastLiquidityAction) reviveEvent(o.lastLiquidityAction);
        return o;
      });
      return {
        version: PROJECTION_VERSION as typeof PROJECTION_VERSION,
        scopeId,
        batchId: 'live-' + cursor.source_hash,
        end: tip,
        sourceHash: cursor.source_hash,
        configVersion,
        registryScopeId,
        events,
        qualityErrors,
        observations,
        ...(windowContextIncomplete ? { windowContextIncomplete: true } : {}),
      };
    })();
  }
}
/** The reference a journaled cursor stores, or null when the row still holds the legacy array. */
function parseRegistryCursor(json: string): RegistryCursorV1 | null {
  const value = JSON.parse(json) as Partial<RegistryCursorV1> | null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value.format === 'registry-cursor-v1' &&
    typeof value.revisionKey === 'string' &&
    typeof value.registryScopeId === 'string' &&
    Number.isSafeInteger(value.registrySeq) &&
    typeof value.operationScopeId === 'string' &&
    Number.isSafeInteger(value.operationSeq)
    ? (value as RegistryCursorV1)
    : null;
}

/** The pool registrations a legacy cursor still carries, or none when it holds a reference. */
function legacyRegistrations(json: string | undefined): PersistedPoolRegistration[] {
  if (json === undefined) return [];
  const value = JSON.parse(json) as unknown;
  return Array.isArray(value) ? (value as PersistedPoolRegistration[]) : [];
}

function reviveEvent(event: PoolEvent): PoolEvent {
  event.ref.blockNumber = BigInt(event.ref.blockNumber);
  if (event.kind === 'swap')
    for (const key of [
      'rawAmount0',
      'rawAmount1',
      'amountIn',
      'amountOut',
      'sqrtPriceX96After',
      'liquidityAfter',
    ] as const)
      event[key] = BigInt(event[key]);
  else if (event.kind === 'liquidity') event.delta = BigInt(event.delta);
  return event;
}

/** Lightweight health reader: a present but stale live cache must never fall back
 * to an older offline cursor. Older databases without the live migration still work. */
function readProjectionWatermarkSnapshot(
  db: Database.Database,
  scopeId: string,
): { source_hash: string; block_number: number; block_hash: string } | undefined {
  const exists = db
    .prepare("select 1 from sqlite_master where type='table' and name='live_projection_cursors'")
    .get();
  if (exists) {
    const cursor = db
      .prepare('select * from live_projection_cursors where scope_id=?')
      .get(scopeId) as Cursor | undefined;
    if (cursor) {
      const revision = db.prepare('select revision from live_source_revisions where scope_id=?');
      const token = encodeJson([
        VERSION,
        cursor.config_version,
        scopeId,
        cursor.registry_scope_id,
        revision.get(scopeId) ?? null,
        revision.get(cursor.registry_scope_id) ?? null,
      ]);
      if (cursor.source_hash !== token) return undefined;
      const tip = new SqliteRangeStore(db).acceptedTip(scopeId);
      return tip
        ? { source_hash: token, block_number: Number(tip.number), block_hash: tip.hash }
        : undefined;
    }
  }
  return db
    .prepare('select source_hash,block_number,block_hash from projection_cursors where scope_id=?')
    .get(scopeId) as { source_hash: string; block_number: number; block_hash: string } | undefined;
}

export function readProjectionWatermark(
  db: Database.Database,
  scopeId: string,
): { source_hash: string; block_number: number; block_hash: string } | undefined {
  return db.transaction(() => readProjectionWatermarkSnapshot(db, scopeId))();
}
