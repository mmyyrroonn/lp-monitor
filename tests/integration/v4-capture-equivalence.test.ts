/**
 * E2 offline equivalence for the V4 capture experiment.
 *
 * One frozen fake chain is captured twice — once through the live default `pool-ids` strategy and
 * once through the experimental `manager` strategy — through the real record path
 * (`buildOperationFilterPlan` → `fetchBoundedLogs` → `fetchRange`) and then through the real
 * interpretation path (`resolveLogTimes` → `commitAcceptedSignalBatch` → `buildMetricsReport`).
 *
 * The provider below answers every request by filtering the fixture logs against the request it was
 * actually given: address, topic alternatives and block range. It never returns a canned array, so a
 * strategy that asked for less would receive less, and the equivalence below is a fact about the two
 * request shapes rather than about a mock that answers everything with everything.
 *
 * Nothing here reaches the network: the reader is built over an unreachable URL with an injected
 * `fetchFn`, and the whole fixture is in-process.
 */
import { afterEach, describe, expect, test } from 'vitest';
import type Database from 'better-sqlite3';
import {
  encodeAbiParameters,
  encodeEventTopics,
  toEventSelector,
  type AbiEvent,
  type Address,
  type Hex,
} from 'viem';
import { openDatabase } from '../../src/storage/database.js';
import { IncompleteRangeError } from '../../src/ingest/completeness.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { createChainReader, type ReaderOptions } from '../../src/rpc/client.js';
import { resolveLogTimes, type LogTimeResolution } from '../../src/ingest/log-time.js';
import type { RangeRecordingBatch } from '../../src/ingest/record-range.js';
import { runV4CaptureExperiment } from '../../src/ingest/v4-capture-experiment.js';
import { computeWatchScopeId } from '../../src/ingest/filter-plan.js';
import { rawLogKey, type RecordedRangeBatch } from '../../src/storage/manifest.js';
import type { BlockAnchor, ChainReader, MinuteBoundary, RawLog } from '../../src/domain/types.js';
import { encodeJson } from '../../src/domain/json.js';
import { createAssetRegistry } from '../../src/registry/assets.js';
import {
  PoolRegistry,
  poolRegistrationId,
  type PoolRegistration,
} from '../../src/registry/pools.js';
import { computeV4PoolId } from '../../src/protocols/uniswap-v4/pool-key.js';
import { v4ManagerAbi } from '../../src/protocols/uniswap-v4/abi.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { decodeSignalState } from '../../src/signals/codec.js';
import { commitAcceptedSignalBatch } from '../../src/signals/project.js';
import { buildMetricsReport } from '../../src/storage/metric-store.js';
import type { AlertRecord } from '../../src/signals/types.js';
import type { RollingWindows } from '../../src/metrics/rolling.js';

const CHAIN_ID = 4663 as const;
const ASSET_VERSION = 'e2-assets';
const zero = '0x0000000000000000000000000000000000000000' as Address;

const word = (value: number): Hex => `0x${value.toString(16).padStart(64, '0')}` as Hex;
const addr = (value: number): Address => `0x${value.toString(16).padStart(40, '0')}` as Address;

const v3Factory = addr(0x01);
const manager = addr(0x02);
/** Two watched tokens, one quote asset, and four pools over them. */
const rwaA = addr(0x31);
const rwaB = addr(0x32);
const quote = addr(0x51);

const eventTopic = (abi: readonly unknown[], name: string): Hex =>
  toEventSelector(
    (abi as readonly { type: string; name?: string }[]).find(
      (entry) => entry.type === 'event' && entry.name === name,
    ) as AbiEvent,
  );
const SWAP_TOPIC = eventTopic(v4ManagerAbi, 'Swap');

type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};
const keyA: PoolKey = { currency0: rwaA, currency1: quote, fee: 500, tickSpacing: 10, hooks: zero };
const keyB: PoolKey = {
  currency0: rwaB,
  currency1: quote,
  fee: 3_000,
  tickSpacing: 60,
  hooks: zero,
};
/** Two stocks in one pool: the pool is attributed to both assets and stays one pool. */
const keyShared: PoolKey = {
  currency0: rwaA,
  currency1: rwaB,
  fee: 3_000,
  tickSpacing: 60,
  hooks: zero,
};
/** A pool the catalogue never holds: only a manager-wide request can see it. */
const keyUnknown: PoolKey = {
  currency0: rwaB,
  currency1: quote,
  fee: 10_000,
  tickSpacing: 200,
  hooks: zero,
};
const poolIdA = computeV4PoolId(keyA);
const poolIdUnknown = computeV4PoolId(keyUnknown);

/**
 * The chain's one time convention, stated once: block n carries timestamp n + 60.
 *
 * Every anchor, boundary and log time below is read back from the provider, never assumed, so the
 * numbers the pipeline sees are the chain's own.
 */
const BLOCK_SEC = 60;
const FROM_BLOCK = 600n;
const TO_BLOCK = 4800n;
const blockTime = (block: bigint): number => Number(block) + BLOCK_SEC;
const blockHash = (block: bigint): Hex => word(Number(block));
const atBlock = (block: bigint): BlockAnchor => ({
  number: block,
  hash: blockHash(block),
  timestampSec: blockTime(block),
});
const end: BlockAnchor = atBlock(TO_BLOCK);

const assets = createAssetRegistry(ASSET_VERSION, [rwaA, rwaB]);
const deployments = { v3Factory, v4Manager: manager };
const scopeId = computeWatchScopeId(assets, 'operations', deployments);

