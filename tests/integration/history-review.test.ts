import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { fetchRange } from '../../src/ingest/record-range.js';
import { PoolRegistry } from '../../src/registry/pools.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { openDatabase } from '../../src/storage/database.js';
import { computeWatchScopeId } from '../../src/ingest/filter-plan.js';
import { runCli } from '../../src/cli.js';
import { reviewHistory, missingIntervals } from '../../src/ops/history.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadAssetVersion } from '../../src/registry/assets.js';

test('range subtraction retains only uncovered inclusive intervals', () => {
  expect(
    missingIntervals(10n, 30n, [
      [5n, 12n],
      [15n, 19n],
      [18n, 25n],
    ]),
  ).toEqual([
    [13n, 14n],
    [26n, 30n],
  ]);
});

test('history uses complete local raw without RPC and clips events to requested blocks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-'));
  const databasePath = join(dir, 'source.sqlite');
  const fixture = recorderFixture();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const environment = { RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' };
  expect(
    await runCli(
      [
        'ingest',
        '--from-block',
        '90',
        '--to-block',
        '200',
        '--db',
        databasePath,
        '--out',
        join(dir, 'seed'),
      ],
      { environment, readerFactory: fixture.factory },
    ),
  ).toBe(0);
  const report = await reviewHistory({
    databasePath,
    outputDirectory: join(dir, 'review'),
    fromBlock: 130n,
    toBlock: 190n,
    config: loadChainConfig('config/robinhood.json'),
    assets: loadAssetVersion('config/watchlist.amc.json'),
    readerFactory: () => {
      throw new Error('must stay offline');
    },
  });
  expect(report.missing).toEqual([]);
  expect(report.registryMissing).toEqual([]);
  expect(report.complete).toBe(true);
  expect(report.projection?.events.map((e) => e.ref.blockNumber)).toEqual([180n]);
  expect(report.acquired).toEqual([]);
  expect(report.activity[0]?.coveredSubset?.activity.poolActivityUsdgRaw).toBeNull();
  expect(report.activity[0]?.coveredSubset?.activity.swapCount).toBe(1);
  vi.restoreAllMocks();
});

test('history rejects unsafe and reversed bounds before opening any database', async () => {
  await expect(
    runCli(['history', '--db', 'missing', '--from-block', '9', '--to-block', '2']),
  ).rejects.toThrow(/ordered/);
  await expect(
    runCli(['history', '--db', 'missing', '--from-block', '0', '--to-block', '9007199254740992']),
  ).rejects.toThrow(/safe/);
});

test('history acquires only missing operation suffix into an isolated snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-gap-'));
  const databasePath = join(dir, 'source.sqlite');
  const fixture = recorderFixture();
  const environment = { RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(
    await runCli(
      [
        'ingest',
        '--from-block',
        '90',
        '--to-block',
        '150',
        '--db',
        databasePath,
        '--out',
        join(dir, 'seed'),
      ],
      { environment, readerFactory: fixture.factory },
    ),
  ).toBe(0);
  const report = await reviewHistory({
    databasePath,
    outputDirectory: join(dir, 'review'),
    fromBlock: 120n,
    toBlock: 200n,
    config: loadChainConfig('config/robinhood.json'),
    assets: loadAssetVersion('config/watchlist.amc.json'),
    environment,
    readerFactory: fixture.factory,
    metadata: {
      version: 'fixture',
      chainId: 4663,
      source: 'synthetic',
      entries: Object.values(loadChainConfig('config/robinhood.json').tokens).map((address) => ({
        address,
        decimals: 6,
        observedAtBlock: '0',
        blockHash: '0x' + '0'.repeat(64),
      })),
    },
  });
  expect(report.missing).toEqual([]);
  expect(report.registryMissing).toEqual([]);
  expect(report.complete).toBe(true);
  expect(report.activity[0]?.coveredSubset?.activity.poolActivityUsdMicros).toBeGreaterThan(0n);
  expect(report.activity[0]?.coveredSubset?.activity.swapCount).toBe(2);
  expect(
    report.acquired.filter((a) => a.mode === 'operations').map((a) => [a.fromBlock, a.toBlock]),
  ).toEqual([[151n, 200n]]);
  expect(report.projection?.events.map((e) => e.ref.blockNumber)).toEqual([120n, 180n]);
  const offline = await reviewHistory({
    databasePath,
    outputDirectory: join(dir, 'again'),
    fromBlock: 120n,
    toBlock: 200n,
    config: loadChainConfig('config/robinhood.json'),
    assets: loadAssetVersion('config/watchlist.amc.json'),
    environment: {},
  });
  expect(offline.missing).toEqual([[151n, 200n]]);
  expect(offline.unavailable.length).toBeGreaterThan(0);
  vi.restoreAllMocks();
});

