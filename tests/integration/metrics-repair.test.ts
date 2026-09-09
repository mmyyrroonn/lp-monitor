import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadAssetVersion } from '../../src/registry/assets.js';
import { computeWatchScopeId } from '../../src/ingest/filter-plan.js';
import { ConfigError } from '../../src/config/env.js';

import { filterMetricEvidence } from '../../src/ops/metrics-cli.js';
import { afterEach, expect, test } from 'vitest';
import { toHex, encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { SqliteProjectionStore } from '../../src/storage/projection-store.js';
import { buildMetricsReport, SqliteMetricStore } from '../../src/storage/metric-store.js';
import { createAssetRegistry } from '../../src/registry/assets.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import {
  rawLogKey,
  type RecordedRangeBatch,
  type PersistedPoolRegistration,
} from '../../src/storage/manifest.js';
import type { RawLog } from '../../src/domain/types.js';

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const addr = (n: number) => toHex(n, { size: 20 }),
  hash = (n: number) => toHex(n, { size: 32 });
const anchor = (n: number) => ({ number: BigInt(n), hash: hash(n), timestampSec: n + 60 });
const pool = addr(1),
  rwa = addr(2),
  usdg = addr(3);
const end = anchor(4800);
const assets = createAssetRegistry('test', [rwa]);
const input = {
  scopeId: 's',
  registryScopeId: 's',
  configVersion: 'c',
  assets,
  usdg,
  metadata: {
    version: 'test',
    chainId: 4663 as const,
    source: 'synthetic',
    entries: [rwa, usdg].map((address) => ({
      address,
      decimals: 6,
      observedAtBlock: '0',
      blockHash: hash(0),
    })),
  },
};
function swap(block: number): RawLog {
  return {
    address: pool,
    blockNumber: BigInt(block),
    blockHash: hash(block),
    transactionHash: hash(block + 10000),
    transactionIndex: 0,
    logIndex: 0,
    rawBlockTimestamp: '0x0',
    topics: encodeEventTopics({
      abi: v3PoolAbi,
      eventName: 'Swap',
      args: { sender: pool, recipient: pool },
    }) as Hex[],
    data: encodeAbiParameters(
      [
        { type: 'int256' },
        { type: 'int256' },
        { type: 'uint160' },
        { type: 'uint128' },
        { type: 'int24' },
      ],
      [1000000n, -2000000n, 2n ** 96n, 1000n, 0],
    ),
  };
}
const registration: PersistedPoolRegistration = {
  pool: { chainId: 4663, protocol: 'v3', address: pool },
  token0: rwa,
  token1: usdg,
  feePips: 3000,
  tickSpacing: 60,
  hooks: addr(0),
  discoveredAt: swap(60),
  assetVersion: 'test',
  source: 'synthetic',
};
function batch(id: string, logs: RawLog[]): RecordedRangeBatch {
  return {
    id,
    scopeId: 's',
    fromBlock: 60n,
    toBlock: 4800n,
    end,
    previous: end,
    logs,
    observedAtMs: 1,
    captureMode: 'synthetic',
    filterPlanHash: 'f',
    manifestHash: id,
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'f',
      expectedShardIds: ['one'],
      shards: [
        {
          shardId: 'one',
          filterId: 'operation-v3',
          request: { fromBlock: 60n, toBlock: 4800n, address: [pool], topics: [] },
          status: 'success',
          responseHash: 'h',
          error: null,
          logKeys: logs.map(rawLogKey),
          logCount: logs.length,
        },
      ],
    },
    poolRegistrations: [{ ...registration, discoveredAt: logs[0] ?? swap(70) }],
    logTimes: logs.map((ref) => ({
      ref,
      time: {
        minuteStartSec: Math.floor((Number(ref.blockNumber) + 60) / 60) * 60,
        exactTimestampSec: null,
        source: 'minute-boundary',
      },
    })),
    boundaries: Array.from({ length: 80 }, (_, i) => {
      const timestampSec = 120 + i * 60,
        n = timestampSec - 60;
      return { timestampSec, firstBlock: BigInt(n), before: anchor(n - 1), at: anchor(n) };
    }),
  };
}
function setup() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const raw = new SqliteRangeStore(db),
    projection = new SqliteProjectionStore(db);
  return { db, raw, projection };
}
test('replay persists lossless metrics, rejects stale P2 and recomputes removed swaps and baselines', () => {
  const { db, raw, projection } = setup();
  const logs = Array.from({ length: 79 }, (_, i) => swap(70 + i * 60));
  raw.acceptRange(batch('a', logs));
  projection.rebuild('s', 's', 'c');
  const first = buildMetricsReport(db, input);
  expect(buildMetricsReport(db, { ...input, usdg: addr(9) }).sourceHash).not.toBe(first.sourceHash);
  expect(filterMetricEvidence(first, new Set())).toEqual({
    valuations: [],
    quotes: [],
    grossFees: [],
  });
  const store = new SqliteMetricStore(db);
  store.replace(first);
  expect(first.windows[0]?.recentClosed5x1m).toMatchObject({ swapCount: 5, usdMicros: 10000000n });
  expect(db.prepare('select count(*) as n from metric_windows').get()).toMatchObject({
    n: expect.any(Number),
  });
  raw.acceptRange(batch('b', logs.slice(0, -1)));
  expect(() => buildMetricsReport(db, input)).toThrow(/projection/i);
  projection.rebuild('s', 's', 'c');
  const next = buildMetricsReport(db, input);
  store.replace(next);
  expect(next.windows[0]?.recentClosed5x1m).toMatchObject({ swapCount: 4, usdMicros: 8000000n });
  expect(next.sourceHash).not.toBe(first.sourceHash);
  expect(buildMetricsReport(db, input)).toEqual(next);
  expect(db.prepare('select count(*) as n from raw_logs').get()).toEqual({ n: 79 });
});
test('retime, scope mismatch and a changed boundary cannot reuse cached closed windows', () => {
  const { db, raw, projection } = setup();
  raw.acceptRange(batch('a', [swap(4750)]));
  projection.rebuild('s', 's', 'c');
  const first = buildMetricsReport(db, input);
  expect(buildMetricsReport(db, { ...input, usdg: addr(9) }).sourceHash).not.toBe(first.sourceHash);
  new SqliteMetricStore(db).replace(first);
  expect(() => buildMetricsReport(db, { ...input, scopeId: 'other' })).toThrow(/projection/i);
  db.prepare('update log_times set minute_start_sec=4740 where scope_id=?').run('s');
  expect(() => buildMetricsReport(db, input)).toThrow(/projection/i);
  projection.rebuild('s', 's', 'c');
  const next = buildMetricsReport(db, input);
  expect(next.coverage.filter((c) => !c.complete).length).toBeGreaterThan(
    first.coverage.filter((c) => !c.complete).length,
  );
  db.prepare('delete from minute_boundaries where timestamp_sec=4800').run();
  const revised = buildMetricsReport(db, input);
  expect(revised.sourceHash).not.toBe(next.sourceHash);
  expect(revised.windows[0]?.recentClosed5x1m ?? null).toBeNull();
});
test('metric replacement rolls back windows and cursor together on failure', () => {
  const { db, raw, projection } = setup();
  raw.acceptRange(batch('a', [swap(4750)]));
  projection.rebuild('s', 's', 'c');
  const report = buildMetricsReport(db, input),
    store = new SqliteMetricStore(db);
  store.replace(report);
  const before = db.prepare('select * from metric_cursors').all();
  db.exec(
    "create trigger fail_metric before insert on metric_windows begin select raise(ABORT,'fail'); end",
  );
  expect(() => store.replace(report)).toThrow('fail');
  expect(db.prepare('select * from metric_cursors').all()).toEqual(before);
  expect(db.prepare('select count(*) as n from metric_windows').get()).toEqual({ n: 80 });
});

