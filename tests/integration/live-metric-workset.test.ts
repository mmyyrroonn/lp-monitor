import { afterEach, expect, test, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, toHex, type Hex } from 'viem';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { eventIndexFor } from '../../src/storage/live-event-index.js';
import { registryCacheFor } from '../../src/storage/registry-cache.js';
import { LiveMetricCache } from '../../src/storage/live-metric-cache.js';
import { buildMetricsReport } from '../../src/storage/metric-store.js';
import { valuationIndexFor } from '../../src/metrics/valuation-index.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';
import { poolRegistrationId } from '../../src/registry/pools.js';
import { createAssetRegistry } from '../../src/registry/assets.js';
import {
  rawLogKey,
  type PersistedPoolRegistration,
  type RecordedRangeBatch,
} from '../../src/storage/manifest.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import type { SwapValuation } from '../../src/metrics/notional.js';
import type { LogTime, RawLog } from '../../src/domain/types.js';

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  vi.restoreAllMocks();
});
const SCOPE = 'ws';
const USDG = toHex(3, { size: 20 });
const STOCK_A = toHex(0x11, { size: 20 });
const STOCK_B = toHex(0x22, { size: 20 });
const STOCK_C = toHex(0x33, { size: 20 });
/** The selected pool: it names no USDG, so its price can only come from another pool's swap. */
const SELECTED = toHex(0x101, { size: 20 });
/** The pool that prices it: the same stock, quoted against USDG. */
const QUOTE_POOL = toHex(0x102, { size: 20 });
/** The pool nobody asks about. */
const OTHER = toHex(0x103, { size: 20 });
/**
 * Watched stocks the selected pool names: its two tokens are both monitored assets, so every swap
 * it makes is valued once per side. The quote pool prices exactly one of them.
 */
const WATCHED_SIDES = 2;
const poolId = (address: Hex): string =>
  poolRegistrationId({ pool: { chainId: 4663, protocol: 'v3', address } });
const SELECTED_ID = poolId(SELECTED);
const QUOTE_POOL_ID = poolId(QUOTE_POOL);
const OTHER_ID = poolId(OTHER);
const hash = (n: number) => toHex(n, { size: 32 });
/** A block's minute is its own height times sixty: the only chain here whose window can move. */
const minuteTime = (block: number): LogTime => ({
  minuteStartSec: block * 60,
  exactTimestampSec: block * 60,
  source: 'log-verified',
});
const TIP = { number: 120n, hash: hash(120), timestampSec: 180 };
const QUOTE_SWAP_BLOCK = 100;
const SELECTED_SWAP_BLOCK = 101;
const OTHER_SWAP_BLOCK = 102;

function fixture(): Database.Database {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}

/** A pool is discovered at its own swap log: the batch has to carry every log it registers. */
function registration(log: RawLog, token0: Hex, token1: Hex): PersistedPoolRegistration {
  return {
    pool: { chainId: 4663 as const, protocol: 'v3' as const, address: log.address },
    token0,
    token1,
    feePips: 3000,
    tickSpacing: 60,
    hooks: toHex(0, { size: 20 }),
    assetVersion: 'ws-v1',
    source: 'synthetic',
    discoveredAt: {
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
    },
  };
}

function logAt(address: Hex, block: number, amount0: bigint, amount1: bigint): RawLog {
  return {
    address,
    blockNumber: BigInt(block),
    blockHash: hash(block),
    transactionHash: hash(block + 1000),
    transactionIndex: 0,
    logIndex: 0,
    rawBlockTimestamp: '0x0',
    topics: encodeEventTopics({
      abi: v3PoolAbi,
      eventName: 'Swap',
      args: { sender: address, recipient: address },
    }) as Hex[],
    data: encodeAbiParameters(
      [
        { type: 'int256' },
        { type: 'int256' },
        { type: 'uint160' },
        { type: 'uint128' },
        { type: 'int24' },
      ],
      [amount0, amount1, 2n ** 96n, 1000n, 0],
    ),
  };
}

