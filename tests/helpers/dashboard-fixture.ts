import { encodeAbiParameters, encodeEventTopics, toHex, type Address, type Hex } from 'viem';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createAssetRegistry } from '../../src/registry/assets.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import {
  rawLogKey,
  type PersistedPoolRegistration,
  type RecordedRangeBatch,
} from '../../src/storage/manifest.js';
import type { RawLog } from '../../src/domain/types.js';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { LiveProjectionStore } from '../../src/storage/live-projection.js';
import {
  poolRegistrationId,
  PoolRegistry,
  type PoolRegistration,
} from '../../src/registry/pools.js';
import type { MetricCoverage } from '../../src/metrics/coverage.js';
import type { SwapValuation } from '../../src/metrics/notional.js';
import {
  buildMetricsReport,
  type MetricInput,
  type MetricsReport,
} from '../../src/storage/metric-store.js';
import { unavailableHealth } from '../../src/dashboard/snapshot.js';
import { liveWindowEnd } from '../../src/metrics/rolling.js';
import type { GenerationInput } from '../../src/dashboard/read-model.js';

export const address = (value: number): Address => toHex(value, { size: 20 });
export const hash = (value: number): Hex => toHex(value, { size: 32 });
export const blockAnchor = (block: number) => ({
  number: BigInt(block),
  hash: hash(block),
  timestampSec: block + 60,
});

export const usdg = address(3);
/** Four monitored stocks plus one that owns no pool at all. */
export const stocks = {
  a: address(0x21),
  b: address(0x22),
  c: address(0x23),
  d: address(0x24),
  e: address(0x25),
};

export type FixturePool = { index: number; token0: Address; token1: Address };

/**
 * Twelve pools: five of stock A (one with no event), four of stock B, a shared A/B pool that each
 * stock counts on its own side, three idle pools of stock D, and one recently discovered pool of
 * stock E. Stock C owns none, so its windows are `no-registered-pools`.
 */
export const POOLS: readonly FixturePool[] = [
  { index: 1, token0: stocks.a, token1: usdg },
  { index: 2, token0: stocks.a, token1: usdg },
  { index: 3, token0: stocks.a, token1: usdg },
  { index: 4, token0: stocks.a, token1: usdg },
  { index: 5, token0: stocks.b, token1: usdg },
  { index: 6, token0: stocks.b, token1: usdg },
  { index: 7, token0: stocks.b, token1: usdg },
  { index: 8, token0: stocks.a, token1: stocks.b },
  { index: 9, token0: stocks.d, token1: usdg },
  { index: 10, token0: stocks.d, token1: usdg },
  { index: 11, token0: stocks.d, token1: usdg },
  { index: 12, token0: stocks.e, token1: usdg },
];

export const poolAddress = (index: number): Address => address(0x100 + index);

export type FixtureEvent = {
  pool: number;
  block: number;
  /** Events that share a transaction index share a transaction hash. */
  tx: number;
  usdgUnits?: number;
};

const DISCOVERY_BLOCKS = new Map<number, number>([[12, 4740]]);
const AGAINST_USDG = new Set([1, 2, 3, 5, 12]);

/**
 * Every pool is discovered by its own first log; pool 12 keeps a discovery height inside the hot
 * window so one stock's long windows stay denied by its birth while its 1m window does not.
 */
export const EVENTS: readonly FixtureEvent[] = [
  ...POOLS.map((pool) => ({
    pool: pool.index,
    block: DISCOVERY_BLOCKS.get(pool.index) ?? 60,
    tx: 900 + pool.index,
    usdgUnits: 2000,
  })),
  { pool: 1, block: 4740, tx: 101, usdgUnits: 2000 },
  { pool: 1, block: 4760, tx: 102, usdgUnits: 3000 },
  { pool: 1, block: 4761, tx: 102, usdgUnits: 1000 },
  { pool: 2, block: 4762, tx: 102, usdgUnits: 4000 },
  { pool: 3, block: 4201, tx: 103, usdgUnits: 2500 },
  { pool: 5, block: 4780, tx: 104, usdgUnits: 2000 },
  // Before any USDG quote, and priced by neither side: the amount stays unknown, the count does not.
  { pool: 8, block: 4700, tx: 105 },
  { pool: 8, block: 4701, tx: 105 },
];

