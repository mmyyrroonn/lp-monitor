// Offline live-runtime benchmark for the 2026-09-15 performance review.
//
// Runs against the deterministic scale fixture and a temporary SQLite database only. It never
// opens data/recorder.sqlite and never issues RPC requests. Structural counters come from the
// production sites wired in src/ops/work-counters.ts, so the reported work is measured, not
// idealized. Run with:
//   pnpm exec tsx scripts/benchmark-live-performance.mjs --pools 80000 --active 400 \
//     --iterations 20 --out artifacts/performance/80k
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { valueSwap } from '../src/metrics/notional.js';
import { buildRollingMetrics } from '../src/metrics/rolling.js';
import { buildMinuteMetrics } from '../src/metrics/windows.js';
import { emptyWorkCounts, setWorkCounter } from '../src/ops/work-counters.js';
import { PoolRegistry, poolRegistrationId } from '../src/registry/pools.js';
import { openDatabase } from '../src/storage/database.js';
import { rawLogKey } from '../src/storage/manifest.js';
import { readBatch } from '../src/storage/payload-store.js';
import { SqliteRangeStore } from '../src/storage/raw-store.js';
import {
  makeScaleData,
  SCALE_MANAGER,
  SCALE_SCOPE_ID,
  SCALE_USDG,
} from '../tests/helpers/live-scale-fixture.js';

const USAGE =
  'Usage: pnpm exec tsx scripts/benchmark-live-performance.mjs --pools N --active N --iterations N --out DIR';

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

function readOutput(argv) {
  const index = argv.indexOf('--out');
  if (index < 0 || !argv[index + 1]) throw new Error(`Missing --out\n${USAGE}`);
  return resolve(argv[index + 1]);
}

const argv = process.argv.slice(2);
const options = {
  pools: readInteger(argv, '--pools'),
  active: readInteger(argv, '--active'),
  iterations: readInteger(argv, '--iterations'),
  assetCount: readInteger(argv, '--assets', 194),
  historyMinutes: readInteger(argv, '--history-minutes', 180),
  out: readOutput(argv),
};
if (options.active > options.pools) throw new Error('--active must not exceed --pools');
if (options.assetCount < 2) throw new Error('--assets must cover the stock co-pool');
if (existsSync(options.out))
  throw new Error(`Output directory already exists: ${options.out}. Choose a new directory.`);

const elapsedMs = (since) => Number(process.hrtime.bigint() - since) / 1e6;
const round6 = (value) => (value === null ? null : Math.round(value * 1000) / 1000);
const percentile = (values, fraction) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
};

/** V3 pools are discovered from factory events; V4 pools from the manager. */
const SCALE_V3_FACTORY = `0x${'f0'.repeat(20)}`;

/** Raw log matching a registration's discovery reference so the store persists the evidence. */
const discoveryLog = (registration) => ({
  address: registration.pool.protocol === 'v3' ? SCALE_V3_FACTORY : registration.pool.manager,
  blockNumber: registration.discoveredAt.blockNumber,
  blockHash: registration.discoveredAt.blockHash,
  transactionHash: registration.discoveredAt.transactionHash,
  transactionIndex: registration.discoveredAt.transactionIndex,
  logIndex: registration.discoveredAt.logIndex,
  topics: [],
  data: '0x',
  rawBlockTimestamp: null,
});

/**
 * One catalogue batch: the whole registration set plus the discovery evidence it points at.
 * @returns {import('../src/storage/manifest.js').RecordedRangeBatch}
 */
function catalogueBatch(registrations, watermark) {
  const logs = registrations.map(discoveryLog);
  const fromBlock = registrations.reduce(
    (lowest, registration) =>
      registration.discoveredAt.blockNumber < lowest
        ? registration.discoveredAt.blockNumber
        : lowest,
    registrations[0].discoveredAt.blockNumber,
  );
  /** @returns {import('../src/storage/manifest.js').FetchShardManifest} */
  const shard = (shardId, filterId, address, keys) => ({
    shardId,
    filterId,
    request: { fromBlock, toBlock: watermark.number, address: [address], topics: [] },
    status: 'success',
    responseHash: 'scale',
    error: null,
    logKeys: keys,
    logCount: keys.length,
  });
  const v4Keys = [];
  const v3Keys = [];
  for (const log of logs) (log.address === SCALE_MANAGER ? v4Keys : v3Keys).push(rawLogKey(log));
  const shards = [shard('catalogue-v4', 'discovery-v4', SCALE_MANAGER, v4Keys)];
  if (v3Keys.length > 0)
    shards.push(shard('catalogue-v3', 'discovery-v3', SCALE_V3_FACTORY, v3Keys));
  return {
    id: 'catalogue',
    scopeId: SCALE_SCOPE_ID,
    fromBlock,
    toBlock: watermark.number,
    end: watermark,
    previous: null,
    logs,
    observedAtMs: 0,
    captureMode: 'synthetic',
    filterPlanHash: 'scale',
    manifestHash: 'scale',
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'scale-v1',
      expectedShardIds: shards.map((entry) => entry.shardId),
      shards,
    },
    poolRegistrations: registrations,
    logTimes: [],
    boundaries: [],
  };
}

