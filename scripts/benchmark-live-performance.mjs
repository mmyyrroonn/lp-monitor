// End-to-end live-runtime scale benchmark for the 2026-09-15 performance review.
//
// The measured rounds run the real pipeline: `fetchRange` plans its requests from the real filter
// plan, the real decoders turn the responses into events, `saveRaw` stores the raw transport,
// `resolveLogTimes` resolves the chain time of every log the batch carries, and
// `commitAcceptedSignalBatch` writes the accepted range, the projection, the windows, the
// valuations and the signals in one transaction. The registry cache, the metadata queue and its
// worker, and the dashboard snapshot coordinator are the shipped ones. Only the network boundary is
// mocked: a `fetch` that answers the JSON-RPC methods the reader is allowed to use from a synthetic
// chain held in memory. No RPC request leaves this process, no run database is opened and no `.env`
// or `config/` file is read.
//
// Usage:
//   pnpm exec tsx scripts/benchmark-live-performance.mjs --pools 80000 --active 400 \
//     --iterations 20 --out artifacts/performance/80k
//
// `--iterations` counts the normal samples only. The three warm-up rounds and the three repair
// rounds are always extra, and are reported apart from the normal batch.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, freemem, loadavg, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { encodeAbiParameters, encodeEventTopics, toEventSelector, toHex } from 'viem';
import { buildOperationShardFilters, computeWatchScopeId } from '../src/ingest/filter-plan.js';
import { resolveLogTimes } from '../src/ingest/log-time.js';
import { OperationFilterIndex } from '../src/ingest/operation-filter-index.js';
import { fetchRange } from '../src/ingest/record-range.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { createSnapshotCoordinator } from '../src/dashboard/snapshot-coordinator.js';
import { AlertOutbox } from '../src/notify/outbox.js';
import { BatchTimings } from '../src/ops/batch-timings.js';
import { saveJson } from '../src/ops/files.js';
import { createMetadataWorker } from '../src/ops/metadata-worker.js';
import { openWorkCounts, WORK_COUNTER_KEYS } from '../src/ops/work-counters.js';
import { computeV4PoolId } from '../src/protocols/uniswap-v4/pool-key.js';
import { createAssetRegistry } from '../src/registry/assets.js';
import { createChainReader } from '../src/rpc/client.js';
import { initialSignalConfig } from '../src/signals/config.js';
import { commitAcceptedSignalBatch, retractSignals } from '../src/signals/project.js';
import { openDatabase } from '../src/storage/database.js';
import { LiveProjectionStore } from '../src/storage/live-projection.js';
import { rawLogKey } from '../src/storage/manifest.js';
import { metadataQueueFor } from '../src/storage/metadata-queue.js';
import { registryCacheFor } from '../src/storage/registry-cache.js';
import { SqliteRangeStore } from '../src/storage/raw-store.js';
import { applyMetadataLookup, enqueueTokenMetadata } from '../src/storage/token-metadata.js';
import { v3PoolAbi } from '../src/protocols/uniswap-v3/abi.js';
import { v4ManagerAbi } from '../src/protocols/uniswap-v4/abi.js';
import {
  SCALE_CHAIN_ID,
  SCALE_MANAGER,
  SCALE_USDG,
  SCALE_WATERMARK_BLOCK,
  SCALE_WATERMARK_SEC,
  makeScaleData,
  scaleAssetAddress,
} from '../tests/helpers/live-scale-fixture.js';

const USAGE =
  'Usage: pnpm exec tsx scripts/benchmark-live-performance.mjs --pools N --active N ' +
  '[--iterations N] [--assets N] [--history-minutes N] --out DIR';

/**
 * The thresholds the measured rounds are planned with. They mirror the shipped
 * `config/robinhood.json` values (maxRangeBlocks, logResponseGuard, overlapBlocks) so a round plans
 * the requests production plans; the file itself is never read, because a benchmark that depends on
 * one deployment's configuration is not reproducible.
 */
const THRESHOLDS = {
  maxRangeBlocks: 1000n,
  logResponseGuard: 5000,
  maxLogsPerResponse: null,
  maxFilterValues: 1000,
  overlapBlocks: 20,
};

const SECONDS_PER_BLOCK = 12;
const BLOCKS_PER_MINUTE = 5;
/** One minute of chain per round: the granularity the window rules are written in. */
const BLOCKS_PER_ROUND = 5;
const WARMUP_ROUNDS = 3;
/** Always extra, always reported on their own: new dependency, metadata repair, history revision. */
const REPAIR_KINDS = ['new-registration-first-swap', 'metadata-backfill', 'history-revision'];
const V3_FACTORY = `0x${'f0'.repeat(20)}`;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const SENDER = `0x${'aa'.repeat(20)}`;
/**
 * Which watchlist asset the repair round's pool is keyed against. A pool is discovered by the
 * asset side of its key, so a pool the discovery plan would never ask about is not a pool a
 * discovery round can find; the odd index is what leaves its decimals for the metadata queue.
 */
const REPAIR_POOL_ASSET = 1;
const PROGRESS_PREFIX = 'benchmark ';

// ---------------------------------------------------------------------------------------------
// Pure helpers: the contract the report is read under.
// ---------------------------------------------------------------------------------------------

/**
 * The documented percentile: sort ascending, take `values[Math.ceil(fraction * n) - 1]`.
 *
 * Deliberately an order statistic of the ascending samples rather than an interpolation or the best
 * of them, so the number a reader checks against the published raw samples is reproducible by hand.
 * @param {readonly number[]} values
 * @param {number} fraction
 * @returns {number | null}
 */
export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ascending = [...values].sort((left, right) => left - right);
  return (
    ascending[Math.min(ascending.length - 1, Math.ceil(fraction * ascending.length) - 1)] ?? null
  );
}

/**
 * How `--iterations` normal samples are spent: 70% new events, and what is left split evenly
 * between watermark-only advances and repeated events. The rounding difference goes to the new
 * events, which is why that share is rounded up and not down.
 * @param {number} iterations
 */
export function allocateNormalSamples(iterations) {
  const fresh = Math.ceil(iterations * 0.7);
  const remainder = iterations - fresh;
  const advance = Math.floor(remainder / 2);
  const repeat = remainder - advance;
  return {
    iterations,
    fresh,
    advance,
    repeat,
    normalTotal: fresh + advance + repeat,
    repairTotal: REPAIR_KINDS.length,
  };
}

/** The wall-clock second a block was mined at, in the synthetic chain's own time. */
function blockTimestampSec(blockNumber) {
  return SCALE_WATERMARK_SEC - Number(SCALE_WATERMARK_BLOCK - blockNumber) * SECONDS_PER_BLOCK;
}

/** The minute a block belongs to. Every minute of this chain starts exactly on a block. */
function blockMinuteStartSec(blockNumber) {
  return Math.floor(blockTimestampSec(blockNumber) / 60) * 60;
}

/** A deterministic block hash: one history per branch, and one branch per fork depth. */
function chainHash(blockNumber, branch = 0) {
  return toHex(BigInt(blockNumber) + 1_000_000_000n + BigInt(branch) * 100_000_000n, { size: 32 });
}

/** The batch payload's own byte length, encoded the way the store encodes it before storing it. */
function transportBytes(value) {
  return Buffer.byteLength(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString(10) : item)),
    'utf8',
  );
}

