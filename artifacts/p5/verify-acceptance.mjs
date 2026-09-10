import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, encodeEventTopics, toHex } from 'viem';
import { v3PoolAbi } from '../../dist/protocols/uniswap-v3/abi.js';
import { encodeJson } from '../../dist/domain/json.js';
import { rawLogKey } from '../../dist/storage/manifest.js';
import { initialSignalConfig } from '../../dist/signals/config.js';
import { replay } from '../../dist/replay/runner.js';

// Standalone synthetic engineering evidence. No source database or provider is opened.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(root);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const rel = (path) => relative(root, resolve(path)).replaceAll('\\', '/');
const runDirectory = resolve('artifacts/p5/raw/acceptance-' + randomUUID());
mkdirSync(runDirectory, { recursive: true });
const commands = [];
const environment = { ...process.env };
for (const key of ['RH_RPC_HTTP', 'RH_RPC_WS', 'RH_PROVIDER_ALIAS']) delete environment[key];
// Direct module checks fail closed if a future change accidentally adds fetch.
globalThis.fetch = async () => { throw new Error('Network forbidden in P5 acceptance'); };
function command(name, args, expectedExit) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: environment, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  const stdout = result.stdout ?? '', stderr = result.stderr ?? '';
  const evidencePath = join(runDirectory, name + '.json');
  writeFileSync(evidencePath, JSON.stringify({ args, exitCode: result.status, stdout, stderr }, null, 2));
  commands.push({ command: ['node', ...args], exitCode: result.status, evidencePath: rel(evidencePath), stdoutSha256: sha(stdout), stderrSha256: sha(stderr) });
  assert.equal(result.status, expectedExit, name + ': ' + stderr);
  return stdout;
}
const help = command('built-help', ['dist/cli.js', 'replay', '--help'], 0);
assert.match(help, /lp replay/);
assert.match(help, /minute-close/);

const address = (n) => toHex(n, { size: 20 });
const blockHash = (n) => toHex(n, { size: 32 });
const anchor = (n) => ({ number: BigInt(n), hash: blockHash(n), timestampSec: n + 60 });
const pool = address(1), rwa = address(2), usdg = address(3);
const logs = Array.from({ length: 79 }, (_, i) => {
  const block = 70 + i * 60;
  const units = i >= 73 && i <= 77 ? 24000 : 2000;
  return { address: pool, blockNumber: BigInt(block), blockHash: blockHash(block), transactionHash: blockHash(block + 10000), transactionIndex: 0, logIndex: 0, rawBlockTimestamp: '0x0',
    topics: encodeEventTopics({ abi: v3PoolAbi, eventName: 'Swap', args: { sender: pool, recipient: pool } }),
    data: encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [1000000n, -BigInt(units) * 1000000n, 2n ** 96n, 1000n, 0]) };
});
const fetchManifest = { version: 1, filterVersion: 'synthetic-p5-acceptance', expectedShardIds: ['one'], shards: [{ shardId: 'one', filterId: 'operation-v3', request: { fromBlock: 60n, toBlock: 4800n, address: [pool], topics: [] }, status: 'success', responseHash: sha(encodeJson(logs)), error: null, logKeys: logs.map(rawLogKey), logCount: logs.length }] };
const raw = { id: 'synthetic-one', scopeId: 'synthetic-p5', fromBlock: 60n, toBlock: 4800n, end: anchor(4800), previous: null, logs, observedAtMs: 4860000, captureMode: 'synthetic', filterPlanHash: sha('synthetic-p5'), manifestHash: sha(encodeJson(fetchManifest)), completeness: 'complete', manifest: fetchManifest,
  poolRegistrations: [{ pool: { chainId: 4663, protocol: 'v3', address: pool }, token0: rwa, token1: usdg, feePips: 3000, tickSpacing: 60, hooks: address(0), discoveredAt: logs[0], assetVersion: 'synthetic-p5', source: 'synthetic' }],
  logTimes: logs.map((ref) => ({ ref, time: { minuteStartSec: Math.floor((Number(ref.blockNumber) + 60) / 60) * 60, exactTimestampSec: null, source: 'minute-boundary' } })),
  boundaries: Array.from({ length: 80 }, (_, i) => { const timestampSec = 120 + i * 60, n = timestampSec - 60; return { timestampSec, firstBlock: BigInt(n), before: anchor(n - 1), at: anchor(n) }; }) };
