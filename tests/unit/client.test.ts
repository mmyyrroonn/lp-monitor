import { expect, test } from 'vitest';
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
