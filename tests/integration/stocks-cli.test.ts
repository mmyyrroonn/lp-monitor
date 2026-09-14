import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runCli } from '../../src/cli.js';

const address = `0x${'12'.repeat(20)}`;
const input = JSON.stringify({
  assets: [
    {
      tokenSymbol: 'AAA',
      status: 'ASSET_STATUS_ACTIVE',
      deployments: [{ chainId: 4663, contractAddress: address }],
    },
  ],
});

function fixtureDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'lp-stocks-cli-'));
  const source = join(dir, 'saved-assets.json');
  writeFileSync(source, input);
  return { dir, source, output: join(dir, 'snapshot') };
}

test('offline refresh writes an immutable three-file snapshot without accessing the network', async () => {
  const fixture = fixtureDirectory();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => {
    throw new Error('network must not be used for --input');
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(
      await runCli(['stocks', 'refresh', '--input', fixture.source, '--out', fixture.output]),
    ).toBe(0);
    expect(readFileSync(join(fixture.output, 'source.json'), 'utf8')).toBe(input);
    const watchlist = JSON.parse(readFileSync(join(fixture.output, 'watchlist.json'), 'utf8'));
    expect(watchlist.rwa).toEqual([
      { symbol: 'AAA', address, identityStatus: 'official-registry-active' },
    ]);
    expect(JSON.parse(readFileSync(join(fixture.output, 'diff.json'), 'utf8'))).toMatchObject({
      added: [address],
      removed: [],
      statusChanged: [],
    });
    expect(JSON.parse(log.mock.calls.flat().join(''))).toMatchObject({
      watchlist: join(fixture.output, 'watchlist.json'),
    });
  } finally {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('refresh refuses an existing output and invalid CLI arguments exit as configuration errors', async () => {
  const fixture = fixtureDirectory();
  try {
    await expect(
      runCli(['stocks', 'refresh', '--input', fixture.source, '--out', fixture.output]),
    ).resolves.toBe(0);
    const previous = readFileSync(join(fixture.output, 'watchlist.json'), 'utf8');
    await expect(
      runCli(['stocks', 'refresh', '--input', fixture.source, '--out', fixture.output]),
    ).rejects.toThrow(/exist|overwrite/i);
    expect(readFileSync(join(fixture.output, 'watchlist.json'), 'utf8')).toBe(previous);
    await expect(runCli(['stocks', 'refresh', '--input', fixture.source])).rejects.toThrow(/out/i);
    expect(existsSync(join(fixture.dir, 'snapshot', 'source.json'))).toBe(true);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
