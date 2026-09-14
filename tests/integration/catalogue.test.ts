import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { ConfigError } from '../../src/config/env.js';
import { runCli } from '../../src/cli.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

test('catalogue CLI records a fixed target without operation-range artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-catalogue-'));
  const fixture = recorderFixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await runCli(
      [
        'catalogue',
        '--duration',
        '10m',
        '--max-rpc-calls',
        '10000',
        '--db',
        join(dir, 'catalogue.sqlite'),
        '--out',
        join(dir, 'runs'),
        '--to-block',
        '200',
        '--watchlist',
        'config/watchlist.stocks.json',
        '--evidence',
        'off',
      ],
      { environment: { RH_RPC_HTTP: 'https://fixture.invalid' }, readerFactory: fixture.factory },
    );
    expect(code).toBe(0);
    const runDirectory = readdirSync(join(dir, 'runs')).sort().at(-1)!;
    const report = JSON.parse(
      readFileSync(join(dir, 'runs', runDirectory, 'catalogue-report.json'), 'utf8'),
    ) as {
      status: string;
      targetAnchor: { number: string };
      poolCount: number;
      stockPoolAttributionCount: number;
      missing: unknown[];
      protocolVersion: string;
    };
    expect(report).toMatchObject({
      status: 'complete',
      targetAnchor: { number: '200' },
      poolCount: 1,
      stockPoolAttributionCount: 1,
      missing: [],
      protocolVersion: 'uniswap-v3+uniswap-v4@1',
    });
    expect(
      readdirSync(join(dir, 'runs', runDirectory)).some((name) => name.startsWith('range-')),
    ).toBe(false);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('catalogue rejects invalid target before opening its database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-catalogue-invalid-'));
  try {
    await expect(
      runCli(
        [
          'catalogue',
          '--duration',
          '10m',
          '--to-block',
          '-1',
          '--db',
          join(dir, 'catalogue.sqlite'),
          '--out',
          join(dir, 'runs'),
        ],
        { environment: { RH_RPC_HTTP: 'https://fixture.invalid' } },
      ),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(existsSync(join(dir, 'catalogue.sqlite'))).toBe(false);
    expect(existsSync(join(dir, 'runs'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