/** The three pools the watch universe holds, named the way the registry names a pool. */
const targetKeys: readonly PoolKey[] = [keyA, keyB, keyShared];
const targetPoolIds: readonly string[] = targetKeys
  .map((key) => `${CHAIN_ID}:v4:${manager}:${computeV4PoolId(key)}`)
  .sort();

type LogSpec = {
  key: PoolKey;
  /** The minute the log is timestamped into; blocks of that minute are [minute - 60, minute - 1]. */
  minuteSec: number;
  offset: number;
  usdgUnits: number;
  /** Logs sharing this number are one transaction with several logs. */
  transaction?: number;
  logIndex?: number;
  kind?: 'swap' | 'donate' | 'initialize';
};

const blockOf = (spec: Pick<LogSpec, 'minuteSec' | 'offset'>): bigint =>
  BigInt(spec.minuteSec - BLOCK_SEC + spec.offset);

function swapLog(spec: LogSpec): RawLog {
  const block = blockOf(spec);
  const units = BigInt(spec.usdgUnits) * 1_000_000n;
  return {
    address: manager,
    blockNumber: block,
    blockHash: blockHash(block),
    transactionHash: word(100_000 + (spec.transaction ?? spec.minuteSec + spec.offset)),
    transactionIndex: 0,
    logIndex: spec.logIndex ?? spec.offset,
    rawBlockTimestamp: null,
    topics: encodeEventTopics({
      abi: v4ManagerAbi,
      eventName: 'Swap',
      args: { id: computeV4PoolId(spec.key), sender: manager },
    }) as Hex[],
    data: encodeAbiParameters(
      [
        { type: 'int128' },
        { type: 'int128' },
        { type: 'uint160' },
        { type: 'uint128' },
        { type: 'int24' },
        { type: 'uint24' },
      ],
      [-units, units, 1n << 96n, 1_000_000n, 0, spec.key.fee],
    ),
  };
}

function donateLog(spec: LogSpec): RawLog {
  const block = blockOf(spec);
  return {
    address: manager,
    blockNumber: block,
    blockHash: blockHash(block),
    transactionHash: word(200_000 + spec.minuteSec + spec.offset),
    transactionIndex: 0,
    logIndex: spec.logIndex ?? spec.offset,
    rawBlockTimestamp: null,
    topics: encodeEventTopics({
      abi: v4ManagerAbi,
      eventName: 'Donate',
      args: { id: computeV4PoolId(spec.key), sender: manager },
    }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1_000_000n, 2_000_000n]),
  };
}

/**
 * A manager `Initialize`. Its two currency topics are what makes the two V4 discovery requests
 * overlap: a pool whose currencies are both watched is returned by each of them.
 */
function initializeLog(spec: LogSpec): RawLog {
  const block = blockOf(spec);
  return {
    address: manager,
    blockNumber: block,
    blockHash: blockHash(block),
    transactionHash: word(300_000 + spec.minuteSec + spec.offset),
    transactionIndex: 0,
    logIndex: spec.logIndex ?? spec.offset,
    rawBlockTimestamp: null,
    topics: encodeEventTopics({
      abi: v4ManagerAbi,
      eventName: 'Initialize',
      args: {
        id: computeV4PoolId(spec.key),
        currency0: spec.key.currency0,
        currency1: spec.key.currency1,
      },
    }) as Hex[],
    data: encodeAbiParameters(
      [
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
        { type: 'uint160' },
        { type: 'int24' },
      ],
      [spec.key.fee, spec.key.tickSpacing, spec.key.hooks, 1n << 96n, 0],
    ),
  };
}

const rawLogFor = (spec: LogSpec): RawLog =>
  spec.kind === 'donate'
    ? donateLog(spec)
    : spec.kind === 'initialize'
      ? initializeLog(spec)
      : swapLog(spec);

/**
 * The chain the equivalence stages are captured from.
 *
 * Background trades every five minutes give every pool closed windows to baseline against. The grid
 * is a real minute grid that avoids the four rolling-window edges (1260, 3960, 4560, 4800): a log
 * sitting exactly on a window's left edge has a legitimately unknown time at minute granularity,
 * and this sample is about the capture, not about that rule. `burst` adds the one hot minute poolA
 * is reminded on, and dropping it in the second stage is what withdraws that reminder.
 */
function chain(options: { burst?: boolean; unknownPool?: boolean } = {}): RawLog[] {
  const specs: LogSpec[] = [];
  // The round's own discovery: each watched pool announces itself in the batch's first minute, so
  // the catalogue the operation requests are planned from is the one this chain produced.
  targetKeys.forEach((key, index) =>
    specs.push({ key, minuteSec: 660, offset: index + 1, usdgUnits: 0, kind: 'initialize' }),
  );
  const background = [keyA, keyB, keyShared];
  let index = 0;
  for (let minuteSec = 720; minuteSec <= 4620; minuteSec += 300)
    specs.push({
      key: background[index++ % background.length]!,
      minuteSec,
      offset: 1,
      usdgUnits: 2_000,
    });
  // One transaction with two Swap logs on one pool: two log keys, one transaction hash.
  specs.push({
    key: keyA,
    minuteSec: 1500,
    offset: 1,
    usdgUnits: 2_000,
    transaction: 7,
    logIndex: 1,
  });
  specs.push({
    key: keyA,
    minuteSec: 1500,
    offset: 2,
    usdgUnits: 2_000,
    transaction: 7,
    logIndex: 2,
  });
  // A non-Swap operation family, so an over-cap response can be recovered by splitting topics.
  specs.push({ key: keyShared, minuteSec: 2100, offset: 3, usdgUnits: 0, kind: 'donate' });
  specs.push({ key: keyA, minuteSec: 2700, offset: 3, usdgUnits: 0, kind: 'donate' });
  if (options.unknownPool)
    specs.push({ key: keyUnknown, minuteSec: 3300, offset: 1, usdgUnits: 4_000 });
  if (options.burst) specs.push({ key: keyA, minuteSec: 4860, offset: 0, usdgUnits: 30_000 });
  return specs.sort((left, right) => Number(blockOf(left) - blockOf(right))).map(rawLogFor);
}

