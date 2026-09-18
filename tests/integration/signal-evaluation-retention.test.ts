import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadEnv } from '../../src/config/env.js';
import { computeWatchScopeId } from '../../src/ingest/filter-plan.js';
import { loadMetricMetadata } from '../../src/metrics/metadata.js';
import { runRecorder, type RecorderOptions } from '../../src/ops/recorder.js';
import { createShutdownController } from '../../src/ops/shutdown.js';
import { loadAssetVersion } from '../../src/registry/assets.js';
import { parseSignalConfig } from '../../src/signals/config.js';
import {
  previewSignalEvaluationRetention,
  pruneSignalDerivedHistory,
  pruneSignalEvaluations,
  reclaimPayloadObjects,
} from '../../src/signals/project.js';
import { openDatabase } from '../../src/storage/database.js';
import { encodeBatchReference, putPayload } from '../../src/storage/payload-store.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

function evaluationRow(
  db: ReturnType<typeof openDatabase>,
  scope: string,
  batch: string,
  pool: string,
  content = batch,
) {
  db.prepare(
    'insert into signal_evaluations(scope_id,batch_id,source_hash,pool_id,payload_json) values(?,?,?,?,?)',
  ).run(scope, batch, 'source', pool, encodeBatchReference(putPayload(db, Buffer.from(content))));
}

function rowsPerPool(db: ReturnType<typeof openDatabase>, scope: string) {
  return db
    .prepare(
      `select pool_id, count(*) as n, group_concat(batch_id) as batches
       from (select pool_id, batch_id from signal_evaluations where scope_id=? order by batch_id)
       group by pool_id order by pool_id`,
    )
    .all(scope);
}

function objectCount(db: ReturnType<typeof openDatabase>): number {
  return db.prepare('select count(*) n from payload_objects').pluck().get() as number;
}

function threeBatches(db: ReturnType<typeof openDatabase>, scope: string) {
  evaluationRow(db, scope, 'b1', 'pool-a');
  evaluationRow(db, scope, 'b2', 'pool-a');
  evaluationRow(db, scope, 'b3', 'pool-a');
  evaluationRow(db, scope, 'b1', 'pool-b');
  evaluationRow(db, scope, 'b2', 'pool-b');
}

test('retention keeps each pool newest rows instead of the newest rows overall', () => {
  const db = openDatabase(':memory:');
  try {
    threeBatches(db, 's');
    // A scope-wide newest-2 keeps the last two rows written, which is one pool's history twice
    // over and drops the pool the snapshot's own write order put first.
    const global = pruneSignalDerivedHistory(db, 's', { evaluations: 2, terminalDeliveries: 0 });
    expect(global.evaluations).toBe(3);
    expect(rowsPerPool(db, 's')).toEqual([{ pool_id: 'pool-b', n: 2, batches: 'b1,b2' }]);
  } finally {
    db.close();
  }
  const perPool = openDatabase(':memory:');
  try {
    threeBatches(perPool, 's');
    const pruned = pruneSignalEvaluations(perPool, 's', 1);
    expect(pruned.deleted).toBe(3);
    // Each pool keeps its own newest row, so a pool that the last batch did not touch keeps
    // the state it was last evaluated in.
    expect(rowsPerPool(perPool, 's')).toEqual([
      { pool_id: 'pool-a', n: 1, batches: 'b3' },
      { pool_id: 'pool-b', n: 1, batches: 'b2' },
    ]);
    expect(pruneSignalEvaluations(perPool, 's', 1)).toEqual({ deleted: 0 });
  } finally {
    perPool.close();
  }
});

test('retention applies to the named scope only and to no pool below the limit', () => {
  const db = openDatabase(':memory:');
  try {
    evaluationRow(db, 's', 'b1', 'pool-a');
    evaluationRow(db, 's', 'b2', 'pool-a');
    evaluationRow(db, 'other', 'b1', 'pool-a');
    evaluationRow(db, 'other', 'b2', 'pool-a');
    expect(pruneSignalEvaluations(db, 's', 1)).toEqual({ deleted: 1 });
    expect(rowsPerPool(db, 's')).toEqual([{ pool_id: 'pool-a', n: 1, batches: 'b2' }]);
    expect(rowsPerPool(db, 'other')).toEqual([{ pool_id: 'pool-a', n: 2, batches: 'b1,b2' }]);
  } finally {
    db.close();
  }
});

