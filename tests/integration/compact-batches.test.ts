import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import { openDatabase } from '../../src/storage/database.js';
import type { BlockAnchor, RawLog } from '../../src/domain/types.js';
import {
  rawLogKey,
  type FetchShardManifest,
  type RecordedRangeBatch,
} from '../../src/storage/manifest.js';
import { readBatch, writeCompactBatch } from '../../src/storage/payload-store.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';

function hex(value: number): Hex {
  return `0x${value.toString(16).padStart(64, '0')}` as Hex;
}

function address(value: number): Address {
  return `0x${value.toString(16).padStart(40, '0')}` as Address;
}

function anchor(number: bigint): BlockAnchor {
  return { number, hash: hex(Number(number)), timestampSec: Number(number) };
}

function compactBatch(id: string): RecordedRangeBatch {
  const log: RawLog = {
    blockHash: hex(15),
    blockNumber: 15n,
    transactionHash: hex(1500),
    transactionIndex: 0,
    logIndex: 0,
    address: address(10),
    topics: [hex(20)],
    data: hex(30),
    rawBlockTimestamp: null,
  };
  const shard: FetchShardManifest = {
    shardId: 'F:10-20',
    filterId: 'F',
    request: { fromBlock: 10n, toBlock: 20n, address: [log.address], topics: [] },
    status: 'success',
    responseHash: hex(900),
    logKeys: [rawLogKey(log)],
    logCount: 1,
    error: null,
  };
  return {
    id,
    scopeId: 'scope-a',
    fromBlock: 10n,
    toBlock: 20n,
    end: anchor(20n),
    previous: anchor(9n),
    logs: [log],
    observedAtMs: 1000,
    captureMode: 'synthetic',
    filterPlanHash: 'plan-F',
    manifestHash: 'manifest-' + id,
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'version-F',
      expectedShardIds: [shard.shardId],
      shards: [shard],
    },
  };
}

test('compact batch preserves the logical batch and can be accepted by the range store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-compact-batch-'));
  const db = openDatabase(join(dir, 'db.sqlite'));
  try {
    const batch = compactBatch('compact-1');
    writeCompactBatch(db, batch);
    expect(
      JSON.parse(
        db
          .prepare('select payload_json from ingest_batches where id=?')
          .pluck()
          .get(batch.id) as string,
      ),
    ).toMatchObject({
      format: 'batch-ref-v1',
      payload: { codec: 'gzip', rawBytes: expect.any(Number) },
    });
    expect(db.prepare('select count(*) as n from payload_objects').get()).toEqual({ n: 1 });
    expect(readBatch(db, batch.id)).toEqual(batch);
    expect(new SqliteRangeStore(db).acceptRange(batch).added).toHaveLength(1);
    expect(new SqliteRangeStore(db).activeLogs(batch.scopeId)).toHaveLength(1);
    writeCompactBatch(db, batch);
    expect(db.prepare('select count(*) as n from payload_objects').get()).toEqual({ n: 1 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy inline batches remain readable', () => {
  const db = openDatabase(':memory:');
  try {
    const batch = compactBatch('legacy-1');
    const store = new SqliteRangeStore(db);
    store.saveRaw(batch);
    const decoded = readBatch(db, batch.id);
    expect(decoded).toMatchObject({
      id: batch.id,
      scopeId: batch.scopeId,
      fromBlock: batch.fromBlock,
      toBlock: batch.toBlock,
      logs: batch.logs,
      manifest: batch.manifest,
    });
    expect(db.prepare('select count(*) as n from payload_objects').get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

test('compact reader fails when the referenced object hash is wrong', () => {
  const db = openDatabase(':memory:');
  try {
    const batch = compactBatch('corrupt-1');
    writeCompactBatch(db, batch);
    const ref = JSON.parse(
      db
        .prepare('select payload_json from ingest_batches where id=?')
        .pluck()
        .get(batch.id) as string,
    ) as {
      payload: { hash: string };
    };
    db.prepare('update payload_objects set payload=? where hash=?').run(
      Buffer.from('not-gzip'),
      ref.payload.hash,
    );
    expect(() => readBatch(db, batch.id)).toThrow(/gzip|hash|payload/i);
  } finally {
    db.close();
  }
});
