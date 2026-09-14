import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { loadChainConfig } from '../../src/config/chain.js';
import { runCli } from '../../src/cli.js';
import { loadEnv } from '../../src/config/env.js';
import { runRecorder } from '../../src/ops/recorder.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

test('catalogue discovery can be followed by latest-only operation recording', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-catalogue-follow-'));
  const fixture = recorderFixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const databasePath = join(dir, 'recorder.sqlite');
  const catalogueOutput = join(dir, 'catalogue');
  const followOutput = join(dir, 'follow');
  try {
    expect(
      await runCli(
        [
          'catalogue',
          '--duration',
          '10m',
          '--max-rpc-calls',
          '10000',
          '--db',
          databasePath,
          '--out',
          catalogueOutput,
          '--to-block',
          '200',
          '--watchlist',
          'config/watchlist.stocks.json',
          '--evidence',
          'off',
        ],
        { environment: { RH_RPC_HTTP: 'https://fixture.invalid' }, readerFactory: fixture.factory },
      ),
    ).toBe(0);

    fixture.advance();
    expect(
      await runRecorder({
        command: 'follow',
        config: loadChainConfig('config/robinhood.json'),
        env: loadEnv({ RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' }),
        watchlistPath: 'config/watchlist.stocks.json',
        databasePath,
        outputDirectory: followOutput,
        durationMs: 3000,
        maxCalls: 10000,
        evidenceMode: 'off',
        readerFactory: fixture.factory,
      }),
    ).toBe(0);

    const runDirectory = readdirSync(followOutput).sort().at(-1)!;
    const manifest = JSON.parse(
      readFileSync(join(followOutput, runDirectory, 'manifest.json'), 'utf8'),
    ) as {
      startMode: string;
      registryCoverage: string;
      discoveryComplete: boolean;
      catalogue: unknown;
      counts: { discoveryBatches: number; operationBatches: number };
    };
    expect(manifest).toMatchObject({
      startMode: 'latest',
      registryCoverage: 'known-pools-only',
      discoveryComplete: false,
      catalogue: null,
    });
    expect(manifest.counts).toMatchObject({ discoveryBatches: 0 });
    expect(manifest.counts.operationBatches).toBeGreaterThan(0);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
