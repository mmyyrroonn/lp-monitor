import { afterEach, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { SqliteProjectionStore } from '../../src/storage/projection-store.js';
import {
  commitAcceptedSignalBatch,
  commitSignalDecision,
  projectSignals,
  retractSignals,
} from '../../src/signals/project.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { decodeSignalState } from '../../src/signals/codec.js';
import { buildMetricsReport } from '../../src/storage/metric-store.js';
import type { AlertRecord, SignalDecision } from '../../src/signals/types.js';
import { batch, hotLogs, metricInput, hash, swap } from '../helpers/alert-fixture.js';
const dbs: Database.Database[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
function setup() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}
const context = { batchId: 'initial', observedAtMs: 100000, captureMode: 'live' as const };
function records(db: Database.Database) {
  return (
    db.prepare('select payload_json from alert_outbox order by sequence').all() as {
      payload_json: string;
    }[]
  ).map((r) => decodeSignalState<AlertRecord>(r.payload_json));
}
test('fresh P3 input emits hot; identical replay 100 times has one revision', () => {
  const db = setup(),
    b = { ...batch('a', hotLogs()), captureMode: 'live' as const };
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, b);
  for (let i = 0; i < 100; i++) projectSignals(db, metricInput, initialSignalConfig, context);
  expect(records(db).map((a) => a.kind)).toEqual(['hot']);
  expect(records(db)[0]!.baseline.fiveMinute.status).toBe('ready');
});
test('removed trigger swaps retract original revision; new branch hot uses new blockHash', () => {
  const db = setup(),
    logs = hotLogs();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, {
    ...batch('a', logs),
    captureMode: 'live',
  });
  const first = records(db)[0]!;
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, {
    ...batch(
      'b',
      logs.filter((_, i) => i < 73 || i > 77),
    ),
    captureMode: 'live',
  });
  expect(records(db).map((a) => a.kind)).toEqual(['hot', 'retracted']);
  expect(records(db)[1]).toMatchObject({ id: first.id, revision: 2, status: 'retracted' });
  const next = {
    ...batch('c', logs),
    captureMode: 'live' as const,
    end: { ...batch('c', logs).end, hash: hash(90000) },
  };
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, next);
  expect(records(db).at(-1)).toMatchObject({ kind: 'hot', endAnchor: { hash: hash(90000) } });
  expect(records(db).at(-1)!.id).not.toBe(first.id);
});
test('raw acceptance, P2 projection, snapshots and outbox roll back together', () => {
  const db = setup();
  db.exec(
    "create trigger crash_alert before insert on alert_outbox begin select raise(abort,'crash'); end",
  );
  expect(() =>
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', hotLogs())),
  ).toThrow('crash');
  expect(new SqliteRangeStore(db).acceptedTip('s')).toBeNull();
  expect(db.prepare('select count(*) n from projection_cursors').get()).toEqual({ n: 0 });
  expect(db.prepare('select count(*) n from signal_snapshots').get()).toEqual({ n: 0 });
});
test('stale projection is rejected, even when old metrics cache exists', () => {
  const db = setup(),
    raw = new SqliteRangeStore(db);
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', hotLogs()));
  raw.acceptRange(batch('b', []));
  expect(() => projectSignals(db, metricInput, initialSignalConfig, context)).toThrow(/stale/i);
  expect(records(db)).toHaveLength(1);
  new SqliteProjectionStore(db).rebuild('s', 's', 'c');
  projectSignals(db, metricInput, initialSignalConfig, { ...context, batchId: 'repaired' });
  expect(records(db).at(-1)!.kind).toBe('retracted');
});
test('recovery with no remaining accepted scope still persists withdrawal of evidence', () => {
  const db = setup();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, {
    ...batch('a', hotLogs()),
    captureMode: 'live',
  });
  db.transaction(() => {
    new SqliteRangeStore(db).resetForWarmup('s');
    retractSignals(db, 's', { ...context, batchId: 'reorg' }, 'scope-rechecking');
  })();
  expect(records(db).at(-1)).toMatchObject({ kind: 'retracted', revision: 2 });
  expect(new SqliteRangeStore(db).acceptedTip('s')).toBeNull();
});
test('added historical baseline and retimed evidence also invalidate provisional reminders', () => {
  for (const mode of ['added', 'retimed']) {
    const db = setup(),
      logs = hotLogs();
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', logs));
    const changed = batch('b', logs);
    if (mode === 'retimed')
      changed.logTimes = changed.logTimes!.map((v, i) =>
        i === 75 ? { ...v, time: { ...v.time, minuteStartSec: 4200 } } : v,
      );
    else {
      const added = { ...logs[10]!, logIndex: 1 };
      changed.logs = [...logs, added];
      changed.manifest.shards[0]!.logCount++;
      changed.manifest.shards[0]!.logKeys = [
        ...changed.manifest.shards[0]!.logKeys,
        '4663:' + added.blockHash + ':' + added.transactionHash + ':1',
      ];
    }
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, changed);
    expect(records(db).some((a) => a.kind === 'retracted')).toBe(true);
  }
});
test('coverage repair with no event changes withdraws unsupported closed-window reminder', () => {
  const db = setup();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', hotLogs()));
  db.prepare('delete from minute_boundaries where scope_id=? and timestamp_sec=?').run('s', 4620);
  projectSignals(db, metricInput, initialSignalConfig, { ...context, batchId: 'coverage-repair' });
  expect(records(db).at(-1)!.kind).toBe('retracted');
});
test('advance with unchanged historical coverage preserves previous alert revision', () => {
  const db = setup(),
    logs = hotLogs();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', logs));
  const next = batch('b', logs);
  next.end = { ...next.end, number: 4801n, timestampSec: 4861, hash: hash(4801) };
  next.toBlock = 4801n;
  next.manifest.shards[0]!.request.toBlock = 4801n;
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, next);
  expect(records(db).map((a) => a.kind)).toEqual(['hot']);
});
test('identical full draft and provenance committed repeatedly retain one revision', () => {
  const db = setup();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', hotLogs()));
  const first = records(db)[0]!;
  const { revision: _revision, provenance, ...recordWithoutRevision } = first;
  const draft = { ...recordWithoutRevision, revision: 1 as const };
  const decision = { alertDraft: draft } as unknown as SignalDecision;
  db.transaction(() => {
    for (let i = 0; i < 100; i++) commitSignalDecision(db, 's', decision, 'synthetic', provenance);
  })();
  expect(records(db)).toHaveLength(1);
  expect(
    db.prepare('select revision from alerts where scope_id=? and id=?').get('s', first.id),
  ).toEqual({
    revision: 1,
  });
});

