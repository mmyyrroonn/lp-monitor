import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadEnv } from '../../src/config/env.js';
import { runRecorder } from '../../src/ops/recorder.js';
import * as databases from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

test.each(['discovery', 'operations'] as const)(
  'raw-save %s failure retains stage, closes resources and excludes arbitrary credentials',
  async (phase) => {
    const dir = mkdtempSync(join(tmpdir(), 'p6-raw-save-'));
    const secret = 'https://fake-user:fake-password@fixture.invalid/private-token';
    const originalOpen = databases.openDatabase;
    const connections: ReturnType<typeof databases.openDatabase>[] = [];
    vi.spyOn(databases, 'openDatabase').mockImplementation((...args) => {
      const db = originalOpen(...args);
      connections.push(db);
      return db;
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalSave = SqliteRangeStore.prototype.saveRaw;
    let saves = 0;
    let failedScope = '';
    let closed = 0;
    vi.spyOn(SqliteRangeStore.prototype, 'saveRaw').mockImplementation(function (
      this: SqliteRangeStore,
      batch,
    ) {
      saves++;
      if (saves === (phase === 'discovery' ? 1 : 2)) {
        failedScope = batch.scopeId;
        throw new Error(secret);
      }
      return originalSave.call(this, batch);
    });
    const factory = recorderFixture().factory;
    try {
      expect(
        await runRecorder({
          command: 'follow',
          config: loadChainConfig('config/robinhood.json'),
          env: loadEnv({ RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' }),
          watchlistPath: 'config/watchlist.amc.json',
          databasePath: join(dir, 'db.sqlite'),
          outputDirectory: join(dir, 'runs'),
          fromBlock: 100n,
          durationMs: 1000,
          maxCalls: 10000,
          evidenceMode: 'off',
          readerFactory: (env, options) => {
            const reader = factory(env, options);
            const close = reader.close.bind(reader);
            reader.close = async () => {
              closed++;
              await close();
            };
            return reader;
          },
        }),
      ).toBe(1);
      expect(closed).toBe(1);
      expect(connections.every((db) => !db.open)).toBe(true);
      expect(saves).toBe(phase === 'discovery' ? 1 : 2);
      const runDir = join(dir, 'runs', readdirSync(join(dir, 'runs'))[0]!);
      const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
      expect(manifest.failures).toEqual(['raw-save']);
      expect(manifest.localFailure).toEqual({ category: 'raw-save', phase });
      expect(manifest.meter.retries).toBe(0);
      const events = error.mock.calls.map(([entry]) => JSON.parse(String(entry)));
      expect(events).toContainEqual({ event: 'raw-save-failure', category: 'raw-save', phase });
      const evidence = readdirSync(runDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => readFileSync(join(runDir, name), 'utf8'))
        .join('\n');
      expect(evidence + JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain(
        secret,
      );
      const db = originalOpen(join(dir, 'db.sqlite'), { readonly: true });
      try {
        expect(new SqliteRangeStore(db).acceptedTip(failedScope)).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      vi.restoreAllMocks();
      for (const db of connections) if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
