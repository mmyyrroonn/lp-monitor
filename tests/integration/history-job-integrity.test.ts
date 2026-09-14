import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';
import { toHex } from 'viem';
import { openDatabase } from '../../src/storage/database.js';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadAssetVersion } from '../../src/registry/assets.js';
import { computeWatchScopeId } from '../../src/ingest/filter-plan.js';
import { prepareHistoryJob, refreshHistoryJob, runHistoryJob } from '../../src/ops/history-job.js';
import type { HistoryJobSpec } from '../../src/storage/history-jobs.js';
import { runRecorder } from '../../src/ops/recorder.js';
import { loadEnv } from '../../src/config/env.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

const environment = { RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' };

function jobSpec(dir: string, overrides: Partial<HistoryJobSpec> = {}): HistoryJobSpec {
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
    // Fixture chain time is 1000 + block, so the context window must fit inside it.
    analysisStartSec: 1_150,
    analysisEndSec: 1_200,
    sourceDatabasePath: join(dir, 'source.sqlite'),
    studyDatabasePath: join(dir, 'study.sqlite'),
    watchlistPath,
    configPath,
    warmupMinutes: 0,
    outcomeMinutes: 0,
    ...overrides,
  };
}

async function seedSource(dir: string, fixture: ReturnType<typeof recorderFixture>) {
  return runRecorder({
    command: 'ingest',
    config: loadChainConfig('config/robinhood.json'),
    env: loadEnv(environment),
    watchlistPath: 'config/watchlist.amc.json',
    databasePath: join(dir, 'source.sqlite'),
    outputDirectory: join(dir, 'seed'),
    fromBlock: 90n,
    toBlock: 200n,
    durationMs: null,
    maxCalls: 10_000,
    evidenceMode: 'off',
    readerFactory: fixture.factory,
  });
}

function scopes(spec: HistoryJobSpec) {
  const config = loadChainConfig(spec.configPath);
  const assets = loadAssetVersion(spec.watchlistPath);
  const deployments = { v3Factory: config.v3Factory, v4Manager: config.v4Manager };
  return {
    operations: computeWatchScopeId(assets, 'operations', deployments),
    registry: computeWatchScopeId(assets, 'discovery-only', deployments),
  };
}

test('a divergent registry branch is invalidated instead of completing the job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-branch-'));
  const fixture = recorderFixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await seedSource(dir, fixture)).toBe(0);
    const spec = jobSpec(dir);
    const prepared = await prepareHistoryJob(spec);
    const scopeIds = scopes(spec);
    const bogus = '0x' + 'de'.repeat(32);
    const db = openDatabase(spec.studyDatabasePath);
    try {
      expect(
        (
          db
            .prepare('select count(*) n from anchors where scope_id=? and block_number=200')
            .get(scopeIds.registry) as { n: number }
        ).n,
      ).toBe(1);
      db.prepare('delete from anchors where scope_id=? and block_number=200').run(
        scopeIds.operations,
      );
      db.prepare(
        'insert into anchors(scope_id,block_number,block_hash,timestamp_sec) values(?,?,?,?)',
      ).run(scopeIds.operations, 200, bogus, 999_999);
    } finally {
      db.close();
    }
    const completed = await runHistoryJob({
      studyDatabasePath: spec.studyDatabasePath,
      jobId: prepared.id,
      environment,
      readerFactory: fixture.factory,
      maxRpcCalls: 500,
      durationMs: 60_000,
    });
    expect(completed.status).toBe('complete');
    expect(completed.notes.join(' ')).toMatch(/divergence/i);
    const check = openDatabase(spec.studyDatabasePath, { readonly: true });
    try {
      expect(
        (
          check.prepare('select count(*) n from anchors where block_hash=?').get(bogus) as {
            n: number;
          }
        ).n,
      ).toBe(0);
    } finally {
      check.close();
    }
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

test('a frozen job keeps running after the live source database changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-frozen-'));
  const fixture = recorderFixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await seedSource(dir, fixture)).toBe(0);
    const spec = jobSpec(dir);
    const prepared = await prepareHistoryJob(spec);
    const source = openDatabase(join(dir, 'source.sqlite'));
    try {
      source.exec('create table unrelated_probe(value text)');
      source.prepare('insert into unrelated_probe(value) values (?)').run('recorder-write');
    } finally {
      source.close();
    }
    const completed = await runHistoryJob({
      studyDatabasePath: spec.studyDatabasePath,
      jobId: prepared.id,
      environment,
      readerFactory: fixture.factory,
      maxRpcCalls: 500,
      durationMs: 60_000,
    });
    expect(completed.status).toBe('complete');
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

test('a changed watchlist still invalidates the frozen job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-watchlist-'));
  const fixture = recorderFixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await seedSource(dir, fixture)).toBe(0);
    const spec = jobSpec(dir, { watchlistPath: join(dir, 'watchlist.json') });
    writeFileSync(spec.watchlistPath, JSON.stringify({ version: 'changed', assets: [] }));
    const prepared = await prepareHistoryJob(spec);
    writeFileSync(
      spec.watchlistPath,
      JSON.stringify({ version: 'changed-again', assets: [], extra: true }),
    );
    await expect(
      runHistoryJob({
        studyDatabasePath: spec.studyDatabasePath,
        jobId: prepared.id,
        environment,
        readerFactory: fixture.factory,
        maxRpcCalls: 500,
        durationMs: 60_000,
      }),
    ).rejects.toThrow(/snapshot changed/i);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

test('a time-only gap is repaired from stored logs within the same run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-time-'));
  const fixture = recorderFixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await seedSource(dir, fixture)).toBe(0);
    const spec = jobSpec(dir);
    const prepared = await prepareHistoryJob(spec);
    const scopeIds = scopes(spec);
    const db = openDatabase(spec.studyDatabasePath);
    try {
      db.prepare('delete from log_times where scope_id=?').run(scopeIds.operations);
    } finally {
      db.close();
    }
    const missingTime = refreshHistoryJob(spec.studyDatabasePath, prepared.id);
    expect(missingTime.timeUnknown.length).toBeGreaterThan(0);
    const completed = await runHistoryJob({
      studyDatabasePath: spec.studyDatabasePath,
      jobId: prepared.id,
      environment,
      readerFactory: fixture.factory,
      maxRpcCalls: 500,
      durationMs: 60_000,
    });
    expect(completed.timeUnknown).toEqual([]);
    expect(completed.missing).toEqual([]);
    expect(completed.status).toBe('complete');
    expect(completed.currentRunRpcCalls).toBeGreaterThan(0);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

test('a study window outside the recorded anchors stays unproven', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-window-'));
  const fixture = recorderFixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await seedSource(dir, fixture)).toBe(0);
    const spec = jobSpec(dir, {
      analysisStartSec: 5_000,
      analysisEndSec: 6_000,
      warmupMinutes: 180,
      outcomeMinutes: 180,
    });
    const prepared = await prepareHistoryJob(spec);
    const completed = await runHistoryJob({
      studyDatabasePath: spec.studyDatabasePath,
      jobId: prepared.id,
      environment,
      readerFactory: fixture.factory,
      maxRpcCalls: 500,
      durationMs: 60_000,
    });
    expect(completed.status).not.toBe('complete');
    expect(completed.operationMissing.map((item) => item.reason)).toContain(
      'analysis-window-unproven',
    );
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
