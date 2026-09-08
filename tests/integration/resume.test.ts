import { expect, test } from 'vitest';
import { toHex } from 'viem';
import type { BlockAnchor, ChainReader, RangeChangeSet } from '../../src/domain/types.js';
import { follow, type FollowStore } from '../../src/ingest/follow.js';
import { RpcFailure } from '../../src/rpc/errors.js';

const anchor = (n: bigint): BlockAnchor => ({
  number: n,
  hash: toHex(n, { size: 32 }),
  timestampSec: 60 + Number(n / 10n),
});
function fixture(initial: bigint | null, head: bigint) {
  let tip = initial === null ? null : anchor(initial);
  let now = 0;
  let sleeps = 0;
  let fail = false;
  const requests: (bigint | 'latest')[] = [];
  const ranges: [bigint, bigint][] = [];
  const reader: ChainReader = {
    getAnchor: async (n) => {
      requests.push(n);
      return anchor(n === 'latest' ? head : n);
    },
    getLogs: async () => [],
  };
  const store: FollowStore = {
    acceptedTip: () => tip,
    checkpoints: () => (tip ? [tip] : []),
    invalidateAfter: (_scope, a) => {
      tip = a;
    },
    resetForWarmup: () => {
      tip = null;
    },
    pruneCheckpoints: () => {},
  };
  const options = {
    scopeId: 'scope',
    startBlock: 0n,
    nowMs: () => now,
    sleep: async (ms: number) => {
      sleeps++;
      now += ms;
    },
    recordRange: async (from: bigint, end: BlockAnchor) => {
      ranges.push([from, end.number]);
      if (fail) {
        fail = false;
        throw new RpcFailure('http-transient', 'unknown', true);
      }
      tip = end;
      return {
        added: [],
        removed: [],
        retimed: [],
        affectedFromBlock: from,
      } satisfies RangeChangeSet;
    },
  };
  return {
    reader,
    store,
    options,
    ranges,
    requests,
    get sleeps() {
      return sleeps;
    },
    setFail: () => {
      fail = true;
    },
  };
}
test('cursor100/head127 scans all new blocks plus overlap in one range', async () => {
  const f = fixture(100n, 127n);
  await follow(f.reader, f.store, 1, { ...f.options, oneShot: true });
  expect(f.ranges).toEqual([[81n, 127n]]);
  expect(f.requests.slice(0, 2)).toEqual(['latest', 100n]);
  expect(f.store.acceptedTip('scope')?.number).toBe(127n);
  expect(f.sleeps).toBe(0);
});
test('head2127 catches up consecutive bounded segments without sleeping between them', async () => {
  const f = fixture(100n, 2127n);
  await follow(f.reader, f.store, 1, { ...f.options, oneShot: true });
  expect(f.ranges).toEqual([
    [81n, 1080n],
    [1061n, 2060n],
    [2041n, 2127n],
  ]);
  expect(f.sleeps).toBe(0);
  expect(f.requests).toContain(1080n);
  expect(f.requests).toContain(2060n);
});
test('empty requested future range does not advance cursor', async () => {
  const f = fixture(null, 99n);
  await follow(f.reader, f.store, 1, { ...f.options, startBlock: 100n, oneShot: true });
  expect(f.ranges).toEqual([]);
  expect(f.store.acceptedTip('scope')).toBeNull();
});
test('transient disconnect retries from unchanged cursor and fills all events', async () => {
  const f = fixture(100n, 127n);
  f.setFail();
  const result = await follow(f.reader, f.store, 4000, f.options);
  expect(f.ranges.slice(0, 2)).toEqual([
    [81n, 127n],
    [81n, 127n],
  ]);
  expect(result.failures).toContain('http-transient');
  expect(f.store.acceptedTip('scope')?.number).toBe(127n);
});
test('restart checks saved cursor hash before invoking the recorder', async () => {
  const f = fixture(120n, 127n);
  f.options.recordRange = async (from, end) => {
    expect(f.requests).toContain(120n);
    return { added: [], removed: [], retimed: [], affectedFromBlock: from };
  };
  await expect(follow(f.reader, f.store, 1, { ...f.options, oneShot: true })).rejects.toThrow(
    /cursor/i,
  );
});
test('invalid overlap cannot trap backlog in a nonadvancing range', async () => {
  const f = fixture(100n, 127n);
  await expect(
    follow(f.reader, f.store, 1, { ...f.options, maxRangeBlocks: 20, overlapBlocks: 20 }),
  ).rejects.toThrow(/overlap/i);
});

