import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadEnv } from '../../src/config/env.js';
import { loadAssetVersion } from '../../src/registry/assets.js';
import { PoolRegistry } from '../../src/registry/pools.js';
import { computeWatchScopeId } from '../../src/ingest/filter-plan.js';
import { fetchRange } from '../../src/ingest/record-range.js';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { acceptedCoverage, missingIntervals } from '../../src/ops/history.js';
import { runCatalogue } from '../../src/ops/catalogue.js';
import { runRecorder, type RecorderOptions } from '../../src/ops/recorder.js';
import { RpcFailure } from '../../src/rpc/errors.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

type Fixture = ReturnType<typeof recorderFixture>;

/** Fail the first anchor reads of one block height, independent of fixture branch state. */
function anchorFailingFactory(
  fixture: Fixture,
  block: bigint,
  failures: readonly unknown[],
  skip = 0,
) {
  const remaining = [...failures];
  const factory: Fixture['factory'] = (env, options) => {
    const reader = fixture.factory(env, options);
    let seen = 0;
    return {
      ...reader,
      getAnchor: async (target: bigint | 'latest') => {
        if (target === block) {
          seen++;
          if (seen > skip && remaining.length > 0) throw remaining.shift();
        }
        return reader.getAnchor(target);
      },
    };
  };
  return factory;
}