/** One minute of chain: the quote pool's swap lands one second before the selected pool's. */
function batch(
  id: string,
  logs: RawLog[],
  poolRegistrations: PersistedPoolRegistration[],
  options: {
    tip?: typeof TIP;
    previous?: typeof TIP;
    fromBlock?: bigint;
    timeOf?: (block: number) => LogTime;
  } = {},
): RecordedRangeBatch {
  const tip = options.tip ?? TIP;
  const previous = options.previous ?? TIP;
  const fromBlock = options.fromBlock ?? 1n;
  const timeOf =
    options.timeOf ??
    ((block: number): LogTime => ({
      minuteStartSec: 120,
      exactTimestampSec: block + 60,
      source: 'log-verified',
    }));
  return {
    id,
    scopeId: SCOPE,
    fromBlock,
    toBlock: tip.number,
    end: tip,
    previous,
    logs,
    observedAtMs: 1,
    captureMode: 'synthetic',
    filterPlanHash: 'ws',
    manifestHash: id,
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'ws',
      expectedShardIds: ['one'],
      shards: [
        {
          shardId: 'one',
          filterId: 'operation-v3',
          request: {
            fromBlock,
            toBlock: tip.number,
            address: [...new Set(logs.map((l) => l.address))],
            topics: [],
          },
          status: 'success',
          responseHash: hash(1),
          logKeys: logs.map(rawLogKey),
          logCount: logs.length,
          error: null,
        },
      ],
    },
    logTimes: logs.map((ref) => ({ ref, time: timeOf(Number(ref.blockNumber)) })),
    poolRegistrations,
  };
}

const input = {
  scopeId: SCOPE,
  registryScopeId: SCOPE,
  configVersion: 'c',
  assets: createAssetRegistry('ws-v1', [STOCK_A, STOCK_B, STOCK_C]),
  usdg: USDG,
  metadata: {
    version: 'ws-v1',
    chainId: 4663 as const,
    source: 'synthetic' as const,
    entries: [STOCK_A, STOCK_B, STOCK_C, USDG].map((address) => ({
      address,
      decimals: 6,
      observedAtBlock: '0',
      blockHash: hash(0),
    })),
  },
};

const QUOTE_LOG = logAt(QUOTE_POOL, QUOTE_SWAP_BLOCK, 1_000_000n, -2_000_000n);
const SELECTED_LOG = logAt(SELECTED, SELECTED_SWAP_BLOCK, 1_500_000n, -2_000_000n);
const OTHER_LOG = logAt(OTHER, OTHER_SWAP_BLOCK, 1_000_000n, -3_000_000n);

/** The three-pool chain. `pools` picks which registrations and logs the accepted batch carries. */
function seed(db: Database.Database, pools: readonly ('quote' | 'selected' | 'other')[]): void {
  const chain = {
    quote: [QUOTE_LOG, registration(QUOTE_LOG, STOCK_A, USDG)],
    selected: [SELECTED_LOG, registration(SELECTED_LOG, STOCK_A, STOCK_B)],
    other: [OTHER_LOG, registration(OTHER_LOG, STOCK_C, USDG)],
  } as const satisfies Record<string, readonly [RawLog, PersistedPoolRegistration]>;
  new SqliteRangeStore(db).acceptRange(
    batch(
      'ws-batch',
      pools.map((key) => chain[key][0]),
      pools.map((key) => chain[key][1] as PersistedPoolRegistration),
    ),
  );
}

/** The bounded options a live caller passes: the workset plus the views it was selected against. */
function live(db: Database.Database, poolIds?: ReadonlySet<string>) {
  const prepared = registryCacheFor(db, SCOPE, SCOPE).prepare();
  return poolIds === undefined
    ? { live: { historyMinutes: 180 } }
    : {
        live: {
          historyMinutes: 180,
          poolIds,
          registry: prepared.view,
          eventIndex: eventIndexFor(db, SCOPE),
        },
      };
}

const poolOfValuation = (valuation: SwapValuation): string =>
  poolRegistrationId({ pool: valuation.pool });
const activityOf = (report: ReturnType<typeof buildMetricsReport>, asset: Hex) =>
  report.rwa.find((r) => r.asset.address === asset)!.blockRangeActivity;
const sortedIds = (ids: readonly string[]) => [...ids].sort();

