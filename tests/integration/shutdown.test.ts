import { EventEmitter } from 'node:events';
import { expect, test } from 'vitest';
import { toHex } from 'viem';
import { createShutdownController } from '../../src/ops/shutdown.js';
import { follow, type FollowStore } from '../../src/ingest/follow.js';

test('SIGINT wakes polling, remains cooperative, and listeners are removed after cleanup', async () => {
  const target = new EventEmitter();
  const stop = createShutdownController(target);
  const waiting = stop.wait(60_000);
  target.emit('SIGINT');
  await waiting;
  expect(stop.requested).toBe(true);
  expect(stop.reason).toBe('SIGINT');
  target.emit('SIGTERM');
  expect(stop.reason).toBe('SIGINT');
  stop.dispose();
  expect(target.listenerCount('SIGINT')).toBe(0);
  expect(target.listenerCount('SIGTERM')).toBe(0);
});

test('stopping during a completed batch prevents a second batch and preserves its cursor for resume', async () => {
  const stop = createShutdownController(new EventEmitter());
  let tip = { number: 10n, hash: toHex(10, { size: 32 }), timestampSec: 10 };
  const store: FollowStore = {
    acceptedTip: () => tip,
    checkpoints: () => [tip],
    invalidateAfter: () => {},
    resetForWarmup: () => {},
    pruneCheckpoints: () => {},
  };
  const scanned: bigint[] = [];
  const states: string[] = [];
  const run = await follow(
    {
      getAnchor: async (n) => ({
        number: n === 'latest' ? 100n : n,
        hash: toHex(n === 'latest' ? 100n : n, { size: 32 }),
        timestampSec: Number(n === 'latest' ? 100n : n),
      }),
      getLogs: async () => [],
    },
    store,
    Date.now() + 60_000,
    {
      scopeId: 'scope',
      startBlock: 0n,
      maxRangeBlocks: 10,
      overlapBlocks: 0,
      shouldStop: () => stop.requested,
      onStateChange: (state) => states.push(state),
      sleep: (ms) => stop.wait(ms),
      recordRange: async (from, end) => {
        scanned.push(from);
        tip = end;
        stop.request('SIGINT');
        return { added: [], removed: [], retimed: [], affectedFromBlock: from };
      },
    },
  );
  expect(scanned).toEqual([11n]);
  expect(tip.number).toBe(20n);
  expect(run.complete).toBe(false);
  expect(run.acceptedRanges).toBe(1);
  expect(states).toEqual([]);
  stop.dispose();
});
