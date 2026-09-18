import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { batch, hotLogs } from '../helpers/alert-fixture.js';

const columns = (db: ReturnType<typeof openDatabase>): string[] =>
  (db.pragma('table_info(fetch_shards)') as { name: string }[]).map((column) => column.name);

/** 015 drops fetch_shards.request_json, and ALTER TABLE ... DROP COLUMN has no IF EXISTS form, so
 * it is applied under a guard rather than from the list every other migration shares. An unguarded
 * drop makes the second open of the same database fail with "no such column": this is the
 * recorder's every restart. */
test('a database survives being opened again after the shard request column is dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-drop-shard-request-'));
  try {
    const path = join(dir, 'recorder.sqlite');
    const first = openDatabase(path);
    first.close();

    const second = openDatabase(path);
    try {
      expect(columns(second)).not.toContain('request_json');
      expect(columns(second)).toContain('response_hash');
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The column's contents were redundant, not the shard row: what the coverage readers compare a
 * batch against is written by a path that no longer binds the request, and the batch payload that
 * carries those requests is left alone. */
test('shard rows written without the request column still carry what coverage reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-drop-shard-request-'));
  try {
    const path = join(dir, 'recorder.sqlite');
    const db = openDatabase(path);
    try {
      const logs = hotLogs();
      new SqliteRangeStore(db).saveRaw(batch('b1', logs));
      const shards = db
        .prepare('select shard_id,status,response_hash,log_count,error from fetch_shards')
        .all() as {
        shard_id: string;
        status: string;
        response_hash: string | null;
        log_count: number;
      }[];
      expect(
        shards.map((row) => [row.shard_id, row.status, row.response_hash, row.log_count]),
      ).toEqual([['one', 'success', 'h', logs.length]]);
      const stored = db.prepare('select payload_json from ingest_batches where id=?').get('b1') as {
        payload_json: string;
      };
      expect(stored.payload_json).toContain('"request"');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
