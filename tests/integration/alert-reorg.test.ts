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
  pruneSignalDerivedHistory,
} from '../../src/signals/project.js';
import { AlertOutbox } from '../../src/notify/outbox.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { decodeSignalState } from '../../src/signals/codec.js';
import { buildMetricsReport } from '../../src/storage/metric-store.js';
import type { AlertRecord, SignalDecision } from '../../src/signals/types.js';
import {
  batch,
  hotLogs,
  metricInput,
  hash,
  swap,
  registration,
  addr,
} from '../helpers/alert-fixture.js';
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

test('unchanged recovery preserves cooldown and does not create a fresh episode', () => {
  const db = setup();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', hotLogs()));
  const snapshot = db.prepare('select payload_json from signal_snapshots').get();
  retractSignals(db, 's', { ...context, batchId: 'recheck' }, 'rechecking');
  expect(db.prepare('select payload_json from signal_snapshots').get()).toEqual(snapshot);
  projectSignals(db, metricInput, initialSignalConfig, {
    ...context,
    batchId: 'unchanged',
    observedAtMs: 999999,
  });
  expect(records(db).map((record) => record.kind)).toEqual(['hot', 'retracted']);
});

test('fromBlock after old alert preserves its active identity and snapshot', () => {
  const db = setup();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', hotLogs()));
  const snapshot = db.prepare('select payload_json from signal_snapshots').get();
  expect(retractSignals(db, 's', context, 'later-evidence', 99999n)).toEqual([]);
  expect(db.prepare('select payload_json from signal_snapshots').get()).toEqual(snapshot);
  expect(db.prepare('select active from alerts').get()).toEqual({ active: 1 });
});

test('unrelated historical registration does not retract an existing hot pool', () => {
  const db = setup();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', hotLogs()));
  const first = records(db)[0]!;
  const snapshot = db
    .prepare('select payload_json from signal_snapshots where pool_id=?')
    .get(first.poolId);
  const next = batch('b', hotLogs());
  next.poolRegistrations = [
    ...next.poolRegistrations!,
    {
      ...registration,
      pool: { chainId: 4663, protocol: 'v3', address: addr(100) },
      discoveredAt: swap(70),
    },
  ];
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, next);
  expect(records(db).filter((record) => record.poolId === first.poolId)).toHaveLength(1);
  expect(
    db.prepare('select payload_json from signal_snapshots where pool_id=?').get(first.poolId),
  ).toEqual(snapshot);
});

test('same chain evidence with different batch and arrival time has stable alert IDs', () => {
  const ids = ['receipt-one', 'receipt-two'].map((id, index) => {
    const db = setup();
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, {
      ...batch(id, hotLogs()),
      observedAtMs: index * 10000,
    });
    return records(db).map((record) => record.id);
  });
  expect(ids[0]).toEqual(ids[1]);
});

test('durable comparison ignores undefined properties removed by JSON storage', () => {
  const db = setup();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', hotLogs()));
  const first = records(db)[0]!;
  const decision = {
    alertDraft: { ...first, revision: 1, absent: undefined },
  } as unknown as SignalDecision;
  db.transaction(() => commitSignalDecision(db, 's', decision, 'synthetic'))();
  expect(records(db)).toHaveLength(1);
});

test('explicit derived retention preserves pending, failed and raw evidence', () => {
  const db = setup();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', hotLogs()));
  const raw = db.prepare('select count(*) n from raw_logs').get();
  const insert = db.prepare(
    "insert into alert_outbox(scope_id,alert_id,revision,capture_mode,status,payload_json) values('s',?,1,'live',?,'{}')",
  );
  for (const status of ['sent', 'superseded', 'failed', 'pending']) insert.run(status, status);
  expect(pruneSignalDerivedHistory(db, 's', { evaluations: 0, terminalDeliveries: 0 })).toEqual({
    evaluations: 1,
    terminalDeliveries: 2,
    payloadObjects: 1,
  });
  expect(db.prepare('select count(*) n from raw_logs').get()).toEqual(raw);
  expect(db.prepare('select status from alert_outbox order by sequence').all()).toEqual([
    { status: 'pending' },
    { status: 'failed' },
    { status: 'pending' },
  ]);
  expect(db.prepare('select count(*) n from alerts').get()).toEqual({ n: 1 });
});

test('material correction to consumed entry bucket revises the same episode under cooldown', () => {
  const db = setup();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', hotLogs()));
  const first = records(db)[0]!;
  const changed = [
    ...hotLogs(),
    ...hotLogs()
      .slice(74, 79)
      .map((log) => ({ ...log, logIndex: 1 })),
  ];
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('corrected', changed));
  expect(records(db).map((record) => record.kind)).toEqual(['hot', 'retracted', 'hot']);
  expect(records(db).at(-1)).toMatchObject({
    id: first.id,
    episodeId: first.episodeId,
    revision: 3,
  });
});