test('known fork conflict in cached decimals removes valuation but retains swap counts and evidence', () => {
  const { db, raw, projection } = setup();
  raw.acceptRange(batch('a', [swap(4750)]));
  projection.rebuild('s', 's', 'c');
  const report = buildMetricsReport(db, {
    ...input,
    metadata: {
      ...input.metadata,
      entries: input.metadata.entries.map((e) => ({
        ...e,
        observedAtBlock: '4750',
        blockHash: hash(99),
      })),
    },
  });
  expect(report.metadataConflicts).toHaveLength(2);
  expect(report.valuations[0]?.usdMicros).toBeNull();
  expect(report.rwa[0]?.blockRangeActivity.swapCount).toBe(1);
});
test('removing the final active swap keeps the registered pool and recomputes closed zero volume', () => {
  const { db, raw, projection } = setup();
  raw.acceptRange(batch('a', [swap(70)]));
  projection.rebuild('s', 's', 'c');
  expect(buildMetricsReport(db, input).windows).toHaveLength(1);
  raw.acceptRange(batch('b', []));
  projection.rebuild('s', 's', 'c');
  const report = buildMetricsReport(db, input);
  expect(report.windows).toHaveLength(1);
  expect(report.windows[0]?.recentClosed5x1m).toMatchObject({
    swapCount: 0,
    txCount: 0,
    usdMicros: 0n,
  });
});

