import { expect, test } from 'vitest';
import { pruneSignalDerivedHistory } from '../../src/signals/project.js';
import { openDatabase } from '../../src/storage/database.js';
import { encodeBatchReference, getPayload, putPayload } from '../../src/storage/payload-store.js';

function evaluationRow(db: ReturnType<typeof openDatabase>, values: [string, string]) {
  db.prepare(
    'insert into signal_evaluations(scope_id,batch_id,source_hash,pool_id,payload_json) values(?,?,?,?,?)',
  ).run(
    's',
    values[0],
    values[1],
    'pool',
    encodeBatchReference(putPayload(db, Buffer.from(values[1]))),
  );
}

function objectCount(db: ReturnType<typeof openDatabase>): number {
  return db.prepare('select count(*) n from payload_objects').pluck().get() as number;
}

test('retention reclaims only payload objects no surviving row references', () => {
  const db = openDatabase(':memory:');
  try {
    evaluationRow(db, ['b1', 'shared']);
    evaluationRow(db, ['b2', 'shared']);
    evaluationRow(db, ['b3', 'unique']);
    expect(objectCount(db)).toBe(2);
    // Keep the two newest rows: both objects are still referenced.
    const kept = pruneSignalDerivedHistory(db, 's', { evaluations: 2, terminalDeliveries: 0 });
    expect(kept.evaluations).toBe(1);
    expect(kept.payloadObjects).toBe(0);
    expect(objectCount(db)).toBe(2);
    const sharedEnvelope = db
      .prepare('select payload_json from signal_evaluations order by rowid limit 1')
      .pluck()
      .get() as string;
    const ref = (JSON.parse(sharedEnvelope) as { payload: ReturnType<typeof putPayload> }).payload;
    expect(Buffer.from(getPayload(db, ref)).toString('utf8')).toBe('shared');
    // Keeping only the newest row leaves the shared object unreferenced.
    const pruned = pruneSignalDerivedHistory(db, 's', { evaluations: 1, terminalDeliveries: 0 });
    expect(pruned.evaluations).toBe(1);
    expect(pruned.payloadObjects).toBe(1);
    expect(objectCount(db)).toBe(1);
    expect(
      db.prepare('select payload_json from signal_evaluations order by rowid').pluck().get(),
    ).toBeTypeOf('string');
  } finally {
    db.close();
  }
});

test('a failing reuse pass rolls back the deletion and the object cleanup', () => {
  const db = openDatabase(':memory:');
  try {
    evaluationRow(db, ['b1', 'one']);
    evaluationRow(db, ['b2', 'two']);
    db.exec('drop table payload_objects');
    expect(() =>
      pruneSignalDerivedHistory(db, 's', { evaluations: 0, terminalDeliveries: 0 }),
    ).toThrow();
    expect(db.prepare('select count(*) n from signal_evaluations').pluck().get()).toBe(2);
  } finally {
    db.close();
  }
});

test('batch references keep their objects alive across evaluation pruning', () => {
  const db = openDatabase(':memory:');
  try {
    const shared = putPayload(db, Buffer.from('shared-content'));
    db.prepare(
      `insert into ingest_batches(
         id,scope_id,chain_id,from_block,to_block,end_hash,end_timestamp_sec,observed_at_ms,
         capture_mode,filter_plan_hash,manifest_hash,completeness,payload_json
       ) values('b1','s',4663,1,2,'0x00',1,1,'synthetic','f','m','complete',?)`,
    ).run(encodeBatchReference(shared));
    evaluationRow(db, ['e1', 'evaluation-only']);
    const pruned = pruneSignalDerivedHistory(db, 's', { evaluations: 0, terminalDeliveries: 0 });
    expect(pruned.payloadObjects).toBe(1);
    expect(objectCount(db)).toBe(1);
    expect(db.prepare('select count(*) n from ingest_batches').pluck().get()).toBe(1);
  } finally {
    db.close();
  }
});
