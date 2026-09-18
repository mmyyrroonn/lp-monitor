import { expect, test, vi } from 'vitest';
import { createChainReader } from '../../src/rpc/client.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('reader cannot send transactions even through generic request', async () => {
  const reader = createChainReader({
    httpRpcUrl: 'https://secret.invalid/key',
    providerAlias: 'test',
    dataDir: 'data',
  });
  await expect(reader.request('eth_sendRawTransaction', ['0x'])).rejects.toThrow(/read-only/);
  expect(reader.meter.summary().calls).toBe(0);
});
test('an unrecognized provider error is retried to the maxRetries bound, then thrown', async () => {
  let calls = 0;
  const reader = createChainReader(
    { httpRpcUrl: 'https://secret.invalid/key', providerAlias: 'test', dataDir: 'data' },
    {
      maxRetries: 2,
      perSecond: 10000,
      fetchFn: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32000, message: 'no shape we recognize' },
          }),
        );
      },
    },
  );
  await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({
    kind: 'request-failed',
  });
  // One initial attempt plus maxRetries, instead of failing the scan on the first message.
  expect(calls).toBe(3);
  expect(reader.meter.summary()).toMatchObject({ calls: 3, retries: 2 });
  await reader.close();
});

test('a retryable failure with no retry left does not stall the limiter', async () => {
  let calls = 0;
  const reader = createChainReader(
    { httpRpcUrl: 'https://secret.invalid/key', providerAlias: 'test', dataDir: 'data' },
    {
      maxRetries: 0,
      perSecond: 10000,
      fetchFn: async () => {
        calls++;
        return calls === 1
          ? new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                error: { code: -32000, message: 'no shape we recognize' },
              }),
            )
          : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1237' }));
      },
    },
  );
  const start = Date.now();
  await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({
    kind: 'request-failed',
  });
  expect(await reader.request('eth_chainId', [])).toBe('0x1237');
  // The retry backoff is 500ms at attempt 0. No retry followed, so the shared limiter must not
  // have been delayed: an unrelated call still goes out on the 1ms rate slot.
  expect(Date.now() - start).toBeLessThan(250);
  expect(reader.meter.summary()).toMatchObject({ calls: 2, retries: 0 });
});
test('a 429 with no retry left still holds back the next call on this provider', async () => {
  let calls = 0;
  const reader = createChainReader(
    { httpRpcUrl: 'https://secret.invalid/key', providerAlias: 'test', dataDir: 'data' },
    {
      maxRetries: 0,
      perSecond: 10000,
      fetchFn: async () => {
        calls++;
        return calls === 1
          ? new Response('too many requests', { status: 429 })
          : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1237' }));
      },
    },
  );
  const start = Date.now();
  await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({ kind: 'rate-limit' });
  expect(await reader.request('eth_chainId', [])).toBe('0x1237');
  // There is no retry to space out, but the provider is still telling the whole process to back
  // off, so the next call on this limiter must wait out the cooldown.
  expect(Date.now() - start).toBeGreaterThanOrEqual(900);
});
test('429 retry is counted and provider error secrets never reach evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lp-client-'));
  const evidenceFile = join(directory, 'requests.jsonl');
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls++;
    return calls === 1
      ? new Response('secret-token=https://secret.invalid/key', { status: 429 })
      : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1237' }));
  };
  try {
    const reader = createChainReader(
      { httpRpcUrl: 'https://secret.invalid/key', providerAlias: 'test', dataDir: 'data' },
      { evidenceFile, fetchFn },
    );
    expect(await reader.request('eth_chainId', [])).toBe('0x1237');
    expect(reader.meter.summary()).toMatchObject({ calls: 2, retries: 1 });
    expect(reader.meter.summary().responseBytes).toBe(
      Buffer.byteLength('secret-token=https://secret.invalid/key') +
        Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1237' })),
    );
    expect(readFileSync(evidenceFile, 'utf8')).not.toContain('secret');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
const rpcEnv = { httpRpcUrl: 'https://secret.invalid/key', providerAlias: 'test', dataDir: 'data' };
const encoder = new TextEncoder();
/** A body that delivers `head` and then never produces another byte, the way a stalled proxy does. */
const stalledBody = (head = '', onCancel?: () => void) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      if (head) controller.enqueue(encoder.encode(head));
    },
    cancel: onCancel,
  });