type JsonRpcRequest = { id: number; method: string; params: unknown[] };
type LogRequest = {
  fromBlock: bigint;
  toBlock: bigint;
  address: readonly string[];
  topics: readonly (string | readonly string[] | null)[];
  topicsLength: number;
};

type ProviderState = {
  /** Every JSON-RPC request the provider really dispatched, in order. */
  readonly requests: JsonRpcRequest[];
  /** The `eth_getLogs` requests, decoded. */
  readonly logRequests: LogRequest[];
  /** How many times each raw log key was returned across all responses. */
  readonly returns: Map<string, number>;
  /** The end anchor the provider currently answers with; a test may move it mid-capture. */
  endHash: Hex;
  /** Logs returned with altered content from their second response onward. */
  readonly rewritten: Set<string>;
  /** The instant the reader treats as its deadline; a test may spend it mid-capture. */
  deadlineMs: number;
};

type FakeProvider = {
  readonly reader: ChainReader;
  readonly state: ProviderState;
  /** Answer the next operation request once with 429 and no logs. */
  limitOnce(): void;
  /** Spend the reader's deadline after `count` requests have been dispatched. */
  expireDeadlineAfter(count: number): void;
  /** Move the end anchor after `count` requests have been dispatched. */
  moveEndHashAfter(count: number): void;
  /** Answer a returned log with altered content from its second response onward. */
  rewriteFromSecondResponse(log: RawLog): void;
  /** The minute boundaries this chain proves, read from the provider's own anchors. */
  boundaries(fromBlock: bigint, toBlock: bigint): Promise<readonly MinuteBoundary[]>;
};

const asLogRequest = (raw: Record<string, unknown>): LogRequest => {
  const topics = ((raw.topics ?? []) as (string | string[] | null)[]).map((topic) =>
    Array.isArray(topic)
      ? topic.map((value) => value.toLowerCase())
      : (topic?.toLowerCase() ?? null),
  );
  return {
    fromBlock: BigInt(String(raw.fromBlock)),
    toBlock: BigInt(String(raw.toBlock)),
    address: ((raw.address ?? []) as string[]).map((value) => value.toLowerCase()),
    topics,
    topicsLength: topics.length,
  };
};

/** A manager operation request, whichever strategy planned it: the manager, with several topics. */
const isOperationRequest = (request: LogRequest): boolean => {
  const topics = request.topics[0];
  return (
    request.address.length === 1 &&
    request.address[0] === manager &&
    Array.isArray(topics) &&
    topics.length > 1
  );
};

const matches = (request: LogRequest, log: RawLog): boolean =>
  log.blockNumber >= request.fromBlock &&
  log.blockNumber <= request.toBlock &&
  request.address.some((value) => value === log.address) &&
  request.topics.every((wanted, index) => {
    if (wanted === null) return true;
    const actual = log.topics[index];
    return typeof wanted === 'string' ? wanted === actual : wanted.some((t) => t === actual);
  });

/**
 * A provider over one frozen chain.
 *
 * The response to every `eth_getLogs` is `chain.filter(matches(request))`: the request's own
 * addresses, topic alternatives and block range decide what comes back. A request that asks for one
 * pool cannot receive another pool's logs, which is what makes the two strategies comparable.
 */
