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
