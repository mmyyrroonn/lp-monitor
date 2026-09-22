import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadEnv } from '../../src/config/env.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { runRecorder, type RecorderOptions } from '../../src/ops/recorder.js';
import { auditStorage } from '../../src/ops/storage-audit.js';
import { runStorageCli } from '../../src/ops/storage-cli.js';
import { computeWatchScopeId } from '../../src/ingest/filter-plan.js';
import { loadAssetVersion } from '../../src/registry/assets.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';
import { readRetentionSafety, releaseRetentionPin } from '../../src/storage/retention-state.js';

function options(directory: string): RecorderOptions {
  return {
    command: 'follow',
    config: loadChainConfig('config/robinhood.json'),
    env: loadEnv({ RH_RPC_HTTP: 'https://fixture.invalid' }),
    watchlistPath: 'config/watchlist.amc.json',
    databasePath: join(directory, 'db.sqlite'),
    outputDirectory: join(directory, 'runs'),
    fromBlock: 100n,
    durationMs: 100,
    maxCalls: 10000,
    evidenceMode: 'off',
    readerFactory: recorderFixture().factory,
  };
}

test('recorder rejects the actual custom signal lookback before constructing an RPC reader', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-retention-config-'));
  let constructed = false;
  try {
    const opts = options(dir);
    opts.config.liveRetentionMinutes = 182;
    opts.signalConfig = {
      ...initialSignalConfig,
      candidate: { ...initialSignalConfig.candidate, samples: 250 },
    };
    const factory = recorderFixture().factory;
    opts.readerFactory = (env, config) => {
      constructed = true;
      return factory(env, config);
    };
    await expect(runRecorder(opts)).rejects.toThrow(/liveRetentionMinutes/);
    expect(constructed).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('raw retention dry-run reports blockers and integrity without changing the database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-retention-preview-'));
  const path = join(dir, 'db.sqlite');
  const db = openDatabase(path);
  db.prepare('insert into scope_cursors values(?,?,?,?)').run('unknown', 100, '0x0', 1000);
  db.close();
  const before = readFileSync(path);
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
  try {
    expect(await runStorageCli(['storage', 'retention', '--raw', '--db', path])).toBe(0);
    const preview = JSON.parse(lines[0]!);
    expect(preview).toMatchObject({ dryRun: true, batches: 0, rawLogs: 0 });
    expect(preview.safety.blockers).toContain('unknown:policy-missing');
    expect(auditStorage(path)).toMatchObject({ integrity: { ok: true, foreignKeyViolations: [] } });
    expect(readFileSync(path)).toEqual(before);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retention write failure is classified separately and rolls back expiry metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-retention-failure-'));
  const opts = options(dir);
  opts.durationMs = 1000;
  const scope = computeWatchScopeId(loadAssetVersion(opts.watchlistPath), 'operations', {
    v3Factory: opts.config.v3Factory,
    v4Manager: opts.config.v4Manager,
  });
  const db = openDatabase(opts.databasePath);
  db.prepare('insert into live_events values(?,?,?,?,?,?,?,?,?)').run(
    scope,
    999,
    'p',
    'swap',
    1,
    0,
    0,
    -60,
    '{}',
  );
  db.exec(
    "create trigger fail_retention before delete on live_events begin select raise(abort,'fixture retention failure'); end",
  );
  db.close();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await runRecorder(opts)).toBe(1);
    const run = readdirSync(opts.outputDirectory)[0]!;
    const manifest = JSON.parse(
      readFileSync(join(opts.outputDirectory, run, 'manifest.json'), 'utf8'),
    );
    expect(manifest.failures).toContain('retention');
    expect(manifest.localFailure).toEqual({ category: 'retention', phase: 'live-window' });
    const check = openDatabase(opts.databasePath);
    try {
      expect(check.prepare('select count(*) from live_events').pluck().get()).toBe(1);
      expect(check.prepare('select count(*) from retention_expirations').pluck().get()).toBe(0);
      expect(check.pragma('foreign_key_check')).toEqual([]);
    } finally {
      check.close();
    }
  } finally {
    log.mockRestore();
    error.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history job pins survive completion and reopen until deliberately released', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-history-retention-pin-'));
  const path = join(dir, 'study.sqlite');
  let db = openDatabase(path);
  try {
    db.prepare(
      `insert into history_jobs(id,spec_hash,source_database_path,study_database_path,spec_json,input_snapshots_json,
      status,phase,missing_json,registry_missing_json,operation_missing_json,time_unknown_json,unpriced_json,updated_at_ms)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'job',
      'hash',
      'source',
      'study',
      '{}',
      '[]',
      'running',
      'operations',
      '[]',
      '[]',
      '[]',
      '[]',
      '[]',
      1,
    );
    db.prepare("update history_jobs set status='complete',phase='finished'").run();
    db.close();
    db = openDatabase(path);
    expect(readRetentionSafety(db).pins).toEqual([{ id: 'history:job', kind: 'history' }]);
    expect(releaseRetentionPin(db, 'history:job')).toBe(true);
    db.close();
    db = openDatabase(path);
    expect(readRetentionSafety(db).pins).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('storage pin commands require explicit release and survive database reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-replay-retention-pin-'));
  const path = join(dir, 'db.sqlite');
  openDatabase(path).close();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(
      await runStorageCli(['storage', 'pin', '--db', path, '--id', 'export', '--kind', 'replay']),
    ).toBe(0);
    const read = () => {
      const db = openDatabase(path, { readonly: true });
      try {
        return readRetentionSafety(db).pins;
      } finally {
        db.close();
      }
    };
    expect(read()).toEqual([{ id: 'export', kind: 'replay' }]);
    expect(await runStorageCli(['storage', 'unpin', '--db', path, '--id', 'export'])).toBe(0);
    expect(read()).toEqual([]);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
