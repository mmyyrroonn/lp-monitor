import { expect, test, vi } from 'vitest';
import { follow, type FollowResult } from '../../src/ingest/follow.js';
import { ShutdownRequested } from '../../src/ops/shutdown.js';
import type { BlockAnchor, ChainReader } from '../../src/domain/types.js';

test('exception preserves earlier accepted ranges and recovered failures in the terminal summary', async () => {
  const head: BlockAnchor = { number: 200n, hash: '0x01', timestampSec: 1200 };
  let tip: BlockAnchor | null = null,
    stopped = false,
    attempts = 0;
  const summaries: FollowResult[] = [];
  const reader = { getAnchor: async () => head } as unknown as ChainReader;
  const store = {
    acceptedTip: () => tip,
    checkpoints: () => [],
    invalidateAfter: vi.fn(),
    resetForWarmup: vi.fn(),
    pruneCheckpoints: vi.fn(),
  };
  await expect(
    follow(reader, store, Date.now() + 60_000, {
      scopeId: 'scope',
      startBlock: 100n,
      sleep: async () => {},
      shouldStop: () => stopped,
      onResult: (result) => summaries.push(result),
      recordRange: async () => {
        attempts++;
        if (attempts === 1) return null;
        if (attempts === 2) {
          tip = head;
          return { added: [], removed: [] } as never;
        }
        stopped = true;
        throw new ShutdownRequested();
      },
    }),
  ).rejects.toBeInstanceOf(ShutdownRequested);
  expect(summaries).toEqual([
    {
      acceptedRanges: 1,
      reorgs: 0,
      warmupResets: 0,
      failures: ['incomplete-range'],
      complete: false,
    },
  ]);
});