test('duration ending with backlog reports incomplete coverage', async () => {
  const f = fixture(100n, 2127n);
  let now = 0;
  const record = f.options.recordRange;
  await expect(
    follow(f.reader, f.store, 10, {
      ...f.options,
      nowMs: () => now,
      oneShot: true,
      recordRange: async (from, end) => {
        const changes = await record(from, end);
        now = 20;
        return changes;
      },
    }),
  ).resolves.toMatchObject({ complete: false, acceptedRanges: 1 });
});
test('same scope rejects a concurrent writer while first request is pending', async () => {
  const f = fixture(100n, 127n);
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const first = follow(
    {
      ...f.reader,
      getAnchor: async (n) => {
        await held;
        return f.reader.getAnchor(n);
      },
    },
    f.store,
    1,
    { ...f.options, oneShot: true },
  );
  await expect(follow(f.reader, f.store, 1, { ...f.options, oneShot: true })).rejects.toThrow(
    /active recorder/,
  );
  release();
  await first;
});
test('fork recovery invalidates to the retained matching checkpoint before replay', async () => {
  const f = fixture(120n, 127n);
  f.store.checkpoints = () => [anchor(100n), anchor(120n)];
  const original = f.reader.getAnchor;
  f.reader.getAnchor = async (n) =>
    n === 120n ? { ...anchor(120n), hash: toHex(999n, { size: 32 }) } : original(n);
  const causes: string[] = [];
  const result = await follow(f.reader, f.store, 1, {
    ...f.options,
    oneShot: true,
    onRecovery: async (a) => {
      causes.push(String(a?.number));
    },
  });
  expect(result.reorgs).toBe(1);
  expect(causes).toEqual(['100']);
  expect(f.ranges).toEqual([[81n, 127n]]);
});

test('recovery refreshes target anchor after a fork changes descendants', async () => {
  const f = fixture(120n, 127n);
  f.store.checkpoints = () => [anchor(100n), anchor(120n)];
  let heads = 0;
  f.reader.getAnchor = async (n) => {
    if (n === 'latest')
      return { ...anchor(127n), hash: toHex(++heads === 1 ? 127n : 999n, { size: 32 }) };
    if (n === 120n) return { ...anchor(120n), hash: toHex(888n, { size: 32 }) };
    return anchor(n);
  };
  const original = f.options.recordRange;
  await follow(f.reader, f.store, 1, {
    ...f.options,
    oneShot: true,
    recordRange: async (from, end) => {
      expect(end.hash).toBe(toHex(999n, { size: 32 }));
      const changes = await original(from, end);
      return changes;
    },
  });
  expect(heads).toBe(2);
});
test('deadline crossed while validating cursor does not start another range', async () => {
  const f = fixture(100n, 127n);
  let now = 0;
  const read = f.reader.getAnchor;
  f.reader.getAnchor = async (n) => {
    if (n === 100n) now = 11;
    return read(n);
  };
  const result = await follow(f.reader, f.store, 10, {
    ...f.options,
    oneShot: true,
    nowMs: () => now,
  });
  expect(f.ranges).toEqual([]);
  expect(result.complete).toBe(false);
});
test.each([-1n, 5n])('invalid target %s rejects before RPC', async (toBlock) => {
  const f = fixture(null, 127n);
  await expect(
    follow(f.reader, f.store, 1, { ...f.options, startBlock: 10n, toBlock, oneShot: true }),
  ).rejects.toThrow(/bounds/);
  expect(f.requests).toEqual([]);
});

test('explicit ingest backfills its requested start even with an existing higher cursor', async () => {
  const f = fixture(200n, 220n);
  await follow(f.reader, f.store, 1, {
    ...f.options,
    startBlock: 100n,
    toBlock: 220n,
    oneShot: true,
  });
  expect(f.ranges[0]).toEqual([100n, 220n]);
});
test('explicit older ingest rescans without rewinding the existing completed cursor', async () => {
  const f = fixture(200n, 220n);
  await follow(f.reader, f.store, 1, {
    ...f.options,
    startBlock: 100n,
    toBlock: 120n,
    oneShot: true,
    recordRange: async (from, end) => {
      f.ranges.push([from, end.number]);
      return { added: [], removed: [], retimed: [], affectedFromBlock: from };
    },
  });
  expect(f.ranges).toEqual([[100n, 120n]]);
  expect(f.store.acceptedTip('scope')?.number).toBe(200n);
});
