import { expect, test } from 'vitest';
import { fetchBoundedLogs } from '../../src/ops/fixture-capture.js';
import { captureFixture, categorizeLogs } from '../../src/ops/fixture-capture.js';
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
  const reader = { getLogs: async (f: { fromBlock: bigint; toBlock: bigint }) => {
    seen.push(`${f.fromBlock}-${f.toBlock}`);
    if (f.toBlock - f.fromBlock > 1n) throw new RpcFailure('range-limit', 'unknown', false);
    return [] as RawLog[];
  }};
  const result = await fetchBoundedLogs(reader, { fromBlock: 1n, toBlock: 4n, address: [], topics: [] }, 5000);
  expect(seen).toEqual(['1-4', '1-2', '3-4']);
  expect(result.complete).toBe(true);
});
test('failed subrange stays incomplete, not zero-volume evidence', async () => {
  const reader = { getLogs: async () => { throw new RpcFailure('budget', 'unknown', false); } };
  const result = await fetchBoundedLogs(reader, { fromBlock: 1n, toBlock: 4n, address: [], topics: [] }, 5000);
  expect(result.complete).toBe(false);
  expect(result.failures).toHaveLength(1);
});
test('single block at guard cannot silently pass', async () => {
  const reader = { getLogs: async () => [{} as RawLog] };
  const result = await fetchBoundedLogs(reader, { fromBlock: 1n, toBlock: 1n, address: [], topics: [] }, 1);
  expect(result.complete).toBe(false);
});

test('reports every configured V4 seed separately when Initialize evidence is missing', () => {
  const config = loadChainConfig('config/robinhood.json');
  const result = categorizeLogs([], config);
  expect(result.seedVerifications).toEqual(config.v4PoolIds.map(poolId => ({ poolId, status: 'unverified' })));
});

test('marks a range incomplete when the fork changes during minute-boundary resolution', async () => {
  const config = loadChainConfig('config/robinhood.json');
  const meter = new RequestMeter(150);
  const anchors = new Map<string, { number: bigint; hash: Hex; timestampSec: number }>();
  let anchorCalls = 0;
  const reader: EvidenceReader = {
    sourceAlias: 'reorg-test', meter, anchors,
    async request(method) {
      meter.begin(method, false);
      if (method === 'eth_chainId') return '0x1237';
      throw new Error(`unexpected ${method}`);
    },
    async getLogs() { meter.begin('eth_getLogs', false); return []; },
    async getAnchor(block) {
      meter.begin('eth_getBlockByNumber', false);
      const number = block === 'latest' ? 2n : block;
      anchorCalls += 1;
      const fork = anchorCalls >= 5 ? 'bb' : 'aa';
      const value = { number, hash: `0x${fork.repeat(32)}` as Hex, timestampSec: number === 1n ? 60 : 120 };
      anchors.set(number.toString(), value);
      return value;
    },
  };
  const outDir = mkdtempSync(join(tmpdir(), 'fixture-reorg-'));
  try {
    const manifest = await captureFixture(reader, config, { fromBlock: 1n, toBlock: 2n, captureMode: 'backfill', outDir, supplementHistory: false });
    expect(manifest.failures).toContain('primary:anchor-conflict');
    expect(manifest.completeness).toBe('incomplete');
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});
