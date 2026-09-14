import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadAssetVersion } from '../../src/registry/assets.js';
import { prepareHistoryJob, runHistoryJob } from '../../src/ops/history-job.js';
import { readHistoryJob, type HistoryJobSpec } from '../../src/storage/history-jobs.js';
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
    targetHash: '0x' + '1'.repeat(64),
    analysisStartSec: 1_120,
    analysisEndSec: 1_200,
    sourceDatabasePath: join(dir, 'source.sqlite'),
    studyDatabasePath: join(dir, 'study.sqlite'),
    watchlistPath,
    configPath,
    warmupMinutes: 180,
    outcomeMinutes: 180,
  };
}

test('budget interruption is durable and leaves the job resumable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-job-recovery-'));
  const sourcePath = join(dir, 'source.sqlite');
  const source = openDatabase(sourcePath);
  source.close();
  const fixture = recorderFixture();
  try {
    const jobSpec = spec(dir);
    const prepared = await prepareHistoryJob(jobSpec);
    const interrupted = await runHistoryJob({
      studyDatabasePath: jobSpec.studyDatabasePath,
      jobId: prepared.id,
      environment: { RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' },
      readerFactory: fixture.factory,
      maxRpcCalls: 1,
      durationMs: 60_000,
    });
    expect(interrupted.status).toBe('paused');
    const paused = readHistoryJob(jobSpec.studyDatabasePath, prepared.id);
    expect(paused.status).toBe('paused');
    expect(paused.attempts).toBe(1);
    expect(paused.cumulativeRpcCalls).toBeGreaterThan(0);
    expect(paused.lastError).toMatch(/budget/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
