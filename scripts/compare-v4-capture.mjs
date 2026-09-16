// Offline comparator for the 2026-09-15 V4 capture experiment (sub-plan 05, task E2).
//
// It reads exactly one explicit local fixture and never contacts a provider. There is no endpoint
// option, no `.env` read, no default URL and no fallback: a missing or malformed fixture is an
// error, not a reason to go online. Both strategies are replayed through the production capture
// path — `buildOperationFilterPlan` -> `fetchBoundedLogs` -> `fetchRange` — and then through the
// production interpretation path — `resolveLogTimes` -> `commitAcceptedSignalBatch` ->
// `buildMetricsReport` — so the two columns below are measured, not modelled.
//
// Request counts and response bytes here are offline planning and payload facts. A difference
// between the two columns is not a provider latency improvement, and this report never converts
// one into the other.
//
// Run with:
//   pnpm exec tsx scripts/compare-v4-capture.mjs --fixture <local.json> --out <new-directory>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createChainReader } from '../src/rpc/client.js';
import { runV4CaptureExperiment } from '../src/ingest/v4-capture-experiment.js';
import { resolveLogTimes } from '../src/ingest/log-time.js';
import { computeWatchScopeId } from '../src/ingest/filter-plan.js';
import { decodeV4 } from '../src/protocols/uniswap-v4/decode.js';
import { createAssetRegistry } from '../src/registry/assets.js';
import { PoolRegistry, poolRegistrationId } from '../src/registry/pools.js';
import { commitAcceptedSignalBatch } from '../src/signals/project.js';
import { initialSignalConfig } from '../src/signals/config.js';
import { openDatabase } from '../src/storage/database.js';
import { buildMetricsReport } from '../src/storage/metric-store.js';
import { rawLogKey } from '../src/storage/manifest.js';

export const FIXTURE_SCHEMA_VERSION = 1;
/**
 * Every integer in a fixture is a decimal string. `bigint` has no JSON form, and a fixture that
 * carried block heights or log indices as JSON numbers would silently lose precision above 2^53 —
 * exactly the range a long recording lives in.
 */
export const BIGINT_CODEC = 'decimal-string';

const USAGE =
  'Usage: pnpm exec tsx scripts/compare-v4-capture.mjs --fixture <file.json> --out <new-directory>';

class FixtureError extends Error {}

function option(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) throw new FixtureError(`Missing ${flag}\n${USAGE}`);
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw new FixtureError(`${flag} needs a value\n${USAGE}`);
  return value;
}

/** A fixture and an output directory are paths on this machine; anything with a scheme is refused. */
function localPath(value, flag) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes('://'))
    throw new FixtureError(`${flag} must be a local path, not a URL: ${value}`);
  return resolve(value);
}

const big = (value, what) => {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value))
    throw new FixtureError(`${what} must be a decimal string (bigint codec "${BIGINT_CODEC}")`);
  return BigInt(value);
};
const address = (value, what) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value))
    throw new FixtureError(`${what} must be a 20-byte hex address`);
  return value.toLowerCase();
};
const hex = (value, what) => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value))
    throw new FixtureError(`${what} must be hex`);
  return value.toLowerCase();
};
const integer = (value, what) => {
  if (!Number.isSafeInteger(value)) throw new FixtureError(`${what} must be a safe integer`);
  return value;
};

