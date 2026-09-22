import type Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import {
  previewRawRetention,
  pruneLiveWindow,
  pruneRawBatches,
  pruneRawLogs,
} from '../../src/storage/retention.js';
import { retentionConsumer } from '../helpers/retention-fixture.js';
import {
  pinRetention,
  readRetentionSafety,
  releaseRetentionPin,
} from '../../src/storage/retention-state.js';

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
    retentionConsumer(db, 's');
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
    retentionConsumer(db, 's');
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
    retentionConsumer(db, 's');
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
    retentionConsumer(db, 's');
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

test('bounded batch retention deletes the same oldest batch and children despite reversed IDs', () => {
  const db = openDatabase(':memory:');
  try {
    retentionConsumer(db, 's');
    retentionConsumer(db, 'other');
    for (const [id, scope, timestamp, completeness] of [
      ['ffff', 's', 100, 'complete'],
      ['0000', 's', 150, 'complete'],
      ['failed', 's', 160, 'incomplete'],
      ['elsewhere', 'other', 50, 'complete'],
      ['recent', 's', 500, 'complete'],
    ] as const) {
      db.prepare(
        `insert into ingest_batches(id,scope_id,chain_id,from_block,to_block,end_hash,end_timestamp_sec,observed_at_ms,capture_mode,filter_plan_hash,manifest_hash,completeness,payload_json)
         values(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        scope,
        4663,
        1,
        10,
        '0x00',
        timestamp,
        1,
        'synthetic',
        'f',
        'm',
        completeness,
        '{}',
      );
      if (completeness === 'complete')
        db.prepare('insert into accepted_ranges values(?,?,?,?,?,?)').run(scope, id, 'f', 1, 10, 1);
      db.prepare('insert into fetch_shards values(?,?,?,?,?,?,?,?,?)').run(
        id,
        'sh',
        'f',
        1,
        10,
        'done',
        null,
        0,
        null,
      );
    }
    expect(pruneRawBatches(db, 's', 200, { maxBatches: 1 })).toEqual({
      batches: 1,
      acceptedRanges: 1,
    });
    expect(db.prepare('select id from ingest_batches order by id').pluck().all()).toEqual([
      '0000',
      'elsewhere',
      'failed',
      'recent',
    ]);
    expect(
      db.prepare('select batch_id from accepted_ranges order by batch_id').pluck().all(),
    ).toEqual(['0000', 'elsewhere', 'recent']);
    expect(db.prepare('select batch_id from fetch_shards order by batch_id').pluck().all()).toEqual(
      ['0000', 'elsewhere', 'failed', 'recent'],
    );
    expect(pruneRawBatches(db, 's', 200, { maxBatches: 1 })).toEqual({
      batches: 1,
      acceptedRanges: 1,
    });
    expect(pruneRawBatches(db, 's', 200, { maxBatches: 1 })).toEqual({
      batches: 1,
      acceptedRanges: 0,
    });
    expect(pruneRawBatches(db, 's', 200, { maxBatches: 1 })).toEqual({
      batches: 0,
      acceptedRanges: 0,
    });
    expect(db.prepare('select id from ingest_batches order by id').pluck().all()).toEqual([
      'elsewhere',
      'recent',
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

test('global raw retention refuses a scope without an explicit policy and progress', () => {
  const db = openDatabase(':memory:');
  try {
    const id = seedRaw(db, 'missing-consumer', 10);
    db.prepare('insert into active_logs values(?,?,?)').run('unknown', 'f', id);
    expect(pruneRawLogs(db, 100).rawLogs).toBe(0);
    expect(db.prepare('select id from raw_logs').pluck().all()).toEqual([id]);
  } finally {
    db.close();
  }
});

test('a fast scope cannot erase shared facts and live rows of a slower scope', () => {
  const db = openDatabase(':memory:');
  try {
    const id = seedRaw(db, 'shared', 10);
    for (const scope of ['fast', 'slow']) {
      db.prepare('insert into active_logs values(?,?,?)').run(scope, 'f', id);
      seedLive(db, scope, id, 120);
      db.prepare('insert into scope_cursors values(?,?,?,?)').run(
        scope,
        scope === 'fast' ? 1000 : 11,
        '0x0',
        scope === 'fast' ? 1000000 : 180,
      );
    }
    retentionConsumer(db, 'fast');
    retentionConsumer(db, 'slow', { tipBlock: 11, tipSec: 180, anchorBlock: 10, anchorSec: 120 });
    expect(pruneRawLogs(db, 900).rawLogs).toBe(0);
    expect(db.prepare('select scope_id from live_events order by scope_id').pluck().all()).toEqual([
      'fast',
      'slow',
    ]);
    retentionConsumer(db, 'slow');
    expect(pruneRawLogs(db, 900).rawLogs).toBe(1);
    expect(
      db
        .prepare('select scope_id,raw_before_block from retention_expirations order by scope_id')
        .all(),
    ).toEqual([
      { scope_id: 'fast', raw_before_block: 11 },
      { scope_id: 'slow', raw_before_block: 11 },
    ]);
    expect(db.prepare('select count(*) from live_events').pluck().get()).toBe(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

test.each(['history', 'replay'] as const)(
  '%s pin protects live and raw inputs until explicit release',
  (kind) => {
    const db = openDatabase(':memory:');
    try {
      retentionConsumer(db, 's');
      const id = seedRaw(db, 'pin-input', 10);
      seedLive(db, 's', id, 120);
      pinRetention(db, 'consumer', kind);
      expect(pruneLiveWindow(db, 's', 1000).liveEvents).toBe(0);
      expect(pruneRawLogs(db, 900).rawLogs).toBe(0);
      expect(readRetentionSafety(db).blockers).toContain(`pin:${kind}:consumer`);
      expect(releaseRetentionPin(db, 'consumer')).toBe(true);
      expect(releaseRetentionPin(db, 'consumer')).toBe(false);
      expect(pruneRawLogs(db, 900).rawLogs).toBe(1);
    } finally {
      db.close();
    }
  },
);

test('an explicit keep-forever policy and missing progress independently pin shared raw facts', () => {
  const db = openDatabase(':memory:');
  try {
    retentionConsumer(db, 's', { rawRetentionSec: null });
    seedRaw(db, 'forever', 10);
    expect(pruneRawLogs(db, 900).rawLogs).toBe(0);
    expect(readRetentionSafety(db).blockers).toContain('s:keep-raw-forever');
    retentionConsumer(db, 's');
    db.prepare('delete from scope_cursors').run();
    expect(pruneRawLogs(db, 900).rawLogs).toBe(0);
    expect(readRetentionSafety(db).blockers).toContain('s:progress-missing');
  } finally {
    db.close();
  }
});

test('retention keeps every advertised checkpoint and overlap block', () => {
  const db = openDatabase(':memory:');
  try {
    retentionConsumer(db, 's', { overlapBlocks: 992 });
    seedRaw(db, 'recovery', 10);
    expect(pruneRawLogs(db, 900).rawLogs).toBe(0);
    retentionConsumer(db, 's');
    db.prepare('insert into checkpoints values(?,?,?,?,?)').run('s', 10, '0x0', 1, null);
    expect(pruneRawLogs(db, 900).rawLogs).toBe(0);
    db.prepare('delete from checkpoints').run();
    expect(pruneRawLogs(db, 900).rawLogs).toBe(1);
  } finally {
    db.close();
  }
});

test('dry-run uses the same bounded selection and retained transports protect raw reconstruction', () => {
  const db = openDatabase(':memory:');
  try {
    retentionConsumer(db, 's');
    const id = seedRaw(db, 'transport-input', 10);
    for (const [batchId, sec] of [
      ['old', 100],
      ['newer', 150],
    ] as const) {
      db.prepare(`insert into ingest_batches values(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        batchId,
        's',
        4663,
        1,
        10,
        '0x0',
        sec,
        1,
        'synthetic',
        'f',
        'm',
        'complete',
        '{}',
      );
      db.prepare('insert into accepted_ranges values(?,?,?,?,?,?)').run(
        's',
        batchId,
        'f',
        1,
        10,
        1,
      );
    }
    const before = db.prepare('select * from ingest_batches order by id').all();
    const preview = previewRawRetention(db, 1);
    expect(preview.scopes).toEqual([{ scopeId: 's', batchIds: ['old'] }]);
    expect(preview.rawLogs).toBe(0);
    expect(preview.acceptedRanges).toBe(1);
    expect(preview.coverageExpiryScopes).toEqual(['s']);
    expect(db.prepare('select * from ingest_batches order by id').all()).toEqual(before);
    expect(pruneRawLogs(db, 900, { maxRows: 1 }).rawLogs).toBe(preview.rawLogs);
    expect(pruneRawBatches(db, 's', 200, { maxBatches: 1 }).batches).toBe(preview.batches);
    expect(pruneRawLogs(db, 900).rawLogs).toBe(0);
    expect(db.prepare('select id from raw_logs').pluck().all()).toEqual([id]);
    pruneRawBatches(db, 's', 200);
    expect(pruneRawLogs(db, 900).rawLogs).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

test('a failed parent deletion rolls back child ranges and availability metadata', () => {
  const db = openDatabase(':memory:');
  try {
    retentionConsumer(db, 's');
    db.prepare('insert into ingest_batches values(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'old',
      's',
      4663,
      1,
      10,
      '0x0',
      100,
      1,
      'synthetic',
      'f',
      'm',
      'complete',
      '{}',
    );
    db.prepare('insert into accepted_ranges values(?,?,?,?,?,?)').run('s', 'old', 'f', 1, 10, 1);
    db.exec(
      "create trigger fail_prune before delete on ingest_batches begin select raise(abort,'cannot prune'); end",
    );
    expect(() => pruneRawBatches(db, 's', 200)).toThrow('cannot prune');
    expect(db.prepare('select count(*) from accepted_ranges').pluck().get()).toBe(1);
    expect(db.prepare('select count(*) from retention_expirations').pluck().get()).toBe(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

test('an unenrolled registry scope prevents shared reclamation', () => {
  const db = openDatabase(':memory:');
  try {
    retentionConsumer(db, 's', { registryScopeId: 'registry' });
    seedRaw(db, 'registry-dependent', 10);
    expect(pruneRawLogs(db, 900).rawLogs).toBe(0);
    expect(readRetentionSafety(db).blockers).toContain('registry:policy-missing');
  } finally {
    db.close();
  }
});

test('physical retention rejects the unbounded negative SQL limit', () => {
  const db = openDatabase(':memory:');
  try {
    expect(() => pruneRawBatches(db, 's', 100, { maxBatches: -1 })).toThrow(RangeError);
    expect(() => pruneRawLogs(db, 100, { maxRows: -1 })).toThrow(RangeError);
    expect(() => pruneLiveWindow(db, 's', 100, { maxRows: -1 })).toThrow(RangeError);
  } finally {
    db.close();
  }
});

test('raw retention probes shared references by index instead of scanning them for every candidate', () => {
  const db = openDatabase(':memory:');
  try {
    retentionConsumer(db, 's');
    seedRaw(db, 'query-plan', 10);
    const prepare = db.prepare.bind(db);
    let selection = '';
    const capture = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('select r.id from raw_logs r')) selection = sql;
      return prepare(sql);
    });
    previewRawRetention(db, 1);
    capture.mockRestore();
    const plan = prepare('explain query plan ' + selection).all(900, 1) as { detail: string }[];
    expect(plan.filter((row) => /^SCAN [pa](?: |$)/.test(row.detail))).toEqual([]);
  } finally {
    db.close();
  }
});

test('a caller cannot prune inside the declared live quote and signal lookback', () => {
  const db = openDatabase(':memory:');
  try {
    retentionConsumer(db, 's', {
      tipSec: 1200,
      rawRetentionSec: 1020,
      liveRetentionSec: 1020,
      requiredLookbackSec: 1000,
    });
    const id = seedRaw(db, 'quote-window', 10);
    seedLive(db, 's', id, 180);
    expect(pruneLiveWindow(db, 's', 1000).liveEvents).toBe(0);
    db.prepare('update scope_cursors set timestamp_sec=1260').run();
    expect(pruneLiveWindow(db, 's', 1000).liveEvents).toBe(1);
  } finally {
    db.close();
  }
});
