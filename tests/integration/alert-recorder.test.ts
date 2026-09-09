import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import { openDatabase } from '../../src/storage/database.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

test.each([false, true])('follow signals are explicit opt-in: %s', async (notify) => {
  const dir = mkdtempSync(join(tmpdir(), 'p4-recorder-'));
  const dbPath = join(dir, 'db.sqlite');
  const f = recorderFixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await runCli(
      [
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
        ...(notify ? ['--notify', 'local'] : []),
      ],
      { environment: { RH_RPC_HTTP: 'https://fixture.invalid' }, readerFactory: f.factory },
    );
    expect(code).toBe(0);
    const db = openDatabase(dbPath);
    try {
      const count = (db.prepare('select count(*) as n from signal_cursors').get() as { n: number })
        .n;
      expect(count).toBe(notify ? 1 : 0);
    } finally {
      db.close();
    }
    if (!notify) expect(existsSync(dbPath + '.alerts.jsonl')).toBe(false);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Seed an already committed live reminder to model a crash before local delivery.
// Restart must validate the chain first and preserve stable revision identities.
import { readFileSync } from 'node:fs';
import { AlertOutbox } from '../../src/notify/outbox.js';
import { encodeSignalState } from '../../src/signals/codec.js';
import type { AlertRecord } from '../../src/signals/types.js';

test.each([
  { fork: false, outage: false },
  { fork: true, outage: false },
  { fork: true, outage: true },
])(
  'restart delivers only reconciled live revision (%j)',
  async ({ fork, outage }) => {
    const dir = mkdtempSync(join(tmpdir(), 'p4-restart-'));
    const dbPath = join(dir, 'db.sqlite');
    const f = recorderFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
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
      '--notify',
      'local',
    ];
    const options = {
      environment: { RH_RPC_HTTP: 'https://fixture.invalid' },
      readerFactory: f.factory,
    };
    try {
      expect(await runCli(args, options)).toBe(0);
      const db = openDatabase(dbPath);
      try {
        const { scope_id: scope } = db.prepare('select scope_id from signal_cursors').get() as {
          scope_id: string;
        };
        const record = {
          id: 'crash-before-delivery',
          revision: 1,
          status: 'provisional',
          kind: 'hot',
          poolId: 'fixture',
          atBatchId: 'seed',
          endAnchor: { number: 200n, hash: '0x' + '0'.repeat(62) + 'c8', timestampSec: 1200 },
          observedAtMs: 1200000,
          watermarkSec: 1200,
          reasons: [],
          metrics: { recentClosed5x1m: null, naturalClosed5m: null, partialCurrent: null },
          coverage: 'complete',
        } as unknown as AlertRecord;
        db.prepare(
          'insert into alerts(scope_id,id,revision,capture_mode,active,payload_json) values(?,?,?,?,?,?)',
        ).run(scope, record.id, 1, 'live', 1, encodeSignalState(record));
        new AlertOutbox(db).enqueue(scope, record, 'live');
      } finally {
        db.close();
      }
      if (fork) f.fork();
      if (outage) f.fail();
      // Stable restart has no eligible next range: backlog still resumes safely.
      if (!fork) args[args.indexOf('--from-block') + 1] = '201';
      expect(await runCli(args, options)).toBe(fork && !outage ? 0 : 4);
      const records = readFileSync(dbPath + '.alerts.jsonl', 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((a) => a.id === 'crash-before-delivery');
      expect(records.map((a) => [a.kind, a.revision])).toEqual([
        [fork ? 'retracted' : 'hot', fork ? 2 : 1],
      ]);
      expect(await runCli(args, options)).toBe(fork && !outage ? 0 : 4);
      const again = readFileSync(dbPath + '.alerts.jsonl', 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((a) => a.id === 'crash-before-delivery');
      expect(again).toEqual(records);
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15000,
);
