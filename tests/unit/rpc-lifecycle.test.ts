import { getEventListeners } from 'node:events';
import { expect, test, vi } from 'vitest';
import { createChainReader } from '../../src/rpc/client.js';
const env = { httpRpcUrl: 'http://127.0.0.1:1', providerAlias: 'test', dataDir: 'data' };

test('an already cancelled reader leaves no deadline timer or caller listener', async () => {
  vi.useFakeTimers();
  try {
    const abort = new AbortController();
    abort.abort();
    const reader = createChainReader(env, { signal: abort.signal, deadlineMs: Date.now() + 5000 });
    await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({ kind: 'aborted' });
    expect(reader.meter.summary().calls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
    await reader.close();
  } finally {
    vi.useRealTimers();
  }
});

test('beginDrain permits final requests but never extends its absolute 30-second bound', async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const reader = createChainReader(env, {
      timeoutMs: 0,
      perSecond: 10000,
      fetchFn: async (_url, init) => {
        if (++calls === 1) return new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}');
        return new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          }),
        );
      },
    });
    reader.beginDrain();
    const first = reader.request('eth_chainId', []);
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toBe('0x1');
    let settled = false;
    const result = reader.request('eth_chainId', []).catch((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    reader.beginDrain();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await result).toMatchObject({ kind: 'deadline' });
    await reader.close();
    expect(reader.meter.summary()).toMatchObject({ activeRpc: 0, queueDepth: 0, calls: 2 });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('close bounds the drain even when no run deadline was supplied', async () => {
  vi.useFakeTimers();
  try {
    const abort = new AbortController();
    const reader = createChainReader(env, {
      signal: abort.signal,
      timeoutMs: 0,
      fetchFn: async (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          }),
        ),
    });
    const result = reader.request('eth_chainId', []).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    const closing = reader.close();
    await vi.advanceTimersByTimeAsync(30_001);
    await closing;
    expect(await result).toMatchObject({ kind: 'deadline' });
    expect(reader.meter.summary()).toMatchObject({ activeRpc: 0, queueDepth: 0, calls: 1 });
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});
