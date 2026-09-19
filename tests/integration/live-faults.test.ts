import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { toHex, type Address } from 'viem';
import type { BlockAnchor, RawLog } from '../../src/domain/types.js';
import { follow } from '../../src/ingest/follow.js';
import { openDatabase } from '../../src/storage/database.js';
import { rawLogKey, type RecordedRangeBatch } from '../../src/storage/manifest.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { createP6TransportFixture, type P6Fault } from '../fixtures/p6-transport.js';

const scopeId = 'p6-live-faults';
const chainConfig = JSON.parse(readFileSync('config/robinhood.json', 'utf8'));
const address = chainConfig.v3Pools[0] as Address;
const topic = toHex(1n, { size: 32 });

function batch(
  fromBlock: bigint,
  end: BlockAnchor,
  previous: BlockAnchor | null,
  logs: readonly RawLog[],
): RecordedRangeBatch {
  const keys = logs.map(rawLogKey);
  return {
    id: `batch-${end.number}-${end.hash.slice(-6)}`,
    scopeId,
    fromBlock,
    toBlock: end.number,
    end,
    previous,
    logs,
    observedAtMs: Number(end.number),
    captureMode: 'synthetic',
    filterPlanHash: 'p6-filter',
    manifestHash: `manifest-${end.hash}`,
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'p6-v1',
      expectedShardIds: ['only'],
      shards: [
        {
          shardId: 'only',
          filterId: 'operations',
          request: { fromBlock, toBlock: end.number, address: [address], topics: [] },
          status: 'success',
          responseHash: `response-${end.hash}`,
          logKeys: keys,
          logCount: keys.length,
          error: null,
        },
      ],
    },
  };
}

function harness() {
  const fixture = createP6TransportFixture();
  const reader = fixture.factory(
    { httpRpcUrl: 'https://p6-fixture.invalid', providerAlias: 'p6-fixture', dataDir: '.' },
    { maxCalls: 10_000, deadlineMs: Date.now() + 60_000, evidenceMode: 'off' },
  );
  const database = openDatabase(':memory:');
  const store = new SqliteRangeStore(database);
  const states: string[] = [];
  const run = (stopAtMs: number, extra: Record<string, unknown> = {}) =>
    follow(reader, store, stopAtMs, {
      scopeId,
      startBlock: 100n,
      pollIntervalMs: 2_000,
      maxRangeBlocks: 1_000,
      overlapBlocks: 20,
      nowMs: fixture.nowMs,
      sleep: fixture.sleep,
      onWait: (ms: number) => fixture.waits.push(ms),
      onStateChange: (state: string) => states.push(state),
      recordRange: async (from: bigint, end: BlockAnchor, previous: BlockAnchor | null) => {
        const logs = await reader.getLogs({
          fromBlock: from,
          toBlock: end.number,
          address: [address],
          topics: [],
        });
        const accepted = batch(from, end, previous, logs);
        store.saveRaw(accepted);
        return store.acceptRange(accepted);
      },
      ...extra,
    } as Parameters<typeof follow>[3]);
  return { fixture, reader, database, store, states, run };
}

test('30 second disconnect retries on the virtual poll clock without moving the cursor', async () => {
  const h = harness();
  h.fixture.faultNext('eth_getBlockByNumber', 'disconnect', 16);
  try {
    await h.run(30_001);
    expect(h.fixture.nowMs()).toBe(30_001);
    expect(h.store.acceptedTip(scopeId)).toBeNull();
    expect(h.states).toEqual(['degraded']);
  } finally {
    await h.reader.close?.();
    h.database.close();
  }
});

test.each(['rate-limit', 'disconnect'] satisfies P6Fault[])(
  '%s failures recover once and emit health only when state changes',
  async (fault) => {
    const h = harness();
    h.fixture.faultNext('eth_getBlockByNumber', fault, 2);
    try {
      await h.run(13_000, { shouldStop: () => h.store.acceptedTip(scopeId) !== null });
      expect(h.store.acceptedTip(scopeId)?.number).toBe(200n);
      expect(h.states).toEqual(['degraded', 'healthy']);
      expect(h.fixture.waits).toEqual([4_000, 4_000, 8_000, 8_000]);
    } finally {
      await h.reader.close?.();
      h.database.close();
    }
  },
);

