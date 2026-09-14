import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ConfigError } from '../config/env.js';

function loadMigration(name: string): string {
  try {
    return readFileSync(new URL('./migrations/' + name, import.meta.url), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return readFileSync(
      new URL('../../../src/storage/migrations/' + name, import.meta.url),
      'utf8',
    );
  }
}

const migration = [
  '001-raw.sql',
  '002-projections.sql',
  '003-metrics.sql',
  '004-alerts.sql',
  '005-live.sql',
  '006-live-indexes.sql',
  '007-live-metrics.sql',
  '008-token-metadata.sql',
  '009-payload-store.sql',
]
  .map(loadMigration)
  .join('\n');

/** Inspect validates the schema but never migrates or changes journal mode.
 * SQLite may still need WAL/SHM sidecars when reading a live WAL database. */
export function openDatabase(
  path: string,
  options: { readonly?: boolean } = {},
): Database.Database {
  if (!options.readonly && path !== ':memory:')
    mkdirSync(dirname(resolve(path)), { recursive: true });
  const database = new Database(
    path,
    options.readonly ? { readonly: true, fileMustExist: true } : {},
  );
  try {
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    if (options.readonly) {
      try {
        // Validate the columns used by projection reads without executing DDL.
        for (const [table, columns] of Object.entries({
          projection_cursors: 'scope_id,source_hash,projection_version,payload_json',
          scope_cursors: 'scope_id,block_number,block_hash,timestamp_sec',
          raw_logs:
            'id,block_hash,block_number,transaction_hash,transaction_index,log_index,address,topics_json,data,raw_block_timestamp',
          active_logs: 'scope_id,filter_id,raw_log_id',
          log_times: 'scope_id,raw_log_id,minute_start_sec,exact_timestamp_sec,source',
          pools:
            'scope_id,protocol,discovered_block_number,discovered_block_hash,pool_key,payload_json',
          accepted_ranges: 'scope_id,batch_id,filter_id,from_block,to_block',
          ingest_batches: 'id,scope_id,payload_json',
          fetch_shards: 'batch_id,shard_id,status,response_hash,log_count,error',
          anchors: 'scope_id,block_number,block_hash,timestamp_sec',
          minute_boundaries:
            'scope_id,timestamp_sec,first_block,before_number,before_hash,before_timestamp_sec,at_number,at_hash,at_timestamp_sec',
        }))
          database.prepare('select ' + columns + ' from ' + table + ' limit 0').all();
      } catch (error) {
        if (
          !(error instanceof Database.SqliteError) ||
          error.code !== 'SQLITE_ERROR' ||
          !/no such (?:table|column):/i.test(error.message)
        )
          throw error;
        throw new ConfigError(
          'Recorded database schema is incompatible; run project --rebuild on a writable migrated database',
        );
      }
      return database;
    }
    if (path !== ':memory:') database.pragma('journal_mode = WAL');
    database.exec(migration);
    const poolColumns = database.pragma('table_info(pools)') as { name: string }[];
    if (!poolColumns.some((column) => column.name === 'protocol'))
      database.exec('alter table pools add column protocol TEXT');
    database.exec(
      "update pools set protocol = json_extract(payload_json, '$.pool.protocol') where protocol is null",
    );
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
