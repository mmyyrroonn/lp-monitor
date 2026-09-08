import { expect, test } from 'vitest';
import { fetchBoundedLogs } from '../../src/ops/fixture-capture.js';
import { captureFixture, categorizeLogs, eventKey } from '../../src/ops/fixture-capture.js';
import { RpcFailure } from '../../src/rpc/errors.js';
import type { RawLog } from '../../src/domain/types.js';
import type { EvidenceReader } from '../../src/rpc/client.js';
import { RequestMeter } from '../../src/ops/request-meter.js';
import { loadChainConfig } from '../../src/config/chain.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
test('range limit splits without skipping blocks', async () => {
  const seen: string[] = [];
  const reader = {
    getLogs: async (f: { fromBlock: bigint; toBlock: bigint }) => {
      seen.push(`${f.fromBlock}-${f.toBlock}`);
      if (f.toBlock - f.fromBlock > 1n) throw new RpcFailure('range-limit', 'unknown', false);
      return [] as RawLog[];
    },
  };
  const result = await fetchBoundedLogs(
    reader,
    { fromBlock: 1n, toBlock: 4n, address: [], topics: [] },
    5000,
  );
  expect(seen).toEqual(['1-4', '1-2', '3-4']);
  expect(result.complete).toBe(true);
});
test('failed subrange stays incomplete, not zero-volume evidence', async () => {
  const reader = {
    getLogs: async () => {
      throw new RpcFailure('budget', 'unknown', false);
    },
  };
  await expect(
    fetchBoundedLogs(reader, { fromBlock: 1n, toBlock: 4n, address: [], topics: [] }, 5000),
  ).rejects.toMatchObject({ kind: 'budget' });
});
test('single block at guard cannot silently pass', async () => {
  const reader = { getLogs: async () => [{} as RawLog] };
  const result = await fetchBoundedLogs(
    reader,
    { fromBlock: 1n, toBlock: 1n, address: [], topics: [] },
    1,
  );
  expect(result.complete).toBe(false);
});

test('reports every configured V4 seed separately when Initialize evidence is missing', () => {
  const config = loadChainConfig('config/robinhood.json');
  const result = categorizeLogs([], config);
  expect(result.seedVerifications).toEqual(
    config.v4PoolIds.map((poolId) => ({ poolId, status: 'unverified' })),
  );
});

