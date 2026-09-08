import { expect, test } from 'vitest';
import type { Hex } from 'viem';
import type { BlockAnchor, ChainReader } from '../../src/domain/types.js';
import { createTimeResolver } from '../../src/rpc/resolve-time.js';

function anchor(number: bigint, timestampSec: number): BlockAnchor {
  return { number, hash: `0x${number.toString(16).padStart(64, '0')}` as Hex, timestampSec };
}

function readerFrom(anchors: readonly BlockAnchor[]) {
  const calls: Array<bigint | 'latest'> = [];
  const byNumber = new Map(anchors.map((value) => [value.number, value]));
  const reader: ChainReader = {
    async getAnchor(block) {
      calls.push(block);
      if (block === 'latest') return anchors.at(-1)!;
      const value = byNumber.get(block);
      if (!value) throw new Error(`missing test anchor ${block}`);
      return value;
    },
    async getLogs() {
      return [];
    },
  };
  return { reader, calls };
}

test('returns the first block at a duplicated timestamp and verifies its predecessor', async () => {
  const anchors = [100, 101, 102, 103, 104, 105, 106, 107].map((number) =>
    anchor(BigInt(number), number < 103 ? 1_000 + number : number < 106 ? 1_103 : 1_104 + number),
  );
  const { reader, calls } = readerFrom(anchors);
  const resolver = createTimeResolver(reader);

  await expect(resolver.resolveBlockAtOrAfter(1_103, { fromBlock: 100n, toBlock: 107n }))
    .resolves.toEqual(anchors[3]);

  expect(calls).toContain(102n);
  expect(calls.length).toBeLessThan(anchors.length);
});

test('uses sparse cached anchors across repeated resolutions', async () => {
  const anchors = Array.from({ length: 1_025 }, (_, number) => anchor(BigInt(number), 10_000 + number));
  const { reader, calls } = readerFrom(anchors);
  const resolver = createTimeResolver(reader);

  await resolver.resolveBlockAtOrAfter(10_700, { fromBlock: 0n, toBlock: 1_024n });
  const firstCallCount = calls.length;
  await resolver.resolveBlockAtOrAfter(10_700, { fromBlock: 0n, toBlock: 1_024n });

  expect(calls.length).toBe(firstCallCount);
  expect(firstCallCount).toBeLessThanOrEqual(15);
  expect(resolver.queriedAnchors.map(({ number }) => number)).toEqual(
    [...resolver.queriedAnchors.map(({ number }) => number)].sort((left, right) => left < right ? -1 : 1),
  );
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid timestamp %s',
  async (timestampSec) => {
    const { reader } = readerFrom([anchor(0n, 1), anchor(1n, 2)]);
    await expect(createTimeResolver(reader).resolveBlockAtOrAfter(timestampSec)).rejects.toThrow(/positive safe integer/i);
  },
);

test('rejects invalid block bounds', async () => {
  const { reader } = readerFrom([anchor(0n, 1), anchor(1n, 2)]);
  const resolver = createTimeResolver(reader);

  await expect(resolver.resolveBlockAtOrAfter(1, { fromBlock: -1n, toBlock: 1n })).rejects.toThrow(/bounds/i);
  await expect(resolver.resolveBlockAtOrAfter(1, { fromBlock: 1n, toBlock: 0n })).rejects.toThrow(/bounds/i);
});

test('rejects targets outside the bounded chain range', async () => {
  const { reader } = readerFrom([anchor(10n, 100), anchor(11n, 110), anchor(12n, 120)]);
  const resolver = createTimeResolver(reader);

  await expect(resolver.resolveBlockAtOrAfter(99, { fromBlock: 10n, toBlock: 12n })).rejects.toThrow(/outside.*range/i);
  await expect(resolver.resolveBlockAtOrAfter(121, { fromBlock: 10n, toBlock: 12n })).rejects.toThrow(/outside.*range/i);
});

test('rejects nonmonotonic sampled anchors', async () => {
  const { reader } = readerFrom([
    anchor(0n, 100),
    anchor(1n, 110),
    anchor(2n, 90),
    anchor(3n, 130),
    anchor(4n, 140),
  ]);

  await expect(
    createTimeResolver(reader).resolveBlockAtOrAfter(115, { fromBlock: 0n, toBlock: 4n }),
  ).rejects.toThrow(/nonmonotonic/i);
});

test('uses block zero as the default lower bound and latest as the upper bound', async () => {
  const anchors = [anchor(0n, 100), anchor(1n, 110), anchor(2n, 120)];
  const { reader, calls } = readerFrom(anchors);

  await expect(createTimeResolver(reader).resolveBlockAtOrAfter(110)).resolves.toEqual(anchors[1]);
  expect(calls).toContain('latest');
  expect(calls).toContain(0n);
});

test('accepts timestamp zero only for genesis and searches later positive timestamps', async () => {
  const anchors = [anchor(0n, 0), anchor(1n, 10), anchor(2n, 20), anchor(3n, 30)];
  const { reader } = readerFrom(anchors);

  await expect(createTimeResolver(reader).resolveBlockAtOrAfter(15)).resolves.toEqual(anchors[2]);
});

test('rejects timestamp zero on a non-genesis anchor', async () => {
  const { reader } = readerFrom([anchor(0n, 0), anchor(1n, 0), anchor(2n, 20)]);

  await expect(createTimeResolver(reader).resolveBlockAtOrAfter(15)).rejects.toThrow(/invalid block anchor/i);
});
