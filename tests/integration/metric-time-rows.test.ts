import { expect, test, vi } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { rawLogKey } from '../../src/storage/manifest.js';
import { batch, hotLogs } from '../helpers/alert-fixture.js';

test('coverage reads the union of actual blocks and claimed times without duplicating active families', () => {
  const db = openDatabase(':memory:');
  try {
    const raw = new SqliteRangeStore(db);
    raw.acceptRange(batch('times', hotLogs()));
    const firstId = db
      .prepare('select id from raw_logs order by block_number limit 1')
      .pluck()
      .get() as number;
    // An old block claiming a recent minute must be read as well as actual in-window blocks.
    db.prepare(
      'update log_times set minute_start_sec=4800,exact_timestamp_sec=null where raw_log_id=?',
    ).run(firstId);
    db.prepare('insert into active_logs values (?,?,?)').run('s', 'second-family', firstId);
    // The full readers remain the independent contract oracle, including unresolved assignments.
    const expected = () => {
      const times = raw.logTimes('s');
      return raw
        .activeLogs('s')
        .filter((log) => {
          const t = times.get(rawLogKey(log));
          return (
            (log.blockNumber >= 4500n && log.blockNumber <= 4800n) ||
            (t?.minuteStartSec !== null &&
              t?.minuteStartSec !== undefined &&
              t.minuteStartSec >= 4700) ||
            (t?.exactTimestampSec !== null &&
              t?.exactTimestampSec !== undefined &&
              t.exactTimestampSec >= 4700)
          );
        })
        .map((log) => ({ blockNumber: log.blockNumber, time: times.get(rawLogKey(log)) }));
    };
    const bounds = { fromBlock: 4500n, toBlock: 4800n, sinceSec: 4700 };
    expect(raw.activeTimeRows('s', bounds)).toEqual(expected());
    expect(raw.activeTimeRows('other', bounds)).toEqual([]);
    db.prepare(
      'delete from log_times where raw_log_id=(select id from raw_logs where block_number=4750)',
    ).run();
    expect(raw.activeTimeRows('s', bounds)).toEqual(expected());
    expect(raw.activeTimeRows('s', bounds).some((r) => r.time === undefined)).toBe(true);
    db.prepare('delete from active_logs where raw_log_id=?').run(firstId);
    expect(raw.activeTimeRows('s', bounds)).toEqual(expected());
  } finally {
    db.close();
  }
});

test('coverage time reads do not decode log topics or data payloads', () => {
  const db = openDatabase(':memory:');
  try {
    const raw = new SqliteRangeStore(db);
    raw.acceptRange(batch('times', hotLogs()));
    const before = raw.activeTimeRows('s');
    // Time coverage needs only identities and assignments, independently of event decoding.
    db.prepare("update raw_logs set topics_json='not-json',data=?").run('0x' + 'ab'.repeat(100000));
    expect(raw.activeTimeRows('s')).toEqual(before);
    expect(raw.logTimes('s').size).toBe(before.length);
  } finally {
    db.close();
  }
});

test('signal evidence reads each active log and its time once through indexed union bounds', () => {
  const db = openDatabase(':memory:');
  try {
    const raw = new SqliteRangeStore(db);
    raw.acceptRange(batch('evidence', hotLogs()));
    const times = raw.logTimes('s');
    const expected = raw
      .activeLogs('s')
      .filter(
        (log) =>
          log.blockNumber >= 4500n || (times.get(rawLogKey(log))?.minuteStartSec ?? -1) >= 4700,
      )
      .map((log) => ({ log, time: times.get(rawLogKey(log)) }));
    const prepare = db.prepare.bind(db);
    let columns: string[] = [];
    let plans: string[] = [];
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      if (statement.reader && sql.includes('raw_logs') && sql.includes('log_times')) {
        columns = statement.columns().map((c) => c.name);
        const all = statement.all.bind(statement);
        statement.all = (...params: unknown[]) => {
          plans = (prepare('explain query plan ' + sql).all(...params) as { detail: string }[]).map(
            (r) => r.detail,
          );
          return all(...params);
        };
      }
      return statement;
    });
    try {
      expect(raw.activeLogEvidence('s', { fromBlock: 4500n, sinceSec: 4700 })).toEqual(expected);
      expect(columns).not.toContain('payload_json');
      expect(
        plans.some((p) => p.includes('log_times_scope_minute') && p.includes('minute_start_sec>?')),
      ).toBe(true);
      expect(
        plans.some(
          (p) => p.includes('log_times_scope_exact') && p.includes('exact_timestamp_sec>?'),
        ),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  } finally {
    db.close();
  }
});

test('narrow evidence remains readable when a legacy database lacks time indexes', () => {
  const db = openDatabase(':memory:');
  try {
    const raw = new SqliteRangeStore(db);
    raw.acceptRange(batch('legacy-evidence', hotLogs()));
    const bounds = { fromBlock: 4500n, sinceSec: 4700 };
    const before = raw.activeLogEvidence('s', bounds);
    db.exec('drop index log_times_scope_minute; drop index log_times_scope_exact');
    expect(raw.activeLogEvidence('s', bounds)).toEqual(before);
  } finally {
    db.close();
  }
});
