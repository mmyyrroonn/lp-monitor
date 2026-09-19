import type Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { pruneLiveWindow, pruneRawBatches, pruneRawLogs } from '../../src/storage/retention.js';

function seedRaw(db: Database.Database, key: string, block: number): number {
  const info = db
    .prepare(
      `insert into raw_logs(
         raw_key,chain_id,block_hash,block_number,transaction_hash,transaction_index,
         log_index,address,topics_json,data,raw_block_timestamp,payload_json
       ) values(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      key,
      4663,
      '0x' + key.padEnd(64, '0'),
      block,
      '0x' + key.padEnd(64, '1'),
      0,
      0,
      '0x00',
      '[]',
      '0x',
      null,
      '{}',
    );
  return Number(info.lastInsertRowid);
}

function seedLive(db: Database.Database, scopeId: string, id: number, minute: number | null): void {
  db.prepare('insert into live_inputs(scope_id,raw_log_id,input_json) values(?,?,?)').run(
    scopeId,
    id,
    '{"i":' + id + '}',
  );
  db.prepare(
    `insert into live_events(scope_id,raw_log_id,pool_id,kind,block_number,transaction_index,log_index,minute_start_sec,payload_json)
     values(?,?,?,?,?,?,?,?,?)`,
  ).run(scopeId, id, 'p', 'swap', id, 0, 0, minute, '{"e":' + id + '}');
}

test('pruneLiveWindow retires resolved rows older than the cutoff and their input snapshots', () => {
  const db = openDatabase(':memory:');
  try {
    const a = seedRaw(db, 'a', 10);
    const b = seedRaw(db, 'b', 20);
    const c = seedRaw(db, 'c', 30);
    seedLive(db, 's', a, 100);
    seedLive(db, 's', b, 500);
    seedLive(db, 's', c, 600);

    const pruned = pruneLiveWindow(db, 's', 300, { maxRows: 10 });
    expect(pruned).toEqual({ liveEvents: 1, qualityErrors: 0, liveInputs: 1 });
    expect(db.prepare('select count(*) n from live_events where scope_id=?').get('s')).toEqual({
      n: 2,
    });
    expect(db.prepare('select count(*) n from live_inputs where scope_id=?').get('s')).toEqual({
      n: 2,
    });
  } finally {
    db.close();
  }
});

test('pruneLiveWindow leaves unresolved rows alone', () => {
  const db = openDatabase(':memory:');
  try {
    const id = seedRaw(db, 'u', 10);
    seedLive(db, 's', id, null);
    const pruned = pruneLiveWindow(db, 's', 0, { maxRows: 10 });
    expect(pruned.liveEvents).toBe(0);
    expect(db.prepare('select count(*) n from live_inputs where scope_id=?').get('s')).toEqual({
      n: 1,
    });
  } finally {
    db.close();
  }
});

test('pruneRawLogs keeps discovery logs pinned by pools and drops old operation logs', () => {
  const db = openDatabase(':memory:');
  try {
    const old = seedRaw(db, 'old', 10);
    const pinned = seedRaw(db, 'pin', 5);
    db.prepare(
      'insert into pools(scope_id,pool_key,protocol,discovered_raw_log_id,discovered_block_number,discovered_block_hash,payload_json) values(?,?,?,?,?,?,?)',
    ).run('s', 'pool', 'v3', pinned, 5, '0x00', '{}');
    db.prepare('insert into active_logs(scope_id,filter_id,raw_log_id) values(?,?,?)').run(
      's',
      'f',
      old,
    );
    db.prepare(
      'insert into log_times(scope_id,raw_log_id,minute_start_sec,exact_timestamp_sec,source,boundary_timestamp_sec) values(?,?,?,?,?,?)',
    ).run('s', old, 100, 100, 'minute-boundary', 160);
    seedLive(db, 's', old, 100);

    const pruned = pruneRawLogs(db, 20, { maxRows: 10 });
    expect(pruned.rawLogs).toBe(1);
    expect(pruned.activeLogs).toBe(1);
    expect(db.prepare('select count(*) n from raw_logs').get()).toEqual({ n: 1 });
    expect(db.prepare('select id from raw_logs').pluck().get()).toBe(pinned);
    expect(db.prepare('select count(*) n from active_logs').get()).toEqual({ n: 0 });
    expect(db.prepare('select count(*) n from live_events').get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

test('pruneRawBatches deletes accepted ranges first and cascades shards', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare(
      `insert into ingest_batches(id,scope_id,chain_id,from_block,to_block,end_hash,end_timestamp_sec,observed_at_ms,capture_mode,filter_plan_hash,manifest_hash,completeness,payload_json)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('old', 's', 4663, 1, 10, '0x00', 100, 1, 'synthetic', 'f', 'm', 'complete', '{}');
    db.prepare(
      `insert into ingest_batches(id,scope_id,chain_id,from_block,to_block,end_hash,end_timestamp_sec,observed_at_ms,capture_mode,filter_plan_hash,manifest_hash,completeness,payload_json)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('new', 's', 4663, 11, 20, '0x00', 500, 1, 'synthetic', 'f', 'm', 'complete', '{}');
    db.prepare(
      'insert into accepted_ranges(scope_id,batch_id,filter_id,from_block,to_block,accepted_at_ms) values(?,?,?,?,?,?)',
    ).run('s', 'old', 'f', 1, 10, 1);
    db.prepare(
      'insert into fetch_shards(batch_id,shard_id,filter_id,from_block,to_block,status,response_hash,log_count,error) values(?,?,?,?,?,?,?,?,?)',
    ).run('old', 'sh', 'f', 1, 10, 'done', null, 0, null);

    const pruned = pruneRawBatches(db, 's', 200, { maxBatches: 10 });
    expect(pruned).toEqual({ batches: 1, acceptedRanges: 1 });
    expect(db.prepare('select count(*) n from ingest_batches').get()).toEqual({ n: 1 });
    expect(db.prepare('select count(*) n from accepted_ranges').get()).toEqual({ n: 0 });
    expect(db.prepare('select count(*) n from fetch_shards').get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
