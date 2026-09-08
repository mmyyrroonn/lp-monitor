import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
const run = (args: string[], extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, RH_RPC_HTTP: '', RH_RPC_WS: '', ...extra },
  });
test.each([[], ['--help'], ['probe', '--help'], ['capture', '--help']].map((args) => ({ args })))(
  'help works without RPC $args',
  ({ args }) => {
    const result = run(args);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('capture');
  },
);
test('missing configuration exits 2 without revealing values', () => {
  const result = run(['probe']);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('RH_RPC_HTTP');
});
test('invalid option errors do not echo potential credentials', () => {
  const result = run(['capture', '--secret-key']);
  expect(result.status).toBe(2);
  expect(result.stderr).not.toContain('secret-key');
});
test('mutually exclusive block options reject before network', () => {
  const result = run(['capture', '--from-block', '5', '--to-block', '3'], {
    RH_RPC_HTTP: 'https://secret.invalid/key',
  });
  expect(result.status).toBe(2);
  expect(result.stderr).not.toContain('secret');
});

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function mockCli(
  args: string[],
  respond: (method: string) => unknown,
  configChange: (c: any) => void = () => {},
  blockOutput = false,
) {
  const dir = mkdtempSync(join(tmpdir(), 'lp-cli-'));
  const config = JSON.parse(readFileSync('config/robinhood.json', 'utf8'));
  configChange(config);
  if (blockOutput) mkdirSync(join(dir, 'output'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      const body = JSON.parse(text);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: respond(body.method) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listen');
    return await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            'src/cli.ts',
            ...args,
            '--config',
            configPath,
            '--out',
            join(dir, 'output'),
          ],
          {
            env: { ...process.env, RH_RPC_HTTP: 'http://127.0.0.1:' + address.port, RH_RPC_WS: '' },
          },
        );
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    rmSync(dir, { recursive: true, force: true });
  }
}
test('probe budget exhaustion exits incomplete code 4', async () => {
  const result = await mockCli(
    ['probe'],
    () => '0x1237',
    (c) => (c.maxRpcCalls = 1),
  );
  expect(result.status).toBe(4);
  expect(result.stderr).toContain('budget');
});
test('wrong chain exits required-failure code 3', async () => {
  const result = await mockCli(['probe'], () => '0x1');
  expect(result.status).toBe(3);
});
test('malformed capture chain response is an RPC failure, not internal error', async () => {
  const result = await mockCli(['capture', '--last-blocks', '1'], (method) =>
    method === 'eth_getBlockByNumber'
      ? { number: '0x64', hash: '0x' + 'ab'.repeat(32), timestamp: '0x64' }
      : 'not-hex',
  );
  expect(result.status).toBe(3);
  expect(result.stderr).toContain('malformed-response');
});
test('capture enforces configured range limit before RPC', async () => {
  const result = await mockCli(
    ['capture', '--last-blocks', '101'],
    () => null,
    (c) => (c.maxRangeBlocks = 100),
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('range');
});
test('P0 CLI supports explicit evidence policy', async () => {
  const result = await mockCli(['probe', '--evidence', 'off'], () => '0x1');
  expect(result.status).toBe(3);
});

test('capture writes explicit budget failure and exits incomplete code 4', async () => {
  const result = await mockCli(
    ['capture', '--last-blocks', '1'],
    (method) =>
      method === 'eth_getBlockByNumber'
        ? { number: '0x64', hash: '0x' + 'ab'.repeat(32), timestamp: '0x64' }
        : '0x1237',
    (c) => (c.maxRpcCalls = 2),
  );
  expect(result.status).toBe(4);
  expect(result.stdout).toContain('budget');
});
test('local output failure exits internal code 1 without raw details', async () => {
  const result = await mockCli(
    ['probe'],
    () => '0x1',
    () => {},
    true,
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Internal error');
  expect(result.stderr).not.toContain('lp-cli-');
});