function fakeProvider(
  logs: readonly RawLog[],
  options: { maxRetries?: number; maxCalls?: number } = {},
): FakeProvider {
  const state: ProviderState = {
    requests: [],
    logRequests: [],
    returns: new Map(),
    endHash: blockHash(TO_BLOCK),
    rewritten: new Set(),
    deadlineMs: Number.MAX_SAFE_INTEGER,
  };
  let limitNextOperation = false;
  let dispatched = 0;
  const oneShots: { after: number; action: () => void }[] = [];
  const runOneShots = (count: number) => {
    for (const shot of oneShots.splice(0))
      if (count >= shot.after) shot.action();
      else oneShots.push(shot);
  };
  const readerOptions = {
    perSecond: 100_000,
    maxBackfillRpcRps: 100_000,
    maxConcurrentRpc: 4,
    maxRetries: options.maxRetries ?? 0,
    // The reader's own default budget is far below what resolving 70 minute boundaries costs, so
    // the fixture states its budget explicitly; the budget case is the one that lowers it.
    maxCalls: options.maxCalls ?? 1_000_000,
    // `deadlineMs` is read on every request, so a test can spend the deadline mid-capture without
    // a real clock and without waiting for one.
    get deadlineMs(): number | undefined {
      return state.deadlineMs;
    },
    fetchFn: async (_input: unknown, init?: { body?: unknown }) => {
      const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
      state.requests.push(request);
      runOneShots(++dispatched);
      const reply = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 });
      if (request.method === 'eth_getBlockByNumber') {
        const raw = String(request.params[0]);
        const number = raw === 'latest' ? TO_BLOCK : BigInt(raw);
        return reply({
          number: `0x${number.toString(16)}`,
          hash: number === TO_BLOCK ? state.endHash : blockHash(number),
          timestamp: `0x${blockTime(number).toString(16)}`,
        });
      }
      if (request.method === 'eth_getLogs') {
        const asked = asLogRequest(request.params[0] as Record<string, unknown>);
        state.logRequests.push(asked);
        if (limitNextOperation && isOperationRequest(asked)) {
          limitNextOperation = false;
          return new Response('{"error":"busy"}', { status: 429 });
        }
        return reply(
          logs
            .filter((log) => matches(asked, log))
            .map((log) => {
              const key = rawLogKey(log);
              const seen = (state.returns.get(key) ?? 0) + 1;
              state.returns.set(key, seen);
              const data =
                state.rewritten.has(key) && seen > 1 ? (`${log.data}00` as Hex) : log.data;
              return {
                address: log.address,
                topics: log.topics,
                data,
                blockNumber: `0x${log.blockNumber.toString(16)}`,
                blockHash: log.blockHash,
                transactionHash: log.transactionHash,
                transactionIndex: `0x${log.transactionIndex.toString(16)}`,
                logIndex: `0x${log.logIndex.toString(16)}`,
                blockTimestamp: null,
                removed: false,
              };
            }),
        );
      }
      throw new Error(`The offline fixture answers no ${request.method} request`);
    },
  };
  const reader = createChainReader(
    {
      httpRpcUrl: 'http://offline.invalid/rpc',
      providerAlias: 'offline-fixture',
      dataDir: 'offline',
    },
    readerOptions as unknown as ReaderOptions,
  );
  return {
    reader,
    state,
    limitOnce: () => {
      limitNextOperation = true;
    },
    expireDeadlineAfter: (count) => {
      oneShots.push({ after: count, action: () => (state.deadlineMs = 0) });
    },
    moveEndHashAfter: (count) => {
      oneShots.push({ after: count, action: () => (state.endHash = word(999_999)) });
    },
    rewriteFromSecondResponse: (log) => {
      state.rewritten.add(rawLogKey(log));
    },
    boundaries: async (fromBlock, toBlock) => {
      const rows: MinuteBoundary[] = [];
      for (let target = 660; BigInt(target) <= toBlock; target += 60) {
        const firstBlock = BigInt(target - BLOCK_SEC);
        if (firstBlock < fromBlock || firstBlock + 1n > toBlock) continue;
        rows.push({
          timestampSec: target,
          firstBlock,
          before: await reader.getAnchor(firstBlock - 1n),
          at: await reader.getAnchor(firstBlock),
        });
      }
      return rows;
    },
  };
}

type Capture = {
  readonly mode: 'pool-ids' | 'manager';
  readonly batch: RangeRecordingBatch;
  readonly result: Awaited<ReturnType<typeof runV4CaptureExperiment>>['result'];
  readonly provider: FakeProvider;
};

async function capture(
  provider: FakeProvider,
  mode: 'pool-ids' | 'manager',
  extra: Record<string, unknown> = {},
): Promise<Capture> {
  const outcome = await runV4CaptureExperiment(provider.reader, {
    fromBlock: FROM_BLOCK,
    toBlock: TO_BLOCK,
    end,
    assets,
    pools: new PoolRegistry([]),
    v3Factory,
    v4Manager: manager,
    observedAtMs: 1_000_000,
    captureMode: 'synthetic',
    // One block chunk per request: the fixture is small, and the request count then describes the
    // plan rather than the chunking.
    maxRangeBlocks: 10_000,
    v4OperationMode: mode,
    ...extra,
  } as never);
  return { mode, batch: outcome.batch, result: outcome.result, provider };
}

/** The batch as the live recorder stores it: the capture plus the minute evidence it resolved. */
function timed(batch: RecordedRangeBatch, resolution: LogTimeResolution): RecordedRangeBatch {
  return {
    ...batch,
    anchors: [batch.end, ...resolution.queriedAnchors],
    boundaries: resolution.boundaries,
    logTimes: batch.logs.map((log) => ({
      ref: log,
      time: resolution.times.get(rawLogKey(log))!,
    })),
  };
}

const metricInput = {
  scopeId,
  registryScopeId: scopeId,
  configVersion: 'e2-config',
  assets,
  usdg: quote,
  metadata: {
    version: 'e2-metadata',
    chainId: CHAIN_ID,
    source: 'synthetic',
    entries: [rwaA, rwaB, quote].map((address) => ({
      address,
      decimals: 6,
      observedAtBlock: '0',
      blockHash: word(0),
    })),
  },
};

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function newDb(): Database.Database {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}

function alertsOf(db: Database.Database): AlertRecord[] {
  return (
    db.prepare('select payload_json from alert_outbox order by sequence').all() as {
      payload_json: string;
    }[]
  ).map((row) => decodeSignalState<AlertRecord>(row.payload_json));
}

/** The alert stream as a comparable value: delivery order, identity, status and reasons. */
const alertRows = (db: Database.Database) =>
  alertsOf(db).map((alert) => ({
    kind: alert.kind,
    status: alert.status,
    revision: alert.revision,
    poolId: alert.poolId,
    logicalTimeSec: alert.logicalTimeSec ?? null,
    reasons: alert.reasons,
    ruleVersion: alert.ruleVersion,
  }));

type Report = ReturnType<typeof buildMetricsReport>;

/** One named rolling window of a row; the record is total, the lookup is what needs the check. */
const metricOf = (row: { rolling: RollingWindows }, name: keyof RollingWindows) =>
  row.rolling[name]!;

/** The four rolling windows of every pool, plus the reasons that gate them. */
const windowRows = (report: Report) =>
  [...report.windows]
    .sort((left, right) => left.poolId.localeCompare(right.poolId))
    .map((window) => ({ poolId: window.poolId, rolling: window.rolling! }));

