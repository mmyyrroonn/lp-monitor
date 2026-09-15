import { expect, test } from 'vitest';
import { classifyRpcError, RpcFailure } from '../../src/rpc/errors.js';
import { RequestMeter } from '../../src/ops/request-meter.js';
import { compareLogSets, timestampQuality } from '../../src/rpc/capabilities.js';
import { probeCapabilities } from '../../src/rpc/capabilities.js';
import { loadChainConfig } from '../../src/config/chain.js';
import type { EvidenceReader } from '../../src/rpc/client.js';
import type { Hex, Address } from 'viem';
test.each([
  [{ code: -32601 }, 'unsupported', false],
  [{ status: 429 }, 'unknown', true],
  [{ name: 'TimeoutError' }, 'unknown', true],
  [{ message: 'missing trie node' }, 'unsupported', false],
  // The residual fallback is retryable: one unfamiliar provider message must not end a scan.
  [{ message: 'something failed' }, 'unknown', true],
])('capability error classification %j', (error, status, retryable) => {
  expect(classifyRpcError(error)).toMatchObject({ status, retryable });
});
test('budget counts retries and stops before extra request', () => {
  const meter = new RequestMeter(2);
  meter.begin('eth_getLogs', false);
  meter.begin('eth_getLogs', true);
  expect(() => meter.begin('eth_getLogs', false)).toThrow(RpcFailure);
  expect(meter.summary()).toMatchObject({ calls: 2, retries: 1 });
});
test('timestamp value is validated, including seconds unit and hash', () => {
  const anchor = { number: 1n, hash: '0xabc', timestampSec: 1788839058 };
  expect(timestampQuality(null, '0xabc', anchor)).toBe('missing');
  expect(timestampQuality('0x0', '0xabc', anchor)).toBe('zero');
  expect(timestampQuality('0x' + BigInt(anchor.timestampSec).toString(16), '0xabc', anchor)).toBe(
    'valid',
  );
  expect(
    timestampQuality('0x' + (BigInt(anchor.timestampSec) * 1000n).toString(16), '0xabc', anchor),
  ).toBe('mismatch');
});
test('split comparison catches missing and modified logs', () => {
  const a = { blockHash: 'a', transactionHash: 'b', logIndex: 0, data: '0x12' };
  expect(compareLogSets([a], [a])).toBe(true);
  expect(compareLogSets([a], [])).toBe(false);
  expect(compareLogSets([a], [{ ...a, data: '0x13' }])).toBe(false);
});

test.each([10, 20])(
  'accepts adaptive 100-block coverage when direct calls are limited to %i blocks',
  async (maxRange) => {
    const config = loadChainConfig('config/robinhood.json');
    const meter = new RequestMeter(150);
    const hash = `0x${'ab'.repeat(32)}` as Hex;
    const reader: EvidenceReader = {
      sourceAlias: 'limited-test',
      meter,
      async request(method) {
        meter.begin(method, false);
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'eth_getCode') return '0x6000';
        if (method === 'eth_call') return `0x${'0'.repeat(63)}6`;
        throw new Error(`unexpected ${method}`);
      },
      async getAnchor(block) {
        meter.begin('eth_getBlockByNumber', false);
        const number = block === 'latest' ? 1_000n : block;
        return { number, hash, timestampSec: Number(number) + 1_000 };
      },
      async getLogs(filter) {
        meter.begin('eth_getLogs', false);
        if (filter.toBlock - filter.fromBlock + 1n > BigInt(maxRange))
          throw new RpcFailure('range-limit');
        return [];
      },
    };

    const report = await probeCapabilities(reader, { config, evidenceFile: 'test.jsonl' });
    expect(report.requiredPassed).toBe(true);
    expect(report.capabilities.rangeLogs100).toMatchObject({
      status: 'supported',
      detail: { direct: { status: 'unknown', kind: 'range-limit' }, adaptive: { complete: true } },
    });
    expect(report.capabilities.currentCode!.detail).not.toHaveProperty('code');
    expect(report.capabilities.currentCall!.detail).toMatchObject({ decimals: 6 });
  },
);