const rawText = encodeJson(raw);
writeFileSync(join(runDirectory, 'range-synthetic-one.json'), rawText);
const manifest = { version: 1, chainId: 4663, scopeId: raw.scopeId, discoveryScope: raw.scopeId, configVersion: 'synthetic-p5', assetVersion: 'synthetic-p5', batches: [{ id: raw.id, scopeId: raw.scopeId, accepted: true, sha256: sha(rawText) }], replay: { version: 1, input: { configVersion: 'synthetic-p5', usdg, assets: { version: 'synthetic-p5', rwa: [{ symbol: 'SYNTHETIC', address: rwa, identityStatus: 'synthetic' }] }, metadata: { version: 'synthetic-p5', chainId: 4663, source: 'synthetic', entries: [rwa, usdg].map((address) => ({ address, decimals: 6, observedAtBlock: '0', blockHash: blockHash(0) })) }, availableAtSec: 0, cohortMode: 'as-of' } } };
const manifestPath = join(runDirectory, 'manifest.json'), rulesPath = join(runDirectory, 'rules.json');
writeFileSync(manifestPath, encodeJson(manifest));
writeFileSync(rulesPath, encodeJson(initialSignalConfig));
const replayArgs = (manifest, mode, out) => ['dist/cli.js', 'replay', '--manifest', rel(manifest), '--rules', rel(rulesPath), '--mode', mode, '--out', rel(out)];
const recordedReceipt = JSON.parse(command('built-recorded', replayArgs(manifestPath, 'recorded-observed', join(runDirectory, 'recorded')), 0));
const recorded = JSON.parse(readFileSync(join(recordedReceipt.outputDirectory, 'report.json'), 'utf8'));
const implementation = JSON.parse(readFileSync(join(recordedReceipt.outputDirectory, 'implementation.json'), 'utf8'));
assert.ok(implementation.length > 0);
assert.ok(implementation.some((file) => file.path === 'signals/engine.js' && file.content.length > 0));
assert.ok(implementation.some((file) => file.path.endsWith('/abi.js') && file.content.length > 0));
for (const key of ['codeHash', 'abiHash']) {
  assert.match(recorded.provenance[key], /^[a-f0-9]{64}$/);
  assert.notEqual(recorded.provenance[key], sha(encodeJson([])));
}
const one = await replay(manifestPath, initialSignalConfig, 'recorded-observed');
assert.equal(one.businessHash, recorded.businessHash);
assert.equal(one.frames[0].observedAtMs, raw.observedAtMs);
const portablePath = join(recordedReceipt.outputDirectory, 'manifest.json');
const rerunReceipt = JSON.parse(command('built-portable-rerun', replayArgs(portablePath, 'recorded-observed', join(runDirectory, 'rerun')), 0));
const rerun = JSON.parse(readFileSync(join(rerunReceipt.outputDirectory, 'report.json'), 'utf8'));
assert.equal(rerun.businessHash, recorded.businessHash);
const minuteReceipt = JSON.parse(command('built-minute-close', replayArgs(manifestPath, 'minute-close', join(runDirectory, 'minute')), 0));
const minute = JSON.parse(readFileSync(join(minuteReceipt.outputDirectory, 'report.json'), 'utf8'));
assert.ok(minute.frames.length > 60);
assert.ok(minute.alerts.some((alert) => alert.kind === 'candidate'));
for (const frame of minute.frames) for (const value of frame.metrics.valuations) assert.ok(value.time.minuteStartSec < Math.floor(frame.evaluatedAtSec / 60) * 60);

const nativePath = 'artifacts/p1/live/runs/2026-09-08T10-39-47-703Z-89fdf338/manifest.json';
const nativeBefore = sha(readFileSync(nativePath));
const nativeReceipt = JSON.parse(command('built-native-incomplete', replayArgs(nativePath, 'minute-close', join(runDirectory, 'native')), 4));
assert.equal(nativeReceipt.status, 'incomplete');
assert.ok(nativeReceipt.issues.some((issue) => issue.code === 'input-snapshot-missing'));
assert.equal(sha(readFileSync(nativePath)), nativeBefore);
let study = { status: 'not-present' };
if (existsSync('artifacts/p5/results.json')) {
  const text = readFileSync('artifacts/p5/results.json', 'utf8');
  const results = JSON.parse(text);
  assert.equal(results.experiments.length, 36);
  assert.equal(new Set(results.experiments.map((row) => row.id)).size, 36);
  assert.ok(results.experiments.every((row) => row.selectedAsWinner === false));
  study = { status: results.status, rows: results.experiments.length, source: 'artifacts/p5/results.json', sha256: sha(text), studyRunId: results.studyRunId };
}
const acceptance = { version: 'p5-acceptance-v1', status: 'passed', scope: 'offline engineering acceptance only', generatedAtUtc: new Date().toISOString(), artifactDirectory: rel(runDirectory), commands,
  synthetic: { source: 'standalone deterministic generated fixture; not market evidence', manifestPath: rel(manifestPath), manifestSha256: sha(readFileSync(manifestPath)), rawSha256: sha(rawText), recordedFrames: recorded.frames.length, observedAtMs: raw.observedAtMs, businessHash: recorded.businessHash, portableBusinessHash: rerun.businessHash, minuteFrames: minute.frames.length, candidateAlerts: minute.alerts.filter((alert) => alert.kind === 'candidate').length, codeHash: recorded.provenance.codeHash, abiHash: recorded.provenance.abiHash, implementationFiles: implementation.length },
  native: { manifestPath: nativePath, manifestSha256: nativeBefore, status: nativeReceipt.status, issueCodes: [...new Set(nativeReceipt.issues.map((issue) => issue.code))], reportPath: rel(join(nativeReceipt.outputDirectory, 'report.json')) }, study,
  limitations: ['No RPC, capture, mutable source database, notification sink, or live deployment is used.', 'Synthetic equivalence is engineering evidence, not historical live-arrival equivalence.', 'Native P1 lacks original historical snapshots and cannot establish historical strategy effectiveness.', 'Study history may remain incomplete despite engineering acceptance.', 'This script does not claim a unit-test count or LP returns.'] };
writeFileSync('artifacts/p5/acceptance.json', JSON.stringify(acceptance, null, 2) + '\n');
console.log(JSON.stringify({ status: acceptance.status, commands: commands.length, syntheticMinuteFrames: minute.frames.length, nativeStatus: nativeReceipt.status, studyRows: study.rows ?? null, acceptance: 'artifacts/p5/acceptance.json' }));
