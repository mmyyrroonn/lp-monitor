import type Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import type { BlockAnchor, LogTime, RawLog } from '../../src/domain/types.js';
import { openDatabase } from '../../src/storage/database.js';
import { rawLogKey, type RecordedRangeBatch } from '../../src/storage/manifest.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';

const databases: Database.Database[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

function hex(value: number): Hex {
  return `0x${value.toString(16).padStart(64, '0')}` as Hex;
}

function address(value: number): Address {
  return `0x${value.toString(16).padStart(40, '0')}` as Address;
}

function anchor(number: bigint): BlockAnchor {
  return { number, hash: hex(Number(number)), timestampSec: Number(number) };
}

function log(id: number, blockNumber: bigint): RawLog {
  return {
    blockHash: hex(Number(blockNumber)),
    blockNumber,
    transactionHash: hex(100_000 + id),
    transactionIndex: id,
    logIndex: id,
    address: address(id),
    topics: [hex(id)],
    data: hex(id),
    rawBlockTimestamp: null,
  };
}

function time(minuteStartSec: number): LogTime {
  return { minuteStartSec, exactTimestampSec: null, source: 'minute-boundary' };
}

function batch(
  id: string,
  fromBlock: bigint,
  toBlock: bigint,
  logs: readonly RawLog[],
  previous: BlockAnchor | null,
  logTimes: RecordedRangeBatch['logTimes'] = [],
): RecordedRangeBatch {
  const shardId = `F:${fromBlock}-${toBlock}`;
  return {
    id,
    scopeId: 'scope',
    fromBlock,
    toBlock,
    previous,
    end: anchor(toBlock),
    logs,
    observedAtMs: 1_000,
    captureMode: 'synthetic',
    filterPlanHash: 'plan',
    manifestHash: `manifest-${id}`,
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'v1',
      expectedShardIds: [shardId],
      shards: [
        {
          shardId,
          filterId: 'F',
          request: {
            fromBlock,
            toBlock,
            address: logs.length === 0 ? [address(999)] : [...new Set(logs.map((x) => x.address))],
            topics: [],
          },
          status: 'success',
          responseHash: hex(900),
          logKeys: logs.map(rawLogKey),
          logCount: logs.length,
          error: null,
        },
      ],
    },
    logTimes,
  };
}

function store(): SqliteRangeStore {
  const database = openDatabase(':memory:');
  databases.push(database);
  return new SqliteRangeStore(database);
}

