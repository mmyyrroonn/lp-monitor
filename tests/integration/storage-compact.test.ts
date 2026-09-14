import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import { openDatabase } from '../../src/storage/database.js';
import type { BlockAnchor, RawLog } from '../../src/domain/types.js';
import type { FetchShardManifest, RecordedRangeBatch } from '../../src/storage/manifest.js';
import { rawLogKey } from '../../src/storage/manifest.js';
import { readBatch } from '../../src/storage/payload-store.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { auditStorage, compactStorage } from '../../src/ops/storage-audit.js';

function hex(value: number): Hex {
  return `0x${value.toString(16).padStart(64, '0')}` as Hex;
}

function address(value: number): Address {
  return `0x${value.toString(16).padStart(40, '0')}` as Address;
}

function batch(id: string): RecordedRangeBatch {
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
    end: { number: 20n, hash: hex(20), timestampSec: 20 },
    previous: { number: 9n, hash: hex(9), timestampSec: 9 },
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

test('storage compact creates a new equivalent database and leaves source inline payload intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-storage-compact-'));
  const sourcePath = join(dir, 'source.sqlite');
  const targetPath = join(dir, 'compact.sqlite');
  const source = openDatabase(sourcePath);
  const original = batch('legacy-compact');
  new SqliteRangeStore(source).saveRaw(original);
  const sourcePayload = source
    .prepare('select payload_json from ingest_batches where id=?')
    .pluck()
    .get(original.id) as string;
  source.close();
  try {
    const result = await compactStorage(sourcePath, targetPath);
    expect(result.batchesCompacted).toBe(1);
    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(targetPath)).toBe(true);
    const sourceAfter = openDatabase(sourcePath, { readonly: true });
    const target = openDatabase(targetPath, { readonly: true });
    try {
      expect(
        sourceAfter
          .prepare('select payload_json from ingest_batches where id=?')
          .pluck()
          .get(original.id),
      ).toBe(sourcePayload);
      const targetPayload = target
        .prepare('select payload_json from ingest_batches where id=?')
        .pluck()
        .get(original.id) as string;
      expect(JSON.parse(targetPayload).format).toBe('batch-ref-v1');
      expect(readBatch(target, original.id)).toMatchObject({
        id: original.id,
        scopeId: original.scopeId,
        fromBlock: original.fromBlock,
        toBlock: original.toBlock,
        logs: original.logs,
      });
      expect(target.prepare('select count(*) as n from payload_objects').get()).toEqual({ n: 1 });
    } finally {
      sourceAfter.close();
      target.close();
    }
    const sourceAudit = auditStorage(sourcePath);
    const targetAudit = auditStorage(targetPath);
    expect(sourceAudit.rawPayloadBytes).toBeGreaterThan(targetAudit.compressedObjectBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('storage compact rejects an existing target and same source target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-storage-compact-reject-'));
  const sourcePath = join(dir, 'source.sqlite');
  const targetPath = join(dir, 'target.sqlite');
  const db = openDatabase(sourcePath);
  db.close();
  const target = openDatabase(targetPath);
  target.close();
  try {
    await expect(compactStorage(sourcePath, targetPath)).rejects.toThrow(/already exists/i);
    await expect(compactStorage(sourcePath, sourcePath)).rejects.toThrow(/must differ/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
