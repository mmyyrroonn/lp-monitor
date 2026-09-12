import { afterEach, expect, test, vi } from 'vitest';
import { toHex } from 'viem';
import { openDatabase } from '../../src/storage/database.js';
import { decimalsAt } from '../../src/metrics/metadata.js';
import {
  refreshTokenMetadata,
  readCachedMetricMetadata,
  validateTokenMetadata,
} from '../../src/storage/token-metadata.js';
const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const addr = (n: number) => toHex(n, { size: 20 });
const hash = (n: number) => toHex(n, { size: 32 });
const seed = { version: 'test', chainId: 4663 as const, source: 'test', entries: [] };
function setup() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}
function reader() {
  return {
    getAnchor: vi.fn(async (n: bigint | 'latest') => ({
      number: BigInt(n),
      hash: hash(Number(n)),
      timestampSec: 100,
    })),
    request: vi.fn(async (_method: string, params: readonly unknown[]) =>
      toHex((params[0] as { to: string }).to === addr(1) ? 6 : 18, { size: 32 }),
    ),
  };
}
test('discovers different token decimals, persists per address and skips cached RPC', async () => {
  const db = setup(),
    rpc = reader();
  const targets = [
    { address: addr(1), blockNumber: 10n },
    { address: addr(2), blockNumber: 10n },
    { address: addr(1), blockNumber: 10n },
  ];
  const result = await refreshTokenMetadata(db, rpc, targets, { nowMs: 0 });
  expect(result.resolved).toBe(2);
  expect(rpc.request).toHaveBeenCalledTimes(2);
  expect(rpc.request.mock.calls[0]![1][1]).toBe('0xa');
  const cached = readCachedMetricMetadata(db, seed);
  expect(decimalsAt(cached, addr(1), 10n)).toBe(6);
  expect(decimalsAt(cached, addr(2), 10n)).toBe(18);
  expect(decimalsAt(cached, addr(1), 9n)).toBeNull();
  await refreshTokenMetadata(db, rpc, targets, { nowMs: 1 });
  expect(rpc.request).toHaveBeenCalledTimes(2);
});
test('malformed/reverting tokens stay unknown and retry only after cooldown', async () => {
  const db = setup(),
    rpc = reader();
  rpc.request.mockResolvedValueOnce('0x');
  const targets = [{ address: addr(1), blockNumber: 10n }];
  expect((await refreshTokenMetadata(db, rpc, targets, { nowMs: 0 })).failed).toBe(1);
  expect(decimalsAt(readCachedMetricMetadata(db, seed), addr(1), 10n)).toBeNull();
  await refreshTokenMetadata(db, rpc, targets, { nowMs: 1 });
  expect(rpc.request).toHaveBeenCalledTimes(1);
  await refreshTokenMetadata(db, rpc, targets, { nowMs: 60000 });
  expect(rpc.request).toHaveBeenCalledTimes(2);
});
test('queries earlier evidence when cache is from a later block; latest applicable observation wins', async () => {
  const db = setup(),
    rpc = reader();
  await refreshTokenMetadata(db, rpc, [{ address: addr(1), blockNumber: 20n }]);
  rpc.request.mockResolvedValueOnce(toHex(8, { size: 32 }));
  await refreshTokenMetadata(db, rpc, [{ address: addr(1), blockNumber: 10n }]);
  const cached = readCachedMetricMetadata(db, seed);
  expect(decimalsAt(cached, addr(1), 10n)).toBe(8);
  expect(decimalsAt(cached, addr(1), 20n)).toBe(6);
});
test('forked observations are discarded and a changing query anchor is never cached', async () => {
  const db = setup(),
    rpc = reader();
  await refreshTokenMetadata(db, rpc, [{ address: addr(1), blockNumber: 10n }]);
  rpc.getAnchor.mockResolvedValue({ number: 10n, hash: hash(99), timestampSec: 100 });
  await validateTokenMetadata(db, rpc);
  expect(decimalsAt(readCachedMetricMetadata(db, seed), addr(1), 10n)).toBeNull();
  rpc.getAnchor.mockResolvedValueOnce({ number: 10n, hash: hash(10), timestampSec: 100 });
  await refreshTokenMetadata(db, rpc, [{ address: addr(1), blockNumber: 10n }]);
  expect(decimalsAt(readCachedMetricMetadata(db, seed), addr(1), 10n)).toBeNull();
});
test('verified configuration seeds avoid duplicate RPC lookups', async () => {
  const db = setup(),
    rpc = reader();
  const known = {
    ...seed,
    entries: [{ address: addr(1), decimals: 8, observedAtBlock: '5', blockHash: hash(5) }],
  };
  await refreshTokenMetadata(db, rpc, [{ address: addr(1), blockNumber: 10n }], { seed: known });
  expect(rpc.request).not.toHaveBeenCalled();
});
test('RPC budget exhaustion is not downgraded to unknown metadata', async () => {
  const db = setup(),
    rpc = reader();
  const { RpcFailure } = await import('../../src/rpc/errors.js');
  rpc.request.mockRejectedValue(new RpcFailure('budget'));
  await expect(
    refreshTokenMetadata(db, rpc, [{ address: addr(1), blockNumber: 10n }]),
  ).rejects.toThrow('budget');
});

test('forked configuration seed is excluded durably and queried again', async () => {
  const db = setup(),
    rpc = reader();
  const known = {
    ...seed,
    entries: [{ address: addr(1), decimals: 8, observedAtBlock: '10', blockHash: hash(99) }],
  };
  await validateTokenMetadata(db, rpc, known);
  expect(decimalsAt(readCachedMetricMetadata(db, known), addr(1), 10n)).toBeNull();
  await refreshTokenMetadata(db, rpc, [{ address: addr(1), blockNumber: 10n }], { seed: known });
  expect(rpc.request).toHaveBeenCalledTimes(1);
  expect(decimalsAt(readCachedMetricMetadata(db, known), addr(1), 10n)).toBe(6);
  await validateTokenMetadata(db, rpc, known);
  await refreshTokenMetadata(db, rpc, [{ address: addr(1), blockNumber: 10n }], { seed: known });
  expect(rpc.request).toHaveBeenCalledTimes(1);
  expect(decimalsAt(readCachedMetricMetadata(db, known), addr(1), 10n)).toBe(6);
});
test('failed tokens cannot starve a previously unseen token across slow batches', async () => {
  const db = setup(),
    rpc = reader();
  rpc.request.mockImplementation(async (_method, params) =>
    (params[0] as { to: string }).to === addr(17) ? toHex(18, { size: 32 }) : '0x',
  );
  const targets = Array.from({ length: 17 }, (_, i) => ({
    address: addr(i + 1),
    blockNumber: 10n,
  }));
  await refreshTokenMetadata(db, rpc, targets, { nowMs: 0, maxTokens: 16 });
  await refreshTokenMetadata(db, rpc, targets, { nowMs: 60000, maxTokens: 16 });
  expect(decimalsAt(readCachedMetricMetadata(db, seed), addr(17), 10n)).toBe(18);
});
