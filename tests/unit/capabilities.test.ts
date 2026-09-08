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
  [{ message: 'something failed' }, 'unknown', false],
])('capability error classification %j', (error, status, retryable) => {
  expect(classifyRpcError(error)).toMatchObject({ status, retryable });
});
test('budget counts retries and stops before extra request', () => {
  const meter = new RequestMeter(2);
  meter.begin('eth_getLogs', false); meter.begin('eth_getLogs', true);
  expect(() => meter.begin('eth_getLogs', false)).toThrow(RpcFailure);
  expect(meter.summary()).toMatchObject({ calls: 2, retries: 1 });
});
test('timestamp value is validated, including seconds unit and hash', () => {
  const anchor = { number: 1n, hash: '0xabc', timestampSec: 1788839058 };
  expect(timestampQuality(null, '0xabc', anchor)).toBe('missing');
  expect(timestampQuality('0x0', '0xabc', anchor)).toBe('zero');
  expect(timestampQuality('0x' + BigInt(anchor.timestampSec).toString(16), '0xabc', anchor)).toBe('valid');
  expect(timestampQuality('0x' + (BigInt(anchor.timestampSec) * 1000n).toString(16), '0xabc', anchor)).toBe('mismatch');
});
test('split comparison catches missing and modified logs', () => {
  const a = { blockHash: 'a', transactionHash: 'b', logIndex: 0, data: '0x12' };
  expect(compareLogSets([a], [a])).toBe(true);
  expect(compareLogSets([a], [])).toBe(false);
  expect(compareLogSets([a], [{ ...a, data: '0x13' }])).toBe(false);
});

test.each([10, 20])('accepts adaptive 100-block coverage when direct calls are limited to %i blocks', async (maxRange) => {
  const config = loadChainConfig('config/robinhood.json');
  const meter = new RequestMeter(150);
  const hash = `0x${'ab'.repeat(32)}` as Hex;
  const reader: EvidenceReader = {
    sourceAlias: 'limited-test', meter, anchors: new Map(),
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
      if (filter.toBlock - filter.fromBlock + 1n > BigInt(maxRange)) throw new RpcFailure('range-limit');
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
});
