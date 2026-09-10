// Run after build, during the initial bounded observation. This reads the DB and RPC only.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadChainConfig } from '../../dist/config/chain.js';
import { loadEnv } from '../../dist/config/env.js';
import { createChainReader } from '../../dist/rpc/client.js';
import { openDatabase } from '../../dist/storage/database.js';
import { SqliteRangeStore } from '../../dist/storage/raw-store.js';
import { loadAssetVersion } from '../../dist/registry/assets.js';
import { PoolRegistry } from '../../dist/registry/pools.js';
import { computeWatchScopeId } from '../../dist/ingest/filter-plan.js';
import { fetchRange } from '../../dist/ingest/record-range.js';
import { resolveLogTimes } from '../../dist/ingest/log-time.js';
import { saveJson } from '../../dist/ops/files.js';
import { encodeJson } from '../../dist/domain/json.js';
const { values } = parseArgs({ options: { db: { type: 'string' }, out: { type: 'string' } } });
const config = loadChainConfig('config/runtime.local.json');
const env = loadEnv(process.env);
const assets = loadAssetVersion('config/watchlist.amc.json');
const deployments = { v3Factory: config.v3Factory, v4Manager: config.v4Manager };
const scopeId = computeWatchScopeId(assets, 'operations', deployments);
const discoveryScope = computeWatchScopeId(assets, 'discovery-only', deployments);
const db = openDatabase(resolve(values.db ?? 'data/p6.sqlite'), { readonly: true });
const store = new SqliteRangeStore(db);
const directory = resolve(values.out ?? 'artifacts/p6', 'comparison-' + new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(directory, { recursive: true });
const startedAtMs = Date.now();
const reader = createChainReader(env, { maxCalls: 200, deadlineMs: startedAtMs + 120000,
  perSecond: config.rpcPerSecond, maxConcurrentRpc: config.maxConcurrentRpc,
  maxBackfillRpcRps: config.maxBackfillRpcRps, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries,
  evidenceMode: 'sampled', evidenceFile: resolve(directory, 'requests.jsonl') });
const meteredReader = { ...reader, getAnchor: (block) => block === 'latest' ? reader.getAnchor(block) : reader.meter.withBackfill(() => reader.getAnchor(block)) };
const measurements = [];
let failure = null;
try {
  if (BigInt(await reader.request('eth_chainId', [])) !== BigInt(config.chainId)) throw Error('chain-identity');
  if (!store.acceptedTip(discoveryScope)) throw Error('registry-not-ready');
  const end = await reader.getAnchor('latest');
  const pools = new PoolRegistry([...store.pools(discoveryScope), ...store.pools(scopeId)]);
  for (const size of [10, 20, 100]) {
    const fromBlock = end.number - BigInt(size) + 1n;
    const before = reader.meter.summary();
    const at = Date.now();
    const batch = await fetchRange(meteredReader, { mode: 'operations', fromBlock, toBlock: end.number, end,
      previous: null, assets, pools, ...deployments, logResponseGuard: config.logResponseGuard,
      maxLogsPerResponse: config.maxLogsPerResponse, maxFilterValues: config.maxFilterValues,
      maxRangeBlocks: size, observedAtMs: at, captureMode: 'live' });
    const logsReadyAtMs = Date.now();
    const timing = batch.completeness === 'complete' ? await reader.meter.withBackfill(() => reader.meter.withPurpose('minute-boundary', () =>
      resolveLogTimes(meteredReader, batch.logs, fromBlock, end, store.anchors(scopeId), store.boundaries(scopeId)))) : null;
    const after = reader.meter.summary();
    const times = timing ? [...timing.times.entries()] : null;
    const unresolvedTimes = times ? times.filter(([, value]) => value.source === 'unresolved').length : null;
    const evidence = saveJson(resolve(directory, 'range-' + size + '.json'), { batch, timing: timing ? { ...timing, times } : null }, directory);
    measurements.push({ rangeBlocks: size, fromBlock, toBlock: end.number, completeness: batch.completeness,
      logs: batch.logs.length, rawZeroTimestampLogs: batch.logs.filter(l => l.rawBlockTimestamp != null && BigInt(l.rawBlockTimestamp) === 0n).length,
      acquisitionMs: logsReadyAtMs - at, withMinuteEvidenceMs: Date.now() - at,
      timingFailures: timing?.failures ?? null, unresolvedTimes, timeEntries: times?.length ?? null, calls: after.calls - before.calls,
      responseBytes: after.responseBytes - before.responseBytes,
      methods: Object.fromEntries(Object.entries(after.methods).map(([name, count]) => [name, count - (before.methods[name] ?? 0)])),
      evidence });
  }
} catch (error) {
  failure = typeof error?.kind === 'string' ? error.kind : 'comparison-incomplete';
  process.exitCode = 4;
} finally {
  await reader.close();
  db.close();
  const result = { sourceAlias: env.providerAlias, startedAtMs, finishedAtMs: Date.now(),
    status: failure === null && measurements.length === 3 && measurements.every(x => x.completeness === 'complete' && x.timingFailures?.length === 0 && x.unresolvedTimes === 0 && x.timeEntries === x.logs) ? 'complete' : 'incomplete',
    failure, measurements, meter: reader.meter.summary(),
    limitation: 'Three overlapping bounded samples from one fixed observed head. Not a sustained-throughput or independent-chain-coverage guarantee.' };
  process.exitCode = result.status === 'complete' ? 0 : 4;
  saveJson(resolve(directory, 'report.json'), result, directory);
  console.log(encodeJson({ directory, ...result }));
}
