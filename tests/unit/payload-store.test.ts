import { expect, test } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import {
  getPayload,
  PayloadFormatError,
  putPayload,
  type PayloadRef,
} from '../../src/storage/payload-store.js';

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
