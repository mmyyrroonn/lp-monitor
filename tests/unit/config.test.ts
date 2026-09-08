import { expect, test } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
test('missing RPC has no default network', () => expect(() => loadEnv({})).toThrow(/RH_RPC_HTTP/));
test('invalid config never echoes secrets', () => {
  for (const env of [{ RH_RPC_HTTP: 'secret-token' }, { RH_RPC_HTTP: 'https://user:secret@host/', RH_PROVIDER_ALIAS: 'https://secret' }]) {
    try { loadEnv(env); throw new Error('accepted'); } catch (e) { expect(String(e)).not.toContain('secret'); }
  }
});
test('explicit endpoint and safe alias', () => {
  const result = loadEnv({ RH_RPC_HTTP: 'https://example.org/key', RH_PROVIDER_ALIAS: 'local-provider' });
  expect(result.providerAlias).toBe('local-provider');
  expect(result.dataDir).toBe('data');
});