const startedAt = Date.now();
const fixtureStarted = process.hrtime.bigint();
const data = makeScaleData({
  poolCount: options.pools,
  activePoolCount: options.active,
  assetCount: options.assetCount,
  historyMinutes: options.historyMinutes,
});
const fixtureMs = elapsedMs(fixtureStarted);

const databasePath = join(tmpdir(), `live-performance-${process.pid}-${startedAt}.sqlite`);
const db = openDatabase(databasePath);
const store = new SqliteRangeStore(db);
try {
  const initStarted = process.hrtime.bigint();
  const catalogue = catalogueBatch(data.registrations, data.watermark);
  store.saveRaw(catalogue, { compact: true });
  store.acceptRange(catalogue);
  const initMs = elapsedMs(initStarted);

  const pools = data.registrations.map((registration) => ({
    pool: registration.pool,
    discoveredAtBlock: registration.discoveredAt.blockNumber,
    rawToken: registration.token0,
  }));
  const activeIds = new Set(
    data.events.flatMap((entry) =>
      entry.event.pool ? [poolRegistrationId({ pool: entry.event.pool })] : [],
    ),
  );
  const activePools = pools.filter((pool) => activeIds.has(poolRegistrationId(pool)));
  const quote = data.registrations.find(
    (registration) =>
      activeIds.has(poolRegistrationId(registration)) &&
      registration.token1.toLowerCase() === SCALE_USDG,
  );
  // A normal batch: a handful of new events for pools inside the active window.
  const roundEvents = data.events.map((entry, index) => ({
    ...entry,
    event: {
      ...entry.event,
      transactionHash: `0x${(index + 5_000_000).toString(16).padStart(64, '0')}`,
    },
  }));
  /** @type {import('../src/metrics/notional.js').SwapValuationMetadata | null} */
  const valuationMetadata = quote
    ? {
        token0: { address: quote.token0, decimals: 18, role: 'rwa' },
        token1: { address: SCALE_USDG, decimals: 6, role: 'usdg' },
        rwa: quote.token0,
        usdg: SCALE_USDG,
        usdgDecimals: 6,
      }
    : null;

  const records = [];
  const stageSamples = {};
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const counts = emptyWorkCounts();
    setWorkCounter((key, delta) => {
      counts[key] += delta;
    });
    const stages = {};
    const stage = (name, work) => {
      const before = process.hrtime.bigint();
      const result = work();
      const elapsed = elapsedMs(before);
      stages[name] = elapsed;
      (stageSamples[name] ??= []).push(elapsed);
      return result;
    };
    const roundStarted = process.hrtime.bigint();
    const registry = stage('registryRead', () => store.pools(SCALE_SCOPE_ID));
    stage('registryMerge', () => new PoolRegistry([...registry]).snapshot());
    // Coverage and page paths decode recorded batches; this is the R03 evidence path.
    stage('batchDecode', () => readBatch(db, catalogue.id));
    stage('windows', () =>
      buildMinuteMetrics(roundEvents, data.coverage, data.watermark, { pools }),
    );
    stage('rolling', () =>
      buildRollingMetrics(roundEvents, data.coverage, data.watermark, { pools: activePools }),
    );
    if (quote && valuationMetadata)
      stage('valuation', () => {
        for (const entry of roundEvents) {
          if (entry.event.kind !== 'swap') continue;
          valueSwap(
            { ...entry.event, pool: quote.pool, tokenIn: quote.token0, tokenOut: SCALE_USDG },
            valuationMetadata,
            [],
          );
        }
      });
    const totalMs = elapsedMs(roundStarted);
    setWorkCounter(null);
    const record = {
      iteration,
      totalMs: round6(totalMs),
      stages: Object.fromEntries(
        Object.entries(stages).map(([key, value]) => [key, round6(value)]),
      ),
      counts,
      rssBytes: process.memoryUsage().rss,
    };
    records.push(record);
    process.stdout.write(
      `round ${iteration + 1}/${options.iterations} total=${record.totalMs}ms ` +
        `registryRead=${record.stages.registryRead ?? 0}ms windows=${record.stages.windows ?? 0}ms ` +
        `evaluatedPools=${counts.evaluatedPools} rss=${Math.round(record.rssBytes / 1024 / 1024)}MB\n`,
    );
  }
  setWorkCounter(null);

  const totals = records.map((record) => record.totalMs);
  let head = 'unavailable';
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    head = 'unavailable';
  }
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    head,
    options,
    fixtureMs: round6(fixtureMs),
    initMs: round6(initMs),
    rounds: records,
    total: {
      p50Ms: round6(percentile(totals, 0.5)),
      p95Ms: round6(percentile(totals, 0.95)),
      maxMs: totals.length > 0 ? round6(Math.max(...totals)) : null,
    },
    stages: Object.fromEntries(
      Object.entries(stageSamples).map(([name, values]) => [
        name,
        { p50Ms: round6(percentile(values, 0.5)), p95Ms: round6(percentile(values, 0.95)) },
      ]),
    ),
    countsPerRound: records.at(-1)?.counts ?? emptyWorkCounts(),
    rssBytes: process.memoryUsage().rss,
    databaseBytes: existsSync(databasePath) ? statSync(databasePath).size : null,
  };
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, 'benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ out: options.out, total: report.total, counts: report.countsPerRound }, null, 2)}\n`,
  );
} finally {
  setWorkCounter(null);
  db.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true });
}
