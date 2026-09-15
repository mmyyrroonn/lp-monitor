import { afterEach, expect, test, vi } from 'vitest';
import { toHex, type Address } from 'viem';
import { openDatabase } from '../../src/storage/database.js';
import { decimalsAt } from '../../src/metrics/metadata.js';
import { metadataQueueFor, type MetadataLease } from '../../src/storage/metadata-queue.js';
import {
  applyMetadataLookup,
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
test('an unchanged cache comes back as the same object and a write is visible on the next read', async () => {
  const db = setup(),
    rpc = reader();
  // One seed object for the whole run, the way the live path reads it: that identity is what makes
  // the built cache reusable, and the durable revision is what retires it.
  await refreshTokenMetadata(db, rpc, [{ address: addr(1), blockNumber: 10n }], { nowMs: 0, seed });
  const first = readCachedMetricMetadata(db, seed);
  expect(readCachedMetricMetadata(db, seed)).toBe(first);
  expect(decimalsAt(first, addr(1), 10n)).toBe(6);
  await refreshTokenMetadata(db, rpc, [{ address: addr(2), blockNumber: 10n }], { nowMs: 1, seed });
  const third = readCachedMetricMetadata(db, seed);
  expect(third).not.toBe(first);
  expect(decimalsAt(third, addr(1), 10n)).toBe(6);
  expect(decimalsAt(third, addr(2), 10n)).toBe(18);
  // A different seed is a different cache: the version it carries is the seed's, not the memo's.
  expect(readCachedMetricMetadata(db, { ...seed, version: 'other' }).version).toBe(
    'other+onchain-v1',
  );
});
test('an address the cache already answers is never queued', async () => {
  const db = setup(),
    rpc = reader();
  const known = {
    ...seed,
    entries: [{ address: addr(1), decimals: 8, observedAtBlock: '5', blockHash: hash(5) }],
  };
  const update = await refreshTokenMetadata(db, rpc, [{ address: addr(1), blockNumber: 10n }], {
    nowMs: 0,
    seed: known,
  });
  expect(rpc.request).not.toHaveBeenCalled();
  expect(update).toEqual({
    attempted: 0,
    resolved: 0,
    failed: 0,
    eligible: 0,
    retryWaiting: 0,
    inflight: 0,
  });
  expect(db.prepare('select count(*) as n from metadata_demand').get()).toEqual({ n: 0 });
});
test('a failed lookup leaves its demand waiting out the backoff in the queue', async () => {
  const db = setup(),
    rpc = reader();
  rpc.request.mockResolvedValueOnce('0x');
  const targets = [{ address: addr(1), blockNumber: 10n }];
  expect(await refreshTokenMetadata(db, rpc, targets, { nowMs: 0 })).toEqual({
    attempted: 1,
    resolved: 0,
    failed: 1,
    eligible: 0,
    retryWaiting: 1,
    inflight: 0,
  });
  expect(db.prepare('select address,next_retry_ms from token_metadata_failures').all()).toEqual([
    { address: addr(1), next_retry_ms: 60000 },
  ]);
  // The wait is real, and the demand it belongs to is still this scope's work rather than work the
  // round deferred away: a second round inside the cooldown spends nothing and queues nothing new.
  expect(await refreshTokenMetadata(db, rpc, targets, { nowMs: 1 })).toEqual({
    attempted: 0,
    resolved: 0,
    failed: 0,
    eligible: 0,
    retryWaiting: 1,
    inflight: 0,
  });
  expect(rpc.request).toHaveBeenCalledTimes(1);
  expect(await refreshTokenMetadata(db, rpc, targets, { nowMs: 60000 })).toEqual({
    attempted: 1,
    resolved: 1,
    failed: 0,
    eligible: 0,
    retryWaiting: 0,
    inflight: 0,
  });
  expect(decimalsAt(readCachedMetricMetadata(db, seed), addr(1), 10n)).toBe(6);
  expect(db.prepare('select count(*) as n from token_metadata_failures').get()).toEqual({ n: 0 });
  expect(db.prepare('select count(*) as n from metadata_demand').get()).toEqual({ n: 0 });
});
test('a missing valuation is leased before a monitored-asset warmup', async () => {
  const db = setup(),
    rpc = reader();
  rpc.request.mockResolvedValue('0x');
  const update = await refreshTokenMetadata(
    db,
    rpc,
    [
      { address: addr(1), blockNumber: 10n, priority: 2 },
      { address: addr(2), blockNumber: 10n, priority: 0 },
    ],
    { nowMs: 0, maxTokens: 1 },
  );
  expect(rpc.request.mock.calls[0]![1][0]).toEqual({ to: addr(2), data: '0x313ce567' });
  expect(update).toEqual({
    attempted: 1,
    resolved: 0,
    failed: 1,
    eligible: 1,
    retryWaiting: 1,
    inflight: 0,
  });
  // Both demands keep the priority they were given: the warmup one was never reached, and the
  // valuation one is waiting out the cooldown its own failure set.
  expect(db.prepare('select address,priority from metadata_demand order by address').all()).toEqual(
    [
      { address: addr(1), priority: 2 },
      { address: addr(2), priority: 0 },
    ],
  );
});
const scope = 'live';
function demand(n: number) {
  return { address: addr(n) as Address, blockNumber: 10n, priority: 0 as const };
}
function lookup(lease: MetadataLease, decimals: number | null, failure: string | null = null) {
  return {
    lease,
    anchor: decimals === null ? null : { number: 10n, hash: hash(10), timestampSec: 100 },
    decimals,
    failure,
  };
}
test('a result whose lease was superseded is never written to the cache', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue(scope, [demand(1)], 0);
  const superseded = queue.lease(scope, 0, 'run')!;
  // The holder stalls past its lease, so another holder takes the same demand and is answered.
  queue.settle(scope, superseded.leaseId, 0, { kind: 'requeue' });
  const current = queue.lease(scope, 0, 'other')!;
  expect(applyMetadataLookup(db, scope, lookup(superseded, 6), 1)).toBe('stale-lease');
  // Nothing landed, and nothing was settled either: the demand is still the live lease's.
  expect(db.prepare('select count(*) as n from token_metadata').get()).toEqual({ n: 0 });
  expect(queue.stats(scope, 1)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 1 });
  expect(applyMetadataLookup(db, scope, lookup(current, 6), 1)).toBe('resolved');
  expect(decimalsAt(readCachedMetricMetadata(db, seed), addr(1), 10n)).toBe(6);
});
test('a superseded lease cannot write a backoff against the holder that owns the demand', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue(scope, [demand(1)], 0);
  const superseded = queue.lease(scope, 0, 'run')!;
  queue.settle(scope, superseded.leaseId, 0, { kind: 'requeue' });
  const current = queue.lease(scope, 0, 'other')!;
  expect(applyMetadataLookup(db, scope, lookup(superseded, null, 'timeout'), 1)).toBe(
    'stale-lease',
  );
  expect(db.prepare('select count(*) as n from token_metadata_failures').get()).toEqual({ n: 0 });
  // The live lease runs out on its own terms, not with a deadline a stranger handed it.
  expect(applyMetadataLookup(db, scope, lookup(current, 6), 1)).toBe('resolved');
  expect(decimalsAt(readCachedMetricMetadata(db, seed), addr(1), 10n)).toBe(6);
});
test('a result anchored where the durable record sees another branch is requeued, not written', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue(scope, [demand(1)], 0);
  const lease = queue.lease(scope, 0, 'run')!;
  db.prepare('insert into token_metadata_invalid_anchors(block_number,block_hash) values(?,?)').run(
    10,
    hash(9),
  );
  const forked = { ...lookup(lease, 6), anchor: { number: 10n, hash: hash(9), timestampSec: 100 } };
  expect(applyMetadataLookup(db, scope, forked, 1)).toBe('stale-branch');
  expect(db.prepare('select count(*) as n from token_metadata').get()).toEqual({ n: 0 });
  // The lease was thrown away rather than held to its 30s expiry: the demand is leasable at once.
  expect(queue.stats(scope, 1)).toEqual({ eligible: 1, retryWaiting: 0, inflight: 0 });
  const again = queue.lease(scope, 1, 'run')!;
  expect(applyMetadataLookup(db, scope, lookup(again, 6), 1)).toBe('resolved');
  expect(decimalsAt(readCachedMetricMetadata(db, seed), addr(1), 10n)).toBe(6);
});
test('demands a round does not reach stay queued for the next one', async () => {
  const db = setup(),
    rpc = reader();
  const targets = [addr(1), addr(2), addr(3)].map((address) => ({ address, blockNumber: 10n }));
  expect(await refreshTokenMetadata(db, rpc, targets, { nowMs: 0, maxTokens: 1 })).toEqual({
    attempted: 1,
    resolved: 1,
    failed: 0,
    eligible: 2,
    retryWaiting: 0,
    inflight: 0,
  });
  expect(await refreshTokenMetadata(db, rpc, targets, { nowMs: 1, maxTokens: 2 })).toEqual({
    attempted: 2,
    resolved: 2,
    failed: 0,
    eligible: 0,
    retryWaiting: 0,
    inflight: 0,
  });
  expect(rpc.request).toHaveBeenCalledTimes(3);
  expect(decimalsAt(readCachedMetricMetadata(db, seed), addr(3), 10n)).toBe(18);
});
