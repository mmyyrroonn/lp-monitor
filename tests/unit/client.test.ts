import { expect, test } from 'vitest';
import { createChainReader } from '../../src/rpc/client.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('reader cannot send transactions even through generic request', async () => {
  const reader = createChainReader({ httpRpcUrl: 'https://secret.invalid/key', providerAlias: 'test', dataDir: 'data' });
  await expect(reader.request('eth_sendRawTransaction', ['0x'])).rejects.toThrow(/read-only/);
  expect(reader.meter.summary().calls).toBe(0);
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
    const reader = createChainReader({ httpRpcUrl: 'https://secret.invalid/key', providerAlias: 'test', dataDir: 'data' }, { evidenceFile, fetchFn });
    expect(await reader.request('eth_chainId', [])).toBe('0x1237');
    expect(reader.meter.summary()).toMatchObject({ calls: 2, retries: 1 });
    expect(reader.meter.summary().responseBytes).toBe(Buffer.byteLength('secret-token=https://secret.invalid/key') + Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1237' })));
    expect(readFileSync(evidenceFile, 'utf8')).not.toContain('secret');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
