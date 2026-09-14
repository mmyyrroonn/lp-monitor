import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { buildStockSnapshot, diffStockSnapshots } from '../../src/registry/stock-snapshot.js';

const address = (byte: string) => `0x${byte.repeat(20)}`;
const asset = (
  tokenSymbol: string,
  status: 'ASSET_STATUS_ACTIVE' | 'ASSET_STATUS_INACTIVE',
  chainId: number,
  contractAddress: string,
) => ({
  tokenSymbol,
  status,
  deployments: [{ chainId, contractAddress }],
  ignoredBySnapshot: true,
});

test('only active chain-4663 deployments enter the current watchlist', () => {
  const active = address('12');
  const raw = JSON.stringify({
    assets: [
      asset('AAA', 'ASSET_STATUS_ACTIVE', 4663, active),
      asset('BBB', 'ASSET_STATUS_INACTIVE', 4663, address('34')),
      asset('CCC', 'ASSET_STATUS_ACTIVE', 1, address('56')),
    ],
    unknownTopLevelField: { preservedInSourceOnly: true },
  });

  const snapshot = buildStockSnapshot(raw, 1789257600);

  expect(snapshot.rwa).toEqual([
    { symbol: 'AAA', address: active, identityStatus: 'official-registry-active' },
  ]);
  expect(snapshot.records).toEqual([
    { symbol: 'AAA', address: active, status: 'active' },
    { symbol: 'BBB', address: address('34'), status: 'inactive' },
  ]);
  expect(snapshot.sourceHash).toBe(createHash('sha256').update(raw, 'utf8').digest('hex'));
  expect(snapshot.sourceUrl).toBe('https://api.robinhood.com/rhj/assets');
  expect(snapshot.fetchedAtSec).toBe(1789257600);
});

test('keeps same-symbol deployments at distinct addresses and derives stable version from normalized records', () => {
  const rawA = JSON.stringify({
    assets: [
      asset('AAA', 'ASSET_STATUS_ACTIVE', 4663, address('bb')),
      asset('AAA', 'ASSET_STATUS_ACTIVE', 4663, address('aa')),
    ],
  });
  const rawB = JSON.stringify({
    assets: [
      asset('AAA', 'ASSET_STATUS_ACTIVE', 4663, address('AA')),
      asset('AAA', 'ASSET_STATUS_ACTIVE', 4663, address('BB')),
    ],
  });

  const first = buildStockSnapshot(rawA, 1);
  const second = buildStockSnapshot(rawB, 2);

  expect(first.rwa.map((entry) => entry.address)).toEqual([address('aa'), address('bb')]);
  expect(first.version).toBe(second.version);
  expect(first.sourceHash).not.toBe(second.sourceHash);
});

test('rejects contradictory status for one chain-4663 address instead of last-record wins', () => {
  const shared = address('ab');
  const raw = JSON.stringify({
    assets: [
      asset('AAA', 'ASSET_STATUS_ACTIVE', 4663, shared),
      asset('AAA', 'ASSET_STATUS_INACTIVE', 4663, shared),
    ],
  });

  expect(() => buildStockSnapshot(raw, 1)).toThrow(/conflict/i);
});

test('rejects invalid responses, invalid addresses, and no chain-4663 records', () => {
  expect(() => buildStockSnapshot('{', 1)).toThrow();
  expect(() => buildStockSnapshot(JSON.stringify({ assets: [] }), 1)).toThrow(/active|chain-4663/i);
  expect(() =>
    buildStockSnapshot(
      JSON.stringify({ assets: [asset('AAA', 'ASSET_STATUS_ACTIVE', 4663, 'bad')] }),
      1,
    ),
  ).toThrow(/address/i);
});

test('reports address additions, removals, and status changes from complete records', () => {
  const before = buildStockSnapshot(
    JSON.stringify({
      assets: [
        asset('AAA', 'ASSET_STATUS_ACTIVE', 4663, address('11')),
        asset('BBB', 'ASSET_STATUS_INACTIVE', 4663, address('22')),
      ],
    }),
    1,
  );
  const after = buildStockSnapshot(
    JSON.stringify({
      assets: [
        asset('AAA', 'ASSET_STATUS_INACTIVE', 4663, address('11')),
        asset('CCC', 'ASSET_STATUS_ACTIVE', 4663, address('33')),
      ],
    }),
    2,
  );

  expect(diffStockSnapshots(before, after)).toEqual({
    added: [address('33')],
    removed: [address('22')],
    statusChanged: [address('11')],
  });
});