function readFixture(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new FixtureError(
      `Fixture is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw?.schemaVersion !== FIXTURE_SCHEMA_VERSION)
    throw new FixtureError(
      `Fixture schemaVersion must be ${FIXTURE_SCHEMA_VERSION}, got ${String(raw?.schemaVersion)}`,
    );
  if (raw.bigintCodec !== BIGINT_CODEC)
    throw new FixtureError(`Fixture bigintCodec must be "${BIGINT_CODEC}"`);
  if (!Array.isArray(raw.logs)) throw new FixtureError('Fixture needs a logs array');
  if (!Array.isArray(raw.catalogue)) throw new FixtureError('Fixture needs a catalogue array');
  const catalogue = raw.catalogue.map((entry, index) => ({
    pool: entry.pool,
    token0: address(entry.token0, `catalogue[${index}].token0`),
    token1: address(entry.token1, `catalogue[${index}].token1`),
    feePips: integer(Number(entry.feePips), `catalogue[${index}].feePips`),
    tickSpacing: integer(Number(entry.tickSpacing), `catalogue[${index}].tickSpacing`),
    hooks: address(
      entry.hooks ?? '0x0000000000000000000000000000000000000000',
      `catalogue[${index}].hooks`,
    ),
    discoveredAt: entry.discoveredAt,
    assetVersion: String(entry.assetVersion),
    source: String(entry.source),
  }));
  const logs = raw.logs.map((log, index) => ({
    address: address(log.address, `logs[${index}].address`),
    topics: (log.topics ?? []).map((topic, at) => hex(topic, `logs[${index}].topics[${at}]`)),
    data: hex(log.data ?? '0x', `logs[${index}].data`),
    blockNumber: big(log.blockNumber, `logs[${index}].blockNumber`),
    blockHash: hex(log.blockHash, `logs[${index}].blockHash`),
    transactionHash: hex(log.transactionHash, `logs[${index}].transactionHash`),
    transactionIndex: integer(Number(log.transactionIndex ?? 0), `logs[${index}].transactionIndex`),
    logIndex: integer(Number(log.logIndex ?? 0), `logs[${index}].logIndex`),
    rawBlockTimestamp: log.rawBlockTimestamp ?? null,
  }));
  const assets = {
    version: String(raw.assets?.version ?? ''),
    addresses: (raw.assets?.addresses ?? []).map((value, index) =>
      address(value, `assets.addresses[${index}]`),
    ),
  };
  if (assets.addresses.length === 0) throw new FixtureError('assets.addresses must not be empty');
  return {
    raw,
    catalogue,
    logs,
    assets,
    chainId: integer(Number(raw.chainId ?? 4663), 'chainId'),
    usdg: address(raw.usdg, 'usdg'),
    decimals: integer(Number(raw.decimals ?? 6), 'decimals'),
    deployments: {
      v3Factory: address(raw.deployments?.v3Factory, 'deployments.v3Factory'),
      v4Manager: address(raw.deployments?.v4Manager, 'deployments.v4Manager'),
    },
    range: {
      fromBlock: big(raw.range?.fromBlock, 'range.fromBlock'),
      toBlock: big(raw.range?.toBlock, 'range.toBlock'),
      end: {
        number: big(raw.range?.end?.number, 'range.end.number'),
        hash: hex(raw.range?.end?.hash, 'range.end.hash'),
        timestampSec: integer(Number(raw.range?.end?.timestampSec), 'range.end.timestampSec'),
      },
    },
    // A recorded anchor map wins; otherwise the fixture states the chain's one linear time rule.
    anchors: new Map(
      (raw.anchors ?? []).map((anchor) => [
        big(anchor.number, 'anchors.number').toString(),
        { hash: hex(anchor.hash, 'anchors.hash'), timestampSec: Number(anchor.timestampSec) },
      ]),
    ),
    baseTimestampSec: Number(raw.chain?.baseTimestampSec ?? 0),
    secondsPerBlock: Number(raw.chain?.secondsPerBlock ?? 1),
    head: big(raw.chain?.head ?? raw.range?.toBlock, 'chain.head'),
  };
}

function anchorAt(fixture, number) {
  const recorded = fixture.anchors.get(number.toString());
  if (recorded) return { number, hash: recorded.hash, timestampSec: recorded.timestampSec };
  return {
    number,
    hash: `0x${number.toString(16).padStart(64, '0')}`,
    timestampSec: fixture.baseTimestampSec + Number(number) * fixture.secondsPerBlock,
  };
}
const blockHashAt = (fixture, number) => anchorAt(fixture, number).hash;
const blockTimeAt = (fixture, number) => anchorAt(fixture, number).timestampSec;

const asRequest = (raw) => ({
  fromBlock: BigInt(String(raw.fromBlock)),
  toBlock: BigInt(String(raw.toBlock)),
  address: (raw.address ?? []).map((value) => String(value).toLowerCase()),
  topics: (raw.topics ?? []).map((topic) =>
    Array.isArray(topic)
      ? topic.map((value) => String(value).toLowerCase())
      : topic === null
        ? null
        : String(topic).toLowerCase(),
  ),
});
/** A manager operation request, whichever strategy planned it: several topic alternatives. */
const isOperationRequest = (request) => {
  const topics = request.topics[0];
  return Array.isArray(topics) && topics.length > 1;
};
const matchesRequest = (request, log) =>
  log.blockNumber >= request.fromBlock &&
  log.blockNumber <= request.toBlock &&
  request.address.some((value) => value === log.address) &&
  request.topics.every((wanted, index) => {
    if (wanted === null) return true;
    const actual = log.topics[index];
    return typeof wanted === 'string' ? wanted === actual : wanted.some((t) => t === actual);
  });

/**
 * A provider over the fixture's frozen chain. Every response is
 * `logs.filter(matchesRequest(request))`, so what a strategy receives is decided by the request it
 * made rather than by a fixture that answers everything with everything.
 */
function fixtureProvider(fixture) {
  const logRequests = [];
  const reader = createChainReader(
    {
      httpRpcUrl: 'http://offline.invalid/rpc',
      providerAlias: 'offline-fixture',
      dataDir: 'offline',
    },
    {
      perSecond: 100_000,
      maxBackfillRpcRps: 100_000,
      maxConcurrentRpc: 4,
      maxRetries: 0,
      maxCalls: 1_000_000,
      fetchFn: async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        const reply = (result) =>
          new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 });
        if (request.method === 'eth_getBlockByNumber') {
          const raw = String(request.params[0]);
          const number = raw === 'latest' ? fixture.head : BigInt(raw);
          const anchor = anchorAt(fixture, number);
          return reply({
            number: `0x${number.toString(16)}`,
            hash: anchor.hash,
            timestamp: `0x${anchor.timestampSec.toString(16)}`,
          });
        }
        if (request.method === 'eth_getLogs') {
          const asked = asRequest(request.params[0]);
          logRequests.push(asked);
          return reply(
            fixture.logs
              .filter((log) => matchesRequest(asked, log))
              .map((log) => ({
                address: log.address,
                topics: log.topics,
                data: log.data,
                blockNumber: `0x${log.blockNumber.toString(16)}`,
                blockHash: log.blockHash,
                transactionHash: log.transactionHash,
                transactionIndex: `0x${log.transactionIndex.toString(16)}`,
                logIndex: `0x${log.logIndex.toString(16)}`,
                blockTimestamp: null,
                removed: false,
              })),
          );
        }
        throw new FixtureError(`The offline fixture answers no ${request.method} request`);
      },
    },
  );
  return { reader, logRequests };
}

/** The chain's own minute boundaries, read back from the provider rather than assumed. */
async function minuteBoundaries(reader, range) {
  const rows = [];
  for (let target = 60; BigInt(target) <= range.toBlock; target += 60) {
    const firstBlock = BigInt(target) - 60n;
    if (firstBlock <= 0n || firstBlock < range.fromBlock || firstBlock > range.toBlock) continue;
    rows.push({
      timestampSec: target,
      firstBlock,
      before: await reader.getAnchor(firstBlock - 1n),
      at: await reader.getAnchor(firstBlock),
    });
  }
  return rows;
}

/**
 * What the production decoder reads out of a capture, per log. A log whose pool the batch's own
 * registrations cannot explain is reported as unexplained rather than decoded against a guess.
 */
function decodedEvents(fixture, batch) {
  const registrations = (batch.poolRegistrations ?? []).filter(
    (entry) => entry.pool.protocol === 'v4',
  );
  const events = [];
  for (const log of batch.logs) {
    const registration = registrations.find(
      (entry) =>
        entry.pool.manager === log.address && entry.pool.poolId === log.topics[1]?.toLowerCase(),
    );
    if (registration === undefined) {
      events.push({ key: rawLogKey(log), kind: 'unexplained-pool', poolId: null });
      continue;
    }
    try {
      const event = decodeV4(
        log,
        {
          minuteStartSec: Math.floor(blockTimeAt(fixture, log.blockNumber) / 60) * 60,
          exactTimestampSec: null,
          source: 'minute-boundary',
        },
        registration,
      );
      const decoded = /** @type {Record<string, unknown>} */ (event);
      events.push({
        key: rawLogKey(log),
        kind: event.kind,
        poolId: poolRegistrationId(registration),
        amountIn: decoded.amountIn === undefined ? null : String(decoded.amountIn),
        amountOut: decoded.amountOut === undefined ? null : String(decoded.amountOut),
        delta: decoded.delta === undefined ? null : String(decoded.delta),
      });
    } catch (error) {
      events.push({
        key: rawLogKey(log),
        kind: 'decode-error',
        poolId: poolRegistrationId(registration),
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return events.sort((left, right) => String(left.key).localeCompare(String(right.key)));
}

async function captureOne(fixture, mode) {
  const { reader, logRequests } = fixtureProvider(fixture);
  const assets = createAssetRegistry(fixture.assets.version, fixture.assets.addresses);
  const outcome = await runV4CaptureExperiment(reader, {
    fromBlock: fixture.range.fromBlock,
    toBlock: fixture.range.toBlock,
    end: fixture.range.end,
    assets,
    pools: new PoolRegistry(fixture.catalogue),
    v3Factory: fixture.deployments.v3Factory,
    v4Manager: fixture.deployments.v4Manager,
    observedAtMs: 1_700_000_000_000,
    captureMode: 'synthetic',
    maxRangeBlocks: big(String(fixture.raw.maxRangeBlocks ?? '10000'), 'maxRangeBlocks'),
    ...(fixture.raw.logResponseGuard === undefined
      ? {}
      : { logResponseGuard: Number(fixture.raw.logResponseGuard) }),
    ...(fixture.raw.maxLogsPerResponse === undefined
      ? {}
      : { maxLogsPerResponse: Number(fixture.raw.maxLogsPerResponse) }),
    v4OperationMode: mode,
  });
  const batch = outcome.batch;
  return {
    mode,
    reader,
    batch,
    requests: logRequests.length,
    operationRequests: logRequests.filter(isOperationRequest).length,
    responseBytes: outcome.result.responseBytes,
    completeness: batch.completeness,
    eligibleForLive: outcome.result.eligibleForLive,
    reasons: outcome.result.reasons,
    knownTargets: (batch.poolRegistrations ?? []).length,
    watchedLogKeys: outcome.result.watchedLogKeys.length,
    unknownLogKeys: outcome.result.unknownLogKeys,
    logKeys: batch.logs.map(rawLogKey).sort(),
    decoded: decodedEvents(fixture, batch),
    shards: batch.manifest.shards.map((shard) => ({
      filterId: shard.filterId,
      status: shard.status,
      logCount: shard.logCount,
      request: {
        fromBlock: shard.request.fromBlock.toString(),
        toBlock: shard.request.toBlock.toString(),
        addresses: shard.request.address.length,
        topicAlternatives: shard.request.topics.map((topic) =>
          topic === null ? null : typeof topic === 'string' ? 1 : topic.length,
        ),
      },
    })),
  };
}

/** The interpreted reading of a complete capture: coverage, four windows, quality and reminders. */
async function interpret(fixture, run) {
  // A range that is not complete cannot become coverage, so it is not interpreted at all.
  if (run.batch.completeness !== 'complete')
    return { measured: false, reason: 'incomplete-capture-cannot-build-coverage' };
  const boundaries = await minuteBoundaries(run.reader, fixture.range);
  const resolution = await resolveLogTimes(
    run.reader,
    run.batch.logs,
    run.batch.fromBlock,
    run.batch.end,
    [],
    boundaries,
  );
  if (resolution.failures.length > 0)
    return { measured: false, reason: 'log-time-unresolved', failures: resolution.failures.length };

  const assets = createAssetRegistry(fixture.assets.version, fixture.assets.addresses);
  const scopeId = computeWatchScopeId(assets, 'operations', fixture.deployments);
  const metricInput = {
    scopeId,
    registryScopeId: scopeId,
    configVersion: `offline-${run.mode}`,
    assets,
    usdg: fixture.usdg,
    metadata: {
      version: 'offline-fixture',
      chainId: fixture.chainId,
      source: 'synthetic',
      // The quote asset is a valuation dependency in its own right: without its decimals every
      // USDG-quoted swap stays unpriced, and an unpriced window would look equal on both sides
      // for the wrong reason.
      entries: [...new Set([...fixture.assets.addresses, fixture.usdg])].map((value) => ({
        address: value,
        decimals: fixture.decimals,
        observedAtBlock: '0',
        blockHash: `0x${'0'.repeat(64)}`,
      })),
    },
  };
  const db = openDatabase(':memory:');
  try {
    commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, {
      ...run.batch,
      previous: null,
      anchors: [run.batch.end, ...resolution.queriedAnchors],
      boundaries: resolution.boundaries,
      logTimes: run.batch.logs.map((log) => ({
        ref: log,
        time: resolution.times.get(rawLogKey(log)) ?? {
          minuteStartSec: null,
          exactTimestampSec: null,
          source: 'unresolved',
        },
      })),
    });
    const report = buildMetricsReport(db, metricInput);
    return {
      measured: true,
      qualityErrors: report.qualityErrors.length,
      coverageIncompleteMinutes: report.coverage.filter((entry) => !entry.complete).length,
      windows: [...report.windows]
        .sort((left, right) => left.poolId.localeCompare(right.poolId))
        .map((window) => ({
          poolId: window.poolId,
          rolling: Object.fromEntries(
            Object.entries(window.rolling ?? {}).map(([name, metric]) => [
              name,
              {
                status: metric.status,
                reasons: metric.reasons,
                swapCount: metric.swapCount,
                txCount: metric.txCount,
                usdMicros: metric.usdMicros === null ? null : metric.usdMicros.toString(),
              },
            ]),
          ),
        })),
      alerts: /** @type {{ payload_json: string }[]} */ (
        db.prepare('select payload_json from alert_outbox order by sequence').all()
      ).map((row) => {
        const alert = JSON.parse(row.payload_json);
        return {
          kind: alert.kind,
          status: alert.status,
          revision: alert.revision,
          poolId: alert.poolId,
          reasons: alert.reasons,
        };
      }),
    };
  } finally {
    db.close();
  }
}

/** A row cell is a count for a list and the value itself otherwise: the tables stay readable. */
const cell = (side, field) => (Array.isArray(side[field]) ? side[field].length : side[field]);

function renderSummary(report) {
  const lines = [
    '# V4 capture experiment: offline comparison',
    '',
    `Fixture: ${report.fixture}`,
    `Schema: schemaVersion ${report.schemaVersion}, bigint codec "${report.bigintCodec}"`,
    `Range: ${report.range.fromBlock}..${report.range.toBlock}, end ${report.range.endHash} at ${report.range.endTimestampSec}`,
    '',
    '| measure | pool-ids | manager |',
    '|---|---|---|',
  ];
  for (const [label, field] of [
    ['requests', 'requests'],
    ['operation requests', 'operationRequests'],
    ['response bytes', 'responseBytes'],
    ['log keys', 'logKeys'],
    ['pools in batch catalogue', 'knownTargets'],
    ['watched log keys', 'watchedLogKeys'],
    ['unknown log keys', 'unknownLogKeys'],
    ['completeness', 'completeness'],
    ['eligible for live', 'eligibleForLive'],
  ])
    lines.push(
      `| ${label} | ${cell(report.strategies['pool-ids'], field)} | ${cell(report.strategies.manager, field)} |`,
    );
  lines.push(
    '',
    'Log key difference:',
    '',
    '```json',
    JSON.stringify(report.logKeyDiff, null, 2),
    '```',
  );
  lines.push('', 'Reasons:', '', '```json', JSON.stringify(report.reasons, null, 2), '```');
  lines.push('', 'Shards:', '', '```json', JSON.stringify(report.shards, null, 2), '```');
  lines.push(
    '',
    'Decoded events:',
    '',
    '```json',
    JSON.stringify(report.decodeDiff, null, 2),
    '```',
  );
  lines.push(
    '',
    'Interpretation:',
    '',
    '```json',
    JSON.stringify(report.metricsDiff, null, 2),
    '```',
  );
  lines.push('', 'Notes:', '');
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const fixturePath = localPath(option(argv, '--fixture'), '--fixture');
  if (!existsSync(fixturePath)) throw new FixtureError(`--fixture does not exist: ${fixturePath}`);
  const out = localPath(option(argv, '--out'), '--out');
  if (existsSync(out)) throw new FixtureError(`--out already exists: ${out}`);

  const fixture = readFixture(fixturePath);
  const poolIds = await captureOne(fixture, 'pool-ids');
  const manager = await captureOne(fixture, 'manager');
  const poolIdsRead = await interpret(fixture, poolIds);
  const managerRead = await interpret(fixture, manager);

  const side = (run) => ({
    requests: run.requests,
    operationRequests: run.operationRequests,
    responseBytes: run.responseBytes,
    logKeys: run.logKeys,
    knownTargets: run.knownTargets,
    watchedLogKeys: run.watchedLogKeys,
    unknownLogKeys: run.unknownLogKeys,
    completeness: run.completeness,
    eligibleForLive: run.eligibleForLive,
  });
  const report = {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    bigintCodec: BIGINT_CODEC,
    fixture: fixturePath,
    range: {
      fromBlock: fixture.range.fromBlock.toString(),
      toBlock: fixture.range.toBlock.toString(),
      endHash: fixture.range.end.hash,
      endTimestampSec: fixture.range.end.timestampSec,
    },
    strategies: { 'pool-ids': side(poolIds), manager: side(manager) },
    logKeyDiff: {
      onlyInPoolIds: poolIds.logKeys.filter((key) => !manager.logKeys.includes(key)),
      onlyInManager: manager.logKeys.filter((key) => !poolIds.logKeys.includes(key)),
    },
    reasons: { 'pool-ids': poolIds.reasons, manager: manager.reasons },
    shards: { 'pool-ids': poolIds.shards, manager: manager.shards },
    decodeDiff: {
      'pool-ids': poolIds.decoded,
      manager: manager.decoded,
      equal: JSON.stringify(poolIds.decoded) === JSON.stringify(manager.decoded),
    },
    metricsDiff: {
      'pool-ids': poolIdsRead,
      manager: managerRead,
      equal: JSON.stringify(poolIdsRead) === JSON.stringify(managerRead),
    },
    notes: [
      'Offline replay over a frozen fixture chain. No provider was contacted and no endpoint was configured.',
      'Request counts and response bytes are planning and payload facts measured on this fixture; they are not provider latency, and this report never converts one into the other.',
      'An incomplete capture is reported as incomplete and is not interpreted: a range that is not complete cannot become coverage.',
      'Unknown log keys are manager-universe evidence the catalogue cannot explain. They keep eligibleForLive false and are never removed from the batch.',
    ],
  };

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(out, 'summary.md'), renderSummary(report));
  process.stdout.write(
    `pool-ids: ${poolIds.requests} requests, ${poolIds.responseBytes} bytes, ${poolIds.logKeys.length} log keys, ${poolIds.completeness}\n` +
      `manager:  ${manager.requests} requests, ${manager.responseBytes} bytes, ${manager.logKeys.length} log keys, ${manager.completeness}\n` +
      `decode equal: ${report.decodeDiff.equal}; metrics equal: ${report.metricsDiff.equal}\n` +
      `wrote ${join(out, 'comparison.json')} and ${join(out, 'summary.md')}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
