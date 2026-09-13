import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runRecorder, type RecorderOptions } from '../../src/ops/recorder.js';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadEnv } from '../../src/config/env.js';
import { loadMetricMetadata } from '../../src/metrics/metadata.js';
import { parseSignalConfig } from '../../src/signals/config.js';
import { openDatabase } from '../../src/storage/database.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'default follow (notify=%s, existing pools=%s) starts at the live head on a fresh database and restart, without historical discovery',
  async (notify, seeded) => {
    const dir = mkdtempSync(join(tmpdir(), 'latest-follow-'));
    const fixture = recorderFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const options: RecorderOptions = {
      command: 'follow',
      ...(notify
        ? {
            notify: 'local' as const,
            metricMetadata: loadMetricMetadata('config/metric-metadata.json'),
            signalConfig: parseSignalConfig(
              JSON.parse(readFileSync('config/signals.initial.json', 'utf8')),
            ),
          }
        : {}),
      config: loadChainConfig('config/robinhood.json'),
      env: loadEnv({ RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' }),
      watchlistPath: 'config/watchlist.amc.json',
      databasePath: join(dir, 'db.sqlite'),
      outputDirectory: join(dir, 'runs'),
      durationMs: 500,
      maxCalls: 10000,
      evidenceMode: 'off',
      readerFactory: fixture.factory,
    };
    try {
      if (seeded) {
        expect(
          await runRecorder({
            ...options,
            command: 'ingest',
            notify: undefined,
            fromBlock: 100n,
            toBlock: 200n,
            durationMs: 3000,
          }),
        ).toBe(0);
      }
      expect(await runRecorder(options)).toBe(0);
      fixture.advance();
      expect(await runRecorder(options)).toBe(0);
      const manifests = readdirSync(options.outputDirectory)
        .sort()
        .map((name) =>
          JSON.parse(readFileSync(join(options.outputDirectory, name, 'manifest.json'), 'utf8')),
        );
      const latestManifests = manifests.filter((m) => m.startMode === 'latest');
      expect(latestManifests).toHaveLength(2);
      const db = openDatabase(options.databasePath, { readonly: true });
      try {
        expect(
          db
            .prepare(
              'select count(*) as n from accepted_ranges where from_block<=210 and to_block>=210',
            )
            .get(),
        ).toEqual({ n: 0 });
      } finally {
        db.close();
      }
      for (const [i, manifest] of latestManifests.entries()) {
        expect(manifest.counts.discoveryBatches).toBe(0);
        expect(manifest.counts.warmupAnchors).toBe(0);
        expect(manifest.counts.operationBatches).toBeGreaterThan(0);
        expect(manifest.batches.every((b: { accepted: boolean }) => b.accepted)).toBe(true);
        expect(
          manifest.batches.every(
            (b: { fromBlock: string }) => BigInt(b.fromBlock) >= [200n, 220n][i]!,
          ),
        ).toBe(true);
        if (seeded) {
          const batch = JSON.parse(
            readFileSync(
              join(
                options.outputDirectory,
                manifest.runId,
                'range-' + manifest.batches[0].id + '.json',
              ),
              'utf8',
            ),
          );
          expect(
            batch.manifest.shards.some((shard: { filterId: string }) =>
              shard.filterId.startsWith('operation-v3'),
            ),
          ).toBe(true);
        }
        expect(manifest.startMode).toBe('latest');
        expect(manifest.discoveryComplete).toBe(false);
        expect(manifest.identity.deployments.v3Factory.candidateChecked).toBe(false);
      }
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