export function swapLog(event: FixtureEvent, logIndex: number): RawLog {
  const pool = poolAddress(event.pool);
  return {
    address: pool,
    blockNumber: BigInt(event.block),
    blockHash: hash(event.block),
    transactionHash: hash(0x9000 + event.tx),
    transactionIndex: 0,
    logIndex,
    rawBlockTimestamp: '0x0',
    topics: encodeEventTopics({
      abi: v3PoolAbi,
      eventName: 'Swap',
      args: { sender: pool, recipient: pool },
    }) as Hex[],
    data: encodeAbiParameters(
      [
        { type: 'int256' },
        { type: 'int256' },
        { type: 'uint160' },
        { type: 'uint128' },
        { type: 'int24' },
      ],
      [
        1000000n,
        -BigInt(AGAINST_USDG.has(event.pool) ? event.usdgUnits! : 2500) * 1000000n,
        2n ** 96n,
        1000n,
        0,
      ],
    ),
  };
}

/** The batch every fixture database accepts: blocks 60 through 4800, closed at chain time 4860. */
export function dashboardBatch(events: readonly FixtureEvent[] = EVENTS): RecordedRangeBatch {
  const logs = events.map(swapLog),
    poolAddresses = POOLS.map((pool) => poolAddress(pool.index)),
    byBlock = new Map<number, RawLog>();
  for (const log of logs) byBlock.set(Number(log.blockNumber), log);
  const registrationFor = (event: FixtureEvent): PersistedPoolRegistration => {
    const pool = POOLS.find((candidate) => candidate.index === event.pool)!,
      discoveredAt = byBlock.get(event.block)!;
    return {
      pool: { chainId: 4663, protocol: 'v3', address: poolAddress(pool.index) },
      token0: pool.token0,
      token1: pool.token1,
      feePips: 3000,
      tickSpacing: 60,
      hooks: address(0),
      discoveredAt,
      assetVersion: 'test',
      source: 'synthetic',
    };
  };
  return {
    id: 'fixture',
    scopeId: 's',
    fromBlock: 60n,
    toBlock: 4800n,
    end: blockAnchor(4800),
    previous: blockAnchor(4800),
    logs,
    observedAtMs: 100000,
    captureMode: 'synthetic',
    filterPlanHash: 'f',
    manifestHash: 'fixture',
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'f',
      expectedShardIds: ['one'],
      shards: [
        {
          shardId: 'one',
          filterId: 'operation-v3',
          request: { fromBlock: 60n, toBlock: 4800n, address: poolAddresses, topics: [] },
          status: 'success',
          responseHash: 'h',
          error: null,
          logKeys: logs.map(rawLogKey),
          logCount: logs.length,
        },
      ],
    },
    poolRegistrations: POOLS.map((pool) => registrationFor(discoveryEventFor(events, pool.index))),
    logTimes: logs.map((ref) => ({
      ref,
      time: {
        minuteStartSec: Math.floor((Number(ref.blockNumber) + 60) / 60) * 60,
        exactTimestampSec: Number(ref.blockNumber) + 60,
        source: 'log-verified',
      },
    })),
    boundaries: Array.from({ length: 80 }, (_, i) => {
      const timestampSec = 120 + i * 60,
        n = timestampSec - 60;
      return {
        timestampSec,
        firstBlock: BigInt(n),
        before: blockAnchor(n - 1),
        at: blockAnchor(n),
      };
    }),
  };
}

function discoveryEventFor(events: readonly FixtureEvent[], pool: number): FixtureEvent {
  const event = events.find((candidate) => candidate.pool === pool);
  if (event === undefined) throw new Error(`No fixture log discovers pool ${pool}`);
  return event;
}

export type DashboardFixture = {
  db: Database.Database;
  readonly: Database.Database;
  path: string;
  input: MetricInput;
  close(): void;
};