test('RWA partial current is unavailable when the current accepted prefix is incomplete', () => {
  const { db, raw, projection } = setup();
  raw.acceptRange(batch('a', [swap(4750)]));
  projection.rebuild('s', 's', 'c');
  db.prepare('delete from fetch_shards').run();
  const report = buildMetricsReport(db, input);
  expect(report.rwa[0]?.partialCurrent).toMatchObject({ available: false, activity: null });
});

test.each([true, false])(
  'rejects a shared watched RWA pool before emitting metrics (has swaps: %s)',
  (hasSwaps) => {
    const { db, raw, projection } = setup();
    const record = batch('multi', [swap(4750)]);
    record.poolRegistrations = [{ ...registration, token1: addr(4), discoveredAt: swap(4750) }];
    raw.acceptRange(record);
    projection.rebuild('s', 's', 'c');
    if (!hasSwaps) {
      const empty = batch('empty', []);
      empty.poolRegistrations = [];
      raw.acceptRange(empty);
      projection.rebuild('s', 's', 'c');
    }
    const multi = { ...input, assets: createAssetRegistry('multi', [rwa, addr(4)]) };
    expect(() => buildMetricsReport(db, multi)).toThrow(/Multiple watched RWA assets.*unsupported/);
    expect(db.prepare('select count(*) as n from metric_cursors').get()).toEqual({ n: 0 });
  },
);

test('retained block range is explicit and remains uncertified across gaps and unresolved time', () => {
  const { db, raw, projection } = setup();
  const record = batch('range', [swap(4750)]);
  record.logTimes = record.logTimes!.map(({ ref }) => ({
    ref,
    time: { minuteStartSec: null, exactTimestampSec: null, source: 'unresolved' },
  }));
  raw.acceptRange(record);
  projection.rebuild('s', 's', 'c');
  const report = buildMetricsReport(db, input);
  expect(report.rwa[0]!.blockRangeActivity).toMatchObject({
    fromBlock: 60n,
    toBlock: 4800n,
    coverageVerified: false,
    swapCount: 1,
  });
  expect(report.rwa[0]!.closed5m.available).toBe(false);
  new SqliteMetricStore(db).replace(report);
  const row = db.prepare('select payload_json from metric_cursors').get() as {
    payload_json: string;
  };
  expect(JSON.parse(row.payload_json).rwa[0].blockRangeActivity).toMatchObject({
    fromBlock: '60',
    toBlock: '4800',
    coverageVerified: false,
    swapCount: 1,
  });
});

const cliDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cliDirs.splice(0)) {
    const base = realpathSync(tmpdir()),
      target = realpathSync(dir);
    if (!target.startsWith(base + sep) || !target.split(sep).at(-1)!.startsWith('p3-review-'))
      throw new Error('cleanup boundary');
    rmSync(target, { recursive: true });
  }
});