/** Every pool's own minute rows: the interpretation at minute granularity, not only per window. */
const minuteRows = (report: Report) =>
  [...report.windows]
    .sort((left, right) => left.poolId.localeCompare(right.poolId))
    .map((window) => ({ poolId: window.poolId, minutes: window.minutes }));

const qualityRows = (report: Report) => ({
  qualityErrors: report.qualityErrors,
  coverage: report.coverage.map((minute) => ({
    minuteStartSec: minute.minuteStartSec,
    fromBlock: minute.fromBlock?.toString() ?? null,
    toBlock: minute.toBlock?.toString() ?? null,
    complete: minute.complete,
    reasons: minute.reasons,
  })),
  rwa: report.rwa.map((row) => ({ asset: row.asset, poolIds: row.poolIds, rolling: row.rolling })),
});

/** Every log key, sorted: the comparison identity of one capture. */
const keysOf = (batch: RecordedRangeBatch): readonly string[] => batch.logs.map(rawLogKey).sort();

/** The full content of every log, ordered by key: equal keys with different bytes still differ. */
const contentsOf = (batch: RecordedRangeBatch): readonly string[] =>
  batch.logs
    .map((log) => [rawLogKey(log), encodeJson(log)] as const)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([, content]) => content);

/** Commits one capture into a database, as the live recorder commits an accepted range. */
async function commitCapture(
  db: Database.Database,
  run: Capture,
  previous: BlockAnchor | null,
): Promise<Report> {
  // The minute evidence the live recorder already holds for this range, read here from the chain
  // itself: the resolution still assigns every log, it just does not have to search for it.
  const boundaries = await run.provider.boundaries(run.batch.fromBlock, run.batch.toBlock);
  const resolution = await resolveLogTimes(
    run.provider.reader,
    run.batch.logs,
    run.batch.fromBlock,
    run.batch.end,
    [],
    boundaries,
  );
  expect(resolution.failures).toEqual([]);
  expect(resolution.boundaries.length).toBeGreaterThan(0);
  commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, {
    ...timed(run.batch, resolution),
    previous,
  });
  return buildMetricsReport(db, metricInput);
}

/** One strategy's own database, committed capture by capture: the two never mix ranges. */
async function commitAlone(run: Capture, previous: BlockAnchor | null = null) {
  const db = newDb();
  return { db, report: await commitCapture(db, run, previous) };
}