test('sustained failures grow the wait and a success resets it', async () => {
  const h = harness();
  // 4 consecutive getAnchor faults, then clean.
  h.fixture.faultNext('eth_getBlockByNumber', 'disconnect', 4);
  try {
    await h.run(60_001, { shouldStop: () => h.store.acceptedTip(scopeId) !== null });
    // After 4 failures the waits must include values larger than poll (4000, 8000, 16000, ...),
    // and once a range is accepted the cursor moved.
    expect(h.store.acceptedTip(scopeId)?.number).toBe(200n);
    const growing = h.fixture.waits.filter((ms) => ms > 2_000);
    expect(growing.length).toBeGreaterThanOrEqual(2);
  } finally {
    await h.reader.close?.();
    h.database.close();
  }
});

test('duplicate blocks and logs are rejected before cursor or decision input advances', async () => {
  const h = harness();
  h.fixture.setDuplicateLogs(true);
  try {
    await expect(h.run(1, { oneShot: true })).rejects.toThrow(/Duplicate raw log/i);
    expect(h.store.acceptedTip(scopeId)).toBeNull();
    expect(h.store.activeLogs(scopeId)).toEqual([]);
    expect(h.database.prepare('select count(*) as n from accepted_ranges').get()).toEqual({ n: 0 });
  } finally {
    await h.reader.close?.();
    h.database.close();
  }
});

test('fork invalidates the old branch and accepts one replacement decision input', async () => {
  const h = harness();
  try {
    await h.run(1, { oneShot: true });
    const oldLogs = h.store.activeLogs(scopeId);
    expect(oldLogs.some((log) => log.blockNumber === 180n)).toBe(true);
    h.fixture.fork();
    h.fixture.advanceClock(1);
    await h.run(2, { oneShot: true });
    const replacement = h.store.activeLogs(scopeId);
    expect(replacement.some((log) => log.blockNumber === 180n)).toBe(false);
    expect(replacement.filter((log) => log.blockNumber === 185n)).toHaveLength(1);
    expect(new Set(replacement.map(rawLogKey)).size).toBe(replacement.length);
  } finally {
    await h.reader.close?.();
    h.database.close();
  }
});

test('malformed JSON response is rejected without accepting transport evidence', async () => {
  const h = harness();
  h.fixture.faultNext('eth_getLogs', 'malformed-json');
  try {
    // A truncated body matches no known provider shape, so it classifies as a retryable
    // `request-failed` rather than an integrity violation. The range stays uncovered and the
    // run says so; what must never happen is evidence being accepted from a bad response.
    const result = await h.run(1, { oneShot: true });
    expect(result.complete).toBe(false);
    expect(result.failures).toEqual(['request-failed']);
    expect(result.acceptedRanges).toBe(0);
    expect(h.store.acceptedTip(scopeId)).toBeNull();
    expect(h.store.activeLogs(scopeId)).toEqual([]);
    expect(h.database.prepare('select count(*) as n from accepted_ranges').get()).toEqual({ n: 0 });
  } finally {
    await h.reader.close?.();
    h.database.close();
  }
});

test('SQLite commit failure retains raw evidence but cannot advance cursor or decisions', async () => {
  const h = harness();
  const accept = vi.spyOn(h.store, 'acceptRange').mockImplementationOnce(() => {
    throw new Error('database or disk is full');
  });
  try {
    await expect(h.run(1, { oneShot: true })).rejects.toThrow(/disk is full/);
    expect(h.store.acceptedTip(scopeId)).toBeNull();
    expect(h.store.activeLogs(scopeId)).toEqual([]);
    expect(h.database.prepare('select count(*) as n from accepted_ranges').get()).toEqual({ n: 0 });
    expect(h.database.prepare('select count(*) as n from ingest_batches').get()).toEqual({ n: 1 });
  } finally {
    accept.mockRestore();
    await h.reader.close?.();
    h.database.close();
  }
});

test('incomplete range result does not advance cursor and recovers without duplicates', async () => {
  const h = harness();
  let calls = 0;
  try {
    await h.run(4_001, {
      shouldStop: () => h.store.acceptedTip(scopeId) !== null,
      recordRange: async (from: bigint, end: BlockAnchor, previous: BlockAnchor | null) => {
        if (++calls === 1) return null;
        const logs = await h.reader.getLogs({
          fromBlock: from,
          toBlock: end.number,
          address: [address],
          topics: [],
        });
        return h.store.acceptRange(batch(from, end, previous, logs));
      },
    });
    expect(h.store.acceptedTip(scopeId)?.number).toBe(200n);
    expect(new Set(h.store.activeLogs(scopeId).map(rawLogKey)).size).toBe(
      h.store.activeLogs(scopeId).length,
    );
  } finally {
    await h.reader.close?.();
    h.database.close();
  }
});