test('offline metrics and rank publish observed output, explicit retained bounds, and lossless saved payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p3-review-'));
  cliDirs.push(dir);
  const configPath = join(dir, 'chain.json'),
    watchPath = join(dir, 'watch.json'),
    metadataPath = join(dir, 'metadata.json'),
    dbPath = join(dir, 'recording.sqlite');
  const chain = JSON.parse(readFileSync('config/robinhood.json', 'utf8'));
  chain.version = 'c';
  chain.tokens.USDG = usdg;
  writeFileSync(configPath, JSON.stringify(chain));
  writeFileSync(
    watchPath,
    JSON.stringify({
      chainId: 4663,
      version: 'test',
      rwa: [{ address: rwa, symbol: 'TEST', identityStatus: 'synthetic' }],
    }),
  );
  writeFileSync(metadataPath, JSON.stringify(input.metadata));
  const config = loadChainConfig(configPath),
    watched = loadAssetVersion(watchPath);
  const scope = computeWatchScopeId(watched, 'operations', config),
    registryScope = computeWatchScopeId(watched, 'discovery-only', config);
  const { db, raw, projection } = setup();
  const record = batch('cli', [swap(4750)]);
  record.scopeId = scope;
  record.poolRegistrations = record.poolRegistrations!.map((r) => ({
    ...r,
    source: 'seed-config',
  }));
  raw.acceptRange(record);
  projection.rebuild(scope, registryScope, 'c');
  await db.backup(dbPath);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const readerFactory = vi.fn(() => {
    throw new Error('No RPC allowed');
  });
  for (const command of ['metrics', 'rank']) {
    const args = [
      command,
      '--db',
      dbPath,
      '--config',
      configPath,
      '--watchlist',
      watchPath,
      '--metadata',
      metadataPath,
      '--save',
    ];
    expect(await runCli(args, { environment: {}, readerFactory })).toBe(0);
    const output = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(output.status).toBe('observed');
    expect(output.rwa[0].blockRangeActivity).toMatchObject({
      fromBlock: '60',
      toBlock: '4800',
      coverageVerified: false,
      swapCount: 1,
    });
    if (command === 'rank')
      expect(output.ranked).toMatchObject([
        { volume5mClosed: '2000000', txCount: 1, multiplierUnit: 'usdMicros' },
      ]);
  }
  expect(readerFactory).not.toHaveBeenCalled();
  const saved = openDatabase(dbPath, { readonly: true });
  try {
    const row = saved.prepare('select payload_json from metric_cursors').get() as {
      payload_json: string;
    };
    expect(JSON.parse(row.payload_json).rwa[0].blockRangeActivity).toMatchObject({
      fromBlock: '60',
      toBlock: '4800',
      coverageVerified: false,
    });
  } finally {
    saved.close();
  }
});

test.each(['ingest_batches', 'fetch_shards', 'minute_boundaries', 'anchors'])(
  'readonly schema rejects a missing P3 input table: %s',
  (table) => {
    const dir = mkdtempSync(join(tmpdir(), 'p3-review-'));
    cliDirs.push(dir);
    const path = join(dir, 'schema.sqlite');
    const db = openDatabase(path);
    db.pragma('foreign_keys=OFF');
    db.exec(`drop table ${table}`);
    db.close();
    expect(() => {
      const opened = openDatabase(path, { readonly: true });
      opened.close();
    }).toThrow(ConfigError);
  },
);

test('multiple watched assets in separate pools remain supported', () => {
  const { db, raw, projection } = setup();
  raw.acceptRange(batch('separate', [swap(4750)]));
  projection.rebuild('s', 's', 'c');
  const report = buildMetricsReport(db, {
    ...input,
    assets: createAssetRegistry('multi', [rwa, addr(4)]),
  });
  expect(report.rwa.find((r) => r.asset.address === rwa)!.blockRangeActivity.swapCount).toBe(1);
  expect(report.rwa.find((r) => r.asset.address === addr(4))!.blockRangeActivity.swapCount).toBe(0);
});

test('retained bounds still contain active swaps after whole accepted intervals are invalidated', () => {
  const { db, raw, projection } = setup();
  raw.acceptRange(batch('retained', [swap(4750)]));
  db.prepare('delete from accepted_ranges where scope_id=?').run('s');
  projection.rebuild('s', 's', 'c');
  const report = buildMetricsReport(db, input);
  expect(report.rwa[0]!.blockRangeActivity).toMatchObject({
    fromBlock: 4750n,
    toBlock: 4750n,
    coverageVerified: false,
    swapCount: 1,
  });
  expect(report.coverage.every((c) => !c.complete)).toBe(true);
});