describe('one frozen chain, two capture strategies', () => {
  test('both strategies capture and interpret the same target pools, same-transaction logs included', async () => {
    const stages = [
      { name: 'burst', logs: chain({ burst: true }), observedAtMs: 1_000_100 },
      { name: 'revised', logs: chain({ burst: false }), observedAtMs: 1_000_200 },
    ];
    const per: Record<string, { db: Database.Database; reports: Report[] }> = {
      'pool-ids': { db: newDb(), reports: [] },
      manager: { db: newDb(), reports: [] },
    };
    for (const stage of stages) {
      const seen: Record<string, Capture> = {};
      for (const mode of ['pool-ids', 'manager'] as const) {
        const provider = fakeProvider(stage.logs);
        const run = await capture(provider, mode, { observedAtMs: stage.observedAtMs });
        seen[mode] = run;
      }
      const forPoolIds = seen['pool-ids']!;
      const forManager = seen.manager!;

      // 1. Raw evidence: the same logs, by key and by content.
      expect(keysOf(forManager.batch)).toEqual(keysOf(forPoolIds.batch));
      expect(contentsOf(forManager.batch)).toEqual(contentsOf(forPoolIds.batch));
      expect(forManager.batch.completeness).toBe('complete');
      expect(forPoolIds.batch.completeness).toBe('complete');
      expect(forManager.result.eligibleForLive).toBe(true);
      expect(forPoolIds.result.eligibleForLive).toBe(true);
      expect(forManager.result.unknownLogKeys).toEqual([]);

      // Two logs of one transaction stay two logs: merging them would drop a log key.
      const shared = forManager.batch.logs.filter((log) => log.transactionHash === word(100_007));
      expect(shared.map((log) => log.logIndex).sort()).toEqual([1, 2]);
      expect(new Set(shared.map((log) => rawLogKey(log))).size).toBe(2);

      // 2. The requests really differed even though the answers did not: one filter plan is the
      // pool-id catalogue, the other the manager universe, and the provider answered both with the
      // same logs because the catalogue covers every operation this chain emits.
      expect(forManager.batch.filterPlanHash).not.toBe(forPoolIds.batch.filterPlanHash);
      expect(forManager.batch.manifest.expectedShardIds).not.toEqual(
        forPoolIds.batch.manifest.expectedShardIds,
      );
      expect(
        forPoolIds.provider.state.logRequests.every((request) => request.topicsLength > 1),
      ).toBe(true);
      expect(
        forManager.provider.state.logRequests.some((request) => request.topicsLength === 1),
      ).toBe(true);
      // Counts are the provider's own, taken where the response arrived.
      expect(forManager.result.requestCount).toBe(forManager.provider.state.logRequests.length);
      expect(forManager.result.responseBytes).toBe(forPoolIds.result.responseBytes);

      // 3. Interpretation: the same minute evidence, registry and metadata over both captures.
      // Each strategy owns its own database, because a manager capture reaches pools the watch
      // universe does not and its accepted ranges must never be mixed with the default scope's.
      const previous = per['pool-ids']!.reports.length === 0 ? null : end;
      for (const mode of ['pool-ids', 'manager'] as const) {
        per[mode]!.reports.push(await commitCapture(per[mode]!.db, seen[mode]!, previous));
      }
      expect(per['pool-ids']!.db.prepare('select count(*) as n from raw_logs').get()).toEqual(
        per.manager!.db.prepare('select count(*) as n from raw_logs').get(),
      );
    }

    const poolIdsReport = per['pool-ids']!.reports.at(-1)!;
    const managerReport = per.manager!.reports.at(-1)!;

    // The comparison is not "the same number of logs": the interpreted result has to agree.
    expect(windowRows(managerReport)).toEqual(windowRows(poolIdsReport));
    expect(qualityRows(managerReport)).toEqual(qualityRows(poolIdsReport));
    expect(managerReport.projectionSourceHash).toBe(poolIdsReport.projectionSourceHash);
    expect(alertRows(per.manager!.db)).toEqual(alertRows(per['pool-ids']!.db));
    // The two modes are different batches, so their identities differ even where their meaning
    // does not: everything above is compared without that identity on purpose.
    const batchIds = (db: Database.Database) => [...new Set(alertsOf(db).map((a) => a.atBatchId))];
    expect(batchIds(per.manager!.db)).toHaveLength(2);
    expect(batchIds(per['pool-ids']!.db)).toHaveLength(2);
    expect(batchIds(per.manager!.db)).not.toEqual(batchIds(per['pool-ids']!.db));

    // ...and the sample is not vacuous: every pool carries closed windows with real numbers, a
    // reminder was delivered and the second stage withdrew one.
    expect(windowRows(poolIdsReport).map((row) => row.poolId)).toEqual(targetPoolIds);
    for (const row of windowRows(poolIdsReport)) {
      expect({ pool: row.poolId, five: metricOf(row, '5m').reasons }).toEqual({
        pool: row.poolId,
        five: [],
      });
      expect({ pool: row.poolId, hour: metricOf(row, '1h').reasons }).toEqual({
        pool: row.poolId,
        hour: [],
      });
    }
    const hot = (report: Report) => windowRows(report).find((row) => row.poolId.endsWith(poolIdA))!;
    // The first stage's report carries the burst, so its numbers are a real measurement of it:
    // the hot minute is one swap, and dropping it moves the hour by exactly that swap's notional.
    expect(metricOf(hot(per['pool-ids']!.reports[0]!), '5m').swapCount).toBe(1);
    expect(metricOf(hot(per.manager!.reports[0]!), '5m').swapCount).toBe(1);
    const hourUsd = (report: Report) => metricOf(hot(report), '1h').usdMicros!;
    expect(hourUsd(per['pool-ids']!.reports[0]!) - hourUsd(poolIdsReport)).toBe(30_000_000_000n);
    expect(hourUsd(per.manager!.reports[0]!) - hourUsd(managerReport)).toBe(30_000_000_000n);
    const alerts = alertsOf(per['pool-ids']!.db);
    expect(alerts.map((alert) => alert.kind)).toEqual(['candidate', 'retracted']);
    expect(alerts[0]!.poolId.endsWith(poolIdA)).toBe(true);
    expect(alerts[0]!.reasons).toContain('candidate');
    // The withdrawal names the repaired history as its reason, and it is the same reminder:
    // same pool, same episode, one revision later, and now retracted.
    expect(alerts[1]!.reasons).toContain('source-history-revised');
    expect(alerts[1]!.poolId).toBe(alerts[0]!.poolId);
    expect(alerts[1]!.episodeId).toBe(alerts[0]!.episodeId);
    expect(alerts[1]!.revision).toBe(alerts[0]!.revision + 1);
  });

  test('a shared pool is attributed to both stocks and stays one pool in both strategies', async () => {
    const logs = chain();
    const forPoolIds = await capture(fakeProvider(logs), 'pool-ids');
    const forManager = await capture(fakeProvider(logs), 'manager');
    const left = await commitAlone(forPoolIds);
    const right = await commitAlone(forManager);
    expect(qualityRows(right.report)).toEqual(qualityRows(left.report));

    const sharedId = targetPoolIds[targetKeys.indexOf(keyShared)]!;
    const withShared = left.report.rwa.filter((row) => row.poolIds.includes(sharedId));
    expect(withShared.map((row) => row.asset.address).sort()).toEqual([rwaA, rwaB]);
    for (const row of withShared)
      expect(row.rolling['1h']!.activity?.swapCount ?? 0).toBeGreaterThan(0);
    // Two stocks, one pool: the pool is listed once per stock and never twice inside one stock.
    for (const row of left.report.rwa) expect(new Set(row.poolIds).size).toBe(row.poolIds.length);
  });

  test('an unknown pool is captured whole, listed, and kept out of the live candidate set', async () => {
    const logs = chain({ unknownPool: true });
    const unknownLog = logs.find(
      (log) => log.topics[0] === SWAP_TOPIC && log.topics[1] === poolIdUnknown,
    )!;
    const forPoolIds = await capture(fakeProvider(logs), 'pool-ids');
    const forManager = await capture(fakeProvider(logs), 'manager');

    // The manager sees a log the catalogue cannot explain; the pool-id request never asked for it.
    expect(forManager.batch.logs.map(rawLogKey)).toContain(rawLogKey(unknownLog));
    expect(forPoolIds.batch.logs.map(rawLogKey)).not.toContain(rawLogKey(unknownLog));
    expect(forManager.result.unknownLogKeys).toEqual([rawLogKey(unknownLog)]);
    expect(forManager.result.watchedLogKeys).not.toContain(rawLogKey(unknownLog));
    expect(forManager.result.eligibleForLive).toBe(false);
    expect(forManager.result.reasons).toContain('unknown-pool-logs');
    expect(forPoolIds.result.eligibleForLive).toBe(true);

    // The provider's whole answer is kept: the unknown log is counted and hashed, not filtered out.
    const shards = forManager.batch.manifest.shards.filter(
      (shard) => shard.filterId === 'operation-v4',
    );
    expect(shards.flatMap((shard) => shard.logKeys)).toContain(rawLogKey(unknownLog));
    // ...and it travels into the accepted range as raw evidence.
    const withUnknown = await commitAlone(forManager);
    expect(
      withUnknown.db
        .prepare('select count(*) as n from raw_logs where raw_key = ?')
        .pluck()
        .get(rawLogKey(unknownLog)),
    ).toBe(1);

    // The two strategies are not equivalent on this chain, and the difference is exactly the log
    // the watch universe cannot name. Its minute cannot be interpreted, so the coverage of that
    // minute fails and every window wide enough to contain it is gated: the manager capture is
    // wider evidence, not a better one, which is why it is not a live candidate.
    const clean = await commitAlone(forPoolIds);
    const unknownMinute = 3300;
    const minuteAt = (report: Report, minute: number) =>
      report.coverage.find((entry) => entry.minuteStartSec === minute);
    expect(minuteAt(clean.report, unknownMinute)?.complete).toBe(true);
    expect(minuteAt(withUnknown.report, unknownMinute)?.reasons).toEqual([
      'projection-quality-error',
    ]);
    expect(withUnknown.report.qualityErrors.length).toBeGreaterThan(
      clean.report.qualityErrors.length,
    );
    expect(
      withUnknown.report.coverage.filter((entry) => entry.minuteStartSec !== unknownMinute),
    ).toEqual(clean.report.coverage.filter((entry) => entry.minuteStartSec !== unknownMinute));

    const hour = (report: Report) =>
      windowRows(report).map((row) => [
        row.poolId,
        metricOf(row, '1h').status,
        metricOf(row, '1h').reasons,
      ]);
    for (const [, status, reasons] of hour(clean.report)) {
      expect(status).toBe('closed');
      expect(reasons).toEqual([]);
    }
    for (const [poolId, status, reasons] of hour(withUnknown.report)) {
      expect([poolId, status, reasons]).toEqual([poolId, 'gap', ['coverage-gap']]);
    }
    // The five-minute window does not reach the unexplained minute, so its own numbers are
    // untouched. What it does lose is one baseline sample: the history window that contained the
    // unexplained minute is no longer closed, so it cannot be a baseline sample any more.
    const five = (report: Report) =>
      windowRows(report).map((row) => {
        const metric = metricOf(row, '5m');
        return {
          poolId: row.poolId,
          status: metric.status,
          reasons: metric.reasons,
          swapCount: metric.swapCount,
          txCount: metric.txCount,
          usdMicros: metric.usdMicros,
          rawNotional: metric.rawNotional,
        };
      });
    expect(five(withUnknown.report)).toEqual(five(clean.report));
    const minuteStatus = (report: Report) =>
      minuteRows(report).map(
        (row) => row.minutes.find((m) => m.minuteStartSec === unknownMinute)?.status ?? null,
      );
    expect(minuteStatus(clean.report)).toEqual(['closed', 'closed', 'closed']);
    expect(minuteStatus(withUnknown.report)).not.toContain('closed');
    // A baseline sample is a closed history window, so the manager capture can only lose samples.
    const baseline = (report: Report) =>
      windowRows(report).map((row) => metricOf(row, '5m').baselineSampleCount);
    const [managerBaseline, cleanBaseline] = [baseline(withUnknown.report), baseline(clean.report)];
    managerBaseline.forEach((count, index) =>
      expect(count).toBeLessThanOrEqual(cleanBaseline[index]!),
    );
    expect(managerBaseline).not.toEqual(cleanBaseline);
    // An unexplained log is not a target-pool event: it changes no reminder.
    expect(alertRows(withUnknown.db)).toEqual(alertRows(clean.db));
  });
});

