import { expect, test } from 'vitest';
import { fetchBoundedLogs } from '../../src/ops/fixture-capture.js';
import { captureFixture, categorizeLogs, eventKey } from '../../src/ops/fixture-capture.js';
import { RpcFailure } from '../../src/rpc/errors.js';
import type { RawLog } from '../../src/domain/types.js';
import type { EvidenceReader } from '../../src/rpc/client.js';
import { RequestMeter } from '../../src/ops/request-meter.js';
import { loadChainConfig } from '../../src/config/chain.js';
import { mkdtempSync, rmSync } from 'node:fs';
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
    anchors,
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
      anchors: new Map(),
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
