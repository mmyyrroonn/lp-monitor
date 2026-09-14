import { expect, test } from 'vitest';
import { fetchBoundedLogs } from '../../src/ingest/fetch-range.js';
import {
  classifyDiscoveryFailures,
  discoveryRetryDelayMs,
  DiscoveryRecoveryStop,
} from '../../src/ingest/discovery-recovery.js';

test('only classified transient failures retry', () => {
  expect(classifyDiscoveryFailures(['timeout-or-network', 'rate-limit'])).toBe('retry');
  expect(classifyDiscoveryFailures(['http-transient'])).toBe('retry');
  expect(classifyDiscoveryFailures(['anchor-changed', 'anchor-conflict'])).toBe('retry');
  expect(classifyDiscoveryFailures(['user-stop', 'shutdown', 'sigint', 'sigterm'])).toBe('stop');
  expect(classifyDiscoveryFailures(['timeout-or-network', 'conflicting-log-identity'])).toBe(
    'fatal',
  );
  expect(classifyDiscoveryFailures(['deadline'])).toBe('stop');
  expect([1, 2, 3, 4, 5, 6].map(discoveryRetryDelayMs)).toEqual([
    2000, 4000, 8000, 16000, 30000, 30000,
  ]);
});

test('unknown, empty, and mixed stop failures fail closed', () => {
  expect(classifyDiscoveryFailures([])).toBe('fatal');
  expect(classifyDiscoveryFailures(['unknown-provider-failure'])).toBe('fatal');
  expect(classifyDiscoveryFailures(['budget', 'user-stop'])).toBe('stop');
  expect(classifyDiscoveryFailures(['deadline', 'timeout-or-network'])).toBe('fatal');
});

test('retry delays reject zero and non-integer failure counts', () => {
  expect(() => discoveryRetryDelayMs(0)).toThrow(RangeError);
  expect(() => discoveryRetryDelayMs(1.5)).toThrow(RangeError);
  expect(() => discoveryRetryDelayMs(-1)).toThrow(RangeError);
});

test('preserves an interruptible budget stop as an incomplete leaf', async () => {
  const result = await fetchBoundedLogs(
    {
      getLogs: async () => {
        throw new DiscoveryRecoveryStop('budget');
      },
    },
    { fromBlock: 1n, toBlock: 1n, address: [], topics: [] },
    5_000,
    undefined,
    { captureCriticalFailures: true },
  );

  expect(result.complete).toBe(false);
  expect(result.failureKinds).toEqual(['budget']);
  expect(result.failures[0]?.reason).toBe('budget');
  expect(result.fragments[0]?.status).toBe('failed');
});
