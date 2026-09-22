import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { LiveProjectionStore } from '../../src/storage/live-projection.js';
import { buildMetricsReport } from '../../src/storage/metric-store.js';
import { readMetricCoverage } from '../../src/metrics/coverage.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { commitAcceptedSignalBatch, projectSignals } from '../../src/signals/project.js';
import { registerRetentionConsumer } from '../../src/storage/retention-state.js';
import { pruneLiveWindow, pruneRawBatches } from '../../src/storage/retention.js';
import { anchor, batch, metricInput, swap } from '../helpers/alert-fixture.js';

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function hotFixture(path = ':memory:') {
  const db = openDatabase(path);
  databases.push(db);
  const archived = batch('archived', [swap(70)]);
  archived.previous = null;
  archived.toBlock = 600n;
  archived.end = anchor(600);
  archived.manifest.shards[0]!.request.toBlock = archived.toBlock;
  archived.boundaries = archived.boundaries!.slice(0, 10);
  new SqliteRangeStore(db).acceptRange(archived);

  const logs = [
    swap(70),
    ...Array.from({ length: 79 }, (_, i) =>
      swap(19270 + i * 60, i >= 73 && i <= 77 ? 30000 : 2000),
    ),
  ];
  const complete = batch('long-hot', logs);
  complete.previous = archived.end;
  complete.toBlock = 24000n;
  complete.end = anchor(24000);
  complete.manifest.shards[0]!.request.toBlock = complete.toBlock;
  complete.boundaries = Array.from({ length: 400 }, (_, i) => {
    const timestampSec = 120 + i * 60;
    return {
      timestampSec,
      firstBlock: BigInt(timestampSec - 60),
      before: anchor(timestampSec - 61),
      at: anchor(timestampSec - 60),
    };
  });
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, complete);
  registerRetentionConsumer(db, {
    scopeId: 's',
    registryScopeId: 's',
    rawRetentionSec: 10920,
    liveRetentionSec: 10920,
    requiredLookbackSec: 10920,
    overlapBlocks: 0,
  });
  db.prepare('delete from checkpoints where block_number < 20000').run();
  db.prepare(
    'insert or ignore into anchors(scope_id,block_number,block_hash,timestamp_sec) values(?,?,?,?)',
  ).run('s', 13080, anchor(13080).hash, 13140);
  return { db, complete };
}

function activeHot(db: Database.Database) {
  return (
    db
      .prepare(
        "select count(*) as n from alerts where json_extract(payload_json,'$.kind')='hot' and active=1",
      )
      .get() as { n: number }
  ).n;
}

test.each(['live', 'batch'] as const)(
  '%s expiry refreshes availability without withdrawing retained hot alerts',
  (kind) => {
    const { db, complete } = hotFixture();
    expect(activeHot(db)).toBe(1);
    if (kind === 'live') expect(pruneLiveWindow(db, 's', 13140).liveEvents).toBe(1);
    else expect(pruneRawBatches(db, 's', 13140).batches).toBe(1);
    const changes = new LiveProjectionStore(db).sync('s', 's', 'c');
    const current = buildMetricsReport(db, metricInput, { live: { historyMinutes: 180 } });
    expect(
      current.coverage.filter((minute) => minute.reasons.includes('retention-expired')),
    ).toEqual([]);
    projectSignals(
      db,
      metricInput,
      initialSignalConfig,
      { batchId: 'after-expiry', observedAtMs: 200000, captureMode: 'synthetic' },
      changes,
    );

    expect(activeHot(db)).toBe(1);
    expect(changes).toMatchObject({ repairFrom: null, coverageChanged: true });
    expect(db.prepare('select * from live_pending_signal_repairs').all()).toEqual([]);
    expect(
      readMetricCoverage(db, 's', [], complete.end, 400).find(
        (minute) => minute.minuteStartSec === 120,
      )?.reasons,
    ).toContain('retention-expired');
  },
);

test.each(['live', 'batch'] as const)(
  '%s expiry does not erase a genuine pending source-coverage repair',
  (kind) => {
    const { db } = hotFixture();
    expect(activeHot(db)).toBe(1);
    db.prepare("delete from accepted_ranges where batch_id='long-hot'").run();
    if (kind === 'live') expect(pruneLiveWindow(db, 's', 13140).liveEvents).toBe(1);
    else expect(pruneRawBatches(db, 's', 13140).batches).toBe(1);
    const changes = new LiveProjectionStore(db).sync('s', 's', 'c');
    expect(changes.repairFrom).toBe(60n);
    projectSignals(
      db,
      metricInput,
      initialSignalConfig,
      { batchId: 'after-source-repair', observedAtMs: 200000, captureMode: 'synthetic' },
      changes,
    );
    expect(activeHot(db)).toBe(0);
  },
);

test('reopening replaces legacy expiry triggers and preserves availability dirtiness without signal repair', () => {
  const directory = mkdtempSync(join(tmpdir(), 'retention-availability-'));
  directories.push(directory);
  const path = join(directory, 'recorded.sqlite');
  const { db } = hotFixture(path);
  // Model an existing 017 database, including the old accepted-range delete trigger.
  db.exec(`
    drop trigger retention_expiration_insert;
    drop trigger retention_expiration_update;
    drop trigger live_coverage_ranges_delete;
    create trigger retention_expiration_insert after insert on retention_expirations begin
      insert into live_dirty_coverage values(new.scope_id,0)
        on conflict(scope_id) do update set min_block=0;
    end;
    create trigger retention_expiration_update after update on retention_expirations begin
      insert into live_dirty_coverage values(new.scope_id,0)
        on conflict(scope_id) do update set min_block=0;
    end;
    create trigger live_coverage_ranges_delete after delete on accepted_ranges begin
      insert into live_dirty_coverage values(old.scope_id,old.from_block)
        on conflict(scope_id) do update set min_block=min(min_block,excluded.min_block);
    end;
    drop table live_dirty_retention;
  `);
  db.close();
  const migrated = openDatabase(path);
  databases.push(migrated);
  // Insertion and then advancement of the same floor exercise both replacement triggers.
  expect(pruneLiveWindow(migrated, 's', 13140).liveEvents).toBe(1);
  expect(pruneRawBatches(migrated, 's', 13140).batches).toBe(1);
  migrated.close();
  const reopened = openDatabase(path);
  databases.push(reopened);
  const changes = new LiveProjectionStore(reopened).sync('s', 's', 'c');
  projectSignals(
    reopened,
    metricInput,
    initialSignalConfig,
    { batchId: 'after-reopen', observedAtMs: 200000, captureMode: 'synthetic' },
    changes,
  );
  expect(activeHot(reopened)).toBe(1);
  expect(changes).toMatchObject({ repairFrom: null, coverageChanged: true });
  expect(reopened.prepare('select * from live_dirty_retention').all()).toEqual([]);
  expect(reopened.prepare('select * from live_pending_signal_repairs').all()).toEqual([]);
  expect(new LiveProjectionStore(reopened).sync('s', 's', 'c')).toMatchObject({
    repairFrom: null,
    coverageChanged: false,
  });
});
