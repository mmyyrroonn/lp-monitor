import { expect, test } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChainReader } from '../../src/rpc/client.js';
const env = { httpRpcUrl: 'https://rpc.invalid/secret', providerAlias: 'test', dataDir: 'data' };
test('evidence off does not create files and exposes flush/close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rpc-evidence-'));
  try {
    const reader = createChainReader(env, {
      evidenceFile: join(dir, 'requests.jsonl'),
      evidenceMode: 'off',
      fetchFn: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' })),
    });
    await reader.request('eth_chainId', []);
    await reader.flush();
    await reader.close();
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('full evidence rotates without losing completed requests and refuses overflow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rpc-evidence-'));
  try {
    const reader = createChainReader(env, {
      evidenceFile: join(dir, 'requests.jsonl'),
      evidenceMaxBytes: 250,
      evidenceMaxFiles: 2,
      perSecond: 10000,
      fetchFn: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' })),
    });
    await reader.request('eth_chainId', []);
    await reader.request('eth_chainId', []);
    await expect(reader.request('eth_chainId', [])).rejects.toMatchObject({
      kind: 'evidence-capacity',
    });
    const files = await readdir(dir);
    expect(files).toHaveLength(2);
    for (const file of files)
      expect(JSON.parse((await readFile(join(dir, file), 'utf8')).trim()).result).toBe('0x1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('close drains in-flight requests before sealing evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rpc-close-'));
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const gate = new Promise<void>((r) => (release = r));
  try {
    const reader = createChainReader(env, {
      evidenceFile: join(dir, 'requests.jsonl'),
      fetchFn: async () => {
        started();
        await gate;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
      },
    });
    const pending = reader.request('eth_chainId', []);
    await ready;
    const closing = reader.close();
    release();
    await expect(pending).resolves.toBe('0x1');
    await closing;
    expect(await readFile(join(dir, 'requests.jsonl'), 'utf8')).toContain('0x1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('sampled evidence preserves hashes and bounded rotating files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rpc-sampled-'));
  try {
    const reader = createChainReader(env, {
      evidenceFile: join(dir, 'requests.jsonl'),
      evidenceMode: 'sampled',
      evidenceSampleEvery: 100,
      evidenceMaxBytes: 300,
      evidenceMaxFiles: 2,
      perSecond: 10000,
      fetchFn: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' })),
    });
    for (let i = 0; i < 5; i++) await reader.request('eth_chainId', []);
    await reader.close();
    const files = await readdir(dir);
    expect(files).toHaveLength(2);
    for (const file of files) {
      const entry = JSON.parse((await readFile(join(dir, file), 'utf8')).trim());
      expect(entry.result).toBeUndefined();
      expect(entry.resultHash).toMatch(/^[a-f0-9]{64}$/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
