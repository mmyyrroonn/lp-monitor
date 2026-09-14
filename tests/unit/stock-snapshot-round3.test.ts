import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadAssetVersion } from '../../src/registry/assets.js';
import { buildStockSnapshot, loadStockSnapshot } from '../../src/registry/stock-snapshot.js';

const inactiveAddress = `0x${'12'.repeat(20)}`;

test('builds and loads an official all-inactive snapshot while legacy follow watchlist loading rejects it', () => {
  const raw = JSON.stringify({
    assets: [
      {
        tokenSymbol: 'AAA',
        status: 'ASSET_STATUS_INACTIVE',
        deployments: [{ chainId: 4663, contractAddress: inactiveAddress }],
      },
    ],
  });
  const snapshot = buildStockSnapshot(raw, 1789257600);
  const directory = mkdtempSync(join(tmpdir(), 'lp-stock-round3-inactive-'));
  const path = join(directory, 'watchlist.json');
  try {
    writeFileSync(path, JSON.stringify(snapshot));
    expect(snapshot).toMatchObject({ rwa: [], records: [{ status: 'inactive' }] });
    expect(loadStockSnapshot(path)).toMatchObject({ rwa: [], records: [{ status: 'inactive' }] });
    expect(() => loadAssetVersion(path)).toThrow(/rwa|observed RWA/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a baseline whose persisted active projection disagrees with valid records and version', () => {
  const raw = JSON.stringify({
    assets: [
      {
        tokenSymbol: 'AAA',
        status: 'ASSET_STATUS_ACTIVE',
        deployments: [{ chainId: 4663, contractAddress: inactiveAddress }],
      },
    ],
  });
  const snapshot = buildStockSnapshot(raw, 1789257600);
  const directory = mkdtempSync(join(tmpdir(), 'lp-stock-round3-rwa-'));
  try {
    writeFileSync(join(directory, 'watchlist.json'), JSON.stringify({ ...snapshot, rwa: [] }));
    expect(() => loadStockSnapshot(directory)).toThrow(/rwa|active/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