/**
 * A projected database over the twelve-pool fixture. `dropBoundarySec` removes one minute boundary
 * before the projection is synced, which is how a coverage hole is produced on purpose.
 */
export function openDashboardFixture(
  options: { events?: readonly FixtureEvent[]; dropBoundarySec?: number } = {},
): DashboardFixture {
  const path = join(mkdtempSync(join(tmpdir(), 'dashboard-fixture-')), 'test.sqlite'),
    db = openDatabase(path),
    events = options.events ?? EVENTS;
  new SqliteRangeStore(db).acceptRange(dashboardBatch(events));
  if (options.dropBoundarySec !== undefined)
    db.prepare('delete from minute_boundaries where scope_id = ? and timestamp_sec = ?').run(
      's',
      options.dropBoundarySec,
    );
  new LiveProjectionStore(db).sync('s', 's', 'c');
  const readonly = openDatabase(path, { readonly: true });
  return {
    db,
    readonly,
    path,
    input: {
      scopeId: 's',
      registryScopeId: 's',
      configVersion: 'c',
      assets: createAssetRegistry('test', [stocks.a, stocks.b, stocks.c, stocks.d, stocks.e]),
      usdg,
      metadata: {
        version: 'test',
        chainId: 4663 as const,
        source: 'synthetic',
        entries: [stocks.a, stocks.b, stocks.c, stocks.d, stocks.e, usdg].map((entry) => ({
          address: entry,
          decimals: 6,
          observedAtBlock: '0',
          blockHash: hash(0),
        })),
      },
    },
    close() {
      db.close();
      readonly.close();
    },
  };
}

export function metricsReport(fixture: DashboardFixture): MetricsReport {
  return buildMetricsReport(fixture.readonly, fixture.input, {
    live: { historyMinutes: 180 },
    includeAssetValuations: true,
  });
}

export function registrationsOf(fixture: DashboardFixture): readonly PoolRegistration[] {
  const raw = new SqliteRangeStore(fixture.readonly);
  return new PoolRegistry([
    ...raw.pools(fixture.input.registryScopeId),
    ...raw.pools(fixture.input.scopeId),
  ]).snapshot();
}

export type ScaleScenario = {
  registrations: readonly PoolRegistration[];
  input: GenerationInput;
  /** Pools that carry at least one swap inside the hot window. */
  activePoolIds: readonly string[];
};

/** One already-valued swap against USDG, priced by its USDG side. */
export function sampleValuation(
  pool: PoolRegistration['pool'],
  tx: number,
  exactTimestampSec: number,
): SwapValuation {
  const nth = tx % 7,
    ref = {
      blockHash: hash(4800),
      blockNumber: 4800n,
      transactionHash: hash(0x4000 + tx),
      transactionIndex: 0,
      logIndex: nth,
    };
  return {
    ref,
    eventId: rawLogKey(ref),
    time: {
      minuteStartSec: Math.floor(exactTimestampSec / 60) * 60,
      exactTimestampSec,
      source: 'log-verified',
    },
    pool,
    transactionHash: ref.transactionHash,
    nativeToken: usdg,
    nativeAmountRaw: BigInt(1000 + nth) * 1000000n,
    nativeDecimals: 6,
    nativeSide: 'token1',
    usdgNotionalRaw: BigInt(1000 + nth) * 1000000n,
    usdMicros: BigInt(1000 + nth) * 1000000n,
    pricingSide: 'usdg',
    quoteEvidence: null,
    quality: 'usdg-only',
  };
}

/**
 * The catalogue the plan sizes the dashboard against: 194 stocks, 80k pools, a bounded set of them
 * active, one 180-minute hot window. Built in memory only — no database, no catalogue read — so a
 * test can measure the summary and the page walk at the stated scale.
 */
