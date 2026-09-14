import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';
import { toHex } from 'viem';
import { runCli } from '../../src/cli.js';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadAssetVersion } from '../../src/registry/assets.js';
import { prepareHistoryJob, runHistoryJob } from '../../src/ops/history-job.js';
import type { HistoryJobSpec } from '../../src/storage/history-jobs.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

function spec(dir: string): HistoryJobSpec {
  const configPath = resolve('config/robinhood.json');
  const watchlistPath = resolve('config/watchlist.amc.json');
  return {
    version: 1,
    chainId: 4663,
    assetVersion: loadAssetVersion(watchlistPath).version,
    protocolVersion: loadChainConfig(configPath).version,
    fromBlock: '120',
    toBlock: '200',
    targetHash: toHex(200n, { size: 32 }),
    // The fixture chain maps block N to timestamp 1000+N, so this spec must not
    // request warmup/outcome context outside the recorded anchor span.
    analysisStartSec: 1_120,
    analysisEndSec: 1_200,
    sourceDatabasePath: join(dir, 'source.sqlite'),
    studyDatabasePath: join(dir, 'study.sqlite'),
    watchlistPath,
    configPath,
    warmupMinutes: 0,
    outcomeMinutes: 0,
  };
}

test('history job resumes missing ranges in an isolated study database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-job-run-'));
  const fixture = recorderFixture();
  const environment = { RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(
      await runCli(
        [
          'ingest',
          '--watchlist',
          'config/watchlist.amc.json',
          '--from-block',
          '90',
          '--to-block',
          '150',
          '--db',
          join(dir, 'source.sqlite'),
          '--out',
          join(dir, 'seed'),
        ],
        { environment, readerFactory: fixture.factory },
      ),
    ).toBe(0);
    const jobSpec = spec(dir);
    const prepared = await prepareHistoryJob(jobSpec);
    expect(prepared.status).toBe('prepared');
    expect(prepared.operationMissing.length).toBeGreaterThan(0);
    const completed = await runHistoryJob({
      studyDatabasePath: jobSpec.studyDatabasePath,
      jobId: prepared.id,
      environment,
      readerFactory: fixture.factory,
      maxRpcCalls: 500,
      durationMs: 60_000,
    });
    expect(completed.status).toBe('complete');
    expect(completed.cumulativeRpcCalls).toBeGreaterThan(0);
    expect(completed.currentRunRpcCalls).toBe(completed.cumulativeRpcCalls);
    expect(completed.missing).toEqual([]);
    expect(completed.completedCoverage).toEqual([
      { fromBlock: '120', toBlock: '200', reason: 'accepted-complete' },
    ]);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
