import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadAssetVersion } from '../../src/registry/assets.js';
import { loadStockSnapshot } from '../../src/registry/stock-snapshot.js';
import { runCli } from '../../src/cli.js';

const address = `0x${'12'.repeat(20)}`;
const records = [{ symbol: 'AAA', address, status: 'inactive' as const }];
const source = JSON.stringify({ assets: [] });

function writeHistoricalSnapshot(directory: string, overrides: Record<string, unknown> = {}) {
  const snapshot = {
    version: createHash('sha256').update(JSON.stringify(records), 'utf8').digest('hex'),
    chainId: 4663,
    fetchedAtSec: 1789257600,
    sourceUrl: 'https://api.robinhood.com/rhj/assets',
    sourceHash: createHash('sha256').update(source, 'utf8').digest('hex'),
    rwa: [],
    records,
    ...overrides,
  };
  writeFileSync(join(directory, 'watchlist.json'), JSON.stringify(snapshot));
  writeFileSync(join(directory, 'source.json'), source);
  return snapshot;
}

test('loads an all-inactive historical snapshot by directory but legacy active watchlist loading still rejects it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lp-stock-history-'));
  const input = join(directory, 'current-assets.json');
  const output = join(directory, 'next');
  try {
    writeHistoricalSnapshot(directory);
    expect(loadStockSnapshot(directory)).toMatchObject({ rwa: [], records });
    expect(() => loadAssetVersion(join(directory, 'watchlist.json'))).toThrow(/rwa|observed RWA/i);

    writeFileSync(
      input,
      JSON.stringify({
        assets: [
          {
            tokenSymbol: 'BBB',
            status: 'ASSET_STATUS_ACTIVE',
            deployments: [{ chainId: 4663, contractAddress: `0x${'34'.repeat(20)}` }],
          },
        ],
      }),
    );
    await expect(
      runCli(['stocks', 'refresh', '--input', input, '--before', directory, '--out', output]),
    ).resolves.toBe(0);
    expect(
      JSON.parse(
        await import('node:fs').then(({ readFileSync }) =>
          readFileSync(join(output, 'diff.json'), 'utf8'),
        ),
      ),
    ).toEqual({
      added: [`0x${'34'.repeat(20)}`],
      removed: [address],
      statusChanged: [],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a baseline whose semantic version does not match its normalized records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lp-stock-version-'));
  try {
    writeHistoricalSnapshot(directory, { version: '0'.repeat(64) });
    expect(() => loadStockSnapshot(join(directory, 'watchlist.json'))).toThrow(/version/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('verifies sibling source.json against sourceHash when present', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lp-stock-source-'));
  try {
    writeHistoricalSnapshot(directory);
    expect(loadStockSnapshot(join(directory, 'watchlist.json')).sourceHash).toHaveLength(64);
    writeFileSync(join(directory, 'source.json'), '{"assets":["tampered"]}');
    expect(() => loadStockSnapshot(directory)).toThrow(/sourceHash/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
