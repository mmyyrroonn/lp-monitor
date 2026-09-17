import { afterEach, expect, test } from 'vitest';
import { toHex } from 'viem';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { readBatch } from '../../src/storage/payload-store.js';
import { BatchCoverageStore } from '../../src/storage/batch-coverage.js';
import { checkBatchIntegrity } from '../../src/replay/integrity.js';
import { acceptedMetricRanges, readMetricCoverage } from '../../src/metrics/coverage.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';
import { rawLogKey, type RecordedRangeBatch } from '../../src/storage/manifest.js';
import type { MinuteBoundary } from '../../src/domain/types.js';

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const SCOPE = 's';
const hash = (n: number) => toHex(n, { size: 32 });
const addr = (n: number) => toHex(n, { size: 20 });
const anchor = (n: number, timestampSec: number) => ({
  number: BigInt(n),
  hash: hash(n),
  timestampSec,
});
const boundary = (timestampSec: number, firstBlock: number): MinuteBoundary => ({
  timestampSec,
  firstBlock: BigInt(firstBlock),
  before: anchor(firstBlock - 1, timestampSec - 1),
  at: anchor(firstBlock, timestampSec),
});

/** Two address partitions over 100..120. `secondTo` shortens one of them, which the batch-wide
 * filter check still accepts while the per-address partition check does not. */
function batch(secondTo = 120n): RecordedRangeBatch {
  return {
    id: 'a',
    scopeId: SCOPE,
    fromBlock: 100n,
    toBlock: 120n,
    end: anchor(120, 180),
    previous: null,
    logs: [],
    observedAtMs: 1,
    captureMode: 'synthetic',
    filterPlanHash: 'f',
    manifestHash: 'm',
    completeness: 'complete',
    boundaries: [boundary(120, 100), boundary(180, 120)],
    manifest: {
      version: 1,
      filterVersion: 'f',
      expectedShardIds: ['one', 'two'],
      shards: ['one', 'two'].map((shardId, i) => ({
        shardId,
        filterId: 'operation-v3',
        request: {
          fromBlock: 100n,
          toBlock: i === 1 ? secondTo : 120n,
          address: [addr(i + 1)],
          topics: [],
        },
        status: 'success',
        responseHash: 'h',
        logKeys: [],
        logCount: 0,
        error: null,
      })),
    },
  };
}