test('a selected report reproduces the full report for its pools from the pools that price them', () => {
  const db = fixture();
  seed(db, ['quote', 'selected', 'other']);
  const reference = fixture();
  seed(reference, ['quote', 'selected']);

  const selected = new Set([SELECTED_ID]);
  const full = buildMetricsReport(db, input, live(db));
  const partial = buildMetricsReport(db, input, live(db, selected));
  // An independent reference: the unchanged full path over a chain that holds only the two pools
  // the selection needs. The bounded path must not be compared against its own output.
  const twoPool = buildMetricsReport(reference, input, live(reference));

  expect(full.selection).toEqual({ kind: 'all' });
  expect(sortedIds(full.windows.map((w) => w.poolId))).toEqual(
    sortedIds([SELECTED_ID, QUOTE_POOL_ID, OTHER_ID]),
  );
  expect(partial.selection).toEqual({ kind: 'pools', poolIds: [SELECTED_ID] });
  expect(partial.windows).toEqual(full.windows.filter((w) => w.poolId === SELECTED_ID));
  expect(partial.windows).toEqual(twoPool.windows.filter((w) => w.poolId === SELECTED_ID));
  expect(partial.annotations).toEqual(full.annotations.filter((a) => a.poolId === SELECTED_ID));
  expect(partial.annotations).toEqual(twoPool.annotations.filter((a) => a.poolId === SELECTED_ID));
  expect(partial.valuations).toEqual(
    full.valuations.filter((v) => poolOfValuation(v) === SELECTED_ID),
  );
  expect(partial.valuations).toEqual(
    twoPool.valuations.filter((v) => poolOfValuation(v) === SELECTED_ID),
  );
  expect(partial.quotes).toEqual(twoPool.quotes);
  expect(partial.sourceHash).not.toBe(full.sourceHash);

  // The selected pool quotes nothing itself, so its price can only have come from the pool that
  // was not selected — exactly the input a bounded round is not allowed to drop.
  const valued = partial.valuations.find((v) => poolOfValuation(v) === SELECTED_ID)!;
  expect(valued.quality).toBe('usd-estimate');
  expect(valued.quoteEvidence).not.toBeNull();
  expect(valued.usdMicros).not.toBeNull();
  expect(full.valuations.find((v) => poolOfValuation(v) === SELECTED_ID)!.usdMicros).toEqual(
    valued.usdMicros,
  );
  expect(partial.valuations.some((v) => poolOfValuation(v) === QUOTE_POOL_ID)).toBe(false);
  expect(partial.valuations.some((v) => poolOfValuation(v) === OTHER_ID)).toBe(false);
  expect(partial.grossFees.map((f) => f.eventId)).toEqual([rawLogKey(SELECTED_LOG)]);

  // The stock aggregation keeps a row per watched asset and counts only what the selection covers:
  // the pool that prices the selection is an input, not a member of it.
  expect(partial.rwa.map((r) => r.asset.address)).toEqual(full.rwa.map((r) => r.asset.address));
  expect(activityOf(full, STOCK_A).swapCount).toBe(2);
  expect(activityOf(partial, STOCK_A).swapCount).toBe(1);
  expect(activityOf(full, STOCK_C).swapCount).toBe(1);
  expect(activityOf(partial, STOCK_C).swapCount).toBe(0);
  expect(sortedIds(partial.rwa.find((r) => r.asset.address === STOCK_A)!.poolIds)).toEqual([
    SELECTED_ID,
  ]);
  expect(sortedIds(partial.rwa.find((r) => r.asset.address === STOCK_C)!.poolIds)).toEqual([]);
  expect(partial.notes).toContain(
    'Selected-pool report: stock aggregates, pool counts and market totals cover only the pools named in selection, not the full catalogue.',
  );
});

test('selecting every pool reproduces the whole report and still bounds the valuation index', () => {
  const db = fixture();
  seed(db, ['quote', 'selected', 'other']);
  const all = new Set([SELECTED_ID, QUOTE_POOL_ID, OTHER_ID]);
  const full = buildMetricsReport(db, input, live(db));
  const selected = buildMetricsReport(db, input, live(db, all));

  expect(selected.selection).toEqual({ kind: 'pools', poolIds: sortedIds([...all]) });
  expect(selected.windows).toEqual(full.windows);
  expect(selected.annotations).toEqual(full.annotations);
  expect(selected.valuations).toEqual(full.valuations);
  expect(selected.quotes).toEqual(full.quotes);
  expect(selected.grossFees).toEqual(full.grossFees);
  expect(selected.rwa).toEqual(full.rwa);
  // The window is the selection, not the source hash: naming every pool is still a bounded round.
  expect(selected.sourceHash).not.toBe(full.sourceHash);
});

test('a repeated selection computes no valuation again and never touches the durable cache', () => {
  const db = fixture();
  seed(db, ['quote', 'selected', 'other']);
  const selected = new Set([SELECTED_ID]);
  const first = buildMetricsReport(db, input, live(db, selected));
  // The selection holds one swap event, so the first round had exactly one valuation to compute
  // before it could show that the second round has none.
  expect(first.valuations).toHaveLength(1);

  const durable = vi.spyOn(LiveMetricCache.prototype, 'memo');
  const counts = openWorkCounts();
  const again = buildMetricsReport(db, input, live(db, selected));
  counts.close();

  expect(counts.counts.valuationComputes).toBe(0);
  expect(durable.mock.calls.filter(([key]) => String(key).startsWith('valuation:'))).toEqual([]);
  expect(again).toEqual(first);
});

