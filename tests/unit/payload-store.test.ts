import { expect, test } from 'vitest';
import type { Hex } from 'viem';
import { batch, swap } from '../helpers/alert-fixture.js';
import { openDatabase } from '../../src/storage/database.js';
import {
  getPayload,
  PayloadFormatError,
  putPayload,
  readBatch,
  type PayloadRef,
} from '../../src/storage/payload-store.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';

test('content references round-trip and deduplicate', () => {
  const db = openDatabase(':memory:');
  try {
    const bytes = new TextEncoder().encode('{"amount":"-9007199254740993","time":null}');
    const a = putPayload(db, bytes);
    const b = putPayload(db, bytes);
    expect(a.hash).toBe(b.hash);
    expect([...getPayload(db, a)]).toEqual([...bytes]);
    expect(db.prepare('select count(*) as n from payload_objects').get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});

test('a damaged or missing object fails closed', () => {
  const db = openDatabase(':memory:');
  try {
    const ref = putPayload(db, new TextEncoder().encode('payload'));
    db.prepare('update payload_objects set payload=? where hash=?').run(
      Buffer.from('broken'),
      ref.hash,
    );
    expect(() => getPayload(db, ref)).toThrow(PayloadFormatError);
    const missing: PayloadRef = { ...ref, hash: '0'.repeat(64) };
    expect(() => getPayload(db, missing)).toThrow(/missing/i);
  } finally {
    db.close();
  }
});

test('a logical batch above the object limit is stored as ordered chunks', () => {
  const db = openDatabase(':memory:');
  try {
    const wide = ('0x' + 'ab'.repeat(30_000)) as Hex;
    const logs = Array.from({ length: 1_200 }, (_, index) => ({
      ...swap(60 + index * 60),
      logIndex: index,
      data: wide,
    }));
    const huge = batch('huge', logs);
    const store = new SqliteRangeStore(db);
    expect(() => store.saveRaw(huge, { compact: true })).not.toThrow();
    const envelope = JSON.parse(
      db
        .prepare('select payload_json from ingest_batches where id=?')
        .pluck()
        .get('huge') as string,
    ) as { format: string; payloads: PayloadRef[] };
    expect(envelope.format).toBe('batch-ref-v2');
    expect(envelope.payloads.length).toBeGreaterThan(1);
    expect(db.prepare('select count(*) n from payload_objects').pluck().get()).toBe(
      envelope.payloads.length,
    );
    const read = readBatch(db, 'huge');
    expect(read.logs).toHaveLength(logs.length);
    expect(read.logs[0]!.data).toBe(wide);
    expect(read.manifestHash).toBe(huge.manifestHash);
    db.prepare('delete from payload_objects where hash=?').run(envelope.payloads[0]!.hash);
    expect(() => readBatch(db, 'huge')).toThrow(/missing/i);
  } finally {
    db.close();
  }
}, 120_000);

test('references reject unknown codecs and oversized data before allocation', () => {
  const db = openDatabase(':memory:');
  try {
    expect(() =>
      getPayload(db, {
        version: 1,
        hash: '0'.repeat(64),
        codec: 'br' as 'gzip',
        rawBytes: 0,
      }),
    ).toThrow(/invalid payload reference/i);
    expect(() => putPayload(db, new Uint8Array(64 * 1024 * 1024 + 1))).toThrow(/64 MiB/i);
  } finally {
    db.close();
  }
});