test('rolling evidence includes the current minute up to its endpoint', () => {
  const db = setup();
  const future = swap(4741, 2000);
  commitAcceptedSignalBatch(
    db,
    metricInput,
    initialSignalConfig,
    batch('a', [...hotLogs(), future]),
  );
  const closed = records(db).find((record) => record.kind === 'hot')!;
  expect(closed.logicalTimeSec).toBe(4860);
  expect(closed.presentation!.evidenceTxs).toContain(future.transactionHash);
  expect(
    closed.provenance!.evidenceEventIds.some((id) => id.includes(future.transactionHash)),
  ).toBe(true);
  expect(closed.presentation!.liquidityNote).toContain('unknown');
});

test('live identity with later backfill revision still withdraws live evidence', async () => {
  const db = setup();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, {
    ...batch('a', hotLogs()),
    captureMode: 'live',
  });
  const first = records(db)[0]!;
  const decision = {
    alertDraft: { ...first, revision: 1, observedAtMs: 999999 },
  } as unknown as SignalDecision;
  db.transaction(() => commitSignalDecision(db, 's', decision, 'backfill'))();
  retractSignals(db, 's', context, 'invalidated');
  const seen: AlertRecord[] = [];
  await new AlertOutbox(db).deliverPending((record) => {
    seen.push(record);
  });
  expect(seen.map((record) => [record.kind, record.revision])).toEqual([['retracted', 3]]);
  expect(db.prepare('select capture_mode,status from alert_outbox where revision=1').get()).toEqual(
    { capture_mode: 'live', status: 'superseded' },
  );
});

test('different rolling endpoints have distinct initial signal identities', () => {
  const ids = [4800, 4801].map((tip) => {
    const db = setup();
    const source = batch(String(tip), hotLogs());
    source.end = { number: BigInt(tip), timestampSec: tip + 60, hash: hash(tip) };
    source.toBlock = BigInt(tip);
    source.manifest.shards[0]!.request.toBlock = BigInt(tip);
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, source);
    return records(db).map((record) => record.id);
  });
  expect(ids[0]).not.toEqual(ids[1]);
});

test('quiet new receipt does not append redundant rule audit', () => {
  const db = setup();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('a', hotLogs()));
  const count = db.prepare('select count(*) n from signal_evaluations').get();
  const source = batch('new-head', hotLogs());
  source.end = { number: 4801n, timestampSec: 4861, hash: hash(4801) };
  source.toBlock = 4801n;
  source.manifest.shards[0]!.request.toBlock = 4801n;
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, source);
  expect(db.prepare('select count(*) n from signal_evaluations').get()).toEqual(count);
});

test('delayed historical closed draft from live capture is persisted as backfill only', async () => {
  const db = setup();
  const source = { ...batch('delayed', hotLogs()), captureMode: 'live' as const };
  source.end = { number: 5100n, timestampSec: 5160, hash: hash(5100) };
  source.toBlock = 5100n;
  source.manifest.shards[0]!.request.toBlock = 5100n;
  source.boundaries = [
    ...source.boundaries!,
    ...Array.from({ length: 5 }, (_, i) => {
      const timestampSec = 4920 + i * 60,
        n = timestampSec - 60;
      return {
        timestampSec,
        firstBlock: BigInt(n),
        before: { number: BigInt(n - 1), hash: hash(n - 1), timestampSec: timestampSec - 1 },
        at: { number: BigInt(n), hash: hash(n), timestampSec },
      };
    }),
  ];
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, source);
  expect(records(db).find((record) => record.kind === 'hot')!.historical).toBe(true);
  expect(
    db
      .prepare(
        "select distinct capture_mode from alert_outbox where json_extract(payload_json,'$.kind')='hot'",
      )
      .all(),
  ).toEqual([{ capture_mode: 'backfill' }]);
  expect(
    await new AlertOutbox(db).deliverPending(() => {
      throw new Error('historical must not deliver');
    }),
  ).toEqual({ sent: 0, failed: 0 });
});

test('detected recovery resets branch identity even when replacement tip advances', () => {
  const db = setup();
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, batch('old', hotLogs()));
  const first = records(db)[0]!;
  retractSignals(db, 's', context, 'scope-rechecking');
  const source = batch('replacement', hotLogs());
  source.end = { number: 4801n, timestampSec: 4861, hash: hash(900001) };
  source.toBlock = 4801n;
  source.manifest.shards[0]!.request.toBlock = 4801n;
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, source);
  const replacement = records(db).at(-1)!;
  expect(replacement.kind).toBe('hot');
  expect(replacement.id).not.toBe(first.id);
  expect(replacement.endAnchor.hash).toBe(hash(900001));
});
