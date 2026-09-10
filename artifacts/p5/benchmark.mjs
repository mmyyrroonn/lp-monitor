import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { encodeAbiParameters, encodeEventTopics, toHex } from 'viem';
import { v3PoolAbi } from '../../dist/protocols/uniswap-v3/abi.js';
import { encodeJson } from '../../dist/domain/json.js';
import { rawLogKey } from '../../dist/storage/manifest.js';
import { initialSignalConfig } from '../../dist/signals/config.js';
import { replay } from '../../dist/replay/runner.js';

// Reproducible synthetic scaling check: one pool, one raw batch, one log/minute.
// No market evidence, external calls, or source database reads. Run after pnpm build.
globalThis.fetch = async () => {
  throw new Error('Network forbidden in P5 benchmark');
};
const address = (n) => toHex(n, { size: 20 });
const hash = (n) => toHex(n, { size: 32 });
const anchor = (n) => ({ number: BigInt(n), hash: hash(n), timestampSec: n + 60 });
const pool = address(1),
  rwa = address(2),
  usdg = address(3);
const output = resolve(process.argv[2] ?? 'artifacts/p5/benchmark.json');
const outputRelative = relative(resolve('artifacts/p5'), output);
assert.ok(
  !isAbsolute(outputRelative) &&
    outputRelative !== '..' &&
    !outputRelative.startsWith('../') &&
    !outputRelative.startsWith('..\\'),
  'Benchmark output must stay in artifacts/p5',
);
const directory = resolve('artifacts/p5/raw/benchmark-' + randomUUID());
mkdirSync(directory, { recursive: true });
const evidence = {
  measuredAt: new Date().toISOString(),
  command: 'node artifacts/p5/benchmark.mjs ' + (process.argv[2] ?? ''),
  node: process.version,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  sample: 'synthetic single batch, one pool, one swap per minute, no warmup run',
  mode: 'minute-close',
  includes:
    'read, integrity, projection, metrics, signals and result hashes; excludes fixture generation and output report writes',
  sizes: [60, 120, 240, 480],
  samples: [],
  limitation:
    'Single-run timings on this machine; not a latency guarantee or evidence for multi-day cohort feasibility.',
};
for (const minutes of evidence.sizes) {
  const endBlock = (minutes + 1) * 60;
  const logs = Array.from({ length: minutes }, (_, i) => {
    const block = 70 + i * 60;
    return {
      address: pool,
      blockNumber: BigInt(block),
      blockHash: hash(block),
      transactionHash: hash(block + 10000),
      transactionIndex: 0,
      logIndex: 0,
      rawBlockTimestamp: '0x0',
      topics: encodeEventTopics({
        abi: v3PoolAbi,
        eventName: 'Swap',
        args: { sender: pool, recipient: pool },
      }),
      data: encodeAbiParameters(
        [
          { type: 'int256' },
          { type: 'int256' },
          { type: 'uint160' },
          { type: 'uint128' },
          { type: 'int24' },
        ],
        [1000000n, -2000000000n, 2n ** 96n, 1000n, 0],
      ),
    };
  });
  const raw = {
    id: 'sample-' + minutes,
    scopeId: 's',
    fromBlock: 60n,
    toBlock: BigInt(endBlock),
    end: anchor(endBlock),
    previous: null,
    logs,
    observedAtMs: (endBlock + 60) * 1000,
    captureMode: 'live',
    filterPlanHash: 'f',
    manifestHash: 'sample-' + minutes,
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'f',
      expectedShardIds: ['one'],
      shards: [
        {
          shardId: 'one',
          filterId: 'operation-v3',
          request: { fromBlock: 60n, toBlock: BigInt(endBlock), address: [pool], topics: [] },
          status: 'success',
          responseHash: 'synthetic',
          error: null,
          logKeys: logs.map(rawLogKey),
          logCount: logs.length,
        },
      ],
    },
    poolRegistrations: [
      {
        pool: { chainId: 4663, protocol: 'v3', address: pool },
        token0: rwa,
        token1: usdg,
        feePips: 3000,
        tickSpacing: 60,
        hooks: address(0),
        discoveredAt: logs[0],
        assetVersion: 'test',
        source: 'synthetic',
      },
    ],
    logTimes: logs.map((ref) => ({
      ref,
      time: {
        minuteStartSec: Math.floor((Number(ref.blockNumber) + 60) / 60) * 60,
        exactTimestampSec: null,
        source: 'minute-boundary',
      },
    })),
    boundaries: Array.from({ length: minutes + 1 }, (_, i) => {
      const timestampSec = 120 + i * 60,
        n = timestampSec - 60;
      return { timestampSec, firstBlock: BigInt(n), before: anchor(n - 1), at: anchor(n) };
    }),
  };
  const rawText = encodeJson(raw);
  const sha256 = createHash('sha256').update(rawText).digest('hex');
  const manifest = {
    version: 1,
    chainId: 4663,
    scopeId: 's',
    discoveryScope: 's',
    configVersion: 'c',
    assetVersion: 'test',
    batches: [
      {
        id: raw.id,
        scopeId: 's',
        accepted: true,
        path: raw.id + '.json',
        sha256,
        fromBlock: String(raw.fromBlock),
        toBlock: String(raw.toBlock),
        manifestHash: raw.manifestHash,
        completeness: raw.completeness,
        logs: logs.length,
      },
    ],
    replay: {
      version: 1,
      input: {
        configVersion: 'c',
        usdg,
        assets: { version: 'test', rwa: [{ address: rwa }] },
        metadata: {
          version: 'test',
          chainId: 4663,
          source: 'synthetic',
          entries: [rwa, usdg].map((address) => ({
            address,
            decimals: 6,
            observedAtBlock: '0',
            blockHash: hash(0),
          })),
        },
        availableAtSec: 0,
        cohortMode: 'as-of',
      },
    },
  };
  writeFileSync(join(directory, raw.id + '.json'), rawText);
  const manifestPath = join(directory, raw.id + '-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const start = performance.now();
  const result = await replay(manifestPath, initialSignalConfig, 'minute-close');
  const elapsedMs = Math.round(performance.now() - start);
  assert.equal(result.status, 'complete', JSON.stringify(result.issues));
  assert.equal(result.frames.length, minutes);
  const sample = {
    minutes,
    elapsedMs,
    frames: result.frames.length,
    msPerFrame: Math.round((elapsedMs / minutes) * 100) / 100,
    status: result.status,
    codeHash: result.provenance.codeHash,
    businessHash: result.businessHash,
  };
  evidence.samples.push(sample);
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(sample));
}
