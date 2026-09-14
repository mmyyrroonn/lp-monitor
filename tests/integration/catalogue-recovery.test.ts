import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadEnv } from '../../src/config/env.js';
import { runRecorder } from '../../src/ops/recorder.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

test('historical discovery retries one missing interval without refetching its accepted prefix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-catalogue-recovery-'));
  const fixture = recorderFixture();
  fixture.failRange(50n, ['timeout', 'rate-limit', 'timeout']);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const config = { ...loadChainConfig('config/robinhood.json'), discoveryMaxRangeBlocks: 50 };
    expect(
      await runRecorder({
        command: 'ingest',
        config,
        env: loadEnv({ RH_RPC_HTTP: 'https://fixture.invalid' }),
        watchlistPath: 'config/watchlist.stocks.json',
        databasePath: join(dir, 'db.sqlite'),
        outputDirectory: join(dir, 'runs'),
        fromBlock: 200n,
        toBlock: 200n,
        durationMs: null,
        maxCalls: 10_000,
        evidenceMode: 'off',
        readerFactory: fixture.factory,
      }),
    ).toBe(0);

    const firstRangeAttempts = fixture.rangeAttempts.filter((item) => item.fromBlock === 0n);
    expect(firstRangeAttempts).toHaveLength(4);
    expect(firstRangeAttempts.every((item) => item.failure === null)).toBe(true);
    const failedIntervalAttempts = fixture.rangeAttempts.filter((item) => item.fromBlock === 50n);
    expect(
      failedIntervalAttempts.filter((item) => item.failure !== null).map((item) => item.failure),
    ).toEqual(['timeout', 'rate-limit', 'timeout']);
    expect(failedIntervalAttempts.some((item) => item.failure === null)).toBe(true);

    const runFolder = readdirSync(join(dir, 'runs'))[0]!;
    const manifest = JSON.parse(
      readFileSync(join(dir, 'runs', runFolder, 'manifest.json'), 'utf8'),
    ) as {
      status: string;
      discoveryComplete: boolean;
      batches: Array<{
        fromBlock: string;
        toBlock: string;
        accepted: boolean;
        failureKinds?: string[];
        rpcAttempts?: number;
      }>;
    };
    expect(manifest.status).toBe('complete');
    expect(manifest.discoveryComplete).toBe(true);
    const failedIntervalBatches = manifest.batches.filter((batch) => batch.fromBlock === '50');
    expect(failedIntervalBatches.filter((batch) => !batch.accepted)).toHaveLength(1);
    expect(failedIntervalBatches.filter((batch) => batch.accepted)).toHaveLength(1);
    expect(failedIntervalBatches[0]?.failureKinds).toEqual(['timeout-or-network', 'rate-limit']);
    expect(failedIntervalBatches[0]?.rpcAttempts).toBeGreaterThanOrEqual(4);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('rechecks a changed end anchor and retries a transient anchor refresh failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-catalogue-anchor-recovery-'));
  const fixture = recorderFixture();
  const config = { ...loadChainConfig('config/robinhood.json'), discoveryMaxRangeBlocks: 50 };
  const base = {
    command: 'ingest' as const,
    config,
    env: loadEnv({ RH_RPC_HTTP: 'https://fixture.invalid' }),
    watchlistPath: 'config/watchlist.stocks.json',
    databasePath: join(dir, 'db.sqlite'),
    outputDirectory: join(dir, 'runs'),
    fromBlock: 200n,
    toBlock: 200n,
    durationMs: null,
    maxCalls: 10_000,
    evidenceMode: 'off' as const,
    readerFactory: fixture.factory,
  };
  expect(await runRecorder(base)).toBe(0);
  fixture.fork();
  fixture.resetBranchAfterAnchor(149n);
  fixture.flipAfterLog(150n);
  fixture.failAnchor(199n, ['ok', 'timeout']);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await runRecorder(base)).toBe(0);
    const retryEvents = log.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((event): event is Record<string, unknown> => event?.event === 'discovery-retry');
    expect(
      retryEvents.some(
        (event) =>
          event.phase === 'batch' && (event.failureKinds as string[]).includes('anchor-changed'),
      ),
    ).toBe(true);
    expect(
      retryEvents.some(
        (event) =>
          event.phase === 'anchor' &&
          (event.failureKinds as string[]).includes('timeout-or-network'),
      ),
    ).toBe(true);
    const runFolder = readdirSync(join(dir, 'runs')).sort().at(-1)!;
    const manifest = JSON.parse(
      readFileSync(join(dir, 'runs', runFolder, 'manifest.json'), 'utf8'),
    ) as {
      status: string;
      discoveryComplete: boolean;
      batches: Array<{ accepted: boolean; failureKinds?: string[] }>;
    };
    expect(manifest.status).toBe('complete');
    expect(manifest.discoveryComplete).toBe(true);
    expect(
      manifest.batches.some(
        (batch) => !batch.accepted && batch.failureKinds?.includes('anchor-changed'),
      ),
    ).toBe(true);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