test('a retention of zero clears the scope, and invalid limits are rejected', () => {
  const db = openDatabase(':memory:');
  try {
    threeBatches(db, 's');
    for (const keep of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => pruneSignalEvaluations(db, 's', keep)).toThrow(RangeError);
    for (const maxRows of [0, -2, 1.5])
      expect(() => pruneSignalEvaluations(db, 's', 1, { maxRows })).toThrow(RangeError);
    expect(db.prepare('select count(*) n from signal_evaluations').pluck().get()).toBe(5);
    expect(pruneSignalEvaluations(db, 's', 0)).toEqual({ deleted: 5 });
    expect(db.prepare('select count(*) n from signal_evaluations').pluck().get()).toBe(0);
  } finally {
    db.close();
  }
});

test('a bounded pass deletes the oldest rows and converges when it is repeated', () => {
  const db = openDatabase(':memory:');
  try {
    threeBatches(db, 's');
    evaluationRow(db, 's', 'b1', 'pool-c');
    evaluationRow(db, 's', 'b2', 'pool-c');
    evaluationRow(db, 's', 'b1', 'pool-d');
    expect(pruneSignalEvaluations(db, 's', 1, { maxRows: 2 })).toEqual({ deleted: 2 });
    // Oldest first: the two pool-a rows written before any other pool.
    expect(rowsPerPool(db, 's')).toEqual([
      { pool_id: 'pool-a', n: 1, batches: 'b3' },
      { pool_id: 'pool-b', n: 2, batches: 'b1,b2' },
      { pool_id: 'pool-c', n: 2, batches: 'b1,b2' },
      { pool_id: 'pool-d', n: 1, batches: 'b1' },
    ]);
    expect(pruneSignalEvaluations(db, 's', 1, { maxRows: 2 })).toEqual({ deleted: 2 });
    expect(pruneSignalEvaluations(db, 's', 1, { maxRows: 2 })).toEqual({ deleted: 0 });
    expect(db.prepare('select count(*) n from signal_evaluations').pluck().get()).toBe(4);
  } finally {
    db.close();
  }
});

test('the preview counts what the pass then deletes, without changing anything', () => {
  const db = openDatabase(':memory:');
  try {
    threeBatches(db, 's');
    evaluationRow(db, 'other', 'b1', 'pool-a', 'other-scope');
    evaluationRow(db, 'other', 'b2', 'pool-a', 'other-scope');
    const before = db.prepare('select count(*) n from signal_evaluations').pluck().get();
    const preview = previewSignalEvaluationRetention(db, 's', 1);
    expect(preview.rows).toBe(3);
    expect(preview.totalRows).toBe(5);
    expect(preview.pools).toBe(2);
    expect(preview.payloadBytes).toBeGreaterThan(0);
    // The other scope keeps both of its rows, so the object only they share survives the pass
    // and is not reported for collection.
    expect(preview.orphanPayloadObjects).toBe(1);
    expect(db.prepare('select count(*) n from signal_evaluations').pluck().get()).toBe(before);
    expect(pruneSignalEvaluations(db, 's', 1)).toEqual({ deleted: preview.rows });
    // The preview's orphan count is the reclaim's result, not an estimate of it: both derive
    // the live set from the rows the retention leaves behind.
    expect(reclaimPayloadObjects(db)).toEqual({ payloadObjects: preview.orphanPayloadObjects });
  } finally {
    db.close();
  }
});

test('deleting rows leaves payload reclamation to a step of its own', () => {
  const db = openDatabase(':memory:');
  try {
    evaluationRow(db, 's', 'b1', 'pool-a', 'keep');
    evaluationRow(db, 's', 'b2', 'pool-a', 'drop-me');
    evaluationRow(db, 's', 'b3', 'pool-a', 'keep');
    expect(objectCount(db)).toBe(2);
    expect(pruneSignalEvaluations(db, 's', 1)).toEqual({ deleted: 2 });
    // Two rows are gone and one of their objects is unreferenced, but nothing has collected it.
    expect(objectCount(db)).toBe(2);
    expect(reclaimPayloadObjects(db)).toEqual({ payloadObjects: 1 });
    expect(objectCount(db)).toBe(1);
  } finally {
    db.close();
  }
});