/** A body that produces only when asked: one `piece` every `gapMs`, then closes. */
const drippingBody = (pieces: string[], gapMs: number) => {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next === pieces.length) {
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      controller.enqueue(encoder.encode(pieces[next++]!));
    },
  });
};
test('a body that stops producing data fails as a retryable timeout and drops the socket', async () => {
  let aborts = 0;
  let cancelled = false;
  const reader = createChainReader(rpcEnv, {
    timeoutMs: 100,
    maxRetries: 0,
    perSecond: 10000,
    fetchFn: async (_input, init) => {
      init?.signal?.addEventListener('abort', () => aborts++);
      return new Response(
        stalledBody('{"jsonrpc":"2.0","id":1,', () => (cancelled = true)),
        {
          status: 200,
        },
      );
    },
  });
  const start = Date.now();
  await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({
    kind: 'timeout-or-network',
    retryable: true,
  });
  // The headers arrived, so viem's timeout was already spent and this read had nothing bounding it
  // but undici's 300s body default. Failing at the idle budget is what hands it back to the retry.
  expect(Date.now() - start).toBeLessThan(2000);
  expect(aborts).toBe(1);
  // The abort is what undici turns into a socket teardown. Erroring our own stream alone would
  // leave the connection ESTABLISHED with the body read still running behind it.
  expect(cancelled).toBe(true);
});
test('a stalled body is retried to the maxRetries bound', async () => {
  let calls = 0;
  const reader = createChainReader(rpcEnv, {
    timeoutMs: 50,
    maxRetries: 2,
    perSecond: 10000,
    fetchFn: async () => {
      calls++;
      return new Response(stalledBody(), { status: 200 });
    },
  });
  await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({
    kind: 'timeout-or-network',
  });
  // Retryable, so the existing backoff path runs untouched: one attempt plus maxRetries.
  expect(calls).toBe(3);
  expect(reader.meter.summary()).toMatchObject({ calls: 3, retries: 2 });
});
test('a body that keeps delivering chunks is not killed for taking long', async () => {
  // Two characters every 40ms: a gap far inside the 250ms budget, over a total run several times
  // longer than it. Both margins are wide so a loaded machine cannot decide the outcome.
  const pieces = JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1237' }).match(/.{1,2}/g)!;
  const reader = createChainReader(rpcEnv, {
    timeoutMs: 250,
    perSecond: 10000,
    fetchFn: async () =>
      new Response(drippingBody(pieces, 40), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  const start = Date.now();
  expect(await reader.request('eth_chainId', [])).toBe('0x1237');
  // The body takes several times the budget end to end; only the gap between chunks is budgeted,
  // so a large getLogs response is never killed merely for being slow.
  expect(Date.now() - start).toBeGreaterThan(250);
});
test('a settled body leaves no watchdog timer behind', async () => {
  // Only the watchdog is faked: the reader's streams and rate limiter must keep their real
  // scheduling for the read to make progress at all.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const healthy = createChainReader(rpcEnv, {
      timeoutMs: 10000,
      perSecond: 10000,
      fetchFn: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' })),
    });
    expect(await healthy.request('eth_chainId', [])).toBe('0x1');
    // A body that completed must not leave a timer holding the loop open at shutdown.
    expect(vi.getTimerCount()).toBe(0);
    // Nor may one that stalled: its watchdog has already fired and disarmed itself.
    const stalled = createChainReader(rpcEnv, {
      timeoutMs: 10000,
      maxRetries: 0,
      perSecond: 10000,
      fetchFn: async () => new Response(stalledBody(), { status: 200 }),
    });
    const failed = stalled.request('eth_chainId', []).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await failed).toMatchObject({ kind: 'timeout-or-network' });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
