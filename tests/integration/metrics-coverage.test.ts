import { afterEach, expect, test, vi } from 'vitest';
import { toHex } from 'viem';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { acceptedMetricRanges, readMetricCoverage } from '../../src/metrics/coverage.js';
import type { RecordedRangeBatch } from '../../src/storage/manifest.js';
import type { MinuteBoundary } from '../../src/domain/types.js';

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const hash = (n: number) => toHex(n, { size: 32 });
const anchor = (n: number, timestampSec: number) => ({
  number: BigInt(n),
  hash: hash(n),
  timestampSec,
});
const boundary = (t: number, n: number): MinuteBoundary => ({
  timestampSec: t,
  firstBlock: BigInt(n),
  before: anchor(n - 1, t - 1),
  at: anchor(n, t),
});
function fixture(from = 100n, secondTo = 120n, emptyMinute = false) {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db);
  const end = anchor(120, 180);
  const batch: RecordedRangeBatch = {
    id: 'a',
    scopeId: 'scope',
    fromBlock: from,
    toBlock: 120n,
    end,
    previous: null,
    logs: [],
    observedAtMs: 1,
    captureMode: 'synthetic',
    filterPlanHash: 'f',
    manifestHash: 'm',
    completeness: 'complete',
    boundaries: emptyMinute
      ? [120, 180].map((timestampSec) => ({
          timestampSec,
          firstBlock: 120n,
          before: anchor(119, 119),
          at: anchor(120, 180),
        }))
      : [boundary(120, 100), boundary(180, 120)],
    manifest: {
      version: 1,
      filterVersion: 'f',
      expectedShardIds: ['one', 'two'],
      shards: ['one', 'two'].map((shardId, i) => ({
        shardId,
        filterId: 'operation-v3',
        request: {
          fromBlock: from,
          toBlock: i === 1 ? secondTo : 120n,
          address: [toHex(i + 1, { size: 20 })],
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
  raw.acceptRange(batch);
  return { db, raw, end, batch };
}
test('only complete same-scope full minute coverage permits a zero minute', () => {
  const { db, end } = fixture();
  expect(
    readMetricCoverage(db, 'scope', [], end).find((m) => m.minuteStartSec === 120),
  ).toMatchObject({ complete: true, fromBlock: 100n, toBlock: 119n });
  expect(readMetricCoverage(db, 'different', [], end).every((m) => !m.complete)).toBe(true);
});
test('one missing block and one missing address shard fail closed even without events', () => {
  const { db, end } = fixture(101n);
  expect(
    readMetricCoverage(db, 'scope', [], end).find((m) => m.minuteStartSec === 120)?.complete,
  ).toBe(false);
  const f = fixture();
  f.db.prepare("delete from fetch_shards where shard_id='two'").run();
  expect(
    readMetricCoverage(f.db, 'scope', [], f.end).find((m) => m.minuteStartSec === 120)?.complete,
  ).toBe(false);
});
test('decode error or unresolved event blocks the containing block interval', () => {
  const { db, end } = fixture();
  const errors = [
    {
      code: 'invalid-data',
      poolId: null,
      raw: {
        blockNumber: 105n,
        blockHash: hash(105),
        transactionHash: hash(1),
        transactionIndex: 0,
        logIndex: 0,
        address: toHex(1, { size: 20 }),
        topics: [],
        data: '0x' as const,
        rawBlockTimestamp: null,
      },
      time: { minuteStartSec: null, exactTimestampSec: null, source: 'unresolved' },
    },
  ] as Parameters<typeof readMetricCoverage>[2];
  expect(
    readMetricCoverage(db, 'scope', errors, end).find((m) => m.minuteStartSec === 120)?.complete,
  ).toBe(false);
});
test('invalid boundary and unseen current minute never close', () => {
  const { db, end } = fixture();
  db.prepare('update minute_boundaries set before_number=1 where timestamp_sec=120').run();
  expect(readMetricCoverage(db, 'scope', [], end).every((m) => !m.complete)).toBe(true);
});

test('a successful short address partition cannot borrow coverage from another address', () => {
  const { db, end } = fixture(100n, 110n);
  expect(
    readMetricCoverage(db, 'scope', [], end).find((m) => m.minuteStartSec === 120)?.complete,
  ).toBe(false);
});
test('current minute checks accepted prefix and retains decode errors', () => {
  const { db, end } = fixture();
  const result = readMetricCoverage(db, 'scope', [], end).at(-1)!;
  expect(result).toMatchObject({
    minuteStartSec: 180,
    fromBlock: 120n,
    toBlock: 120n,
    complete: false,
    reasons: ['watermark-partial'],
  });
});

test('a time jump with the same verified adjacent anchor pair closes a no-block minute', () => {
  const { db, end } = fixture(100n, 120n, true);
  expect(
    readMetricCoverage(db, 'scope', [], end).find((m) => m.minuteStartSec === 120),
  ).toMatchObject({ complete: true, fromBlock: 120n, toBlock: 119n });
});

test('accepted coverage cache reuses immutable validation and invalidates on shard mutation', () => {
  const { db } = fixture();
  const parse = vi.spyOn(JSON, 'parse');
  expect(acceptedMetricRanges(db, 'scope')).toHaveLength(1);
  const afterFirst = parse.mock.calls.length;
  expect(acceptedMetricRanges(db, 'scope')).toHaveLength(1);
  expect(parse.mock.calls.length).toBe(afterFirst);
  db.prepare("update fetch_shards set status='failed' where shard_id='two'").run();
  expect(acceptedMetricRanges(db, 'scope')).toEqual([]);
  const afterFailure = parse.mock.calls.length;
  expect(afterFailure).toBeGreaterThan(afterFirst);
  db.prepare("update fetch_shards set status='success' where shard_id='two'").run();
  expect(acceptedMetricRanges(db, 'scope')).toHaveLength(1);
  expect(parse.mock.calls.length).toBeGreaterThan(afterFailure);
  parse.mockRestore();
});

test('accepted coverage cache is scope isolated and malformed payload fails closed', () => {
  const { db } = fixture();
  expect(acceptedMetricRanges(db, 'different')).toEqual([]);
  db.pragma('foreign_keys=OFF');
  db.prepare("update ingest_batches set payload_json='{' where id='a'").run();
  expect(() => acceptedMetricRanges(db, 'scope')).not.toThrow();
  expect(acceptedMetricRanges(db, 'scope')).toEqual([]);
});

test('large immutable selector validation skips expensive decode on a cache hit', () => {
  const { db } = fixture();
  const row = db.prepare("select payload_json from ingest_batches where id='a'").get() as {
    payload_json: string;
  };
  const payload = JSON.parse(row.payload_json);
  const addresses = Array.from({ length: 100 }, (_, i) => toHex(i + 1, { size: 20 }));
  const topics = [Array.from({ length: 100 }, (_, i) => toHex(i + 1, { size: 32 }))];
  for (const shard of payload.manifest.shards) {
    shard.request.address = addresses;
    shard.request.topics = topics;
  }
  db.prepare("update ingest_batches set payload_json=? where id='a'").run(JSON.stringify(payload));
  const parse = vi.spyOn(JSON, 'parse');
  expect(acceptedMetricRanges(db, 'scope')).toHaveLength(1);
  const afterCold = parse.mock.calls.length;
  expect(afterCold).toBeGreaterThan(0);
  expect(acceptedMetricRanges(db, 'scope')).toHaveLength(1);
  expect(parse.mock.calls.length).toBe(afterCold);
  parse.mockRestore();
});

test('valid payload identity mutation and restoration invalidate a warm cache', () => {
  const { db } = fixture();
  expect(acceptedMetricRanges(db, 'scope')).toHaveLength(1);
  const row = db.prepare("select payload_json from ingest_batches where id='a'").get() as {
    payload_json: string;
  };
  const original = row.payload_json;
  const changed = JSON.parse(original);
  changed.scopeId = 'other';
  db.prepare("update ingest_batches set payload_json=? where id='a'").run(JSON.stringify(changed));
  expect(acceptedMetricRanges(db, 'scope')).toEqual([]);
  db.prepare("update ingest_batches set payload_json=? where id='a'").run(original);
  expect(acceptedMetricRanges(db, 'scope')).toHaveLength(1);
});

test('accepted range shrink and deletion remain authoritative after cache warmup', () => {
  const { db } = fixture();
  expect(acceptedMetricRanges(db, 'scope')).toEqual([{ fromBlock: 100n, toBlock: 120n }]);
  db.prepare("update accepted_ranges set from_block=110 where scope_id='scope'").run();
  expect(acceptedMetricRanges(db, 'scope')).toEqual([{ fromBlock: 110n, toBlock: 120n }]);
  db.prepare("delete from accepted_ranges where scope_id='scope'").run();
  expect(acceptedMetricRanges(db, 'scope')).toEqual([]);
});

function addBatch(f: ReturnType<typeof fixture>, id: string, from = 100n, to = 120n) {
  const batch: RecordedRangeBatch = {
    ...f.batch,
    id,
    fromBlock: from,
    toBlock: to,
    end: anchor(Number(to), 180),
    boundaries: [],
    manifest: {
      ...f.batch.manifest,
      shards: f.batch.manifest.shards.map((s) => ({
        ...s,
        request: { ...s.request, fromBlock: from, toBlock: to },
      })),
    },
  };
  f.raw.saveRaw(batch);
  f.db
    .prepare('insert into accepted_ranges values (?,?,?,?,?,?)')
    .run('scope', id, 'operation-v3', Number(from), Number(to), 1);
}

test('saturated cache retains admitted validations while overflow and mutations stay checked', () => {
  const f = fixture();
  f.db.transaction(() => {
    for (let i = 1; i < 2051; i++) addBatch(f, 'batch-' + i);
  })();
  const parse = vi.spyOn(JSON, 'parse');
  try {
    expect(acceptedMetricRanges(f.db, 'scope')).toHaveLength(2051);
    parse.mockClear();
    expect(acceptedMetricRanges(f.db, 'scope')).toHaveLength(2051);
    expect(parse).toHaveBeenCalledTimes(3);
    f.db.prepare("update ingest_batches set payload_json='{' where id='a'").run();
    expect(acceptedMetricRanges(f.db, 'scope')).toHaveLength(2050);
    f.db.prepare("update fetch_shards set status='failed' where batch_id='batch-1'").run();
    expect(acceptedMetricRanges(f.db, 'scope')).toHaveLength(2049);
    f.db.prepare("delete from accepted_ranges where batch_id='batch-2'").run();
    expect(acceptedMetricRanges(f.db, 'scope')).toHaveLength(2048);
  } finally {
    parse.mockRestore();
  }
});

test('bounded selection excludes old batches but validates all rows and shards of straddling batches', () => {
  const f = fixture();
  addBatch(f, 'old', 1n, 99n);
  const bounds = { fromBlock: 110n, toBlock: 115n };
  expect(acceptedMetricRanges(f.db, 'scope', bounds)).toEqual([{ fromBlock: 100n, toBlock: 120n }]);
  expect(acceptedMetricRanges(f.db, 'scope')).toHaveLength(2);
  const payload = JSON.parse(
    (
      f.db.prepare("select payload_json from ingest_batches where id='a'").get() as {
        payload_json: string;
      }
    ).payload_json,
  );
  payload.manifest.shards[1].filterId = 'operation-v4';
  f.db
    .prepare("update ingest_batches set payload_json=? where id='a'")
    .run(JSON.stringify(payload));
  f.db
    .prepare('insert into accepted_ranges values (?,?,?,?,?,?)')
    .run('scope', 'a', 'operation-v4', 100, 109, 1);
  expect(acceptedMetricRanges(f.db, 'scope', bounds)).toEqual([{ fromBlock: 100n, toBlock: 109n }]);
  f.db.prepare("delete from accepted_ranges where filter_id='operation-v4'").run();
  expect(acceptedMetricRanges(f.db, 'scope', bounds)).toEqual([]);
  f.db.prepare("update fetch_shards set status='failed' where batch_id='a'").run();
  expect(acceptedMetricRanges(f.db, 'scope', bounds)).toEqual([]);
});

test.each(['normal', 'missing', 'invalid', 'conflict', 'gap', 'time-jump'])(
  'minute bounded path matches full validation with %s boundaries',
  (variant) => {
    const f = fixture(100n, 120n, variant === 'time-jump');
    addBatch(f, 'old', 1n, 99n);
    if (variant === 'missing')
      f.db.prepare('delete from minute_boundaries where timestamp_sec=180').run();
    if (variant === 'invalid')
      f.db.prepare('update minute_boundaries set before_number=1 where timestamp_sec=120').run();
    if (variant === 'conflict')
      f.db.prepare('update minute_boundaries set first_block=90 where timestamp_sec=180').run();
    if (variant === 'gap')
      f.db.prepare("update accepted_ranges set from_block=110 where batch_id='a'").run();
    const bounded = readMetricCoverage(f.db, 'scope', [], f.end);
    const prepare = f.db.prepare.bind(f.db);
    const spy = vi.spyOn(f.db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('candidate')) {
        const statement = prepare(
          'select batch_id,filter_id,from_block,to_block from accepted_ranges where scope_id=?',
        );
        return { all: (scope: string) => statement.all(scope) } as ReturnType<typeof f.db.prepare>;
      }
      return prepare(sql);
    });
    try {
      expect(readMetricCoverage(f.db, 'scope', [], f.end)).toEqual(bounded);
    } finally {
      spy.mockRestore();
    }
  },
);

test('minute horizon avoids decoding unrelated old payloads without closing a coverage gap', () => {
  const f = fixture(101n);
  addBatch(f, 'old', 1n, 99n);
  const parse = vi.spyOn(JSON, 'parse');
  try {
    const result = readMetricCoverage(f.db, 'scope', [], f.end);
    expect(result[0]?.reasons).toContain('range-gap');
    const batchParses = parse.mock.calls.filter(([text]) =>
      String(text).includes('expectedShardIds'),
    );
    expect(batchParses).toHaveLength(1);
    expect(acceptedMetricRanges(f.db, 'scope')).toHaveLength(2);
  } finally {
    parse.mockRestore();
  }
});

test('sliding bounded windows release stale admissions and revalidate when revisited', () => {
  const f = fixture();
  f.db.transaction(() => {
    for (let i = 1; i < 2048; i++) addBatch(f, 'early-' + i);
    for (let i = 0; i < 10; i++) addBatch(f, 'late-' + i, 200n, 220n);
  })();
  const early = { fromBlock: 100n, toBlock: 120n };
  const late = { fromBlock: 200n, toBlock: 220n };
  const parse = vi.spyOn(JSON, 'parse');
  try {
    expect(acceptedMetricRanges(f.db, 'scope', early)).toHaveLength(2048);
    expect(acceptedMetricRanges(f.db, 'scope', late)).toHaveLength(10);
    parse.mockClear();
    expect(acceptedMetricRanges(f.db, 'scope', late)).toHaveLength(10);
    expect(parse).not.toHaveBeenCalled();
    f.db.prepare("update fetch_shards set status='failed' where batch_id='a'").run();
    expect(acceptedMetricRanges(f.db, 'scope', early)).toHaveLength(2047);
    expect(parse).toHaveBeenCalledTimes(2048);
    parse.mockClear();
    expect(acceptedMetricRanges(f.db, 'scope', early)).toHaveLength(2047);
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});
