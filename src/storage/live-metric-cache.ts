import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { encodeSignalState, decodeSignalState } from '../signals/codec.js';

/** Durable, transaction-bound hot contributions. Inputs include all dependencies;
 * time expiry deletes only derived cache rows, never source or alert evidence. */
export class LiveMetricCache {
  private readonly select: Database.Statement;
  private readonly upsert: Database.Statement;
  constructor(
    private readonly db: Database.Database,
    private readonly scopeId: string,
  ) {
    this.select = db.prepare(
      'select input_hash,payload_json from live_metric_cache where scope_id=? and cache_key=?',
    );
    this.upsert =
      db.prepare(`insert into live_metric_cache(scope_id,cache_key,minute_start_sec,input_hash,payload_json) values(?,?,?,?,?)
      on conflict(scope_id,cache_key) do update set minute_start_sec=excluded.minute_start_sec,input_hash=excluded.input_hash,payload_json=excluded.payload_json`);
  }
  memo<T>(key: string, minuteStartSec: number, input: unknown, compute: () => T): T {
    const hash = createHash('sha256').update(encodeSignalState(input)).digest('hex');
    const prior = this.select.get(this.scopeId, key) as
      { input_hash: string; payload_json: string } | undefined;
    if (prior?.input_hash === hash) return decodeSignalState<T>(prior.payload_json);
    const result = compute();
    this.upsert.run(this.scopeId, key, minuteStartSec, hash, encodeSignalState(result));
    return result;
  }
  expireBefore(sinceSec: number): void {
    this.db
      .prepare('delete from live_metric_cache where scope_id=? and minute_start_sec<?')
      .run(this.scopeId, sinceSec);
  }
}
