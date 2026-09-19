import { expect, test, vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import { loadChainConfig } from '../../src/config/chain.js';
import { parseDuration } from '../../src/ops/recorder-cli.js';
import { warmupStart } from '../../src/ingest/checkpoint.js';
import { toHex } from 'viem';
test('P1 recovery and budget defaults are separate from P0 probe budget', () => {
  const c = loadChainConfig('config/robinhood.json');
  expect(c.warmupMinutes).toBe(60);
  expect(c.checkpointRetentionMinutes).toBe(180);
  expect(c.recorderMaxRpcCalls).toBe(10000);
  expect(c.maxRpcCalls).toBe(150);
  expect(c.maxConcurrentRpc).toBe(2);
  expect(c.maxLogsPerResponse).toBeNull();
  expect(c.maxFilterValues).toBe(1000);
});
test.each([
  ['10m', 600000],
  ['5s', 5000],
  ['1h', 3600000],
  ['1d', 86400000],
  ['30d', 2592000000],
])('bounded duration %s', (s, ms) => expect(parseDuration(String(s))).toBe(ms));
test.each(['', '0m', 'Infinity', '1000000000000h', '-1m', '1.5m'])(
  'bad duration %s rejected',
  (s) => expect(() => parseDuration(s)).toThrow(),
);
test.each([
  ['ingest', '--from-block', '1'],
  ['follow'],
  ['follow', '--duration', '1m', '--to-block', '2'],
  ['ingest', '--from-block', '2', '--to-block', '1'],
])('P1 invalid arguments reject before network %s', async (...args) => {
  await expect(runCli(args, { environment: {} })).rejects.toThrow();
});
test('help exposes both P1 commands without needing RPC', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await runCli(['--help'], { environment: {} })).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain('follow');
    expect(log.mock.calls[0]?.[0]).toContain('ingest');
  } finally {
    log.mockRestore();
  }
});
test('warmup uses chain timestamp minute lower_bound and deployment floor', async () => {
  const mk = (n: bigint) => ({
    number: n,
    hash: toHex(n, { size: 32 }),
    timestampSec: 1000 + Number(n),
  });
  let calls = 0;
  const reader = {
    getAnchor: async (n: bigint | 'latest') => {
      calls++;
      return mk(n === 'latest' ? 10000n : n);
    },
    getLogs: async () => [],
  };
  const start = await warmupStart(reader, mk(10000n), 100n, 60);
  expect(start).toBe(6380n);
  expect(calls).toBeLessThan(20);
  expect(await warmupStart(reader, mk(10000n), 9000n, 60)).toBe(9000n);
});
