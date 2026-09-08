import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { encodeJson } from '../domain/json.js';
import { encodeCheckedInteger } from '../domain/codec.js';
import { PoolRegistry, poolRegistrationId } from '../registry/pools.js';
import { projectRange, PROJECTION_VERSION, type ProjectionResult } from '../state/project-range.js';
import { SqliteRangeStore } from './raw-store.js';
import { rawLogKey } from './manifest.js';

export interface StoredProjection extends ProjectionResult {
  sourceHash: string;
  configVersion: string;
  registryScopeId: string;
}

/** Snapshot reads/replacements: rescans can remove/retime logs without changing the chain tip. */
export class SqliteProjectionStore {
  private readonly raw: SqliteRangeStore;
  constructor(private readonly db: Database.Database) {
    this.raw = new SqliteRangeStore(db);
  }
  private snapshot(scopeId: string, registryScopeId: string, configVersion: string) {
    const tip = this.raw.acceptedTip(scopeId);
    if (!tip) return null;
    const logs = this.raw.activeLogs(scopeId);
    const times = this.raw.logTimes(scopeId);
    const registry = new PoolRegistry([
      ...this.raw.pools(registryScopeId),
      ...(scopeId === registryScopeId ? [] : this.raw.pools(scopeId)),
    ]);
    const ranges = this.db
      .prepare(
        'select batch_id, filter_id, from_block, to_block from accepted_ranges where scope_id=? order by from_block,to_block,batch_id,filter_id',
      )
      .all(scopeId);
    const sourceHash = createHash('sha256')
      .update(
        encodeJson({
          version: PROJECTION_VERSION,
          scopeId,
          registryScopeId,
          configVersion,
          tip,
          registryTip: this.raw.acceptedTip(registryScopeId),
          ranges,
          logs,
          times: logs.map((l) => [rawLogKey(l), times.get(rawLogKey(l)) ?? null]),
          registry: registry.snapshot(),
        }),
      )
      .digest('hex');
    return { tip, logs, times, registry, sourceHash };
  }
  rebuild(
    scopeId: string,
    registryScopeId = scopeId,
    configVersion = 'unspecified',
  ): StoredProjection {
    return this.db
      .transaction(() => {
        const snapshot = this.snapshot(scopeId, registryScopeId, configVersion);
        if (!snapshot) throw new Error('No accepted scope to project');
        const result: StoredProjection = {
          ...projectRange(
            {
              id: 'rebuild-' + snapshot.sourceHash,
              scopeId,
              end: snapshot.tip,
              completeness: 'complete',
            },
            snapshot.logs,
            snapshot.times,
            snapshot.registry,
          ),
          sourceHash: snapshot.sourceHash,
          registryScopeId,
          configVersion,
        };
        for (const table of ['projected_events', 'pool_observations', 'projection_quality_errors'])
          this.db.prepare('delete from ' + table + ' where scope_id=?').run(scopeId);
        const eventInsert = this.db.prepare('insert into projected_events values (?,?,?,?,?,?,?)');
        for (const e of result.events)
          eventInsert.run(
            scopeId,
            rawLogKey(e.ref),
            e.pool ? poolRegistrationId({ pool: e.pool }) : null,
            e.kind,
            encodeCheckedInteger(e.ref.blockNumber, 0),
            e.time.minuteStartSec,
            encodeJson(e),
          );
        const obsInsert = this.db.prepare('insert into pool_observations values (?,?,?)');
        for (const o of result.observations)
          obsInsert.run(scopeId, poolRegistrationId(o), encodeJson(o));
        const errorInsert = this.db.prepare(
          'insert into projection_quality_errors values (?,?,?,?)',
        );
        for (const e of result.qualityErrors)
          errorInsert.run(scopeId, rawLogKey(e.raw), e.code, encodeJson(e));
        this.db
          .prepare(
            `insert into projection_cursors values (?,?,?,?,?,?,?,?,?)
        on conflict(scope_id) do update set registry_scope_id=excluded.registry_scope_id,
        projection_version=excluded.projection_version,config_version=excluded.config_version,
        source_hash=excluded.source_hash,batch_id=excluded.batch_id,block_number=excluded.block_number,
        block_hash=excluded.block_hash,payload_json=excluded.payload_json`,
          )
          .run(
            scopeId,
            registryScopeId,
            PROJECTION_VERSION,
            configVersion,
            result.sourceHash,
            result.batchId,
            encodeCheckedInteger(result.end.number, 0),
            result.end.hash,
            encodeJson(result),
          );
        return result;
      })
      .immediate();
  }
  read(
    scopeId: string,
    registryScopeId = scopeId,
    configVersion = 'unspecified',
  ): StoredProjection | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('select source_hash, payload_json from projection_cursors where scope_id=?')
        .get(scopeId) as { source_hash: string; payload_json: string } | undefined;
      if (!row) return null;
      const snapshot = this.snapshot(scopeId, registryScopeId, configVersion);
      if (!snapshot || snapshot.sourceHash !== row.source_hash) return null;
      return decodeProjection(row.payload_json);
    })();
  }
}

// Revive only typed protocol quantities; ancillary decoded values remain strings.
function decodeProjection(text: string): StoredProjection {
  const value = JSON.parse(text) as StoredProjection;
  value.end.number = BigInt(value.end.number);
  const reviveEvent = (event: ProjectionResult['events'][number]) => {
    event.ref.blockNumber = BigInt(event.ref.blockNumber);
    if (event.kind === 'swap') {
      for (const key of [
        'rawAmount0',
        'rawAmount1',
        'amountIn',
        'amountOut',
        'sqrtPriceX96After',
        'liquidityAfter',
      ] as const)
        event[key] = BigInt(event[key]);
    } else if (event.kind === 'liquidity') event.delta = BigInt(event.delta);
  };
  for (const e of value.events) reviveEvent(e);
  for (const o of value.observations) {
    if (o.lastSwap) reviveEvent(o.lastSwap);
    if (o.lastLiquidityAction) reviveEvent(o.lastLiquidityAction);
  }
  for (const e of value.qualityErrors) e.raw.blockNumber = BigInt(e.raw.blockNumber);
  return value;
}