test('marks a range incomplete when the fork changes during minute-boundary resolution', async () => {
  const config = loadChainConfig('config/robinhood.json');
  const meter = new RequestMeter(150);
  const anchors = new Map<string, { number: bigint; hash: Hex; timestampSec: number }>();
  let anchorCalls = 0;
  const reader: EvidenceReader = {
    sourceAlias: 'reorg-test',
    meter,
    async flush() {},
    async close() {},
    async request(method) {
      meter.begin(method, false);
      if (method === 'eth_chainId') return '0x1237';
      throw new Error(`unexpected ${method}`);
    },
    async getLogs() {
      meter.begin('eth_getLogs', false);
      return [];
    },
    async getAnchor(block) {
      meter.begin('eth_getBlockByNumber', false);
      const number = block === 'latest' ? 2n : block;
      anchorCalls += 1;
      const fork = anchorCalls >= 3 ? 'bb' : 'aa';
      const value = {
        number,
        hash: `0x${fork.repeat(32)}` as Hex,
        timestampSec: number === 1n ? 60 : 120,
      };
      anchors.set(number.toString(), value);
      return value;
    },
  };
  const outDir = mkdtempSync(join(tmpdir(), 'fixture-reorg-'));
  try {
    const manifest = await captureFixture(reader, config, {
      fromBlock: 1n,
      toBlock: 2n,
      captureMode: 'backfill',
      outDir,
      supplementHistory: false,
    });
    expect(manifest.failures).toContain('primary:anchor-conflict');
    expect(manifest.completeness).toBe('incomplete');
    const stored = JSON.parse(readFileSync(join(outDir, 'anchors.json'), 'utf8')) as {
      number: string;
      hash: string;
    }[];
    expect(new Set(stored.filter((a) => a.number === '2').map((a) => a.hash)).size).toBe(2);
    expect(stored.length).toBe(new Set(stored.map((a) => a.number + ':' + a.hash)).size);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('event keys normalize provider hash case', () => {
  const log = { blockHash: '0xAB', transactionHash: '0xCD', logIndex: 1 } as unknown as RawLog;
  expect(eventKey(log)).toBe(eventKey({ ...log, blockHash: '0xab', transactionHash: '0xcd' }));
});
test('rate limit is propagated without splitting', async () => {
  let calls = 0;
  const reader = {
    getLogs: async () => {
      calls++;
      throw new RpcFailure('rate-limit');
    },
  };
  await expect(
    fetchBoundedLogs(reader, { fromBlock: 1n, toBlock: 4n, address: [], topics: [] }, 5000),
  ).rejects.toMatchObject({ kind: 'rate-limit' });
  expect(calls).toBe(1);
});

test.each(['budget', 'rate-limit'])(
  'capture retains %s in its incomplete manifest',
  async (kind) => {
    const config = loadChainConfig('config/robinhood.json');
    const reader = {
      sourceAlias: 'capture-failure',
      meter: new RequestMeter(150),
      async flush() {},
      async close() {},
      async request() {
        return '0x1237';
      },
      async getLogs() {
        throw new RpcFailure(kind);
      },
      async getAnchor(block: bigint | 'latest') {
        const number = block === 'latest' ? 1n : block;
        return { number, hash: '0xaa' as Hex, timestampSec: Number(number) * 10 };
      },
    } satisfies EvidenceReader;
    const outDir = mkdtempSync(join(tmpdir(), 'capture-failure-'));
    try {
      const report = await captureFixture(reader, config, {
        fromBlock: 0n,
        toBlock: 1n,
        captureMode: 'backfill',
        outDir,
        supplementHistory: false,
      });
      expect(report.failures).toContain('primary:' + kind);
      expect(report.acceptancePassed).toBe(false);
      expect(report.failures).not.toContain('primary:invalid-time-anchors');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  },
);
test('capture rejects malformed chain ID as typed RPC failure', async () => {
  const reader = { request: async () => 'not-a-quantity' } as unknown as EvidenceReader;
  await expect(
    captureFixture(reader, loadChainConfig('config/robinhood.json'), {
      fromBlock: 0n,
      toBlock: 1n,
      captureMode: 'backfill',
      outDir: 'unused',
    }),
  ).rejects.toMatchObject({ kind: 'malformed-response' });
});

test('initial capture chunks obey configured maximum range size', async () => {
  const ranges: string[] = [];
  const reader = {
    getLogs: async (f: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push(f.fromBlock + '-' + f.toBlock);
      return [];
    },
  };
  await fetchBoundedLogs(reader, { fromBlock: 0n, toBlock: 7n, address: [], topics: [] }, 5000, 3n);
  expect(ranges).toEqual(['0-2', '3-5', '6-7']);
});

test('shared capture ranges persist each consistent anchor once', async () => {
  const config = loadChainConfig('config/robinhood.json');
  config.v4PoolHistoryHints = config.v4PoolHistoryHints.map((h) => ({
    poolId: h.poolId,
    timestampSec: 600,
  }));
  config.deploymentCandidateBlock = '900';
  const requested: Array<bigint | 'latest'> = [];
  const reader = {
    sourceAlias: 'dedup',
    meter: new RequestMeter(null),
    async flush() {},
    async close() {},
    async request() {
      return '0x1237';
    },
    async getLogs() {
      return [];
    },
    async getAnchor(block: bigint | 'latest') {
      requested.push(block);
      const number = block === 'latest' ? 1000n : block;
      return {
        number,
        hash: ('0x' + number.toString(16).padStart(64, '0')) as Hex,
        timestampSec: Number(number) * 10,
      };
    },
  } satisfies EvidenceReader;
  const outDir = mkdtempSync(join(tmpdir(), 'capture-dedup-'));
  try {
    const manifest = await captureFixture(reader, config, {
      fromBlock: 800n,
      toBlock: 810n,
      captureMode: 'backfill',
      outDir,
    });
    const anchors = JSON.parse(readFileSync(join(outDir, 'anchors.json'), 'utf8')) as {
      number: string;
    }[];
    expect(anchors.length).toBe(new Set(anchors.map((a) => a.number)).size);
    expect(manifest.failures).toEqual([]);
    expect(requested).not.toContain('latest');
    expect((manifest.rangeEvidence[1] as { filter: { fromBlock: bigint } }).filter.fromBlock).toBe(
      40n,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test.each([1, 3, 7])('range splitting never exceeds maxCalls=%s', async (maxCalls) => {
  const meter = new RequestMeter(maxCalls);
  let dispatched = 0;
  const reader = {
    async getLogs() {
      meter.begin('eth_getLogs', false);
      dispatched++;
      throw new RpcFailure('range-limit');
    },
  };
  await expect(
    fetchBoundedLogs(reader, { fromBlock: 0n, toBlock: 1023n, address: [], topics: [] }, 5000),
  ).rejects.toMatchObject({ kind: 'budget' });
  expect(dispatched).toBe(maxCalls);
  expect(meter.summary().calls).toBeLessThanOrEqual(maxCalls);
});

test.each([
  ['59', '60', true],
  ['61', '62', false],
])('seed hint bounds %s-%s are verified before use', async (fromBlock, toBlock, valid) => {
  const config = loadChainConfig('config/robinhood.json');
  config.v4PoolHistoryHints = config.v4PoolHistoryHints.map((h) => ({
    ...h,
    timestampSec: 600,
    fromBlock,
    toBlock,
  }));
  const requested: Array<bigint | 'latest'> = [];
  const reader = {
    sourceAlias: 'seed-bounds',
    meter: new RequestMeter(null),
    async flush() {},
    async close() {},
    async request() {
      return '0x1237';
    },
    async getLogs() {
      return [];
    },
    async getAnchor(block: bigint | 'latest') {
      requested.push(block);
      const number = block === 'latest' ? 1000n : block;
      return {
        number,
        hash: ('0x' + number.toString(16).padStart(64, '0')) as Hex,
        timestampSec: Number(number) * 10,
      };
    },
  } satisfies EvidenceReader;
  const outDir = mkdtempSync(join(tmpdir(), 'seed-bounds-'));
  try {
    const manifest = await captureFixture(reader, config, {
      fromBlock: 800n,
      toBlock: 801n,
      captureMode: 'backfill',
      outDir,
    });
    expect(requested).toContain(BigInt(fromBlock));
    expect(requested).toContain(BigInt(toBlock));
    expect(requested).not.toContain(0n);
    expect(requested).not.toContain('latest');
    if (valid) expect(manifest.failures).toEqual([]);
    else {
      expect(manifest.completeness).toBe('incomplete');
      expect(manifest.failures.some((f) => f.startsWith('seed-1-supplement:'))).toBe(true);
      expect(manifest.rangeEvidence).toHaveLength(1);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('adaptive log fetching preserves secondary evidence failure without more calls', async () => {
  const error = new RpcFailure('range-limit');
  error.evidenceFailure = new RpcFailure('evidence-capacity');
  let calls = 0;
  const reader = {
    async getLogs() {
      calls++;
      if (calls === 1) throw error;
      return [];
    },
  };
  await expect(
    fetchBoundedLogs(reader, { fromBlock: 1n, toBlock: 10n, address: [], topics: [] }, 5000),
  ).rejects.toBe(error);
  expect(calls).toBe(1);
});

test.each(['anchor', 'logs'])(
  'capture retains primary and secondary %s failure in manifest',
  async (where) => {
    const error = new RpcFailure('timeout-or-network');
    error.evidenceFailure = new RpcFailure('evidence-capacity');
    const reader: EvidenceReader = {
      sourceAlias: 'secondary-capture',
      meter: new RequestMeter(null),
      async request() {
        return '0x1237';
      },
      async getAnchor(block) {
        if (where === 'anchor') throw error;
        const number = block === 'latest' ? 1n : block;
        return { number, hash: '0xaa', timestampSec: Number(number) * 10 };
      },
      async getLogs() {
        throw error;
      },
    };
    const outDir = mkdtempSync(join(tmpdir(), 'capture-secondary-'));
    try {
      const manifest = await captureFixture(reader, loadChainConfig('config/robinhood.json'), {
        fromBlock: 0n,
        toBlock: 1n,
        captureMode: 'backfill',
        outDir,
        supplementHistory: false,
      });
      expect(manifest.completeness).toBe('incomplete');
      expect(manifest.acceptancePassed).toBe(false);
      expect(manifest.failures).toContain('primary:timeout-or-network');
      expect(manifest.failures).toContain('primary:evidence:evidence-capacity');
      expect(JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')).failures).toEqual(
        manifest.failures,
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  },
);
