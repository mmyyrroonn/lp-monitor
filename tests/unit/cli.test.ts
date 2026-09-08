import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { encoding: 'utf8', env: { ...process.env, RH_RPC_HTTP: '', RH_RPC_WS: '', ...extra } });
test.each([[], ['--help'], ['probe', '--help'], ['capture', '--help']].map(args => ({ args })))('help works without RPC $args', ({ args }) => {
  const result = run(args); expect(result.status).toBe(0); expect(result.stdout).toContain('capture');
});
test('missing configuration exits 2 without revealing values', () => {
  const result = run(['probe']); expect(result.status).toBe(2); expect(result.stderr).toContain('RH_RPC_HTTP');
});
test('invalid option errors do not echo potential credentials', () => {
  const result = run(['capture', '--secret-key']); expect(result.status).toBe(2); expect(result.stderr).not.toContain('secret-key');
});
test('mutually exclusive block options reject before network', () => {
  const result = run(['capture', '--from-block', '5', '--to-block', '3'], { RH_RPC_HTTP: 'https://secret.invalid/key' });
  expect(result.status).toBe(2); expect(result.stderr).not.toContain('secret');
});