describe('provider boundaries stay visible', () => {
  test('a response at the cap is re-asked in smaller requests and only then called complete', async () => {
    const logs = [
      initializeLog({ key: keyA, minuteSec: 660, offset: 1, usdgUnits: 0 }),
      swapLog({ key: keyA, minuteSec: 1500, offset: 1, usdgUnits: 2_000 }),
      donateLog({ key: keyA, minuteSec: 2100, offset: 1, usdgUnits: 0 }),
    ];
    const control = await capture(fakeProvider(logs), 'manager');
    expect(control.batch.completeness).toBe('complete');

    const capped = await capture(fakeProvider(logs), 'manager', {
      logResponseGuard: 5_000,
      maxLogsPerResponse: 2,
    });
    expect(capped.batch.completeness).toBe('complete');
    expect(capped.result.eligibleForLive).toBe(true);
    expect(keysOf(capped.batch)).toEqual(keysOf(control.batch));
    // A response of exactly the cap is never taken as an answer on its own.
    expect(capped.result.requestCount).toBeGreaterThan(control.result.requestCount);
    expect(capped.provider.state.logRequests.filter(isOperationRequest).length).toBeGreaterThan(
      control.provider.state.logRequests.filter(isOperationRequest).length,
    );
    // The splitting really reduced the topic alternatives the provider was asked for.
    expect(
      capped.provider.state.logRequests.some(
        (request) => request.topicsLength === 1 && Array.isArray(request.topics[0]),
      ) || capped.provider.state.logRequests.some((request) => request.topicsLength === 1),
    ).toBe(true);
  });

  test('a single block that still exceeds the cap fails the capture instead of reporting it', async () => {
    const one = swapLog({ key: keyA, minuteSec: 3000, offset: 1, usdgUnits: 2_000 });
    const two = swapLog({
      key: keyA,
      minuteSec: 3000,
      offset: 1,
      usdgUnits: 3_000,
      logIndex: 2,
    });
    expect(two.blockNumber).toBe(one.blockNumber);
    const init = initializeLog({ key: keyA, minuteSec: 660, offset: 1, usdgUnits: 0 });
    const capped = await capture(fakeProvider([init, one, two]), 'manager', {
      logResponseGuard: 5_000,
      maxLogsPerResponse: 2,
    });
    expect(capped.batch.completeness).toBe('incomplete');
    expect(capped.result.eligibleForLive).toBe(false);
    expect(capped.result.reasons).toContain('incomplete-capture');
    expect(
      capped.batch.manifest.shards.some(
        (shard) => shard.status === 'truncated' && shard.error === 'range-limit',
      ),
    ).toBe(true);
    // The same block was asked for more than once: the split really happened before giving up.
    expect(capped.provider.state.logRequests.length).toBeGreaterThan(1);

    // An incomplete capture cannot become coverage: the store refuses it and holds no range.
    const db = newDb();
    const store = new SqliteRangeStore(db);
    expect(() => store.acceptRange(capped.batch)).toThrow(IncompleteRangeError);
    expect(store.acceptedTip(scopeId)).toBeNull();
    expect(capped.batch.poolRegistrations ?? []).toEqual([]);
  });

  test('a rate-limited operation request is retried and the capture still completes', async () => {
    const provider = fakeProvider(chain(), { maxRetries: 1 });
    provider.limitOnce();
    const run = await capture(provider, 'manager');
    expect(run.batch.completeness).toBe('complete');
    expect(run.result.eligibleForLive).toBe(true);
    expect(run.provider.state.logRequests.filter(isOperationRequest).length).toBeGreaterThan(1);
  });

  test('a spent RPC budget stops the operation request and is recorded as a failure', async () => {
    const control = fakeProvider(chain());
    const baseline = await capture(control, 'manager');
    expect(baseline.batch.completeness).toBe('complete');
    const budget = control.state.requests.findIndex(
      (request) =>
        request.method === 'eth_getLogs' &&
        isOperationRequest(asLogRequest(request.params[0] as Record<string, unknown>)),
    );
    expect(budget).toBeGreaterThan(0);

    const provider = fakeProvider(chain(), { maxCalls: budget });
    const run = await capture(provider, 'manager');
    expect(provider.state.requests.length).toBe(budget);
    expect(provider.state.logRequests.filter(isOperationRequest)).toEqual([]);
    expect(run.batch.completeness).toBe('incomplete');
    expect(run.result.reasons).toContain('failure:budget');
    expect(run.result.reasons).toContain('incomplete-capture');
    expect(run.result.eligibleForLive).toBe(false);
    expect(
      run.batch.manifest.shards.some(
        (shard) => shard.filterId === 'operation-v4' && shard.status === 'failed',
      ),
    ).toBe(true);
  });

  test('a deadline that runs out mid-capture stops it without any further request', async () => {
    const provider = fakeProvider(chain());
    // Four discovery requests, then the deadline is spent: nothing after it reaches the provider.
    provider.expireDeadlineAfter(4);
    const run = await capture(provider, 'manager');
    expect(provider.state.requests.length).toBe(4);
    expect(provider.state.logRequests.filter(isOperationRequest)).toEqual([]);
    expect(run.batch.completeness).toBe('incomplete');
    expect(run.result.reasons).toContain('failure:deadline');
    expect(run.result.eligibleForLive).toBe(false);
  });

  test('the same log key returned twice with different content is a conflict, not a duplicate', async () => {
    // Both of the shared pool's currencies are watched, so its Initialize is returned by both V4
    // discovery requests. Returning different bytes for it is a conflict the batch must refuse.
    const init = initializeLog({ key: keyShared, minuteSec: 1500, offset: 1, usdgUnits: 0 });
    const provider = fakeProvider([init]);
    provider.rewriteFromSecondResponse(init);
    const run = await capture(provider, 'manager');
    expect(provider.state.returns.get(rawLogKey(init))).toBeGreaterThan(1);
    expect(run.batch.completeness).toBe('incomplete');
    expect(run.batch.recordingErrors.some((error) => error.startsWith('conflicting-log:'))).toBe(
      true,
    );
    expect(run.batch.recordingFailureKinds).toContain('conflicting-log-identity');
    expect(run.result.eligibleForLive).toBe(false);

    // The same chain read twice with the same bytes stays one log, not a conflict and not a copy.
    const stable = await capture(fakeProvider([init]), 'manager');
    expect(stable.provider.state.returns.get(rawLogKey(init))).toBeGreaterThan(1);
    expect(stable.batch.completeness).toBe('complete');
    expect(stable.batch.logs).toHaveLength(1);
  });

  test('an end anchor that moves under the capture is an anchor failure, not a complete range', async () => {
    const provider = fakeProvider(chain());
    // The tip moves once the logs are in hand, which is what a reorg at the tip looks like to a
    // capture that re-reads its end anchor before accepting the range.
    provider.moveEndHashAfter(4);
    const run = await capture(provider, 'manager');
    expect(run.batch.completeness).toBe('incomplete');
    expect(run.batch.recordingErrors).toContain('end-anchor-changed');
    expect(run.batch.recordingFailureKinds).toContain('anchor-changed');
    expect(run.result.reasons).toContain('failure:anchor-changed');
    expect(run.result.eligibleForLive).toBe(false);
  });
});
