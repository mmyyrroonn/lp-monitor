import { afterEach, expect, test } from 'vitest';
import { toHex } from 'viem';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { readMetricCoverage } from '../../src/metrics/coverage.js';
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
  return { db, raw, end };
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
