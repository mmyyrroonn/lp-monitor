import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadAssetVersion } from '../../src/registry/assets.js';
import {
  normalizeHistoryJobSpec,
  readHistoryJob,
  type HistoryJobSpec,
} from '../../src/storage/history-jobs.js';
import { prepareHistoryJob } from '../../src/ops/history-job.js';
import { missingIntervals } from '../../src/ops/history.js';

function makeSpec(dir: string, overrides: Partial<HistoryJobSpec> = {}): HistoryJobSpec {
  const configPath = resolve('config/robinhood.json');
  const watchlistPath = resolve('config/watchlist.amc.json');
  return {
    version: 1,
    chainId: 4663,
    assetVersion: loadAssetVersion(watchlistPath).version,
    protocolVersion: loadChainConfig(configPath).version,
    fromBlock: '100',
    toBlock: '399',
    targetHash: '0x' + '1'.repeat(64),
    analysisStartSec: 1_000,
    analysisEndSec: 2_000,
    sourceDatabasePath: join(dir, 'source.sqlite'),
    studyDatabasePath: join(dir, 'study.sqlite'),
    watchlistPath,
    configPath,
    warmupMinutes: 180,
    outcomeMinutes: 180,
    ...overrides,
  };
}

test('resume schedules only uncovered inclusive block ranges', () => {
  expect(
    missingIntervals(100n, 399n, [
      [100n, 199n],
      [300n, 399n],
    ]),
  ).toEqual([[200n, 299n]]);
});

test('prepare persists a fixed spec and category-specific gaps across reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-job-plan-'));
  try {
    const spec = makeSpec(dir);
    const first = await prepareHistoryJob(spec);
    const second = readHistoryJob(spec.studyDatabasePath, first.id);
    expect(second.id).toBe(first.id);
    expect(second.specHash).toBe(first.specHash);
    expect(second.status).toBe('prepared');
    expect(second.spec.fromBlock).toBe('100');
    expect(second.registryMissing.some((item) => item.reason.includes('coverage'))).toBe(true);
    expect(second.operationMissing.some((item) => item.reason.includes('coverage'))).toBe(true);
    expect(second.missing.length).toBe(
      second.registryMissing.length +
        second.operationMissing.length +
        second.timeUnknown.length +
        second.unpriced.length,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepare rejects source and study aliasing and conflicting study writers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-job-conflict-'));
  try {
    const spec = makeSpec(dir);
    await expect(
      prepareHistoryJob({ ...spec, sourceDatabasePath: spec.studyDatabasePath }),
    ).rejects.toThrow(/must differ/);
    await prepareHistoryJob(spec);
    await expect(prepareHistoryJob({ ...spec, targetHash: '0x' + '2'.repeat(64) })).rejects.toThrow(
      /already owned/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume refuses changed frozen input files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-job-snapshot-'));
  try {
    const watchlistPath = join(dir, 'watchlist.json');
    const sourceWatchlist = resolve('config/watchlist.amc.json');
    writeFileSync(watchlistPath, readFileSync(sourceWatchlist));
    const spec = makeSpec(dir, { watchlistPath });
    const state = await prepareHistoryJob(spec);
    writeFileSync(
      watchlistPath,
      require('node:fs').readFileSync(watchlistPath) + Buffer.from('\n'),
    );
    const { runHistoryJob } = await import('../../src/ops/history-job.js');
    await expect(
      runHistoryJob({ studyDatabasePath: spec.studyDatabasePath, jobId: state.id }),
    ).rejects.toThrow(/snapshot changed/);
    expect(readHistoryJob(spec.studyDatabasePath, state.id).status).toBe('failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
