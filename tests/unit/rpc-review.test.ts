import { expect, test, vi } from 'vitest';
import { RequestMeter } from '../../src/ops/request-meter.js';
import { classifyRpcError } from '../../src/rpc/errors.js';
import { RateLimiter } from '../../src/rpc/rate-limit.js';
import { createChainReader } from '../../src/rpc/client.js';
const env = { httpRpcUrl: 'https://secret.invalid/429', providerAlias: 'test', dataDir: 'data' };
test('unlimited meter and short elapsed rate', () => {
  vi.useFakeTimers();
  try {
    const meter = new RequestMeter(null);
    meter.begin('eth_call', false);
    vi.advanceTimersByTime(100);
    expect(meter.summary()).toMatchObject({ calls: 1, averageRpcPerSecond: 10 });
    expect(meter.remainingCalls).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
test.each([
  [{ status: 503, message: 'HTTP https://rpc/429' }, 'http-transient', true],
  [{ code: -32601, message: '429' }, 'method-not-found', false],
  [{ code: -32005, message: 'block range too large' }, 'range-limit', false],
  [{ code: -32005, message: 'rate limit exceeded' }, 'rate-limit', true],
  [{ code: -32005, message: 'limit exceeded' }, 'unknown-limit', false],
  [{ message: 'HTTP https://rpc/429' }, 'request-failed', false],
])('classifies structured provider errors safely %j', (error, kind, retryable) => {
  expect(classifyRpcError(error)).toMatchObject({ kind, retryable });
  expect(classifyRpcError(error).message).not.toContain('https');
});
test('penalty recovers after success and rate can exceed five', async () => {
  vi.useFakeTimers();
  try {
    const limiter = new RateLimiter(10);
    limiter.penalize();
    for (let i = 0; i < 12; i++) limiter.succeed();
    const first = limiter.acquire();
    await vi.runAllTimersAsync();
    await first;
    const start = Date.now();
    const next = limiter.acquire();
    await vi.runAllTimersAsync();
    await next;
    expect(Date.now() - start).toBe(100);
  } finally {
    vi.useRealTimers();
  }
});
test('logs normalize hashes, addresses and filter topics', async () => {
  const hash = '0x' + 'AB'.repeat(32),
    address = ('0x' + 'AB'.repeat(20)) as `0x${string}`;
  const reader = createChainReader(env, {
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: [
            {
              address,
              topics: [hash],
              data: '0xAB',
              blockNumber: '0x1',
              blockHash: hash,
              transactionHash: hash,
              transactionIndex: '0x0',
              logIndex: '0x0',
            },
          ],
        }),
      ),
  });
  const logs = await reader.getLogs({
    fromBlock: 1n,
    toBlock: 1n,
    address: [address],
    topics: [hash.toLowerCase() as `0x${string}`],
  });
  expect(logs[0]).toMatchObject({
    address: address.toLowerCase(),
    blockHash: hash.toLowerCase(),
    data: '0xab',
  });
});
test('budget exhaustion bypasses rate wait', async () => {
  const reader = createChainReader(env, {
    maxCalls: 1,
    perSecond: 0.001,
    fetchFn: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' })),
  });
  await reader.request('eth_chainId', []);
  await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({ kind: 'budget' });
}, 500);
test('concurrency defaults to two and configurable one serializes active transports', async () => {
  for (const concurrency of [undefined, 1, 3]) {
    let active = 0,
      peak = 0;
    const reader = createChainReader(env, {
      perSecond: 10000,
      maxConcurrentRpc: concurrency,
      fetchFn: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
      },
    });
    await Promise.all(Array.from({ length: 6 }, () => reader.request('eth_chainId', [])));
    expect(peak).toBe(concurrency ?? 2);
    await reader.close();
  }
});
test.each([
  [{ removed: true }, 'log-range-or-removed'],
  [{ blockNumber: '0x2' }, 'log-range-or-removed'],
  [{ address: '0x' + 'CD'.repeat(20) }, 'log-address-mismatch'],
  [{ topics: ['0x' + 'CD'.repeat(32)] }, 'log-topic-mismatch'],
  [{ topics: null }, 'malformed-topics'],
  [{ data: '0x1' }, 'malformed-log-data'],
])('rejects malformed/out-of-filter logs %j', async (patch, kind) => {
  const address = ('0x' + 'ab'.repeat(20)) as `0x${string}`,
    hash = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
  const reader = createChainReader(env, {
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: [
            {
              address,
              topics: [hash],
              data: '0x',
              blockNumber: '0x1',
              blockHash: hash,
              transactionHash: hash,
              transactionIndex: '0x0',
              logIndex: '0x0',
              ...patch,
            },
          ],
        }),
      ),
  });
  await expect(
    reader.getLogs({ fromBlock: 1n, toBlock: 1n, address: [address], topics: [hash] }),
  ).rejects.toMatchObject({ kind });
});
test.each([204, 304])('empty HTTP %i returns safe failure', async (status) => {
  const reader = createChainReader(env, {
    maxRetries: 0,
    fetchFn: async () => new Response(null, { status }),
  });
  await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({
    message: expect.stringMatching(/^RPC /),
  });
});
test('503 retries once and counts retry', async () => {
  let calls = 0;
  const reader = createChainReader(env, {
    fetchFn: async () =>
      ++calls === 1
        ? new Response('secret', { status: 503 })
        : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' })),
  });
  expect(await reader.request('eth_chainId', [])).toBe('0x1');
  expect(reader.meter.summary()).toMatchObject({ calls: 2, retries: 1 });
});
import { HttpRequestError, RpcRequestError, TimeoutError } from 'viem';
test.each([
  [new HttpRequestError({ url: 'https://secret.invalid/429', status: 503 }), 'http-transient'],
  [new HttpRequestError({ url: 'https://secret.invalid', status: 429 }), 'rate-limit'],
  [new TimeoutError({ url: 'https://secret.invalid/429', body: {} }), 'timeout-or-network'],
  [
    new RpcRequestError({
      url: 'https://secret.invalid/429',
      body: {},
      error: { code: -32601, message: 'Method not found' },
    }),
    'method-not-found',
  ],
  [
    new RpcRequestError({
      url: 'https://secret.invalid/429',
      body: {},
      error: { code: -32005, message: 'CU per second limit exceeded' },
    }),
    'rate-limit',
  ],
  [
    new RpcRequestError({
      url: 'https://secret.invalid/429',
      body: {},
      error: { code: -32005, message: 'CU/sec exceeded' },
    }),
    'rate-limit',
  ],
  [
    new RpcRequestError({
      url: 'https://secret.invalid/429',
      body: {},
      error: { code: -32005, message: 'block range too large' },
    }),
    'range-limit',
  ],
  [new TypeError('fetch failed'), 'timeout-or-network'],
])('real viem error %s is %s without secrets', (error, kind) => {
  const failure = classifyRpcError(error);
  expect(failure.kind).toBe(kind);
  expect(failure.message).not.toContain('secret');
});
test('anchor hash normalizes and reader does not accumulate unused anchors', async () => {
  const reader = createChainReader(env, {
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { number: '0x1', hash: '0x' + 'AB'.repeat(32), timestamp: '0x1' },
        }),
      ),
  });
  expect((await reader.getAnchor(1n)).hash).toBe('0x' + 'ab'.repeat(32));
  expect('anchors' in reader).toBe(false);
});
test('meter peak uses a bounded sliding second including exact expiration', () => {
  vi.useFakeTimers();
  try {
    const meter = new RequestMeter(null);
    for (let i = 0; i < 10000; i++) {
      meter.begin('eth_call', false);
      vi.advanceTimersByTime(10);
    }
    expect(meter.summary()).toMatchObject({ calls: 10000, peakOneSecond: 100 });
    expect('callTimes' in meter).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('concurrent budget exhaustion does not wait for a queued rate slot', async () => {
  vi.useFakeTimers();
  try {
    let networkCalls = 0;
    const reader = createChainReader(env, {
      maxCalls: 1,
      perSecond: 0.001,
      maxConcurrentRpc: 2,
      fetchFn: async () => {
        networkCalls++;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
      },
    });
    const start = Date.now();
    const settled = Promise.allSettled([
      reader.request('eth_chainId', []),
      reader.request('eth_chainId', []),
    ]);
    await vi.runAllTimersAsync();
    const result = await settled;
    expect(networkCalls).toBe(1);
    expect(result[1]).toMatchObject({ status: 'rejected', reason: { kind: 'budget' } });
    expect(Date.now() - start).toBeLessThan(100);
    await reader.close();
  } finally {
    vi.useRealTimers();
  }
});

test('actual HTTP 429 penalizes client requests and sustained success restores baseline', async () => {
  vi.useFakeTimers();
  try {
    const times: number[] = [];
    const reader = createChainReader(env, {
      perSecond: 10,
      fetchFn: async () => {
        times.push(Date.now());
        return times.length === 1
          ? new Response('too many requests', { status: 429 })
          : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
      },
    });
    for (let i = 0; i < 14; i++) {
      const request = reader.request('eth_chainId', []);
      await vi.runAllTimersAsync();
      expect(await request).toBe('0x1');
    }
    expect(times[1]! - times[0]!).toBe(1000);
    expect(times[2]! - times[1]!).toBe(1000);
    expect(times.at(-1)! - times.at(-2)!).toBe(100);
    expect(reader.meter.summary()).toMatchObject({ calls: 15, retries: 1 });
    await reader.close();
  } finally {
    vi.useRealTimers();
  }
});