test('probe propagates quota exhaustion rather than reporting unsupported capability', async () => {
  const reader = {
    request: async () => {
      throw new RpcFailure('budget');
    },
    meter: new RequestMeter(1),
    sourceAlias: 'test',
  } as unknown as EvidenceReader;
  await expect(
    probeCapabilities(reader, {
      config: loadChainConfig('config/robinhood.json'),
      evidenceFile: 'requests.jsonl',
    }),
  ).rejects.toMatchObject({ kind: 'budget' });
});
test('single timestamp sample is inspected once', async () => {
  const config = loadChainConfig('config/robinhood.json');
  let timestampQueries = 0;
  const log = {
    address: config.v4Manager,
    blockNumber: 995n,
    blockHash: '0xabc',
    transactionHash: '0xdef',
    logIndex: 0,
    transactionIndex: 0,
    topics: [],
    data: '0x',
    rawBlockTimestamp: '0x7cb',
  };
  const reader = {
    sourceAlias: 'test',
    meter: new RequestMeter(),
    request: async (method: string) =>
      method === 'eth_chainId' ? '0x1237' : method === 'eth_getCode' ? '0x6000' : '0x06',
    getAnchor: async (block: bigint | 'latest') => {
      if (block === 995n) timestampQueries++;
      return {
        number: block === 'latest' ? 1000n : block,
        hash: '0xabc',
        timestampSec: Number(block === 'latest' ? 1000n : block) + 1000,
      };
    },
    getLogs: async (f: any) => (f.fromBlock <= 995n && f.toBlock >= 995n ? [log] : []),
  } as unknown as EvidenceReader;
  const report = await probeCapabilities(reader, { config, evidenceFile: 'requests.jsonl' });
  expect(report.logTimestamp.sampled).toBe(1);
  expect(timestampQueries).toBe(1);
});

test.each([0n, 1n, 9n, 19n, 99n])(
  'young chain %s never requests a negative or future block range',
  async (head) => {
    const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
    const reader = {
      sourceAlias: 'young-chain',
      meter: new RequestMeter(),
      request: async (method: string) =>
        method === 'eth_chainId' ? '0x1237' : method === 'eth_getCode' ? '0x6000' : '0x06',
      getAnchor: async (block: bigint | 'latest') => ({
        number: block === 'latest' ? head : block,
        hash: '0xabc' as Hex,
        timestampSec: Number(block === 'latest' ? head : block),
      }),
      getLogs: async (f: { fromBlock: bigint; toBlock: bigint }) => {
        ranges.push(f);
        return [];
      },
    } as EvidenceReader;
    await probeCapabilities(reader, {
      config: loadChainConfig('config/robinhood.json'),
      evidenceFile: 'requests.jsonl',
    });
    expect(ranges.length).toBeGreaterThan(0);
    for (const f of ranges) {
      expect(f.fromBlock).toBeGreaterThanOrEqual(0n);
      expect(f.toBlock).toBeGreaterThanOrEqual(f.fromBlock);
      expect(f.toBlock).toBeLessThanOrEqual(head);
    }
  },
);

test('probe does not adapt a range-limit carrying evidence failure', async () => {
  let calls = 0;
  const error = new RpcFailure('range-limit');
  error.evidenceFailure = new RpcFailure('evidence-capacity');
  const reader: EvidenceReader = {
    sourceAlias: 'secondary-failure',
    meter: new RequestMeter(null),
    async request(method) {
      return method === 'eth_chainId' ? '0x1237' : '0x12';
    },
    async getAnchor(block) {
      return { number: block === 'latest' ? 200n : block, hash: '0xaa', timestampSec: 2000 };
    },
    async getLogs() {
      calls++;
      if (calls === 1) throw error;
      return [];
    },
  };
  await expect(
    probeCapabilities(reader, {
      config: loadChainConfig('config/robinhood.json'),
      evidenceFile: '',
    }),
  ).rejects.toBe(error);
  expect(calls).toBe(1);
});
