import { expect, test } from 'vitest';
import { completePartitions } from '../../src/ingest/completeness.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';
import type { FetchShardManifest } from '../../src/storage/manifest.js';
import { batch, addr, hash } from '../helpers/alert-fixture.js';

type Request = FetchShardManifest['request'];
function input(requests: Partial<Request>[]) {
  const value = batch('partitions', []);
  value.fromBlock = 10n;
  value.toBlock = 20n;
  const template = value.manifest.shards[0]!;
  value.manifest = {
    ...value.manifest,
    expectedShardIds: requests.map((_, i) => String(i)),
    shards: requests.map((request, i) => ({
      ...template,
      shardId: String(i),
      request: {
        fromBlock: 10n,
        toBlock: 20n,
        address: [addr(1)],
        topics: [],
        ...request,
      },
    })),
  };
  return value;
}

test('full-range shards prove coverage without materializing the pool selector cross product', () => {
  const value = input([
    { topics: [[hash(1), hash(2), hash(3)], Array.from({ length: 1000 }, (_, i) => hash(i))] },
  ]);
  const work = openWorkCounts();
  try {
    expect(completePartitions(value)).toBe(true);
  } finally {
    work.close();
  }
  expect(work.counts.partitionSelectorsExpanded).toBeLessThanOrEqual(value.manifest.shards.length);
});

test.each([
  { name: 'empty manifest', requests: [], want: false },
  { name: 'empty address', requests: [{ address: [] }], want: false },
  { name: 'empty topic alternatives', requests: [{ topics: [[]] }], want: false },
  { name: 'empty shard beside covered selector', requests: [{ address: [] }, {}], want: true },
  { name: 'null and scalar topics', requests: [{ topics: [null, hash(1)] }], want: true },
  { name: 'adjacent partial ranges', requests: [{ toBlock: 15n }, { fromBlock: 16n }], want: true },
  { name: 'one missing block', requests: [{ toBlock: 14n }, { fromBlock: 16n }], want: false },
  {
    name: 'address cannot borrow another address coverage',
    requests: [{ address: [addr(1)] }, { address: [addr(2)], toBlock: 15n }],
    want: false,
  },
  {
    name: 'topic cannot borrow another topic coverage',
    requests: [{ topics: [hash(1)] }, { topics: [hash(2)], toBlock: 15n }],
    want: false,
  },
  {
    name: 'partial duplicate of fully covered selector',
    requests: [{}, { toBlock: 15n }],
    want: true,
  },
] satisfies { name: string; requests: Partial<Request>[]; want: boolean }[])(
  '$name',
  ({ requests, want }) => {
    expect(completePartitions(input(requests))).toBe(want);
  },
);

test('selector expansion budget remains enforced before later empty topics', () => {
  const addresses = Array.from({ length: 100 }, (_, i) => addr(i));
  const topics = Array.from({ length: 1001 }, (_, i) => hash(i));
  expect(completePartitions(input([{ address: addresses, topics: [topics.slice(0, 1000)] }]))).toBe(
    true,
  );
  expect(completePartitions(input([{ address: addresses, topics: [topics] }]))).toBe(false);
  expect(completePartitions(input([{ address: addresses, topics: [topics, []] }]))).toBe(false);
});

test('address-only selectors retain their existing budget semantics', () => {
  const addresses = Array.from({ length: 100001 }, () => addr(1));
  expect(completePartitions(input([{ address: addresses }]))).toBe(true);
  expect(completePartitions(input([{ address: addresses, topics: [null] }]))).toBe(false);
});

test('partial ranges still exercise strict selector expansion', () => {
  const work = openWorkCounts();
  try {
    expect(completePartitions(input([{ toBlock: 15n }, { fromBlock: 16n }]))).toBe(true);
  } finally {
    work.close();
  }
  expect(work.counts.partitionSelectorsExpanded).toBe(2);
});

test('malformed selector values still fail validation on full ranges', () => {
  expect(() =>
    completePartitions(input([{ address: [null] as unknown as Request['address'] }])),
  ).toThrow();
  expect(() =>
    completePartitions(input([{ topics: [[null]] as unknown as Request['topics'] }])),
  ).toThrow();
});
