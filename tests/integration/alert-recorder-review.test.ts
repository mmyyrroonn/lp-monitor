import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runRecorderCli } from '../../src/ops/recorder-cli.js';
import { openDatabase } from '../../src/storage/database.js';
import * as signals from '../../src/signals/project.js';
import { AlertOutbox } from '../../src/notify/outbox.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'p4-review-recorder-'));
  const dbPath = join(dir, 'db.sqlite');
  const fixture = recorderFixture();
  const args = [
    'follow',
    '--duration',
    '1s',
    '--from-block',
    '100',
    '--db',
    dbPath,
    '--out',
    join(dir, 'runs'),
    '--evidence',
    'off',
  ];
  const options = {
    environment: { RH_RPC_HTTP: 'https://fixture.invalid' },
    readerFactory: fixture.factory,
  };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return {
    dir,
    dbPath,
    fixture,
    args,
    options,
    log,
    cleanup: () => {
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test.each([false, true])(
  'startup only evaluates live at a freshly verified current head: lagging=%s',
  async (lagging) => {
    const f = setup();
    try {
      expect(await runRecorderCli(f.args, f.options)).toBe(0);
      const project = vi.spyOn(signals, 'projectSignals');
      if (lagging) f.fixture.advance();
      f.args[f.args.indexOf('--from-block') + 1] = '221';
      await runRecorderCli([...f.args, '--notify', 'local'], f.options);
      if (lagging) expect(project).not.toHaveBeenCalled();
      else expect(project.mock.calls.map((call) => call[3].captureMode)).toEqual(['live']);
    } finally {
      f.cleanup();
    }
  },
  10000,
);

test('signal transaction failures are classified with raw evidence retained and no accepted operation cursor', async () => {
  const f = setup();
  try {
    vi.spyOn(signals, 'commitAcceptedSignalBatch').mockImplementation(() => {
      throw new Error('private diagnostic detail');
    });
    expect(await runRecorderCli([...f.args, '--notify', 'local'], f.options)).toBe(1);
    const run = readdirSync(join(f.dir, 'runs'))[0]!;
    const summary = JSON.parse(readFileSync(join(f.dir, 'runs', run, 'manifest.json'), 'utf8'));
    expect(summary.failures).toContain('signal-evaluation');
    expect(summary.acceptedTip).toBeNull();
    expect(
      summary.batches.some(
        (batch: { accepted: boolean; scopeId: string }) =>
          batch.scopeId === summary.scopeId && !batch.accepted,
      ),
    ).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('private diagnostic detail');
    const db = openDatabase(f.dbPath);
    try {
      expect(
        (db.prepare('select count(*) n from raw_logs').get() as { n: number }).n,
      ).toBeGreaterThan(0);
      expect(
        (
          db
            .prepare('select count(*) n from ingest_batches where scope_id=?')
            .get(summary.scopeId) as { n: number }
        ).n,
      ).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  } finally {
    f.cleanup();
  }
});

test('delivery failures are visible in progress and the final durable summary', async () => {
  const f = setup();
  try {
    vi.spyOn(AlertOutbox.prototype, 'deliverPending').mockResolvedValue({ sent: 0, failed: 1 });
    expect(await runRecorderCli([...f.args, '--notify', 'local'], f.options)).toBe(0);
    const run = readdirSync(join(f.dir, 'runs'))[0]!;
    const summary = JSON.parse(readFileSync(join(f.dir, 'runs', run, 'manifest.json'), 'utf8'));
    expect(summary.alertDelivery.failed).toBeGreaterThan(0);
    expect(summary.alertDelivery.status).toBe('degraded');
    expect(
      f.log.mock.calls.some(
        ([line]) => typeof line === 'string' && line.includes('alert-delivery'),
      ),
    ).toBe(true);
    expect(summary.status).toBe('complete');
  } finally {
    f.cleanup();
  }
});

test.each(['signals', 'metadata'])(
  'rejects ignored --%s without notify before RPC',
  async (option) => {
    const factory = vi.fn();
    await expect(
      runRecorderCli(['follow', '--duration', '1s', '--' + option, 'unused'], {
        environment: {},
        readerFactory: factory,
      }),
    ).rejects.toThrow('requires --notify local');
    expect(factory).not.toHaveBeenCalled();
  },
);

test('signal errors distinguish missing file, invalid JSON and schema paths without input values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p4-review-config-'));
  const path = join(dir, 'signals.json');
  const factory = vi.fn();
  const run = () =>
    runRecorderCli(['follow', '--duration', '1s', '--notify', 'local', '--signals', path], {
      environment: {},
      readerFactory: factory,
    });
  try {
    await expect(run()).rejects.toThrow('signal configuration file not found');
    writeFileSync(path, '{private diagnostic detail');
    await expect(run()).rejects.toThrow('signal configuration JSON');
    const config = JSON.parse(readFileSync('config/signals.initial.json', 'utf8'));
    config.candidate.threshold = 'private diagnostic detail';
    writeFileSync(path, JSON.stringify(config));
    await expect(run()).rejects.toThrow('candidate.threshold');
    await expect(run()).rejects.not.toThrow('private diagnostic detail');
    expect(factory).not.toHaveBeenCalled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('catch-up batches remain historical and cannot drain ordinary live backlog before reaching head', async () => {
  const f = setup();
  try {
    const config = JSON.parse(readFileSync('config/robinhood.json', 'utf8'));
    config.maxRangeBlocks = 50;
    config.overlapBlocks = 10;
    const configPath = join(f.dir, 'chain.json');
    writeFileSync(configPath, JSON.stringify(config));
    const commit = vi.spyOn(signals, 'commitAcceptedSignalBatch');
    const deliver = vi
      .spyOn(AlertOutbox.prototype, 'deliverPending')
      .mockResolvedValue({ sent: 0, failed: 0 });
    expect(
      await runRecorderCli([...f.args, '--config', configPath, '--notify', 'local'], f.options),
    ).toBe(0);
    const modes = commit.mock.calls.map((call) => call[3].captureMode);
    expect(modes.length).toBeGreaterThan(1);
    expect(modes.slice(0, -1).every((mode) => mode === 'backfill')).toBe(true);
    expect(modes.at(-1)).toBe('live');
    expect(deliver.mock.calls.slice(1).map((call) => call[2])).toEqual(
      modes.map((mode) => (mode === 'live' ? undefined : 'retracted')),
    );
  } finally {
    f.cleanup();
  }
});