test('history with no source database records missing evidence in its own review database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-empty-'));
  const report = await reviewHistory({
    databasePath: join(dir, 'absent.sqlite'),
    outputDirectory: join(dir, 'review'),
    fromBlock: 120n,
    toBlock: 130n,
    config: loadChainConfig('config/robinhood.json'),
    assets: loadAssetVersion('config/watchlist.amc.json'),
    environment: {},
  });
  expect(report.missing).toEqual([[120n, 130n]]);
  expect(report.activity[0]?.intervalTotal).toBeNull();
  expect(report.activity[0]?.coveredSubset).toBeNull();
});

test('complete operations cannot hide incomplete discovery coverage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-registry-'));
  const databasePath = join(dir, 'source.sqlite');
  const fixture = recorderFixture();
  const environment = { RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(
    await runCli(
      [
        'ingest',
        '--from-block',
        '90',
        '--to-block',
        '200',
        '--db',
        databasePath,
        '--out',
        join(dir, 'seed'),
      ],
      { environment, readerFactory: fixture.factory },
    ),
  ).toBe(0);
  const config = loadChainConfig('config/robinhood.json');
  const assets = loadAssetVersion('config/watchlist.amc.json');
  const scope = computeWatchScopeId(assets, 'discovery-only', config);
  const db = openDatabase(databasePath);
  db.prepare('delete from accepted_ranges where scope_id=?').run(scope);
  db.close();
  const offline = await reviewHistory({
    databasePath,
    outputDirectory: join(dir, 'offline'),
    fromBlock: 120n,
    toBlock: 190n,
    config,
    assets,
    environment: {},
  });
  expect(offline.registryMissing).toEqual([[0n, 190n]]);
  expect(offline.complete).toBe(false);
  expect(offline.activity[0]?.intervalTotal).toBeNull();
  const repaired = await reviewHistory({
    databasePath,
    outputDirectory: join(dir, 'repair'),
    fromBlock: 120n,
    toBlock: 190n,
    config,
    assets,
    environment,
    readerFactory: fixture.factory,
  });
  expect(repaired.registryMissing).toEqual([]);
  expect(repaired.complete).toBe(true);
  expect(repaired.acquired.map((a) => a.mode)).toEqual(['discovery-only']);
  vi.restoreAllMocks();
});

test('newly recovered registry rejects old operation batches with narrow selectors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-selectors-'));
  const databasePath = join(dir, 'source.sqlite');
  const fixture = recorderFixture();
  const environment = { RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' };
  const config = loadChainConfig('config/robinhood.json');
  const assets = loadAssetVersion('config/watchlist.amc.json');
  const scopeId = computeWatchScopeId(assets, 'operations', config);
  const reader = fixture.factory(loadEnv(environment), {
    maxCalls: 1000,
    perSecond: 100000,
    timeoutMs: 1000,
    maxRetries: 0,
    evidenceMode: 'off',
  });
  const narrow = await fetchRange(reader, {
    mode: 'operations',
    fromBlock: 120n,
    toBlock: 190n,
    end: await reader.getAnchor(190n),
    assets,
    pools: new PoolRegistry([]),
    v3Factory: config.v3Factory,
    v4Manager: config.v4Manager,
    observedAtMs: 1000,
    captureMode: 'backfill',
  });
  await reader.close?.();
  expect(narrow.manifest.shards.every((s) => s.filterId.startsWith('discovery-'))).toBe(true);
  const db = openDatabase(databasePath);
  new SqliteRangeStore(db).acceptRange(narrow);
  db.close();
  const report = await reviewHistory({
    databasePath,
    outputDirectory: join(dir, 'review'),
    fromBlock: 120n,
    toBlock: 190n,
    config,
    assets,
    environment,
    readerFactory: fixture.factory,
  });
  expect(report.scopeId).toBe(scopeId);
  expect(report.localMissing).toEqual([]);
  expect(report.localRegistryMissing).toEqual([[0n, 190n]]);
  expect(report.acquired.map((a) => [a.mode, a.fromBlock, a.toBlock])).toEqual([
    ['discovery-only', 0n, 190n],
    ['operations', 120n, 190n],
  ]);
  expect(report.complete).toBe(true);
  expect(report.activity[0]?.coveredSubset?.activity.swapCount).toBe(2);
});
