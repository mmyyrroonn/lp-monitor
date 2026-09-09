import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../src/domain/chain.js', () => ({ CHAIN_ID: 9999 }));
import { CHAIN_ID } from '../../src/domain/chain.js';
import { toHex } from 'viem';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { SqliteProjectionStore } from '../../src/storage/projection-store.js';
import { buildMetricsReport } from '../../src/storage/metric-store.js';
import { rawLogKey, type RecordedRangeBatch } from '../../src/storage/manifest.js';
import { createAssetRegistry } from '../../src/registry/assets.js';
import { readMetricCoverage } from '../../src/metrics/coverage.js';
import { loadMetricMetadata } from '../../src/metrics/metadata.js';
import type { RawLog } from '../../src/domain/types.js';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const addr = (n: number) => toHex(n, { size: 20 }),
  hash = (n: number) => toHex(n, { size: 32 });
const anchor = (n: number, t: number) => ({ number: BigInt(n), hash: hash(n), timestampSec: t });
const end = anchor(120, 180);
function fixture(logs: RawLog[] = []) {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const record: RecordedRangeBatch = {
    id: 'chain',
    scopeId: 's',
    fromBlock: 100n,
    toBlock: 120n,
    end,
    previous: null,
    logs,
    observedAtMs: 1,
    captureMode: 'synthetic',
    filterPlanHash: 'f',
    manifestHash: 'm',
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'f',
      expectedShardIds: ['one'],
      shards: [
        {
          shardId: 'one',
          filterId: 'operation-v3',
          request: { fromBlock: 100n, toBlock: 120n, address: [addr(1)], topics: [] },
          status: 'success',
          responseHash: 'h',
          logKeys: logs.map(rawLogKey),
          logCount: logs.length,
          error: null,
        },
      ],
    },
    boundaries: [
      { timestampSec: 120, firstBlock: 100n, before: anchor(99, 119), at: anchor(100, 120) },
      { timestampSec: 180, firstBlock: 120n, before: anchor(119, 179), at: end },
    ],
    logTimes: logs.map((ref) => ({
      ref,
      time: { minuteStartSec: 120, exactTimestampSec: null, source: 'minute-boundary' },
    })),
  };
  new SqliteRangeStore(db).acceptRange(record);
  return db;
}
test('coverage uses canonical configured chain keys for persisted event timing', () => {
  const db = fixture([
    {
      address: addr(1),
      blockNumber: 105n,
      blockHash: hash(105),
      transactionHash: hash(1),
      transactionIndex: 0,
      logIndex: 0,
      topics: [],
      data: '0x',
      rawBlockTimestamp: null,
    },
  ]);
  expect(readMetricCoverage(db, 's', [], end).find((m) => m.minuteStartSec === 120)).toMatchObject({
    complete: true,
    reasons: [],
  });
  db.prepare('update log_times set exact_timestamp_sec=180').run();
  expect(readMetricCoverage(db, 's', [], end).find((m) => m.minuteStartSec === 120)).toMatchObject({
    complete: false,
    reasons: ['event-time-mismatch'],
  });
});
test('report chain identity comes from CHAIN_ID', () => {
  const db = fixture();
  new SqliteProjectionStore(db).rebuild('s', 's', 'c');
  const report = buildMetricsReport(db, {
    scopeId: 's',
    registryScopeId: 's',
    configVersion: 'c',
    assets: createAssetRegistry('a', [addr(2)]),
    usdg: addr(3),
    metadata: { version: 'm', chainId: CHAIN_ID, source: 'synthetic', entries: [] },
  });
  expect(report.chainId).toBe(CHAIN_ID);
});
test('metadata schema accepts the configured chain and rejects the previous chain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p3-chain-'));
  try {
    const path = join(dir, 'metadata.json'),
      metadata = { version: 'm', chainId: CHAIN_ID, source: 'synthetic', entries: [] };
    writeFileSync(path, JSON.stringify(metadata));
    expect(loadMetricMetadata(path).chainId).toBe(CHAIN_ID);
    writeFileSync(path, JSON.stringify({ ...metadata, chainId: 4663 }));
    expect(() => loadMetricMetadata(path)).toThrow(/metadata/i);
  } finally {
    const target = realpathSync(dir);
    if (
      !target.startsWith(realpathSync(tmpdir()) + sep) ||
      !target.split(sep).at(-1)!.startsWith('p3-chain-')
    )
      throw new Error('cleanup boundary');
    rmSync(target, { recursive: true });
  }
});
