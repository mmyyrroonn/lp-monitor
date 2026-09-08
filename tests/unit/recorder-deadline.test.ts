import { expect, test } from 'vitest';
import { createChainReader } from '../../src/rpc/client.js';
test('expired recorder deadline rejects before dispatch without consuming method budget', async () => {
  let calls = 0;
  const reader = createChainReader(
    { httpRpcUrl: 'https://fixture.invalid', providerAlias: 'synthetic', dataDir: 'data' },
    {
      maxCalls: 10,
      deadlineMs: Date.now() - 1,
      fetchFn: async () => {
        calls++;
        return new Response('{}');
      },
    },
  );
  try {
    await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({ kind: 'deadline' });
    expect(calls).toBe(0);
    expect(reader.meter.summary().calls).toBe(0);
  } finally {
    await reader.close();
  }
});
test('queued request crossing deadline does not start a transport call', async () => {
  let calls = 0;
  const reader = createChainReader(
    { httpRpcUrl: 'https://fixture.invalid', providerAlias: 'synthetic', dataDir: 'data' },
    {
      maxCalls: 10,
      perSecond: 2,
      deadlineMs: Date.now() + 200,
      maxRetries: 0,
      fetchFn: async (_input, init) => {
        calls++;
        const req = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: '0x1237' }));
      },
    },
  );
  try {
    expect(await reader.request('eth_chainId', [])).toBe('0x1237');
    await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({ kind: 'deadline' });
    expect(calls).toBe(1);
  } finally {
    await reader.close();
  }
});
