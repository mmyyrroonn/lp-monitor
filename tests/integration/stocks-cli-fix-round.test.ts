import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test, vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import { loadAssetVersion } from '../../src/registry/assets.js';

const address = (byte: string) => `0x${byte.repeat(20)}`;
const raw = (
  assets: Array<{
    symbol: string;
    status: 'ASSET_STATUS_ACTIVE' | 'ASSET_STATUS_INACTIVE';
    address: string;
  }>,
) =>
  JSON.stringify({
    assets: assets.map((asset) => ({
      tokenSymbol: asset.symbol,
      status: asset.status,
      deployments: [{ chainId: 4663, contractAddress: asset.address }],
    })),
  });

function fixtureDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'lp-stocks-cli-fix-'));
  return {
    dir,
    prior: join(dir, 'prior'),
    output: join(dir, 'next'),
    source: join(dir, 'assets.json'),
  };
}

test('refresh diffs against an explicit immutable prior watchlist and remains load-compatible', async () => {
  const fixture = fixtureDirectory();
  const first = raw([
    { symbol: 'AAA', status: 'ASSET_STATUS_ACTIVE', address: address('11') },
    { symbol: 'BBB', status: 'ASSET_STATUS_INACTIVE', address: address('22') },
  ]);
  const second = raw([
    { symbol: 'AAA', status: 'ASSET_STATUS_INACTIVE', address: address('11') },
    { symbol: 'CCC', status: 'ASSET_STATUS_ACTIVE', address: address('33') },
  ]);
  try {
    writeFileSync(fixture.source, first);
    await expect(
      runCli(['stocks', 'refresh', '--input', fixture.source, '--out', fixture.prior]),
    ).resolves.toBe(0);
    writeFileSync(fixture.source, second);
    await expect(
      runCli([
        'stocks',
        'refresh',
        '--input',
        fixture.source,
        '--before',
        join(fixture.prior, 'watchlist.json'),
        '--out',
        fixture.output,
      ]),
    ).resolves.toBe(0);
    expect(JSON.parse(readFileSync(join(fixture.output, 'diff.json'), 'utf8'))).toEqual({
      added: [address('33')],
      removed: [address('22')],
      statusChanged: [address('11')],
    });
    expect(loadAssetVersion(join(fixture.output, 'watchlist.json')).assets).toEqual([
      { symbol: 'CCC', address: address('33'), identityStatus: 'official-registry-active' },
    ]);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('invalid snapshot input leaves no output and never mutates an existing snapshot', async () => {
  const fixture = fixtureDirectory();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => {
    throw new Error('network must not be used');
  });
  try {
    writeFileSync(fixture.source, '{');
    await expect(
      runCli(['stocks', 'refresh', '--input', fixture.source, '--out', fixture.output]),
    ).rejects.toThrow();
    expect(existsSync(fixture.output)).toBe(false);

    writeFileSync(
      fixture.source,
      raw([{ symbol: 'AAA', status: 'ASSET_STATUS_ACTIVE', address: address('11') }]),
    );
    await expect(
      runCli(['stocks', 'refresh', '--input', fixture.source, '--out', fixture.output]),
    ).resolves.toBe(0);
    const previous = readFileSync(join(fixture.output, 'watchlist.json'), 'utf8');
    writeFileSync(fixture.source, '{');
    await expect(
      runCli(['stocks', 'refresh', '--input', fixture.source, '--out', fixture.output]),
    ).rejects.toThrow();
    expect(readFileSync(join(fixture.output, 'watchlist.json'), 'utf8')).toBe(previous);
  } finally {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('process CLI maps stocks configuration errors to exit code 2', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'stocks', 'refresh'],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
    },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('requires --out');
});

test('watchlist loader rejects malformed persisted stock status records', async () => {
  const fixture = fixtureDirectory();
  try {
    writeFileSync(
      fixture.source,
      raw([{ symbol: 'AAA', status: 'ASSET_STATUS_ACTIVE', address: address('11') }]),
    );
    await runCli(['stocks', 'refresh', '--input', fixture.source, '--out', fixture.output]);
    const watchlist = JSON.parse(readFileSync(join(fixture.output, 'watchlist.json'), 'utf8'));
    watchlist.records[0].status = 'unknown';
    const malformed = join(fixture.dir, 'malformed-watchlist.json');
    writeFileSync(malformed, JSON.stringify(watchlist));
    expect(() => loadAssetVersion(malformed)).toThrow(/records|status/i);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
