import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadEnv } from '../../src/config/env.js';
import { loadMetricMetadata } from '../../src/metrics/metadata.js';
import { parseSignalConfig } from '../../src/signals/config.js';
import { runRecorder, type RecorderOptions } from '../../src/ops/recorder.js';
import { createShutdownController } from '../../src/ops/shutdown.js';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

function setup(dir: string): RecorderOptions {
  return {
    command: 'follow',
    notify: 'local',
    signalConfig: parseSignalConfig(
      JSON.parse(readFileSync('config/signals.initial.json', 'utf8')),
    ),
    metricMetadata: loadMetricMetadata('config/metric-metadata.json'),
    config: loadChainConfig('config/robinhood.json'),
    env: loadEnv({ RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'p6-fixture' }),
    watchlistPath: 'config/watchlist.amc.json',
    databasePath: join(dir, 'db.sqlite'),
    outputDirectory: join(dir, 'runs'),
    fromBlock: 100n,
    durationMs: 1000,
    maxCalls: 10000,
    evidenceMode: 'off',
    readerFactory: recorderFixture().factory,
  };
}

test('SIGINT after raw save preserves evidence without advancing operation cursor; restart commits once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-stop-'));
  const opts = setup(dir);
  const signals = new EventEmitter();
  const shutdown = createShutdownController(signals);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const original = SqliteRangeStore.prototype.saveRaw;
  let savedScope = '';
  const rawSpy = vi.spyOn(SqliteRangeStore.prototype, 'saveRaw').mockImplementation(function (
    this: SqliteRangeStore,
    batch,
  ) {
    original.call(this, batch);
    if (batch.captureMode === 'live') {
      savedScope = batch.scopeId;
      signals.emit('SIGINT');
    }
  });
  try {
    expect(await runRecorder({ ...opts, shutdown })).toBe(0);
    expect(shutdown.requested).toBe(true);
    const stoppedRun = readdirSync(opts.outputDirectory)[0]!;
    const stoppedManifest = JSON.parse(
      readFileSync(join(opts.outputDirectory, stoppedRun, 'manifest.json'), 'utf8'),
    );
    expect(stoppedManifest.follow).toMatchObject({
      acceptedRanges: 0,
      reorgs: 0,
      complete: false,
      failures: [],
    });
    expect(stoppedManifest.stopReason).toBe('SIGINT');

    const db = openDatabase(opts.databasePath, { readonly: true });
    try {
      expect(db.prepare('select count(*) as n from raw_logs').get()).toMatchObject({
        n: expect.any(Number),
      });
      expect(
        (db.prepare('select count(*) as n from raw_logs').get() as { n: number }).n,
      ).toBeGreaterThan(0);
      expect(new SqliteRangeStore(db).acceptedTip(savedScope)).toBeNull();
      expect(db.prepare('select count(*) as n from signal_evaluations').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    rawSpy.mockRestore();
    expect(await runRecorder(opts)).toBe(0);
    const resumed = openDatabase(opts.databasePath, { readonly: true });
    try {
      expect(new SqliteRangeStore(resumed).acceptedTip(savedScope)?.number).toBe(200n);
      expect(resumed.prepare('select count(*) as n from signal_cursors').get()).toEqual({ n: 1 });
      expect(
        resumed
          .prepare(
            'select raw_key,count(*) as n from raw_logs group by raw_key having count(*) > 1',
          )
          .all(),
      ).toEqual([]);
    } finally {
      resumed.close();
    }
  } finally {
    shutdown.dispose();
    rawSpy.mockRestore();
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real recorder persists measured evidence-to-outbox timing, phase budgets and current health without endpoint secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-telemetry-'));
  const opts = setup(dir);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await runRecorder(opts)).toBe(0);
    const run = readdirSync(opts.outputDirectory)[0]!;
    const report = JSON.parse(
      readFileSync(join(opts.outputDirectory, run, 'ops-report.json'), 'utf8'),
    );
    const manifest = JSON.parse(
      readFileSync(join(opts.outputDirectory, run, 'manifest.json'), 'utf8'),
    );
    expect(manifest.telemetry.batchTimings.length).toBeGreaterThan(0);
    const timing = manifest.telemetry.batchTimings[0];
    expect(timing.completeEvidenceAtMs).toBeLessThanOrEqual(timing.outboxDurableAtMs);
    expect(timing.outboxDurableAtMs).toBeLessThanOrEqual(timing.notifyAttemptCompletedAtMs);
    expect(timing.deliveredAtMs).toBeNull();
    expect(manifest.telemetry.healthSamples.at(-1).scanned.blockNumber).toBe('200');
    expect(manifest.telemetry.healthSamples.at(-1).projected.blockNumber).toBe('200');
    expect(JSON.stringify({ report, manifest })).not.toContain('fixture.invalid');
    expect(JSON.parse(readFileSync(opts.databasePath + '.health.json', 'utf8')).scopeId).toBe(
      manifest.scopeId,
    );
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cold startup writes a starting health sidecar before the first RPC', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-starting-'));
  const opts = setup(dir);
  const fixture = recorderFixture();
  let checked = false;
  const readerFactory: NonNullable<RecorderOptions['readerFactory']> = (...args) => {
    const reader = fixture.factory(...args);
    return {
      ...reader,
      async getAnchor(block) {
        if (!checked && block === 'latest') {
          checked = true;
          expect(existsSync(opts.databasePath + '.health.json')).toBe(true);
          expect(
            JSON.parse(readFileSync(opts.databasePath + '.health.json', 'utf8')),
          ).toMatchObject({
            runtimeState: 'starting',
            head: null,
            projected: null,
          });
        }
        return reader.getAnchor(block);
      },
    };
  };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await runRecorder({ ...opts, readerFactory })).toBe(0);
    expect(checked).toBe(true);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unexpected local processing error retains follow statistics and a sanitized local category', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-local-error-'));
  const opts = setup(dir);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  let operationRawSaved = false;
  const originalSave = SqliteRangeStore.prototype.saveRaw;
  const saved = vi.spyOn(SqliteRangeStore.prototype, 'saveRaw').mockImplementation(function (
    this: SqliteRangeStore,
    batch,
  ) {
    originalSave.call(this, batch);
    if (batch.captureMode === 'live') operationRawSaved = true;
  });
  const originalTimes = SqliteRangeStore.prototype.logTimes;
  const times = vi.spyOn(SqliteRangeStore.prototype, 'logTimes').mockImplementation(function (
    this: SqliteRangeStore,
    scope,
  ) {
    if (operationRawSaved) throw Error('https://user:secret@private.invalid/project');
    return originalTimes.call(this, scope);
  });
  try {
    expect(await runRecorder(opts)).toBe(1);
    const run = readdirSync(opts.outputDirectory)[0]!;
    const manifest = JSON.parse(
      readFileSync(join(opts.outputDirectory, run, 'manifest.json'), 'utf8'),
    );
    expect(manifest.failures).toContain('local-error');
    expect(manifest.failures).not.toContain('request-failed');
    expect(manifest.follow).toMatchObject({ acceptedRanges: 0, complete: false });
    expect(JSON.stringify(manifest)).not.toContain('private.invalid');
    expect(manifest.stopReason).toBeNull();
  } finally {
    times.mockRestore();
    saved.mockRestore();
    log.mockRestore();
    error.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('health includes intermediate backlog samples before the outer poll reaches its head', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-backlog-health-'));
  const opts = setup(dir);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(
      await runRecorder({
        ...opts,
        durationMs: 3000,
        config: { ...opts.config, maxRangeBlocks: 50, overlapBlocks: 2 },
      }),
    ).toBe(0);
    const run = readdirSync(opts.outputDirectory)[0]!;
    const manifest = JSON.parse(
      readFileSync(join(opts.outputDirectory, run, 'manifest.json'), 'utf8'),
    );
    expect(
      manifest.telemetry.healthSamples.some(
        (sample: { headGapBlocks: string | null }) =>
          sample.headGapBlocks !== null && BigInt(sample.headGapBlocks) > 0n,
      ),
    ).toBe(true);
    expect(manifest.telemetry.healthSamples.at(-1).scanned.blockNumber).toBe('200');
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stop during minute resolution prevents later RPC admissions and preserves raw evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-stop-resolution-'));
  const opts = setup(dir),
    fixture = recorderFixture();
  const shutdown = createShutdownController(new EventEmitter());
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const originalSave = SqliteRangeStore.prototype.saveRaw;
  let operationRawSaved = false,
    callsAtStop: number | null = null;
  const saved = vi.spyOn(SqliteRangeStore.prototype, 'saveRaw').mockImplementation(function (
    this: SqliteRangeStore,
    batch,
  ) {
    originalSave.call(this, batch);
    if (batch.captureMode === 'live') operationRawSaved = true;
  });
  const readerFactory: NonNullable<RecorderOptions['readerFactory']> = (...args) => {
    const reader = fixture.factory(...args);
    return {
      ...reader,
      async getAnchor(block) {
        const anchor = await reader.getAnchor(block);
        if (operationRawSaved && callsAtStop === null) {
          shutdown.request('SIGINT');
          callsAtStop = fixture.requests.length;
        }
        return anchor;
      },
    };
  };
  try {
    expect(await runRecorder({ ...opts, shutdown, readerFactory })).toBe(0);
    expect(callsAtStop).not.toBeNull();
    expect(fixture.requests.length).toBe(callsAtStop);
    const run = readdirSync(opts.outputDirectory)[0]!;
    const manifest = JSON.parse(
      readFileSync(join(opts.outputDirectory, run, 'manifest.json'), 'utf8'),
    );
    expect(manifest.status).toBe('stopped');
    expect(manifest.follow).toMatchObject({ acceptedRanges: 0, complete: false });
    expect(
      manifest.batches.some(
        (batch: { accepted: boolean; logs: number }) => !batch.accepted && batch.logs > 0,
      ),
    ).toBe(true);
  } finally {
    saved.mockRestore();
    shutdown.dispose();
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGINT during identity verification prevents subsequent startup RPCs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-stop-identity-'));
  const opts = setup(dir),
    fixture = recorderFixture();
  const shutdown = createShutdownController(new EventEmitter());
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  let callsAtStop: number | null = null;
  const readerFactory: NonNullable<RecorderOptions['readerFactory']> = (...args) => {
    const reader = fixture.factory(...args);
    return {
      ...reader,
      async request(method, params) {
        const result = await reader.request(method, params);
        if (callsAtStop === null) {
          shutdown.request('SIGINT');
          callsAtStop = fixture.requests.length;
        }
        return result;
      },
    };
  };
  try {
    expect(await runRecorder({ ...opts, shutdown, readerFactory })).toBe(0);
    expect(callsAtStop).not.toBeNull();
    expect(fixture.requests.length).toBe(callsAtStop);
    const run = readdirSync(opts.outputDirectory)[0]!;
    const manifest = JSON.parse(
      readFileSync(join(opts.outputDirectory, run, 'manifest.json'), 'utf8'),
    );
    expect(manifest.status).toBe('stopped');
    expect(manifest.failures).not.toContain('identity-unverified');
    expect(manifest.counts.operationBatches).toBe(0);
  } finally {
    shutdown.dispose();
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