function round3(value) {
  return value === null || value === undefined ? null : Math.round(value * 1000) / 1000;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Per-field p50/p95 over the samples, so one report answers for the middle and for the tail. */
function distribution(values, unit = 'Ms') {
  return {
    count: values.length,
    [`p50${unit}`]: round3(percentile(values, 0.5)),
    [`p95${unit}`]: round3(percentile(values, 0.95)),
    [`max${unit}`]: values.length === 0 ? null : round3(Math.max(...values)),
  };
}

/** The same distribution for sizes, in bytes rather than milliseconds. */
function bytesDistribution(values) {
  return distribution(values, 'Bytes');
}

function elapsedMs(since) {
  return Number(process.hrtime.bigint() - since) / 1e6;
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}

// ---------------------------------------------------------------------------------------------
// Command line.
// ---------------------------------------------------------------------------------------------

function readInteger(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  if (index < 0) {
    if (fallback === undefined) throw new Error(`Missing ${flag}\n${USAGE}`);
    return fallback;
  }
  const raw = argv[index + 1];
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${flag} must be a positive integer (received ${raw})\n${USAGE}`);
  return value;
}

/**
 * The options one run is started with; a bad one is refused before anything is opened.
 * @param {readonly string[]} argv
 */
export function parseBenchmarkOptions(argv) {
  const index = argv.indexOf('--out');
  const out = index < 0 ? undefined : argv[index + 1];
  if (out === undefined || out.length === 0) throw new Error(`Missing --out\n${USAGE}`);
  const options = {
    pools: readInteger(argv, '--pools'),
    active: readInteger(argv, '--active'),
    iterations: readInteger(argv, '--iterations', 20),
    assetCount: readInteger(argv, '--assets', 194),
    historyMinutes: readInteger(argv, '--history-minutes', 180),
    out: resolve(out),
  };
  if (options.active > options.pools) throw new Error('--active must not exceed --pools');
  if (options.assetCount < 2) throw new Error('--assets must cover the stock co-pool');
  if (options.historyMinutes < 2) throw new Error('--history-minutes must leave a covered window');
  if (existsSync(options.out))
    throw new Error(`Output directory already exists: ${options.out}. Choose a new directory.`);
  return options;
}

// ---------------------------------------------------------------------------------------------
// The synthetic chain: the one mocked boundary.
// ---------------------------------------------------------------------------------------------

/** The pool key the repair round's discovery event registers: a fresh asset against the quote. */
function repairPoolKey() {
  return {
    currency0: scaleAssetAddress(REPAIR_POOL_ASSET),
    currency1: SCALE_USDG,
    fee: 3000,
    tickSpacing: 60,
    hooks: ZERO_ADDRESS,
  };
}

/**
 * The JSON-RPC surface of the mocked chain.
 *
 * It answers exactly the read-only methods the reader may call, filters `eth_getLogs` by the
 * request's own block range, addresses and topics — the reader re-checks all three, so a laxer mock
 * would fail rather than pass — and derives block time arithmetically, so a minute-boundary search
 * converges on the same answer every time. `served` is what the chain currently holds: the driver
 * appends a round's logs to it, and an overlapping round is served the same logs again, which is
 * what makes a repeat round a repeat rather than a second invention.
 */
function createScaleChain() {
  /** @type {{head: bigint, branch: number, forkAfter: bigint | null, served: any[], requests: {getLogs: number, getAnchor: number, call: number}}} */
  const chain = {
    head: SCALE_WATERMARK_BLOCK,
    branch: 0,
    // Blocks after this one are served from the current branch; null disables forking.
    forkAfter: null,
    served: [],
    requests: { getLogs: 0, getAnchor: 0, call: 0 },
  };
  const branchFor = (blockNumber) =>
    chain.forkAfter !== null && blockNumber > chain.forkAfter ? chain.branch : 0;
  const wireLog = (log) => ({
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: toHex(log.blockNumber),
    blockHash: chainHash(log.blockNumber, branchFor(log.blockNumber)),
    transactionHash: log.transactionHash,
    transactionIndex: toHex(log.transactionIndex),
    logIndex: toHex(log.logIndex),
    blockTimestamp: null,
    removed: false,
  });
  const topicsMatch = (wanted, actual) =>
    wanted === null ||
    wanted === undefined ||
    (Array.isArray(wanted) ? wanted : [wanted]).some(
      (candidate) => String(candidate).toLowerCase() === String(actual ?? '').toLowerCase(),
    );
  const transport = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    const [arg, second] = request.params;
    let result;
    switch (request.method) {
      case 'eth_chainId':
        result = toHex(SCALE_CHAIN_ID);
        break;
      case 'eth_getBlockByNumber': {
        chain.requests.getAnchor += 1;
        const number = arg === 'latest' ? chain.head : BigInt(arg);
        result = {
          number: toHex(number),
          hash: chainHash(number, branchFor(number)),
          timestamp: toHex(blockTimestampSec(number)),
        };
        break;
      }
      case 'eth_getCode':
        result = second !== undefined && BigInt(second) > 0n ? '0x6000' : '0x';
        break;
      case 'eth_call': {
        chain.requests.call += 1;
        // `decimals()` for any address, so the metadata queue always resolves what a round demands.
        result =
          String(arg.data).toLowerCase() === '0x313ce567'
            ? encodeAbiParameters([{ type: 'uint256' }], [arg.to === SCALE_USDG ? 6n : 18n])
            : '0x';
        break;
      }
      case 'eth_getLogs': {
        chain.requests.getLogs += 1;
        const filter = arg;
        const from = BigInt(filter.fromBlock);
        const to = BigInt(filter.toBlock);
        const addresses = new Set((filter.address ?? []).map((item) => String(item).toLowerCase()));
        result = chain.served
          .filter(
            (log) =>
              log.blockNumber >= from &&
              log.blockNumber <= to &&
              addresses.has(log.address.toLowerCase()) &&
              (filter.topics ?? []).every((wanted, index) =>
                topicsMatch(wanted, log.topics[index]),
              ),
          )
          .map(wireLog);
        break;
      }
      default:
        throw new Error(`Mock chain received an unreachable method: ${request.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  };
  return { chain, transport };
}

/**
 * The reader the rounds are measured against: the real client over the mocked transport.
 *
 * Pacing, concurrency and the call budget are stated rather than tuned: the mock answers instantly,
 * so leaving production pacing in place would measure the mock's queue instead of the pipeline.
 * What production uses stays what `config/robinhood.json` says; the report names this boundary.
 */
function createScaleReader(transport) {
  /** @type {any} */
  const env = {
    httpRpcUrl: 'http://mock.invalid/',
    providerAlias: 'mock',
    chainId: SCALE_CHAIN_ID,
  };
  return createChainReader(env, {
    fetchFn: transport,
    maxCalls: null,
    perSecond: Number.MAX_SAFE_INTEGER,
    maxBackfillRpcRps: Number.MAX_SAFE_INTEGER,
    maxConcurrentRpc: Number.MAX_SAFE_INTEGER,
    maxRetries: 0,
    evidenceMode: 'off',
  });
}

/** A reader that adds up the wall clock spent inside the mocked transport. */
function countingReader(reader, accumulator) {
  const timed = async (work) => {
    const started = Date.now();
    try {
      return await work();
    } finally {
      accumulator.value += Date.now() - started;
    }
  };
  return new Proxy(reader, {
    get(target, property, receiver) {
      if (property === 'getAnchor') return async (block) => timed(() => target.getAnchor(block));
      if (property === 'getLogs') return async (filter) => timed(() => target.getLogs(filter));
      if (property === 'request')
        return async (method, params) => timed(() => target.request(method, params));
      return Reflect.get(target, property, receiver);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Raw log encoding: canonical for the decoders that read it back.
// ---------------------------------------------------------------------------------------------

const eventTopic = (abi, name) =>
  toEventSelector(abi.find((entry) => entry.type === 'event' && entry.name === name));

// The fixture states its own literal ABI shapes; these two keep the encoders' argument types out of
// the way of a script that only has to be right at runtime and in the report's own contract.
const encodeTopics = (abi, eventName, args) => encodeEventTopics({ abi, eventName, args });
const encodeData = (types, values) => encodeAbiParameters(types, values);

/**
 * A V4 manager `Swap` for one pool. The literal is a transport log rather than a decoded one, so it
 * is left untyped here and checked by the decoder that reads it back.
 * @returns {any}
 */
function v4SwapLog(registration, blockNumber, txHash, logIndex, amount) {
  return {
    address: registration.pool.manager.toLowerCase(),
    topics: encodeTopics(v4ManagerAbi, 'Swap', { id: registration.pool.poolId, sender: SENDER }),
    data: encodeData(
      [
        { type: 'int128' },
        { type: 'int128' },
        { type: 'uint160' },
        { type: 'uint128' },
        { type: 'int24' },
        { type: 'uint24' },
      ],
      [amount, -amount, 2n ** 96n, 1_000_000n, 0, 3000],
    ),
    blockNumber,
    transactionHash: txHash,
    transactionIndex: 0,
    logIndex,
    rawBlockTimestamp: null,
  };
}

/**
 * A V3 pool `Swap` for one pool.
 * @returns {any}
 */
function v3SwapLog(registration, blockNumber, txHash, logIndex, amount) {
  return {
    address: registration.pool.address.toLowerCase(),
    topics: encodeTopics(v3PoolAbi, 'Swap', { sender: SENDER, recipient: SENDER }),
    data: encodeData(
      [
        { type: 'int256' },
        { type: 'int256' },
        { type: 'uint160' },
        { type: 'uint128' },
        { type: 'int24' },
      ],
      [amount, -amount, 2n ** 96n, 1_000_000n, 0],
    ),
    blockNumber,
    transactionHash: txHash,
    transactionIndex: 0,
    logIndex,
    rawBlockTimestamp: null,
  };
}

/**
 * A V4 manager `Initialize` whose PoolId the discovery decoder re-derives from the key itself.
 * @returns {any}
 */
function v4InitializeLog(key, poolId, blockNumber, txHash, logIndex) {
  return {
    address: SCALE_MANAGER,
    topics: encodeTopics(v4ManagerAbi, 'Initialize', {
      id: poolId,
      currency0: key.currency0,
      currency1: key.currency1,
    }),
    data: encodeData(
      [
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
        { type: 'uint160' },
        { type: 'int24' },
      ],
      [key.fee, key.tickSpacing, key.hooks, 2n ** 96n, 0],
    ),
    blockNumber,
    transactionHash: txHash,
    transactionIndex: 0,
    logIndex,
    rawBlockTimestamp: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Fixture initialization: the A1 scale catalogue and the covered window.
// ---------------------------------------------------------------------------------------------

/**
 * The raw log a registration's discovery reference points at, so the store holds its evidence.
 * @returns {any}
 */
function discoveryLog(registration) {
  return {
    address:
      registration.pool.protocol === 'v3' ? V3_FACTORY : registration.pool.manager.toLowerCase(),
    blockNumber: registration.discoveredAt.blockNumber,
    blockHash: registration.discoveredAt.blockHash,
    transactionHash: registration.discoveredAt.transactionHash,
    transactionIndex: registration.discoveredAt.transactionIndex,
    logIndex: registration.discoveredAt.logIndex,
    topics: [],
    data: '0x',
    rawBlockTimestamp: null,
  };
}

/**
 * The catalogue batch: every registration plus the discovery evidence it points at.
 *
 * This is the A1 fixture written through the real store — `saveRaw` then `acceptRange` — so the
 * registry the rounds are planned and decoded against is the registry the store holds rather than
 * an array passed around beside it. It is synthetic in the one way a fixture has to be: it states
 * the registrations it found instead of having decoded them from a provider response.
 * @returns {any}
 */
function catalogueBatch(registrations, watermark, boundaries) {
  const logs = registrations.map(discoveryLog);
  const fromBlock = registrations.reduce(
    (lowest, registration) =>
      registration.discoveredAt.blockNumber < lowest
        ? registration.discoveredAt.blockNumber
        : lowest,
    registrations[0].discoveredAt.blockNumber,
  );
  const keysFor = (predicate) => logs.filter(predicate).map((log) => rawLogKey(log));
  const v4Keys = keysFor((log) => log.address.toLowerCase() === SCALE_MANAGER);
  const v3Keys = keysFor((log) => log.address.toLowerCase() !== SCALE_MANAGER);
  const shard = (shardId, filterId, address, keys) => ({
    shardId,
    filterId,
    request: { fromBlock, toBlock: watermark.number, address: [address], topics: [] },
    status: 'success',
    responseHash: 'scale-catalogue',
    error: null,
    logKeys: keys,
    logCount: keys.length,
  });
  const shards = [];
  if (v4Keys.length > 0) shards.push(shard('catalogue-v4', 'discovery-v4', SCALE_MANAGER, v4Keys));
  if (v3Keys.length > 0) shards.push(shard('catalogue-v3', 'discovery-v3', V3_FACTORY, v3Keys));
  return {
    id: 'scale-catalogue',
    scopeId: '',
    fromBlock,
    toBlock: watermark.number,
    end: watermark,
    previous: null,
    logs,
    observedAtMs: 0,
    captureMode: 'synthetic',
    filterPlanHash: 'scale-catalogue',
    manifestHash: 'scale-catalogue',
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'scale-catalogue-v1',
      expectedShardIds: shards.map((entry) => entry.shardId),
      shards,
    },
    poolRegistrations: registrations,
    // Every discovery log is placed in the minute its own block belongs to, so the window rules
    // read the fixture's own evidence instead of an unresolved time.
    logTimes: logs.map((log) => ({
      ref: log,
      time: {
        minuteStartSec: blockMinuteStartSec(log.blockNumber),
        exactTimestampSec: null,
        source: 'minute-boundary',
      },
    })),
    anchors: [watermark],
    boundaries,
  };
}

/** The minute boundaries of the covered window, plus the margin a live horizon looks back over. */
function windowBoundaries(historyMinutes, marginMinutes) {
  const boundaries = [];
  for (let minute = 0; minute <= historyMinutes + marginMinutes; minute += 1) {
    const firstBlock = SCALE_WATERMARK_BLOCK - BigInt(minute * BLOCKS_PER_MINUTE);
    const timestampSec = SCALE_WATERMARK_SEC - minute * 60;
    if (timestampSec <= 0 || firstBlock <= 1n) continue;
    boundaries.push({
      timestampSec,
      firstBlock,
      before: {
        number: firstBlock - 1n,
        hash: chainHash(firstBlock - 1n),
        timestampSec: timestampSec - SECONDS_PER_BLOCK,
      },
      at: { number: firstBlock, hash: chainHash(firstBlock), timestampSec },
    });
  }
  return boundaries;
}

// ---------------------------------------------------------------------------------------------
// The measured round: the shipped batch path, minus the follow loop that decides the ranges.
// ---------------------------------------------------------------------------------------------

/**
 * One accepted round, start to finish.
 *
 * The order is the recorder's own: prepare the registry view this batch is planned and decoded
 * against, fetch the range, store the raw transport, resolve the chain time of every log the batch
 * carries, write the artifact, demand the token metadata the batch could not price, commit the
 * accepted range and everything derived from it in one transaction, then drain the alert outbox.
 * The registry view and the filter templates are settled on every path out of the round.
 */
async function runRound(state, spec) {
  const { reader, store, db, metricInput, signalConfig, scopeId, assets } = state;
  const startedAtMs = Date.now();
  const chain = state.chain;
  const end = {
    number: spec.toBlock,
    hash: chainHash(spec.toBlock, chainBranchFor(chain, spec.toBlock)),
    timestampSec: blockTimestampSec(spec.toBlock),
  };
  const timings = new BatchTimings();
  const work = openWorkCounts();
  const prepared = registryCacheFor(db, metricInput.registryScopeId, scopeId).prepare();
  const network = { value: 0 };
  const timedReader = countingReader(reader, network);
  try {
    const acquisitionAtMs = Date.now();
    const batch = await timings.measureAsync('rpcAcquisition', () =>
      reader.meter.withPurpose('logs', () =>
        fetchRange(
          timedReader,
          /** @type {any} */ ({
            mode: 'operations',
            fromBlock: spec.fromBlock,
            toBlock: spec.toBlock,
            end,
            previous: spec.previous,
            assets,
            registry: prepared,
            operationFilters: state.operationFilters,
            v3Factory: V3_FACTORY,
            v4Manager: SCALE_MANAGER,
            logResponseGuard: THRESHOLDS.logResponseGuard,
            maxLogsPerResponse: THRESHOLDS.maxLogsPerResponse,
            maxFilterValues: THRESHOLDS.maxFilterValues,
            maxRangeBlocks: THRESHOLDS.maxRangeBlocks,
            observedAtMs: Date.now(),
            captureMode: spec.captureMode,
          }),
        ),
      ),
    );
    // The local window opens here: the provider's answers are complete, and everything from this
    // instant to the commit being durable is this process's own work.
    const rpcResultsAtMs = Date.now();
    if (batch.completeness !== 'complete')
      throw new Error(
        `Round ${spec.label} recorded an incomplete range: ${batch.recordingErrors.join(', ')}`,
      );
    timings.measure('rawPersist', () => store.saveRaw(batch, { compact: true }));
    const timeContext = timings.measure('coverage', () =>
      store.liveTimeContext(scopeId, spec.fromBlock, end, state.liveTimeHistoryMinutes),
    );
    const allLogs = [
      ...new Map(
        [...timeContext.unresolved, ...batch.logs].map((log) => [rawLogKey(log), log]),
      ).values(),
    ];
    const timeFrom = allLogs.reduce(
      (lowest, log) => (log.blockNumber < lowest ? log.blockNumber : lowest),
      timeContext.retryFromBlock,
    );
    const networkBefore = network.value;
    const resolution = await timings.measureAsync('coverage', () =>
      resolveLogTimes(
        timedReader,
        allLogs,
        timeFrom,
        end,
        timeContext.anchors,
        timeContext.boundaries,
      ),
    );
    const networkWaitMsAfterFetch = network.value - networkBefore;
    const timed = {
      ...batch,
      anchors: [end, ...resolution.queriedAnchors],
      boundaries: resolution.boundaries,
      logTimes: allLogs.map((log) => ({ ref: log, time: resolution.times.get(rawLogKey(log)) })),
    };
    timings.measure('artifactPersist', () =>
      saveJson(
        resolve(state.artifactDirectory, `range-${batch.id}.json`),
        timed,
        state.artifactDirectory,
      ),
    );
    if (
      timed.logTimes.some((entry) => entry.time === undefined || entry.time.source === 'unresolved')
    )
      throw new Error(`Round ${spec.label} left an event without a resolved minute`);

    demandMetadata(state, timed);
    await reader.flush?.();
    prepared.stage(timed.poolRegistrations ?? []);
    const drain = state.metadataWorker.prepareDrain();
    const metadataCounts = { resolved: 0, failed: 0, stale: 0 };
    let changes;
    try {
      changes = commitAcceptedSignalBatch(db, metricInput, signalConfig, timed, {
        timings,
        registry: prepared,
        applyMetadata: () =>
          Object.assign(metadataCounts, storeReadyMetadata(state, drain.results)),
      }).changes;
    } catch (error) {
      drain.rollback();
      throw error;
    }
    drain.ack();
    state.metadataApplied.resolved += metadataCounts.resolved;
    state.metadataApplied.failed += metadataCounts.failed;
    state.metadataApplied.stale += metadataCounts.stale;
    prepared.publish();
    state.operationFilters.publish();
    const fatal = state.metadataWorker.fatalError();
    if (fatal !== null) throw fatal;
    const commitDoneAtMs = Date.now();
    await timings.measureAsync('notify', () =>
      state.outbox.deliverPending(async () => {
        state.alertsDelivered += 1;
      }, scopeId),
    );
    return {
      spec,
      startedAtMs,
      acquisitionAtMs,
      rpcResultsAtMs,
      commitDoneAtMs,
      totalMs: commitDoneAtMs - startedAtMs,
      rpcAcquisitionMs: rpcResultsAtMs - acquisitionAtMs,
      // From the provider's answers being complete to the accepted transaction being durable:
      // storing the raw batch, deriving the state, finishing the artifact and committing it.
      localProcessingMs: commitDoneAtMs - rpcResultsAtMs,
      networkWaitMsAfterFetch,
      stageMs: timings.snapshot(),
      counts: { ...work.counts },
      changes,
      batch: timed,
      metadataCounts,
      rawBatchBytes: transportBytes(batch),
      poolRegistrationsBytes: transportBytes(batch.poolRegistrations ?? []),
      manifestBytes: transportBytes(batch.manifest),
    };
  } finally {
    prepared.discard();
    state.operationFilters.discard();
    work.close();
  }
}

function chainBranchFor(chain, blockNumber) {
  return chain.forkAfter !== null && blockNumber > chain.forkAfter ? chain.branch : 0;
}

/** Count what a round demanded and hand it to the queue; the worker resolves it beside the loop. */
function demandMetadata(state, batch) {
  state.metadataCandidates += (batch.poolRegistrations ?? []).length * 2 + 1;
  /** @type {any[]} */
  const targets = [{ address: SCALE_USDG, blockNumber: batch.fromBlock, priority: 1 }];
  for (const pool of batch.poolRegistrations ?? []) {
    const height =
      pool.discoveredAt.blockNumber > batch.fromBlock
        ? pool.discoveredAt.blockNumber
        : batch.fromBlock;
    if (height <= batch.toBlock)
      for (const address of [pool.token0, pool.token1])
        targets.push({ address, blockNumber: height, priority: 0 });
  }
  enqueueTokenMetadata(state.db, targets, {
    nowMs: Date.now(),
    seed: state.metadata,
    scopeId: state.scopeId,
  });
  state.metadataWorker.kick();
}

/** Store what the metadata worker finished, inside the caller's transaction. */
function storeReadyMetadata(state, results) {
  const counts = { resolved: 0, failed: 0, stale: 0 };
  for (const result of results) {
    const outcome = applyMetadataLookup(state.db, state.scopeId, result, Date.now());
    if (outcome === 'resolved') counts.resolved += 1;
    else if (outcome === 'failed') counts.failed += 1;
    else counts.stale += 1;
  }
  return counts;
}

/** One sample: everything one round did, in the units the report is read in. */
function sampleOf(round, index, kind, http, rssBytes) {
  return {
    index,
    kind,
    fromBlock: round.spec.fromBlock.toString(),
    toBlock: round.spec.toBlock.toString(),
    logs: round.batch.logs.length,
    manifestShards: round.batch.manifest.shards.length,
    // The registrations this batch carries are the ones its own logs reference; the ones whose
    // discovery evidence lies inside its range are the pools this round is the first to know.
    registrationsCarried: (round.batch.poolRegistrations ?? []).length,
    newlyDiscovered: (round.batch.poolRegistrations ?? []).filter(
      (registration) => registration.discoveredAt.blockNumber >= round.spec.fromBlock,
    ).length,
    batchId: round.batch.id,
    // The value lists of the operation requests this round planned: the part of the plan that grows
    // with the catalogue, and the part the still-unshipped manager strategy would remove.
    perShardRequestBytes: round.batch.manifest.shards
      .filter((shard) => shard.filterId.startsWith('operation'))
      .map((shard) => transportBytes(shard.request)),
    totalMs: round3(round.totalMs),
    rpcAcquisitionMs: round3(round.rpcAcquisitionMs),
    localProcessingMs: round3(round.localProcessingMs),
    networkWaitMsAfterFetch: round3(round.networkWaitMsAfterFetch),
    notifyMs: round3(round.stageMs.notify ?? null),
    stageMs: Object.fromEntries(
      Object.entries(round.stageMs).map(([stage, value]) => [stage, round3(value)]),
    ),
    counts: round.counts,
    metadataApplied: round.metadataCounts,
    rawBatchBytes: round.rawBatchBytes,
    poolRegistrationsBytes: round.poolRegistrationsBytes,
    manifestBytes: round.manifestBytes,
    http,
    rssBytes,
  };
}

// ---------------------------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------------------------

/**
 * Run one benchmark and return its report. The caller owns the output directory and the report.
 * @param {{pools:number,active:number,iterations:number,assetCount:number,historyMinutes:number,out:string}} options
 * @param {{onProgress?:(line:string)=>void,parallelLoad?:string}} [hooks]
 */
export async function runBenchmark(options, hooks = {}) {
  const progress =
    hooks.onProgress ?? ((line) => process.stdout.write(PROGRESS_PREFIX + line + '\n'));
  const startedAt = Date.now();
  const allocation = allocateNormalSamples(options.iterations);
  const databasePath = join(tmpdir(), `live-performance-${process.pid}-${startedAt}.sqlite`);
  const artifactDirectory = join(options.out, 'artifacts');
  mkdirSync(artifactDirectory, { recursive: true });

  const fixtureStarted = process.hrtime.bigint();
  const data = makeScaleData({
    poolCount: options.pools,
    activePoolCount: options.active,
    assetCount: options.assetCount,
    historyMinutes: options.historyMinutes,
  });
  const fixtureMs = elapsedMs(fixtureStarted);

  const assets = createAssetRegistry(
    'scale-v1',
    Array.from({ length: options.assetCount }, (_unused, index) => scaleAssetAddress(index)),
  );
  /** @type {any} */
  const deployments = { v3Factory: V3_FACTORY, v4Manager: SCALE_MANAGER };
  const scopeId = computeWatchScopeId(assets, 'operations', deployments);
  const registryScopeId = computeWatchScopeId(assets, 'discovery-only', deployments);
  // Known and missing mixed: the quote and every even asset carry a decimals observation, so a
  // valuation either has what it needs or is genuinely waiting for the queue.
  const metadata = {
    version: 'scale-v1',
    chainId: SCALE_CHAIN_ID,
    source: 'synthetic',
    entries: [SCALE_USDG, ...assets.addresses.filter((_address, index) => index % 2 === 0)].map(
      (address) => ({
        address: address.toLowerCase(),
        decimals: address.toLowerCase() === SCALE_USDG ? 6 : 18,
        observedAtBlock: SCALE_WATERMARK_BLOCK.toString(),
        blockHash: chainHash(SCALE_WATERMARK_BLOCK),
      }),
    ),
  };
  const metricInput = {
    scopeId,
    registryScopeId,
    configVersion: 'scale-v1',
    assets,
    usdg: SCALE_USDG,
    metadata,
  };
  const liveTimeHistoryMinutes =
    Math.min(
      10080,
      Math.max(
        180,
        initialSignalConfig.candidate.samples + 10,
        initialSignalConfig.confirmRelative.samples * 5 + 10,
        initialSignalConfig.cooling.buckets * 5 + 10,
      ),
    ) + 2;

  const { chain, transport } = createScaleChain();
  const reader = createScaleReader(transport);
  const db = openDatabase(databasePath);
  const store = new SqliteRangeStore(db);
  const outbox = new AlertOutbox(db);
  const operationFilters = new OperationFilterIndex(deployments, THRESHOLDS.maxFilterValues);
  const metadataWorker = createMetadataWorker({
    db,
    reader,
    scopeId,
    owner: 'benchmark',
    canStart: () => true,
  });
  const coordinator = createSnapshotCoordinator({
    dbPath: databasePath,
    scopeId,
    registryScopeId,
    configVersion: 'scale-v1',
    assetVersion: assets.version,
    assets: assets.assets,
    usdg: SCALE_USDG,
    metadata,
    // The shipped worker module, loaded through the repository's own TypeScript entry point: a
    // worker thread does not inherit this process's loader, so it registers one for itself.
    workerFactory: () =>
      new Worker(new URL('../src/dashboard/snapshot-worker.ts', import.meta.url), {
        execArgv: [
          '--import',
          new URL('../tests/helpers/tsx-worker-loader.mjs', import.meta.url).href,
        ],
      }),
  });
  const server = createDashboardServer({ coordinator });
  await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)));
  const bound = server.address();
  if (bound === null || typeof bound === 'string')
    throw new Error('The dashboard server bound no port to sample');
  const port = bound.port;
  const summaryUrl = `http://127.0.0.1:${port}/api/snapshot`;
  const httpProbe = async () => {
    const started = Date.now();
    const response = await fetch(summaryUrl);
    const body = await response.arrayBuffer();
    return {
      status: response.status,
      latencyMs: Date.now() - started,
      responseBytes: body.byteLength,
    };
  };

  const watermark = {
    number: SCALE_WATERMARK_BLOCK,
    hash: chainHash(SCALE_WATERMARK_BLOCK),
    timestampSec: SCALE_WATERMARK_SEC,
  };
  const windowStartBlock =
    SCALE_WATERMARK_BLOCK - BigInt(options.historyMinutes * BLOCKS_PER_MINUTE);

  const state = {
    reader,
    store,
    db,
    metricInput,
    signalConfig: initialSignalConfig,
    scopeId,
    assets,
    metadata,
    liveTimeHistoryMinutes,
    artifactDirectory,
    operationFilters,
    metadataWorker,
    metadataApplied: { resolved: 0, failed: 0, stale: 0 },
    metadataCandidates: 0,
    outbox,
    alertsDelivered: 0,
    chain,
  };

  /** @type {any} */
  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      loadAverage: loadavg(),
      // The dashboard reader is a worker thread of this same process: that is load this run causes
      // rather than load the machine happened to carry, and the report says so either way.
      parallelLoad:
        'dashboard snapshot worker thread (in-process, started by this run); operator report: ' +
        (hooks.parallelLoad ?? 'none stated'),
      gitHead: gitHead(),
    },
    options: { ...options },
    stageAccounting: {
      exclusive: ['rpcAcquisition', 'notify'],
      insideLocalProcessing: [
        'rawPersist',
        'artifactPersist',
        'coverage',
        'registry',
        'projection',
        'valuation',
        'windows',
        'signals',
        'commitOther',
      ],
      note:
        'localProcessingMs is the wall clock from the mocked RPC answers being complete to the ' +
        'accepted transaction being durable: storing the raw batch, resolving the chain time, ' +
        'writing the artifact, deriving the projection, the windows, the valuations and the ' +
        'signals, and committing them. Every stage inside it is measured once and they partition ' +
        'that one window, so their sum is at most it. rpcAcquisition and notify stand outside it. ' +
        'networkWaitMsAfterFetch is the part of the window that was spent inside the transport ' +
        'rather than computing, and the background metadata apply is inside it by construction: ' +
        "its CPU is this process's work while its network is not counted in any stage.",
    },
    percentileDefinition: 'ascending[Math.ceil(0.95 * n) - 1]',
    boundary: {
      network: 'mocked in process: fetch answers JSON-RPC from a synthetic chain',
      provider: 'none: no HTTP request leaves this process',
      pacing:
        'the mock reader runs unpaced and unbudgeted; config/robinhood.json pacing unexercised',
      database: 'temporary SQLite under the OS temp directory, removed at exit',
      clock: 'wall clock, so RSS and the dashboard worker thread are part of the measurement',
    },
    fixtureMs: round3(fixtureMs),
    init: {},
    allocation,
    warmup: { rounds: WARMUP_ROUNDS, samples: [] },
    normal: { samples: [], durationsMs: [] },
    repairs: [],
    filterPlan: {},
    http: {},
    metadata: {},
  };

  try {
    // ---- initialization: timed on its own, never part of a sample ---------------------------
    const catalogueAt = process.hrtime.bigint();
    const catalogue = catalogueBatch(
      data.registrations,
      watermark,
      windowBoundaries(options.historyMinutes, 10),
    );
    catalogue.scopeId = registryScopeId;
    store.saveRaw(catalogue, { compact: true });
    store.acceptRange(catalogue);
    const catalogueMs = elapsedMs(catalogueAt);

    const coverageAt = process.hrtime.bigint();
    // The covered window is established the way the recorder establishes it: a real operations
    // round over the whole window, against the chain's own anchors, whose minute boundaries are
    // then the ones every later round reads. The window holds no operation events here; the
    // registrations it is planned and decoded against are the ones just accepted.
    const initRound = await runRound(state, {
      label: 'init-window',
      kind: 'init',
      fromBlock: windowStartBlock,
      toBlock: SCALE_WATERMARK_BLOCK,
      previous: null,
      captureMode: 'backfill',
    });
    const coverageMs = elapsedMs(coverageAt);
    chain.head = SCALE_WATERMARK_BLOCK;
    let tip = watermark;
    report.init = {
      fixtureMs: round3(fixtureMs),
      catalogueMs: round3(catalogueMs),
      coverageMs: round3(coverageMs),
      totalMs: round3(fixtureMs + catalogueMs + coverageMs),
      registrations: data.registrations.length,
      activePools: options.active,
      coverageMinutes: options.historyMinutes + 1,
      window: { fromBlock: windowStartBlock.toString(), toBlock: SCALE_WATERMARK_BLOCK.toString() },
      catalogueLogs: catalogue.logs.length,
      catalogueShards: catalogue.manifest.shards.length,
      operationsScope: scopeId,
      registryScopeId,
      boundaryRows: catalogue.boundaries.length,
      windowRoundLogs: initRound.batch.logs.length,
      windowRoundShards: initRound.batch.manifest.shards.length,
      getLogsRequests: chain.requests.getLogs,
      anchorRequests: chain.requests.getAnchor,
    };
    progress(
      `init registrations=${report.init.registrations} catalogue=${report.init.catalogueMs}ms ` +
        `window=${report.init.coverageMs}ms shards=${report.init.windowRoundShards} ` +
        `getLogs=${chain.requests.getLogs}`,
    );

    // ---- the rounds -------------------------------------------------------------------------
    const active = data.registrations.slice(0, options.active);
    const logsForRound = (lowBlock, roundNumber) => {
      const logs = [];
      for (let position = 0; position < active.length; position += 1) {
        const registration = active[position];
        if (registration === undefined) continue;
        const blockNumber = lowBlock + BigInt(position % BLOCKS_PER_ROUND);
        const amount = 1_000_000n + BigInt(position) + BigInt(roundNumber * 7);
        const txHash = toHex(BigInt(roundNumber) * 1_000_000n + BigInt(position) + 1n, {
          size: 32,
        });
        logs.push(
          registration.pool.protocol === 'v3'
            ? v3SwapLog(registration, blockNumber, txHash, 0, amount)
            : v4SwapLog(registration, blockNumber, txHash, 0, amount),
        );
        // A same-transaction pair is part of the fixture: every 97th pool swaps twice inside one
        // transaction, which is where a log-per-transaction assumption would break.
        if (position % 97 === 0)
          logs.push(
            registration.pool.protocol === 'v3'
              ? v3SwapLog(registration, blockNumber, txHash, 1, amount + 1n)
              : v4SwapLog(registration, blockNumber, txHash, 1, amount + 1n),
          );
      }
      return logs;
    };
    const runAndSample = async (spec, index, kind) => {
      const round = await runRound(state, spec);
      const http = await httpProbe();
      return sampleOf(round, index, kind, http, process.memoryUsage().rss);
    };

    // The warm-up: real rounds against real blocks, deliberately excluded from the batch.
    for (let warmup = 0; warmup < WARMUP_ROUNDS; warmup += 1) {
      const fromBlock = tip.number + 1n;
      const toBlock = fromBlock + BigInt(BLOCKS_PER_ROUND) - 1n;
      const previous = tip;
      chain.served.push(...logsForRound(fromBlock, 10_000 + warmup));
      chain.head = toBlock;
      tip = { number: toBlock, hash: chainHash(toBlock), timestampSec: blockTimestampSec(toBlock) };
      const sample = await runAndSample(
        {
          label: `warmup-${warmup + 1}`,
          kind: 'warmup',
          fromBlock,
          toBlock,
          previous,
          captureMode: 'live',
        },
        warmup,
        'warmup',
      );
      report.warmup.samples.push(sample);
      progress(
        `warmup ${warmup + 1}/${WARMUP_ROUNDS} total=${sample.totalMs}ms ` +
          `local=${sample.localProcessingMs}ms logs=${sample.logs}`,
      );
    }

    const normalPlan = [
      ...Array.from({ length: allocation.fresh }, () => 'fresh'),
      ...Array.from({ length: allocation.advance }, () => 'advance'),
      ...Array.from({ length: allocation.repeat }, () => 'repeat'),
    ];
    const perShardBytes = [];
    for (let index = 0; index < normalPlan.length; index += 1) {
      const kind = normalPlan[index];
      const previous = tip;
      let fromBlock = tip.number + 1n;
      if (kind === 'repeat') {
        // An overlapping range, the way the follow loop re-reads the blocks it just covered: the
        // chain answers with logs this scope already holds, and the round has to deduplicate them.
        fromBlock = tip.number + 1n - BigInt(THRESHOLDS.overlapBlocks);
      }
      const toBlock = tip.number + BigInt(BLOCKS_PER_ROUND);
      // An advance round records a range with nothing in it: the watermark moves, no event does.
      if (kind === 'fresh') chain.served.push(...logsForRound(tip.number + 1n, index));
      chain.head = toBlock;
      tip = { number: toBlock, hash: chainHash(toBlock), timestampSec: blockTimestampSec(toBlock) };
      const sample = await runAndSample(
        { label: `${kind}-${index + 1}`, kind, fromBlock, toBlock, previous, captureMode: 'live' },
        index,
        kind,
      );
      report.normal.samples.push(sample);
      report.normal.durationsMs.push(sample.totalMs);
      progress(
        `round ${index + 1}/${normalPlan.length} ${kind} total=${sample.totalMs}ms ` +
          `local=${sample.localProcessingMs}ms logs=${sample.logs} ` +
          `evaluated=${sample.counts.evaluatedPools} rss=${Math.round(sample.rssBytes / 1024 / 1024)}MB`,
      );
    }

    // ---- the repair rounds: extra, and never mixed into the normal batch ---------------------
    // 1. A pool that did not exist until this round, swapping in the block that created it.
    {
      const key = repairPoolKey();
      const poolId = computeV4PoolId(/** @type {any} */ (key));
      const blockNumber = tip.number + 1n;
      const txHash = toHex(9_000_001n, { size: 32 });
      chain.served.push(
        v4InitializeLog(key, poolId, blockNumber, txHash, 0),
        v4SwapLog(
          { pool: { chainId: SCALE_CHAIN_ID, protocol: 'v4', manager: SCALE_MANAGER, poolId } },
          blockNumber,
          txHash,
          1,
          5_000_000n,
        ),
      );
      const toBlock = blockNumber + BigInt(BLOCKS_PER_ROUND) - 1n;
      const previous = tip;
      chain.head = toBlock;
      tip = { number: toBlock, hash: chainHash(toBlock), timestampSec: blockTimestampSec(toBlock) };
      const sample = await runAndSample(
        {
          label: 'repair-new-registration',
          kind: REPAIR_KINDS[0],
          fromBlock: blockNumber,
          toBlock,
          previous,
          captureMode: 'live',
        },
        0,
        REPAIR_KINDS[0],
      );
      sample.newPoolId = poolId;
      report.repairs.push(sample);
      if (sample.newlyDiscovered === 0)
        throw new Error(
          'The repair round registered no pool: the discovery path was not exercised',
        );
      progress(
        `repair ${REPAIR_KINDS[0]} total=${sample.totalMs}ms discovered=${sample.newlyDiscovered}`,
      );
    }

    // 2. The metadata a dependency change introduced, resolved beside the loop and applied inside a
    //    commit — the repair the queue exists for, and the CPU it costs the round that lands it.
    {
      const pending = metadataQueueFor(db).stats(scopeId, Date.now());
      // Tokens outside the watchlist stand in for the dependency a repair reacts to: they are
      // demanded, the worker answers them over the mocked network while the loop is idle, and the
      // round's own commit is what stores the observation.
      const dependencyTokens = Array.from({ length: 12 }, (_unused, index) =>
        scaleAssetAddress(options.assetCount + index),
      );
      state.metadataCandidates += dependencyTokens.length;
      enqueueTokenMetadata(
        db,
        dependencyTokens.map((address) => ({ address, blockNumber: tip.number, priority: 0 })),
        { nowMs: Date.now(), seed: metadata, scopeId },
      );
      await metadataWorker.drain();
      const previous = tip;
      const fromBlock = tip.number + 1n;
      const toBlock = fromBlock + BigInt(BLOCKS_PER_ROUND) - 1n;
      chain.served.push(...logsForRound(fromBlock, 20_000));
      chain.head = toBlock;
      tip = { number: toBlock, hash: chainHash(toBlock), timestampSec: blockTimestampSec(toBlock) };
      const sample = await runAndSample(
        {
          label: 'repair-metadata',
          kind: REPAIR_KINDS[1],
          fromBlock,
          toBlock,
          previous,
          captureMode: 'live',
        },
        1,
        REPAIR_KINDS[1],
      );
      sample.queueBeforeDrain = pending;
      sample.dependencyTokens = dependencyTokens.length;
      report.repairs.push(sample);
      progress(
        `repair ${REPAIR_KINDS[1]} total=${sample.totalMs}ms ` +
          `resolved=${sample.metadataApplied.resolved}`,
      );
    }

    // 3. A revision of history this scope already accepted: the chain forks, the accepted range is
    //    withdrawn from the fork point, and the replacement branch is re-fetched and re-accepted.
    {
      const forkAfter = tip.number - 3n;
      const forkAnchor = {
        number: forkAfter,
        hash: chainHash(forkAfter),
        timestampSec: blockTimestampSec(forkAfter),
      };
      retractSignals(
        db,
        scopeId,
        { batchId: 'repair-revision', observedAtMs: Date.now(), captureMode: 'live' },
        'scope-rechecking',
        0n,
      );
      const changes = store.invalidateAfter(scopeId, forkAnchor);
      registryCacheFor(db, registryScopeId, scopeId).invalidate();
      chain.branch = 1;
      chain.forkAfter = forkAfter;
      const fromBlock = forkAfter + 1n;
      const toBlock = tip.number + BigInt(BLOCKS_PER_ROUND);
      chain.head = toBlock;
      tip = {
        number: toBlock,
        hash: chainHash(toBlock, 1),
        timestampSec: blockTimestampSec(toBlock),
      };
      const sample = await runAndSample(
        {
          label: 'repair-history-revision',
          kind: REPAIR_KINDS[2],
          fromBlock,
          toBlock,
          previous: forkAnchor,
          captureMode: 'backfill',
        },
        2,
        REPAIR_KINDS[2],
      );
      sample.retractedLogs = changes.removed.length;
      sample.revisionLogs = sample.logs;
      report.repairs.push(sample);
      chain.branch = 0;
      chain.forkAfter = null;
      progress(
        `repair ${REPAIR_KINDS[2]} total=${sample.totalMs}ms ` +
          `retracted=${sample.retractedLogs} logs=${sample.revisionLogs}`,
      );
    }

    // ---- the R05 cost, stated at the scale it was run at -------------------------------------
    const v3Registrations = data.registrations.filter(
      (registration) => registration.pool.protocol === 'v3',
    );
    const v4PoolIds = [
      ...new Set(
        data.registrations.flatMap((registration) =>
          registration.pool.protocol === 'v4' ? [registration.pool.poolId.toLowerCase()] : [],
        ),
      ),
    ].sort();
    const v3Addresses = [
      ...new Set(
        v3Registrations.flatMap((registration) =>
          registration.pool.protocol === 'v3' ? [registration.pool.address.toLowerCase()] : [],
        ),
      ),
    ].sort();
    const operationShards = buildOperationShardFilters(
      /** @type {any} */ ({ v3Addresses, v4PoolIds }),
      { v4Manager: SCALE_MANAGER },
      THRESHOLDS.maxFilterValues,
    );
    const samplesSoFar = [...report.normal.samples, ...report.warmup.samples, ...report.repairs];
    report.filterPlan = {
      strategy: 'pool-ids (the live default; the manager experiment is not wired into production)',
      maxFilterValues: THRESHOLDS.maxFilterValues,
      v3AddressValues: v3Addresses.length,
      v4PoolIdValues: v4PoolIds.length,
      v3ShardCount: operationShards.filter((shard) => shard.id === 'operation-v3').length,
      v4ShardCount: operationShards.filter((shard) => shard.id === 'operation-v4').length,
      operationFilterRebuilds: maxCount(samplesSoFar, 'operationFilterRebuilds'),
      operationFilterValuesScanned: maxCount(samplesSoFar, 'operationFilterValuesScanned'),
      // The per-request value lists themselves: the part of the plan that grows with the catalogue
      // and the part R05 is about, measured rather than described.
      perShardRequestBytes: bytesDistribution(
        report.normal.samples.flatMap((sample) => sample.perShardRequestBytes ?? []),
      ),
      manifestBytesPerRound: bytesDistribution(report.normal.samples.map((s) => s.manifestBytes)),
      rawBatchBytesPerRound: bytesDistribution(report.normal.samples.map((s) => s.rawBatchBytes)),
      poolRegistrationsBytesPerRound: bytesDistribution(
        report.normal.samples.map((s) => s.poolRegistrationsBytes),
      ),
      shardsPerRound: distribution(report.normal.samples.map((s) => s.manifestShards)),
      getLogsRequests: chain.requests.getLogs,
      anchorRequests: chain.requests.getAnchor,
      callRequests: chain.requests.call,
    };

    // ---- summary ----------------------------------------------------------------------------
    const normal = report.normal;
    normal.p50Ms = round3(percentile(normal.durationsMs, 0.5));
    normal.p95Ms = round3(percentile(normal.durationsMs, 0.95));
    normal.maxMs = normal.durationsMs.length === 0 ? null : round3(Math.max(...normal.durationsMs));
    normal.durationsMs = normal.durationsMs.map(round3);
    normal.percentileDefinition = report.percentileDefinition;
    normal.localProcessingMs = distribution(normal.samples.map((s) => s.localProcessingMs));
    normal.rpcAcquisitionMs = distribution(normal.samples.map((s) => s.rpcAcquisitionMs));
    normal.rawBatchBytes = bytesDistribution(normal.samples.map((s) => s.rawBatchBytes));
    normal.manifestBytes = bytesDistribution(normal.samples.map((s) => s.manifestBytes));
    normal.stages = Object.fromEntries(
      [...report.stageAccounting.insideLocalProcessing, ...report.stageAccounting.exclusive]
        .map((stage) => [
          stage,
          distribution(normal.samples.map((sample) => sample.stageMs[stage]).filter(isNumber)),
        ])
        .filter((entry) => entry[1].count > 0),
    );
    // Every structural counter over the normal batch, keyed by the same names the production sites
    // increment, so a reader compares a run against the acceptance table without decoding samples.
    normal.counters = Object.fromEntries(
      WORK_COUNTER_KEYS.map((key) => [
        key,
        distribution(normal.samples.map((sample) => sample.counts[key]).filter(isNumber)),
      ]),
    );
    normal.perRound = {
      evaluatedPools: normal.samples.map((sample) => sample.counts.evaluatedPools),
      evaluatedWorksetPools: normal.samples.map((sample) => sample.counts.evaluatedWorksetPools),
      registryRowsRead: normal.samples.map((sample) => sample.counts.registryRowsRead),
      registryRowsSerialized: normal.samples.map((sample) => sample.counts.registryRowsSerialized),
    };
    const allSamples = [...report.warmup.samples, ...normal.samples, ...report.repairs];
    report.http = {
      url: '/api/snapshot',
      samples: allSamples.map((sample) => sample.http),
      latencyMs: distribution(allSamples.map((sample) => sample.http.latencyMs)),
      responseBytes: distribution(allSamples.map((sample) => sample.http.responseBytes)),
      note:
        'A summary GET answered from the published snapshot: the request asks for a newer ' +
        'generation and is answered from what is published now rather than waiting for one.',
    };
    report.metadata = {
      applied: state.metadataApplied,
      candidates: state.metadataCandidates,
      queue: metadataQueueFor(db).stats(scopeId, Date.now()),
      seedEntries: metadata.entries.length,
      assetsWithoutSeed: assets.addresses.length - metadata.entries.length,
    };
    report.alerts = { delivered: state.alertsDelivered };
    report.rssBytes = process.memoryUsage().rss;
    report.databaseBytes = existsSync(databasePath) ? statSync(databasePath).size : null;
    report.generatedAt = new Date().toISOString();
    return report;
  } finally {
    await coordinator.close().catch(() => undefined);
    await new Promise((done) => server.close(done));
    await metadataWorker.stop().catch(() => undefined);
    db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

function maxCount(samples, key) {
  return samples.reduce((highest, sample) => Math.max(highest, sample.counts?.[key] ?? 0), 0);
}

// ---------------------------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------------------------

async function main() {
  const options = parseBenchmarkOptions(process.argv.slice(2));
  const report = await runBenchmark(options, { parallelLoad: process.env.BENCHMARK_PARALLEL_LOAD });
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, 'benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    join(options.out, 'summary.json'),
    `${JSON.stringify(
      {
        out: options.out,
        allocation: report.allocation,
        init: report.init,
        normal: {
          count: report.normal.samples.length,
          p50Ms: report.normal.p50Ms,
          p95Ms: report.normal.p95Ms,
          localProcessingMs: report.normal.localProcessingMs,
        },
        repairs: report.repairs.map((sample) => ({
          kind: sample.kind,
          totalMs: sample.totalMs,
          localProcessingMs: sample.localProcessingMs,
        })),
        filterPlan: {
          v4PoolIdValues: report.filterPlan.v4PoolIdValues,
          v4ShardCount: report.filterPlan.v4ShardCount,
          v3ShardCount: report.filterPlan.v3ShardCount,
          perShardRequestBytes: report.filterPlan.perShardRequestBytes,
          manifestBytesPerRound: report.filterPlan.manifestBytesPerRound,
        },
        http: report.http.latencyMs,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`${JSON.stringify({ out: options.out, normal: report.normal.p95Ms })}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