function environment() {
  return loadEnv({ RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' });
}

function deployments(config: ReturnType<typeof loadChainConfig>) {
  return { v3Factory: config.v3Factory, v4Manager: config.v4Manager };
}

function runDirectory(outputDirectory: string): string {
  return join(outputDirectory, readdirSync(outputDirectory).sort().at(-1)!);
}

async function seedAcceptedDiscoveryRange(
  fixture: Fixture,
  databasePath: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<void> {
  const config = { ...loadChainConfig('config/robinhood.json'), discoveryMaxRangeBlocks: 50 };
  const assets = loadAssetVersion('config/watchlist.stocks.json');
  const reader = fixture.factory(environment(), {
    maxCalls: 10_000,
    perSecond: 100_000,
    maxBackfillRpcRps: 100_000,
    timeoutMs: 1_000,
    maxRetries: 0,
    evidenceMode: 'off',
    evidenceFile: databasePath + '.requests.jsonl',
  });
  try {
    const end = await reader.getAnchor(toBlock);
    const batch = await fetchRange(reader, {
      mode: 'discovery-only',
      fromBlock,
      toBlock,
      end,
      previous: null,
      assets,
      pools: new PoolRegistry([]),
      ...deployments(config),
      logResponseGuard: config.logResponseGuard,
      maxLogsPerResponse: config.maxLogsPerResponse,
      maxFilterValues: config.maxFilterValues,
      discoveryMaxRangeBlocks: config.discoveryMaxRangeBlocks,
      observedAtMs: Date.now(),
      captureMode: 'backfill',
    });
    expect(batch.completeness).toBe('complete');
    const db = openDatabase(databasePath);
    try {
      const store = new SqliteRangeStore(db);
      store.saveRaw(batch, { compact: true });
      store.acceptRange(batch);
    } finally {
      db.close();
    }
  } finally {
    await reader.close?.();
  }
}

function discoveryCoverage(databasePath: string): readonly [bigint, bigint][] {
  const config = loadChainConfig('config/robinhood.json');
  const assets = loadAssetVersion('config/watchlist.stocks.json');
  const scopeId = computeWatchScopeId(assets, 'discovery-only', deployments(config));
  const db = openDatabase(databasePath, { readonly: true });
  try {
    return acceptedCoverage(db, scopeId);
  } finally {
    db.close();
  }
}

function recorderOptions(dir: string, fixture: Fixture): RecorderOptions {
  return {
    command: 'ingest',
    config: { ...loadChainConfig('config/robinhood.json'), discoveryMaxRangeBlocks: 50 },
    env: environment(),
    watchlistPath: 'config/watchlist.stocks.json',
    databasePath: join(dir, 'db.sqlite'),
    outputDirectory: join(dir, 'runs'),
    fromBlock: 200n,
    toBlock: 200n,
    durationMs: null,
    maxCalls: 10_000,
    evidenceMode: 'off',
    readerFactory: fixture.factory,
  };
}

test('catalogue rebuilds an unproven accepted prefix instead of trusting the cursor alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-catalogue-prefix-'));
  const fixture = recorderFixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await seedAcceptedDiscoveryRange(fixture, join(dir, 'db.sqlite'), 150n, 200n);
    expect(missingIntervals(90n, 200n, discoveryCoverage(join(dir, 'db.sqlite')))).toEqual([
      [90n, 149n],
    ]);

    const report = await runCatalogue({
      ...recorderOptions(dir, fixture),
      durationMs: 60_000,
      targetBlock: 200n,
    });
    expect(report.status).toBe('complete');
    expect(report.missing).toEqual([]);
    expect(missingIntervals(90n, 200n, discoveryCoverage(join(dir, 'db.sqlite')))).toEqual([]);
    const manifest = JSON.parse(
      readFileSync(join(report.runDirectory, 'manifest.json'), 'utf8'),
    ) as {
      discoveryScope: string;
      batches: { fromBlock: string; accepted: boolean; scopeId: string }[];
    };
    expect(
      manifest.batches.some(
        (batch) =>
          batch.scopeId === manifest.discoveryScope &&
          batch.accepted &&
          BigInt(batch.fromBlock) <= 90n,
      ),
    ).toBe(true);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

test('catalogue never downgrades completion to a substitute branch at the fixed target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-catalogue-target-'));
  const fixture = recorderFixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const first = await runCatalogue({
      ...recorderOptions(dir, fixture),
      durationMs: 60_000,
      targetBlock: 149n,
    });
    expect(first.status).toBe('complete');
    fixture.flipAfterLog(150n);
    const second = await runCatalogue({
      ...recorderOptions(dir, fixture),
      durationMs: 60_000,
      targetBlock: 200n,
    });
    expect(second.status).toBe('incomplete');
    expect(second.missing.map((item) => item.reason)).toContain('target-anchor-changed');
    expect(second.targetAnchor?.number).toBe(200n);
    expect(second.acceptedTip?.hash.toLowerCase()).not.toBe(
      second.targetAnchor?.hash.toLowerCase(),
    );
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

test('a transient batch-end anchor failure enters discovery recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-catalogue-anchor-retry-'));
  const fixture = recorderFixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await seedAcceptedDiscoveryRange(fixture, join(dir, 'db.sqlite'), 90n, 149n);
    const report = await runCatalogue({
      ...recorderOptions(dir, fixture),
      durationMs: 60_000,
      targetBlock: 200n,
      readerFactory: anchorFailingFactory(fixture, 199n, [new Error('request timed out')]),
    });
    expect(report.status).toBe('complete');
    const retries = log.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((event): event is Record<string, unknown> => event?.event === 'discovery-retry');
    expect(
      retries.some(
        (event) =>
          event.phase === 'anchor' &&
          (event.failureKinds as string[]).includes('timeout-or-network'),
      ),
    ).toBe(true);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

test('an earlier catalogue target excludes pools created after it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-catalogue-earlier-'));
  const fixture = recorderFixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const later = await runCatalogue({
      ...recorderOptions(dir, fixture),
      durationMs: 60_000,
      targetBlock: 200n,
    });
    expect(later.status).toBe('complete');
    expect(later.poolCount).toBe(1);
    const earlier = await runCatalogue({
      ...recorderOptions(dir, fixture),
      durationMs: 60_000,
      targetBlock: 80n,
    });
    expect(earlier.status).toBe('complete');
    expect(earlier.poolCount).toBe(0);
    expect(earlier.stockPoolAttributionCount).toBe(0);
    expect(runDirectory(join(dir, 'runs'))).toContain('catalogue');
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

test('bootstrap keeps recovery for a failing initial checkpoint recheck', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-catalogue-checkpoint-'));
  const fixture = recorderFixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await runRecorder(recorderOptions(dir, fixture))).toBe(0);
    expect(
      await runRecorder({
        ...recorderOptions(dir, fixture),
        readerFactory: anchorFailingFactory(
          fixture,
          200n,
          [new RpcFailure('rate-limit', 'unknown', true)],
          2,
        ),
      }),
    ).toBe(0);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