/** One event inside the batch's block interval, assigned to the minute that interval closes. */
function insertEvent(db: Database.Database): number {
  const log = {
    blockNumber: 105n,
    blockHash: hash(105),
    transactionHash: hash(10_500),
    transactionIndex: 0,
    logIndex: 0,
    address: addr(1),
    topics: [hash(7)],
    data: '0x' as const,
    rawBlockTimestamp: '0x0' as const,
  };
  const key = rawLogKey(log);
  db.prepare(
    `insert into raw_logs(
       raw_key,chain_id,block_hash,block_number,transaction_hash,transaction_index,
       log_index,address,topics_json,data,raw_block_timestamp,payload_json
     ) values (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    key,
    4663,
    log.blockHash,
    Number(log.blockNumber),
    log.transactionHash,
    0,
    0,
    log.address,
    JSON.stringify(log.topics),
    log.data,
    log.rawBlockTimestamp,
    '{}',
  );
  const id = db.prepare('select id from raw_logs where raw_key=?').pluck().get(key) as number;
  db.prepare('insert into active_logs values (?,?,?)').run(SCOPE, 'operation-v3', id);
  db.prepare('insert into log_times values (?,?,?,?,?,?)').run(
    SCOPE,
    id,
    120,
    125,
    'log-verified',
    180,
  );
  return id;
}

function fixture(secondTo = 120n) {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db);
  const accepted = batch(secondTo);
  raw.acceptRange(accepted);
  insertEvent(db);
  return { db, raw, accepted, end: accepted.end, proofs: new BatchCoverageStore(db) };
}

/** Run `work` under the structural counters and report the raw batch decodes it needed. */
function measured<T>(work: () => T): { value: T; decodes: number } {
  const scope = openWorkCounts();
  try {
    return { value: work(), decodes: scope.counts.rawBatchDecodes };
  } finally {
    scope.close();
  }
}

const proofRows = (db: Database.Database) =>
  db.prepare('select count(*) from batch_coverage_proofs').pluck().get() as number;
const epochOf = (db: Database.Database) =>
  db.prepare('select epoch from batch_coverage_epoch where id=1').pluck().get() as number;
const minute = (coverage: ReturnType<typeof readMetricCoverage>) =>
  coverage.find((item) => item.minuteStartSec === 120);

test('a batch accepted in its own transaction answers later reads without decoding it', () => {
  const f = fixture();
  expect(f.proofs.read('a')).not.toBeNull();

  const bounded = measured(() => readMetricCoverage(f.db, SCOPE, [], f.end, 180, true));
  expect(minute(bounded.value)).toMatchObject({ complete: true, fromBlock: 100n, toBlock: 119n });
  expect(bounded.decodes).toBe(0);

  const repeated = measured(() => readMetricCoverage(f.db, SCOPE, [], f.end, 180, true));
  expect(repeated.value).toEqual(bounded.value);
  expect(repeated.decodes).toBe(0);

  const ranges = measured(() => acceptedMetricRanges(f.db, SCOPE));
  expect(ranges.value).toEqual([{ fromBlock: 100n, toBlock: 120n }]);
  expect(ranges.decodes).toBe(0);
});

test('a bounded horizon decodes neither the proven window batch nor an old batch outside it', () => {
  const f = fixture();
  // An accepted batch from before the proof table existed, outside this read's window.
  const older = batch();
  const seeded: RecordedRangeBatch = {
    ...older,
    id: 'old',
    fromBlock: 1n,
    toBlock: 99n,
    end: anchor(99, 60),
    boundaries: [],
    manifest: {
      ...older.manifest,
      shards: older.manifest.shards.map((shard) => ({
        ...shard,
        request: { ...shard.request, fromBlock: 1n, toBlock: 99n },
      })),
    },
  };
  f.raw.saveRaw(seeded);
  f.db
    .prepare('insert into accepted_ranges values (?,?,?,?,?,?)')
    .run(SCOPE, 'old', 'operation-v3', 1, 99, 1);

  const bounded = measured(() => readMetricCoverage(f.db, SCOPE, [], f.end, 180, true));
  expect(bounded.decodes).toBe(0);
  expect(minute(bounded.value)).toMatchObject({ complete: true });

  const full = measured(() => acceptedMetricRanges(f.db, SCOPE));
  expect(full.value).toHaveLength(2);
  expect(full.value).toContainEqual({ fromBlock: 1n, toBlock: 99n });
  expect(full.decodes).toBe(1);
});

test('a stored batch without a proof decodes, and an explicit warm-up proves only what it is given', () => {
  const f = fixture();
  // What a database migrated to 012 looks like: accepted batches with no proof written yet.
  f.db.prepare('delete from batch_coverage_proofs where batch_id=?').run('a');
  expect(f.proofs.read('a')).toBeNull();
  expect(proofRows(f.db)).toBe(0);

  const cold = measured(() => acceptedMetricRanges(f.db, SCOPE));
  expect(cold.value).toEqual([{ fromBlock: 100n, toBlock: 120n }]);
  expect(cold.decodes).toBe(1);

  // Cold start is an explicit list of batches in one maintenance transaction, never a scan of
  // stored history, and it costs exactly one decode per batch named.
  const warm = measured(() => {
    f.db.transaction(() => {
      for (const id of ['a']) f.proofs.accept(readBatch(f.db, id));
    })();
  });
  expect(warm.decodes).toBe(1);
  expect(f.proofs.read('a')).not.toBeNull();

  const after = measured(() => acceptedMetricRanges(f.db, SCOPE));
  expect(after.value).toEqual(cold.value);
  expect(after.decodes).toBe(0);
});

test('a batch whose address partitions do not all cover its range is accepted without a proof', () => {
  // acceptRange accepts this batch: every filter covers the range block by block. Its per-address
  // partitions do not, so a proof claiming coverage would say more than a strict read can confirm.
  const f = fixture(110n);
  expect(f.proofs.read('a')).toBeNull();
  expect(proofRows(f.db)).toBe(0);

  const ranges = measured(() => acceptedMetricRanges(f.db, SCOPE));
  expect(ranges.value).toEqual([]);
  expect(ranges.decodes).toBe(1);
  expect(minute(readMetricCoverage(f.db, SCOPE, [], f.end))?.complete).toBe(false);
});

test('a shard status or count change drops the proof and the batch has to be re-verified', () => {
  const status = fixture();
  status.db.prepare("update fetch_shards set status='failed' where shard_id='two'").run();
  expect(proofRows(status.db)).toBe(0);
  expect(status.proofs.read('a')).toBeNull();
  const failed = measured(() => acceptedMetricRanges(status.db, SCOPE));
  expect(failed.value).toEqual([]);
  expect(failed.decodes).toBe(1);
  expect(minute(readMetricCoverage(status.db, SCOPE, [], status.end))?.complete).toBe(false);

  // Repairing the row restores the verdict through strict verification only: no reader writes
  // evidence back, so this batch keeps decoding until it is accepted again.
  status.db.prepare("update fetch_shards set status='success' where shard_id='two'").run();
  expect(status.proofs.read('a')).toBeNull();
  expect(acceptedMetricRanges(status.db, SCOPE)).toEqual([{ fromBlock: 100n, toBlock: 120n }]);

  const counted = fixture();
  counted.db.prepare("update fetch_shards set log_count=7 where shard_id='two'").run();
  expect(counted.proofs.read('a')).toBeNull();
  expect(acceptedMetricRanges(counted.db, SCOPE)).toEqual([]);
});

test('a payload rewrite drops the proof and a batch that no longer decodes for this scope is not counted', () => {
  const f = fixture();
  const original = f.db
    .prepare("select payload_json from ingest_batches where id='a'")
    .pluck()
    .get() as string;
  const rewritten = JSON.parse(original) as RecordedRangeBatch;
  rewritten.scopeId = 'other';
  f.db
    .prepare("update ingest_batches set payload_json=? where id='a'")
    .run(JSON.stringify(rewritten));

  expect(proofRows(f.db)).toBe(0);
  expect(f.proofs.read('a')).toBeNull();
  const ranges = measured(() => acceptedMetricRanges(f.db, SCOPE));
  expect(ranges.value).toEqual([]);
  expect(ranges.decodes).toBe(1);
});

test('payload object content and deletion are refused by the epoch, not by losing the proof row', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db);
  const accepted = batch();
  raw.saveRaw(accepted, { compact: true });
  raw.acceptRange(accepted);
  const proofs = new BatchCoverageStore(db);
  expect(proofs.read('a')).not.toBeNull();
  expect(db.prepare('select count(*) from payload_objects').pluck().get()).toBeGreaterThan(0);

  const streamed = measured(() => acceptedMetricRanges(db, SCOPE));
  expect(streamed.value).toEqual([{ fromBlock: 100n, toBlock: 120n }]);
  expect(streamed.decodes).toBe(0);

  db.prepare('update payload_objects set payload=?').run(Buffer.from('not a gzip stream'));
  expect(epochOf(db)).toBe(1);
  expect(proofRows(db)).toBe(1);
  expect(proofs.read('a')).toBeNull();
  const changed = measured(() => acceptedMetricRanges(db, SCOPE));
  expect(changed.value).toEqual([]);
  expect(changed.decodes).toBe(1);

  db.prepare('delete from payload_objects').run();
  expect(epochOf(db)).toBe(2);
  expect(proofRows(db)).toBe(1);
  expect(proofs.read('a')).toBeNull();
  expect(acceptedMetricRanges(db, SCOPE)).toEqual([]);
});

test('raw evidence changes invalidate the proof and the reader re-derives the minute', () => {
  const f = fixture();
  expect(f.proofs.read('a')).not.toBeNull();
  expect(minute(readMetricCoverage(f.db, SCOPE, [], f.end))?.complete).toBe(true);

  // The same value written again is not a change: the live path re-writes identical rows.
  f.db.prepare('update raw_logs set data=data').run();
  expect(epochOf(f.db)).toBe(0);
  expect(f.proofs.read('a')).not.toBeNull();

  // A real change moves the event out of the block interval its minute claims.
  f.db.prepare('update raw_logs set block_number=10').run();
  expect(epochOf(f.db)).toBe(1);
  expect(proofRows(f.db)).toBe(1);
  expect(f.proofs.read('a')).toBeNull();
  const rederived = measured(() => acceptedMetricRanges(f.db, SCOPE));
  expect(rederived.value).toEqual([{ fromBlock: 100n, toBlock: 120n }]);
  expect(rederived.decodes).toBe(1);
  expect(minute(readMetricCoverage(f.db, SCOPE, [], f.end))?.reasons).toContain(
    'event-time-mismatch',
  );
});

test('a raw evidence deletion invalidates the proof even for an already re-derived verdict', () => {
  const f = fixture();
  expect(f.proofs.read('a')).not.toBeNull();
  expect(minute(readMetricCoverage(f.db, SCOPE, [], f.end))?.complete).toBe(true);

  // Retention removes the event's rows. The batch's own shard evidence is untouched, so the
  // verdict survives, but the epoch refuses the proof and the reader has to derive it again.
  f.db.prepare('delete from log_times').run();
  f.db.prepare('delete from active_logs').run();
  f.db.prepare('delete from raw_logs').run();
  expect(epochOf(f.db)).toBe(1);
  expect(proofRows(f.db)).toBe(1);
  expect(f.proofs.read('a')).toBeNull();
  const rederived = measured(() => acceptedMetricRanges(f.db, SCOPE));
  expect(rederived.value).toEqual([{ fromBlock: 100n, toBlock: 120n }]);
  expect(rederived.decodes).toBe(1);
});

test('a rolled back accept leaves no proof and a rolled back change leaves the proof standing', () => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db);
  expect(() =>
    db.transaction(() => {
      raw.acceptRange(batch());
      throw new Error('abort');
    })(),
  ).toThrow('abort');
  expect(db.prepare('select count(*) from ingest_batches').pluck().get()).toBe(0);
  expect(proofRows(db)).toBe(0);
  expect(measured(() => acceptedMetricRanges(db, SCOPE)).decodes).toBe(0);

  const f = fixture();
  expect(() =>
    f.db.transaction(() => {
      f.db.prepare("update fetch_shards set status='failed' where shard_id='two'").run();
      throw new Error('abort');
    })(),
  ).toThrow('abort');
  expect(f.proofs.read('a')).not.toBeNull();
  const ranges = measured(() => acceptedMetricRanges(f.db, SCOPE));
  expect(ranges.value).toEqual([{ fromBlock: 100n, toBlock: 120n }]);
  expect(ranges.decodes).toBe(0);
});

test('a proof is never reused for another scope', () => {
  const f = fixture();
  f.db
    .prepare('insert into accepted_ranges values (?,?,?,?,?,?)')
    .run('other', 'a', 'operation-v3', 100, 120, 1);
  const other = measured(() => acceptedMetricRanges(f.db, 'other'));
  expect(other.value).toEqual([]);
  expect(other.decodes).toBe(0);
  expect(acceptedMetricRanges(f.db, SCOPE)).toEqual([{ fromBlock: 100n, toBlock: 120n }]);
});

test('the stored row comparisons refuse a proof whose batch row moved without the trigger', () => {
  const f = fixture();
  f.db.prepare('drop trigger ingest_batch_change').run();
  const original = f.db
    .prepare("select payload_json from ingest_batches where id='a'")
    .pluck()
    .get() as string;
  const rewritten = JSON.parse(original) as RecordedRangeBatch;
  rewritten.toBlock = 1_000_000n;
  f.db
    .prepare("update ingest_batches set payload_json=? where id='a'")
    .run(
      JSON.stringify(rewritten, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString(10) : value,
      ),
    );

  expect(proofRows(f.db)).toBe(1);
  expect(f.proofs.read('a')).toBeNull();
  expect(acceptedMetricRanges(f.db, SCOPE)).toEqual([]);
});

test('a proof row edited in place is refused by its own digest', () => {
  const f = fixture();
  const stored = f.db
    .prepare('select proof_json from batch_coverage_proofs where batch_id=?')
    .pluck()
    .get('a') as string;
  const edited = JSON.parse(stored) as { filters: string[] };
  edited.filters = ['operation-v3', 'operation-v4'];
  f.db
    .prepare('update batch_coverage_proofs set proof_json=? where batch_id=?')
    .run(JSON.stringify(edited), 'a');

  expect(f.proofs.read('a')).toBeNull();
  const ranges = measured(() => acceptedMetricRanges(f.db, SCOPE));
  // The edited filters never reach a caller: the strict path answers instead.
  expect(ranges.value).toEqual([{ fromBlock: 100n, toBlock: 120n }]);
  expect(ranges.decodes).toBe(1);
});

test('a stored proof never substitutes for the strict audit that re-derives coverage', () => {
  const f = fixture();
  expect(f.proofs.read('a')).not.toBeNull();
  // The audit answers from the batch it was handed, never from a stored verdict: a batch whose own
  // shard evidence was rewritten to a failure is reported even though this database held a proof
  // for the same batch id a moment earlier.
  const original = f.db
    .prepare("select payload_json from ingest_batches where id='a'")
    .pluck()
    .get() as string;
  const rewritten = JSON.parse(original) as RecordedRangeBatch;
  rewritten.manifest.shards[1]!.status = 'failed';
  f.db
    .prepare("update ingest_batches set payload_json=? where id='a'")
    .run(JSON.stringify(rewritten));

  expect(checkBatchIntegrity(readBatch(f.db, 'a'), false)).toEqual([
    {
      code: 'shard-incomplete',
      batchId: 'a',
      detail: 'Raw shard coverage failed P1 validation',
    },
  ]);
  // The reader may consult the proof, and here it is refused twice over: the row change dropped
  // the proof, and the batch's own evidence no longer supports acceptance.
  expect(f.proofs.read('a')).toBeNull();
  expect(acceptedMetricRanges(f.db, SCOPE)).toEqual([]);
});

test('a readonly snapshot taken before 012 keeps the strict read path', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const f = fixture();
  const expected = readMetricCoverage(f.db, SCOPE, [], f.end);
  for (const trigger of [
    'ingest_batch_change',
    'ingest_batch_delete',
    'fetch_shard_change',
    'fetch_shard_delete',
    'raw_logs_evidence_change',
    'raw_logs_evidence_delete',
    'payload_object_change',
    'payload_object_delete',
  ])
    f.db.prepare(`drop trigger ${trigger}`).run();
  f.db.exec('drop table batch_coverage_proofs; drop table batch_coverage_epoch;');

  const directory = mkdtempSync(join(tmpdir(), 'lp-batch-coverage-'));
  try {
    const path = join(directory, 'legacy.sqlite');
    await f.db.backup(path);
    const readonly = openDatabase(path, { readonly: true });
    try {
      expect(
        readonly.prepare("select 1 from sqlite_master where name='batch_coverage_proofs'").get(),
      ).toBeUndefined();
      expect(readMetricCoverage(readonly, SCOPE, [], f.end)).toEqual(expected);
    } finally {
      readonly.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