test('a window that advanced past the pool that priced the selection stops publishing its quote', () => {
  // Blocks carry their own minute here, so a second accepted range can move the window past the
  // first range's events while a later swap of the same pool stays inside it.
  const LATE_LOG = logAt(SELECTED, 200, 1_000_000n, -2_000_000n);
  const first = { number: 150n, hash: hash(150), timestampSec: 16_800 };
  const second = { number: 250n, hash: hash(250), timestampSec: 16_980 };
  const open = (database: Database.Database): SqliteRangeStore => {
    const raw = new SqliteRangeStore(database);
    raw.acceptRange(
      batch(
        'ws-one',
        [QUOTE_LOG, SELECTED_LOG],
        [registration(QUOTE_LOG, STOCK_A, USDG), registration(SELECTED_LOG, STOCK_A, STOCK_B)],
        { tip: first, timeOf: minuteTime },
      ),
    );
    return raw;
  };
  const advance = (raw: SqliteRangeStore): void => {
    raw.acceptRange(
      batch('ws-two', [LATE_LOG], [], {
        tip: second,
        previous: first,
        fromBlock: first.number + 1n,
        timeOf: minuteTime,
      }),
    );
  };
  const db = fixture();
  const raw = open(db);
  const selected = new Set([SELECTED_ID]);

  // The first round reaches back the full horizon: the quote pool is in the window and prices the
  // swap the selection reports.
  const early = buildMetricsReport(db, input, live(db, selected));
  expect(early.quotes).toHaveLength(1);
  expect(early.valuations).toHaveLength(1);
  expect(early.valuations[0]!.quoteEvidence).not.toBeNull();
  expect(early.valuations[0]!.usdMicros).not.toBeNull();

  // The second range advances the watermark by three hours, which leaves the quote at minute 6000
  // outside the read window while the swap at minute 12000 stays well inside it. The pool is then a
  // dependency of nothing, and its quote may not be published a second time.
  advance(raw);
  const advanced = buildMetricsReport(db, input, live(db, selected));

  // The full path over the same chain is the expectation, and it never saw the retired quote.
  const reference = fixture();
  const referenceRaw = open(reference);
  advance(referenceRaw);
  const full = buildMetricsReport(reference, input, live(reference));

  expect(advanced.windows.map((w) => w.poolId)).toEqual([SELECTED_ID]);
  expect(advanced.quotes).toEqual([]);
  expect(full.quotes).toEqual([]);
  expect(advanced.valuations).toEqual(full.valuations);
  expect(advanced.valuations).toHaveLength(1);
  expect(advanced.valuations[0]!.quality).toBe('unpriced');
  expect(advanced.valuations[0]!.usdMicros).toBeNull();
  expect(activityOf(advanced, STOCK_A).swapCount).toBe(1);
  const afterSecond = valuationIndexFor(db, SCOPE).size;
  expect(afterSecond).toBeGreaterThan(0);

  // A third range moves the window past the swaps the first round valued. What is held tracks the
  // window and not the rounds: the first range's entries are dropped, and what remains is one entry
  // per swap the reader still returns, per watched side of the selected pool.
  const third = { number: 350n, hash: hash(350), timestampSec: 17_300 };
  raw.acceptRange(
    batch('ws-three', [logAt(SELECTED, 300, 1_000_000n, -2_000_000n)], [], {
      tip: third,
      previous: second,
      fromBlock: second.number + 1n,
      timeOf: minuteTime,
    }),
  );
  const moved = buildMetricsReport(db, input, live(db, selected));
  expect(moved.windows.map((w) => w.poolId)).toEqual([SELECTED_ID]);
  // The reader still returns the second range's swap, so the report values two of them; the index
  // holds each of those twice, once for each watched stock the selected pool names.
  expect(moved.valuations).toHaveLength(2);
  expect(activityOf(moved, STOCK_A).swapCount).toBe(2);
  expect(valuationIndexFor(db, SCOPE).size).toBeLessThan(afterSecond);
  expect(valuationIndexFor(db, SCOPE).size).toBe(moved.valuations.length * WATCHED_SIDES);

  // A round that reads the same window again holds nothing new: this is a window, not a log.
  buildMetricsReport(db, input, live(db, selected));
  expect(valuationIndexFor(db, SCOPE).size).toBe(moved.valuations.length * WATCHED_SIDES);
});

test('a selection names no window for a pool the registry does not have', () => {
  const db = fixture();
  seed(db, ['quote', 'selected', 'other']);
  const missing = poolId(toHex(0xdead, { size: 20 }));
  const report = buildMetricsReport(db, input, live(db, new Set([missing, SELECTED_ID])));

  expect(report.selection).toEqual({ kind: 'pools', poolIds: sortedIds([missing, SELECTED_ID]) });
  expect(report.windows.map((w) => w.poolId)).toEqual([SELECTED_ID]);
  expect(report.valuations.some((v) => poolOfValuation(v) === missing)).toBe(false);
  expect(report.notes).toContain(
    'Selected-pool report: 1 of 2 requested pools are absent from the registry and contribute no window.',
  );
});
