import { expect, test } from 'vitest';
import { toHex } from 'viem';
import type { BlockAnchor } from '../../src/domain/types.js';
import { findMatchingCheckpoint } from '../../src/ingest/reorg.js';

const anchor = (n: number, fork = 0): BlockAnchor => ({
  number: BigInt(n),
  hash: toHex(n + fork, { size: 32 }),
  timestampSec: n + 1,
});
test('recovers A100 when A120 has become B120', async () => {
  const reader = {
    getAnchor: async (n: bigint | 'latest') => anchor(Number(n), n === 120n ? 1000 : 0),
  };
  expect(await findMatchingCheckpoint(reader, [anchor(100), anchor(120)])).toEqual(anchor(100));
});
test('exponential search and binary refinement find newest matching retained checkpoint', async () => {
  let calls = 0;
  const reader = {
    getAnchor: async (n: bigint | 'latest') => {
      calls++;
      return anchor(Number(n), Number(n) > 3210 ? 100000 : 0);
    },
  };
  const checkpoints = Array.from({ length: 10000 }, (_, n) => anchor(n));
  expect((await findMatchingCheckpoint(reader, checkpoints))?.number).toBe(3210n);
  expect(calls).toBeLessThanOrEqual(32);
});
test('no matching retained evidence requests warmup without claiming a checkpoint', async () => {
  let calls = 0;
  expect(
    await findMatchingCheckpoint(
      {
        getAnchor: async (n) => {
          calls++;
          return anchor(Number(n), 1000);
        },
      },
      [anchor(100), anchor(120)],
    ),
  ).toBeNull();
  expect(calls).toBe(2);
});
test('empty checkpoints and a consumed search budget never read the chain', async () => {
  let calls = 0;
  const reader = {
    getAnchor: async () => {
      calls++;
      return anchor(1);
    },
  };
  expect(await findMatchingCheckpoint(reader, [])).toBeNull();
  expect(await findMatchingCheckpoint(reader, [anchor(1)], 0)).toBeNull();
  expect(calls).toBe(0);
});
test('unavailable checkpoint propagates failure rather than causing destructive warmup', async () => {
  await expect(
    findMatchingCheckpoint(
      {
        getAnchor: async () => {
          throw new Error('offline');
        },
      },
      [anchor(100)],
    ),
  ).rejects.toThrow('offline');
});