/** Wait for a condition the run reaches on its own, without pinning it to a tick count. */
async function until(predicate: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was never reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('the recorder prunes the scope it evaluates, at its poll gap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-evaluation-retention-'));
  const fixture = recorderFixture();
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
    if (typeof value === 'string') lines.push(value);
  });
  const shutdown = createShutdownController(new EventEmitter());
  const config = loadChainConfig('config/robinhood.json');
  const assets = loadAssetVersion('config/watchlist.amc.json');
  const databasePath = join(dir, 'source.sqlite');
  // Seed a pool with history the way a run leaves it: several evaluations of one pool, all of
  // them older than the run about to start. The scope has to be the one the recorder evaluates,
  // or the rows are left where the retention never looks.
  const seeded = openDatabase(databasePath);
  const scopeId = computeWatchScopeId(assets, 'operations', {
    v3Factory: config.v3Factory,
    v4Manager: config.v4Manager,
  });
  evaluationRow(seeded, scopeId, 'old-1', 'seeded-pool');
  evaluationRow(seeded, scopeId, 'old-2', 'seeded-pool');
  evaluationRow(seeded, scopeId, 'old-3', 'seeded-pool');
  seeded.close();
  const options: RecorderOptions = {
    command: 'follow',
    fromBlock: 90n,
    notify: 'local',
    config,
    env: loadEnv({ RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' }),
    watchlistPath: 'config/watchlist.amc.json',
    databasePath,
    outputDirectory: join(dir, 'runs'),
    durationMs: 10_000,
    maxCalls: 10_000,
    evidenceMode: 'off',
    metricMetadata: loadMetricMetadata('config/metric-metadata.json'),
    signalConfig: parseSignalConfig(
      JSON.parse(readFileSync('config/signals.initial.json', 'utf8')),
    ),
    readerFactory: fixture.factory,
    shutdown,
  };
  const run = runRecorder(options);
  try {
    await until(() => lines.some((line) => line.includes('"signal-evaluation-retention"')));
  } finally {
    shutdown.request('SIGINT');
    shutdown.dispose();
    spy.mockRestore();
  }
  expect(await run).toBe(0);
  const db = openDatabase(databasePath);
  try {
    const line = JSON.parse(
      lines.find((value) => value.includes('"signal-evaluation-retention"'))!,
    ) as { deleted: number };
    // The seeded pool is two rows over the limit; the round this same poll gap repaired is the
    // only other thing holding more than one row for a pool.
    expect(line.deleted).toBeGreaterThanOrEqual(2);
    // The seeded pool keeps its newest row.
    expect(
      db
        .prepare('select batch_id from signal_evaluations where scope_id=? and pool_id=?')
        .pluck()
        .get(scopeId, 'seeded-pool'),
    ).toBe('old-3');
  } finally {
    db.close();
  }
});

test('reclamation keeps objects a surviving batch or evaluation still references', () => {
  const db = openDatabase(':memory:');
  try {
    const batchObject = putPayload(db, Buffer.from('batch-content'));
    db.prepare(
      `insert into ingest_batches(
         id,scope_id,chain_id,from_block,to_block,end_hash,end_timestamp_sec,observed_at_ms,
         capture_mode,filter_plan_hash,manifest_hash,completeness,payload_json
       ) values('b1','s',4663,1,2,'0x00',1,1,'synthetic','f','m','complete',?)`,
    ).run(encodeBatchReference(batchObject));
    evaluationRow(db, 's', 'b1', 'pool-a', 'shared-with-survivor');
    evaluationRow(db, 's', 'b2', 'pool-a', 'shared-with-survivor');
    evaluationRow(db, 's', 'b1', 'pool-b', 'evaluation-only');
    evaluationRow(db, 's', 'b2', 'pool-b', 'survivor-content');
    expect(pruneSignalEvaluations(db, 's', 1)).toEqual({ deleted: 2 });
    expect(reclaimPayloadObjects(db)).toEqual({ payloadObjects: 1 });
    expect(objectCount(db)).toBe(3);
    // The object the batch still references outlives the evaluation rows that also used it,
    // and so does the one an evaluation row survives with.
    expect(
      db
        .prepare('select count(*) n from payload_objects where hash=?')
        .pluck()
        .get(batchObject.hash),
    ).toBe(1);
    expect(
      db
        .prepare(
          "select count(*) n from payload_objects where hash=(select json_extract(payload_json,'$.payload.hash') from signal_evaluations where pool_id='pool-a')",
        )
        .pluck()
        .get(),
    ).toBe(1);
  } finally {
    db.close();
  }
});