test('repairing an older incomplete baseline minute retracts an unsupported warming candidate', () => {
  const db = setup();
  const source = batch('candidate-gap', [
    ...Array.from({ length: 60 }, (_, i) => swap(1200 + i * 60, 10_000)),
    swap(4800, 25_000),
  ]);
  const missing = source.boundaries!.find((boundary) => boundary.timestampSec === 2460)!;
  source.boundaries = source.boundaries!.filter(
    (boundary) => boundary.timestampSec >= 1260 && boundary.timestampSec !== missing.timestampSec,
  );
  const candidateOnly = {
    ...initialSignalConfig,
    confirmRelative: { ...initialSignalConfig.confirmRelative, enabled: false },
    confirmConsecutive: { ...initialSignalConfig.confirmConsecutive, enabled: false },
  };
  commitAcceptedSignalBatch(db, metricInput, candidateOnly, source);
  expect(records(db)).toHaveLength(1);
  expect(records(db)[0]).toMatchObject({ kind: 'candidate' });
  expect(records(db)[0]!.reasons).toContain('warming/absolute-only');

  db.prepare(
    `insert into minute_boundaries(
      scope_id,timestamp_sec,first_block,before_number,before_hash,before_timestamp_sec,
      at_number,at_hash,at_timestamp_sec) values(?,?,?,?,?,?,?,?,?)`,
  ).run(
    's',
    missing.timestampSec,
    missing.firstBlock,
    missing.before.number,
    missing.before.hash,
    missing.before.timestampSec,
    missing.at.number,
    missing.at.hash,
    missing.at.timestampSec,
  );
  const repairedReport = buildMetricsReport(db, metricInput);
  expect(
    repairedReport.coverage
      .filter((coverage) => !coverage.complete)
      .map((coverage) => [coverage.minuteStartSec, coverage.reasons]),
  ).toEqual([[4860, ['watermark-partial']]]);
  projectSignals(db, metricInput, candidateOnly, {
    ...context,
    batchId: 'historical-coverage-repaired',
  });
  const repairedClosed = repairedReport.windows[0]!.minutes.filter(
    (minute) => minute.status === 'closed' && minute.usdMicros !== null,
  );
  expect(repairedClosed).toHaveLength(60);
  expect(repairedClosed.every((minute) => minute.usdMicros === 10_000_000_000n)).toBe(true);
  expect(records(db).map((record) => record.kind)).toEqual(['candidate', 'retracted']);
});

test('ordinary current partial becoming a gap retracts its active candidate', () => {
  const db = setup();
  const source = batch('candidate-current-gap', [
    ...Array.from({ length: 60 }, (_, i) => swap(1200 + i * 60, 10_000)),
    swap(4800, 25_000),
  ]);
  source.boundaries = source.boundaries!.filter(
    (boundary) => boundary.timestampSec >= 1260 && boundary.timestampSec !== 2460,
  );
  const candidateOnly = {
    ...initialSignalConfig,
    confirmRelative: { ...initialSignalConfig.confirmRelative, enabled: false },
    confirmConsecutive: { ...initialSignalConfig.confirmConsecutive, enabled: false },
  };
  commitAcceptedSignalBatch(db, metricInput, candidateOnly, source);
  expect(records(db).map((record) => record.kind)).toEqual(['candidate']);

  db.prepare('delete from minute_boundaries where scope_id=? and timestamp_sec=?').run('s', 4860);
  projectSignals(db, metricInput, candidateOnly, {
    ...context,
    batchId: 'current-prefix-became-gap',
  });
  expect(records(db).map((record) => record.kind)).toEqual(['candidate', 'retracted']);
});
