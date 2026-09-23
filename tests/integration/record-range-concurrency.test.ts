import { expect, test } from 'vitest';
import type { Address } from 'viem';
import { executePlan } from '../../src/ingest/record-range.js';
import type { PlannedFilter } from '../../src/ingest/filter-plan.js';

const address = '0x1111111111111111111111111111111111111111' as Address;

const plan: readonly PlannedFilter[] = [
  {
    id: 'operation-v3',
    family: 'operation-v3',
    filter: { fromBlock: 0n, toBlock: 0n, address: [address], topics: [] },
  },
  {
    id: 'operation-v3',
    family: 'operation-v3',
    filter: { fromBlock: 1n, toBlock: 1n, address: [address], topics: [] },
  },
];

test('executes independent shard filters with bounded concurrency and stable output order', async () => {
  let active = 0;
  let peak = 0;
  const reader = {
    async getLogs() {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return [];
    },
  };
  const result = await executePlan(reader, plan, 100, 1n, 0);
  expect(peak).toBe(2);
  expect(result.complete).toBe(true);
  expect(result.shards.map((shard) => shard.request.fromBlock)).toEqual([0n, 1n]);
});
