import { afterEach, expect, test } from 'vitest';
import { toHex } from 'viem';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { readMetricCoverage } from '../../src/metrics/coverage.js';
import { pruneLiveWindow, pruneRawBatches } from '../../src/storage/retention.js';
import type { RecordedRangeBatch } from '../../src/storage/manifest.js';
import { retentionConsumer } from '../helpers/retention-fixture.js';

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const anchor = (n: number, timestampSec: number) => ({
  number: BigInt(n),
  hash: toHex(n, { size: 32 }),
  timestampSec,
});
function fixture(emptyMinute = false) {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const end = anchor(120, 180);
  const batch: RecordedRangeBatch = {
    id: 'old',
    scopeId: 's',
    fromBlock: 100n,
    toBlock: 120n,
    end,
    previous: null,
    logs: [],
    observedAtMs: 1,
    captureMode: 'synthetic',
    filterPlanHash: 'f',
    manifestHash: 'm',
    completeness: 'complete',
    boundaries: [120, 180].map((timestampSec, i) => ({
      timestampSec,
      firstBlock: BigInt(emptyMinute ? 120 : 100 + 20 * i),
      before: emptyMinute ? anchor(119, 119) : anchor(99 + 20 * i, timestampSec - 1),
      at: emptyMinute ? end : anchor(100 + 20 * i, timestampSec),
    })),
    manifest: {
      version: 1,
      filterVersion: 'f',
      expectedShardIds: ['one'],
      shards: [
        {
          shardId: 'one',
          filterId: 'operations',
          request: {
            fromBlock: 100n,
            toBlock: 120n,
            address: [toHex(1, { size: 20 })],
            topics: [],
          },
          status: 'success',
          responseHash: 'h',
          logKeys: [],
          logCount: 0,
          error: null,
        },
      ],
    },
  };
  new SqliteRangeStore(db).acceptRange(batch);
  db.prepare('delete from checkpoints').run();
  retentionConsumer(db, 's');
  return { db, end };
}

test('live expiry invalidates a warmed complete coverage minute atomically', () => {
  const { db, end } = fixture();
  db.prepare('insert into live_events values(?,?,?,?,?,?,?,?,?)').run(
    's',
    1,
    'p',
    'swap',
    105,
    0,
    0,
    120,
    '{}',
  );
  const minute = () =>
    readMetricCoverage(db, 's', [], end).find((row) => row.minuteStartSec === 120);
  expect(minute()?.complete).toBe(true);
  expect(pruneLiveWindow(db, 's', 180).liveEvents).toBe(1);
  expect(minute()).toMatchObject({
    complete: false,
    reasons: expect.arrayContaining(['retention-expired']),
  });
});

test('expired batch coverage cannot close a zero-block minute using surviving boundaries', () => {
  const { db, end } = fixture(true);
  const minute = () =>
    readMetricCoverage(db, 's', [], end).find((row) => row.minuteStartSec === 120);
  expect(minute()?.complete).toBe(true);
  expect(pruneRawBatches(db, 's', 181).batches).toBe(1);
  expect(minute()).toMatchObject({
    complete: false,
    reasons: expect.arrayContaining(['retention-expired']),
  });
});