describe('bounded incremental raw storage', () => {
  test('acceptRange snapshots only the affected block interval', () => {
    const raw = store();
    const retained = log(1, 10n);
    const removed = log(2, 105n);
    raw.acceptRange(batch('initial', 0n, 120n, [retained, removed], null));
    const activeSpy = vi.spyOn(raw, 'activeLogs');
    const timeSpy = vi.spyOn(raw, 'logTimes');

    const changes = raw.acceptRange(batch('replace', 101n, 120n, [], anchor(120n)));

    expect(changes.removed.map(rawLogKey)).toEqual([rawLogKey(removed)]);
    expect(activeSpy.mock.calls).toEqual([
      ['scope', { fromBlock: 101n, toBlock: 120n }],
      ['scope', { fromBlock: 101n, toBlock: 120n }],
    ]);
    expect(timeSpy.mock.calls).toEqual(activeSpy.mock.calls);
  });

  test('acceptRange reports an explicit out-of-range time correction', () => {
    const raw = store();
    const historical = log(1, 50n);
    raw.acceptRange(
      batch('historical', 0n, 100n, [historical], null, [{ ref: historical, time: time(0) }]),
    );

    const changes = raw.acceptRange(
      batch('next', 101n, 120n, [], anchor(100n), [{ ref: historical, time: time(60) }]),
    );

    expect(changes.retimed.map(rawLogKey)).toEqual([rawLogKey(historical)]);
    expect(changes.affectedFromBlock).toBe(50n);
  });

  test('bounded readers keep legacy reads and select recent claimed times across old blocks', () => {
    const raw = store();
    const oldBlockRecentTime = log(1, 10n);
    const recentBlockOldTime = log(2, 110n);
    raw.acceptRange(
      batch('initial', 0n, 120n, [oldBlockRecentTime, recentBlockOldTime], null, [
        { ref: oldBlockRecentTime, time: time(180) },
        { ref: recentBlockOldTime, time: time(60) },
      ]),
    );

    expect(raw.activeLogs('scope')).toHaveLength(2);
    expect(raw.activeLogs('scope', { fromBlock: 100n, toBlock: 120n }).map(rawLogKey)).toEqual([
      rawLogKey(recentBlockOldTime),
    ]);
    expect(raw.activeLogs('scope', { sinceSec: 120 }).map(rawLogKey)).toEqual([
      rawLogKey(oldBlockRecentTime),
    ]);
    expect([...raw.logTimes('scope', { sinceSec: 120 }).keys()]).toEqual([
      rawLogKey(oldBlockRecentTime),
    ]);
  });

  test('live time context excludes archival poison but keeps recent unresolved evidence', () => {
    const raw = store();
    const archival = log(1, 10n);
    const recent = log(2, 110n);
    const initial = batch('initial', 0n, 120n, [archival, recent], null);
    raw.acceptRange({
      ...initial,
      boundaries: [
        {
          timestampSec: 60,
          firstBlock: 50n,
          before: { number: 49n, hash: hex(49), timestampSec: 59 },
          at: { number: 50n, hash: hex(50), timestampSec: 60 },
        },
        {
          timestampSec: 120,
          firstBlock: 100n,
          before: { number: 99n, hash: hex(99), timestampSec: 119 },
          at: { number: 100n, hash: hex(100), timestampSec: 120 },
        },
      ],
    });

    const context = raw.liveTimeContext(
      'scope',
      101n,
      { number: 120n, hash: hex(120), timestampSec: 180 },
      1,
    );

    expect(context.retryFromBlock).toBe(100n);
    expect(context.unresolved.map(rawLogKey)).toEqual([rawLogKey(recent)]);
    expect(context.anchors.every((item) => item.number >= 99n)).toBe(true);
    expect(context.boundaries.map((item) => item.timestampSec)).toEqual([60, 120]);
  });

  test('actual bounded raw queries are driven by the height index', () => {
    const database = openDatabase(':memory:');
    databases.push(database);
    const raw = new SqliteRangeStore(database);
    raw.acceptRange(
      batch('initial', 0n, 120n, [log(1, 10n), log(2, 110n)], null, [
        { ref: log(2, 110n), time: time(120) },
      ]),
    );
    const prepare = database.prepare.bind(database);
    let activeSql = '';
    let timesSql = '';
    const spy = vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('indexed by raw_logs_height')) {
        if (sql.includes('exists (')) activeSql = sql;
        if (sql.includes('join log_times')) timesSql = sql;
      }
      return prepare(sql);
    });
    raw.activeLogs('scope', { fromBlock: 100n, toBlock: 120n });
    raw.logTimes('scope', { fromBlock: 100n, toBlock: 120n });
    spy.mockRestore();

    const activePlan = prepare('explain query plan ' + activeSql).all(100, 120, 'scope') as {
      detail: string;
    }[];
    const timesPlan = prepare('explain query plan ' + timesSql).all('scope', 100, 120) as {
      detail: string;
    }[];
    expect(activePlan[0]?.detail).toContain('raw_logs_height');
    expect(timesPlan[0]?.detail).toContain('raw_logs_height');
  });
});
test('live time ref reads avoid decoding raw event payloads', () => {
  const database = openDatabase(':memory:');
  databases.push(database);
  const raw = new SqliteRangeStore(database);
  const first = log(1, 10n);
  const second = log(2, 110n);
  raw.acceptRange(
    batch('refs', 0n, 120n, [first, second], null, [{ ref: second, time: time(120) }]),
  );
  const before = raw.activeLogRefsWithTime('scope', { fromBlock: 0n, toBlock: 120n });
  database
    .prepare("update raw_logs set topics_json='not-json',data=?")
    .run('0x' + 'ab'.repeat(100_000));
  expect(raw.activeLogRefsWithTime('scope', { fromBlock: 0n, toBlock: 120n })).toEqual(before);
  expect(before.map((row) => [rawLogKey(row.ref), row.time])).toEqual([
    [rawLogKey(first), undefined],
    [rawLogKey(second), time(120)],
  ]);
});
