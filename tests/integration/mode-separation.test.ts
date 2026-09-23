import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadEnv } from '../../src/config/env.js';
import { loadMetricMetadata } from '../../src/metrics/metadata.js';
import { parseSignalConfig } from '../../src/signals/config.js';
import { runRecorder, type RecorderOptions } from '../../src/ops/recorder.js';
import { openDatabase } from '../../src/storage/database.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lp-mode-'));
  dirs.push(dir);
  return dir;
}

function options(dir: string, overrides: Partial<RecorderOptions> = {}): RecorderOptions {
  return {
    command: 'follow',
    mode: 'record',
    notify: 'none',
    config: loadChainConfig('config/robinhood.json'),
    env: loadEnv({ RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' }),
    watchlistPath: 'config/watchlist.amc.json',
    databasePath: join(dir, 'db.sqlite'),
    outputDirectory: join(dir, 'runs'),
    fromBlock: 100n,
    durationMs: 1000,
    maxCalls: 10000,
    evidenceMode: 'off',
    readerFactory: recorderFixture().factory,
    ...overrides,
  };
}

function monitorOptions(dir: string, notify: 'none' | 'local'): RecorderOptions {
  return options(dir, {
    mode: 'monitor',
    notify,
    signalConfig: parseSignalConfig(
      JSON.parse(readFileSync('config/signals.initial.json', 'utf8')),
    ),
    metricMetadata: loadMetricMetadata('config/metric-metadata.json'),
  });
}

function manifest(options: RecorderOptions): Record<string, unknown> {
  const run = readdirSync(options.outputDirectory)[0]!;
  return JSON.parse(readFileSync(join(options.outputDirectory, run, 'manifest.json'), 'utf8'));
}

function count(db: ReturnType<typeof openDatabase>, table: string): number {
  return Number(db.prepare(`select count(*) from ${table}`).pluck().get());
}

test('record-only runs no projection and writes no delivery policy', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const dir = workspace();
  const opts = options(dir);
  try {
    expect(await runRecorder(opts)).toBe(0);
    const summary = manifest(opts);
    expect(summary).toMatchObject({ processingMode: 'record', deliveryMode: 'none' });
    const db = openDatabase(opts.databasePath);
    try {
      expect(count(db, 'live_projection_cursors')).toBe(0);
      expect(count(db, 'signal_cursors')).toBe(0);
      expect(count(db, 'alert_outbox')).toBe(0);
      expect(count(db, 'delivery_policy')).toBe(0);
      expect(count(db, 'live_events')).toBe(0);
    } finally {
      db.close();
    }
    expect(existsSync(opts.databasePath + '.alerts.jsonl')).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    dirs.splice(dirs.indexOf(dir), 1);
  }
});

test('monitor-none maintains the projection and signal ledger without any delivery', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const dir = workspace();
  const opts = monitorOptions(dir, 'none');
  try {
    expect(await runRecorder(opts)).toBe(0);
    const summary = manifest(opts);
    expect(summary).toMatchObject({ processingMode: 'monitor', deliveryMode: 'none' });
    const db = openDatabase(opts.databasePath);
    try {
      expect(count(db, 'live_projection_cursors')).toBe(1);
      expect(count(db, 'signal_cursors')).toBe(1);
      expect(db.prepare('select mode from delivery_policy').pluck().get()).toBe('none');
      expect(
        db
          .prepare("select count(*) from alert_outbox where status in ('pending','failed')")
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      db.close();
    }
    expect(existsSync(opts.databasePath + '.alerts.jsonl')).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    dirs.splice(dirs.indexOf(dir), 1);
  }
});

test('monitor starts from a record-only database using local raw instead of new history', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const dir = workspace();
  const record = options(dir);
  try {
    expect(await runRecorder(record)).toBe(0);
    const before = openDatabase(record.databasePath);
    try {
      // Record-only collected the evidence but projected nothing.
      expect(count(before, 'live_projection_cursors')).toBe(0);
      expect(count(before, 'active_logs')).toBeGreaterThan(0);
    } finally {
      before.close();
    }
    // Start monitor beyond the accepted tip: no new chain range is fetched, so the projection can
    // only come from the accepted raw the record-only run left behind. The run reports incomplete
    // (it accepted no operation range); the reconciliation is what this asserts.
    const monitor = { ...monitorOptions(dir, 'none'), fromBlock: 201n };
    expect([0, 4]).toContain(await runRecorder(monitor));
    const after = openDatabase(record.databasePath);
    try {
      expect(count(after, 'live_projection_cursors')).toBe(1);
      expect(count(after, 'live_events')).toBeGreaterThan(0);
      expect(count(after, 'signal_cursors')).toBe(1);
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    dirs.splice(dirs.indexOf(dir), 1);
  }
});

test('monitor-local records an enabled policy and may open the local sink', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const dir = workspace();
  const opts = monitorOptions(dir, 'local');
  try {
    expect(await runRecorder(opts)).toBe(0);
    const summary = manifest(opts);
    expect(summary).toMatchObject({ processingMode: 'monitor', deliveryMode: 'local' });
    const db = openDatabase(opts.databasePath);
    try {
      expect(db.prepare('select mode,generation from delivery_policy').get()).toEqual({
        mode: 'local',
        generation: 1,
      });
      expect(count(db, 'live_projection_cursors')).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    dirs.splice(dirs.indexOf(dir), 1);
  }
});