export function scaleScenario(
  options: { pools?: number; stocks?: number; active?: number } = {},
): ScaleScenario {
  const poolCount = options.pools ?? 80000,
    stockCount = options.stocks ?? 194,
    active = options.active ?? 400,
    addresses = Array.from({ length: stockCount }, (_, i) => address(0x20000 + i)),
    registrations: PoolRegistration[] = [],
    activePoolIds: string[] = [],
    byAsset = new Map<string, SwapValuation[]>();
  for (let index = 0; index < poolCount; index++) {
    const token0 = addresses[index % stockCount]!,
      pool = {
        chainId: 4663 as const,
        protocol: 'v3' as const,
        address: address(0x100000 + index),
      },
      registration: PoolRegistration = {
        pool,
        token0,
        token1: usdg,
        feePips: 3000,
        tickSpacing: 60,
        hooks: address(0),
        discoveredAt: {
          blockHash: hash(60),
          blockNumber: 60n,
          transactionHash: hash(0x8000 + index),
          transactionIndex: 0,
          logIndex: 0,
        },
        assetVersion: 'test',
        source: 'synthetic',
      };
    registrations.push(registration);
    if (index >= active) continue;
    activePoolIds.push(poolRegistrationId(registration));
    const group = byAsset.get(token0) ?? [];
    for (let nth = 0; nth <= index % 3; nth++)
      group.push(sampleValuation(pool, index * 4 + nth, 4801 + nth * 10));
    byAsset.set(token0, group);
  }
  const coverage: MetricCoverage[] = Array.from({ length: 80 }, (_, i) => {
    const minuteStartSec = 120 + i * 60,
      complete = minuteStartSec < 4860;
    return {
      scopeId: 's',
      minuteStartSec,
      fromBlock: BigInt(minuteStartSec - 60),
      toBlock: BigInt(minuteStartSec - 1),
      complete,
      reasons: complete ? [] : ['watermark-partial'],
    };
  });
  return {
    registrations,
    activePoolIds,
    input: {
      scopeId: 's',
      registryScopeId: 's',
      configVersion: 'c',
      assetVersion: 'test',
      sourceHash: 'scale-source',
      registryRevision: 1,
      metadataRevision: 'test',
      cutoffSec: null,
      sourceChainTimeSec: 4860,
      selectedEndSec: 4860,
      availableFromSec: 120,
      nowMs: 4900000,
      status: 'ok',
      message: null,
      health: unavailableHealth(),
      notes: [],
      coverage,
      stocks: addresses.map((asset) => ({
        asset: { symbol: asset, address: asset, identityStatus: 'observed' },
        valuations: byAsset.get(asset) ?? [],
      })),
    },
  };
}

/** The generation inputs one database state produces, read exactly the way the legacy path reads. */
export function generationInput(
  fixture: DashboardFixture,
  options: {
    report?: MetricsReport;
    at?: number;
    registryRevision?: number;
    cutoffSec?: number | null;
    nowMs?: number;
    refreshing?: boolean;
    stocks?: GenerationInput['stocks'];
  } = {},
): GenerationInput {
  const report = options.report ?? metricsReport(fixture),
    watermark = report.at.timestampSec,
    last = Math.floor(watermark / 60) * 60,
    from = Math.max(
      0,
      last - 180 * 60,
      report.coverage.find((row) => row.fromBlock !== null)?.minuteStartSec ?? watermark,
    ),
    cutoffSec = options.cutoffSec ?? options.at ?? null;
  return {
    scopeId: fixture.input.scopeId,
    registryScopeId: fixture.input.registryScopeId,
    configVersion: fixture.input.configVersion,
    assetVersion: fixture.input.assets.version,
    sourceHash: report.sourceHash,
    registryRevision: options.registryRevision ?? 1,
    metadataRevision: fixture.input.metadata.version,
    cutoffSec,
    sourceChainTimeSec: watermark,
    selectedEndSec: cutoffSec ?? liveWindowEnd(watermark, from),
    availableFromSec: from,
    nowMs: options.nowMs ?? 4900000,
    status: 'ok',
    message: null,
    health: unavailableHealth(),
    notes: report.notes,
    coverage: report.coverage,
    stocks:
      options.stocks ??
      report.rwa.map((row) => ({ asset: row.asset, valuations: row.valuations ?? [] })),
    refreshing: options.refreshing ?? false,
  };
}
