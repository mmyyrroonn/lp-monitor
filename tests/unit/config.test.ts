import { expect, test } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
test('missing RPC has no default network', () => expect(() => loadEnv({})).toThrow(/RH_RPC_HTTP/));
test('invalid config never echoes secrets', () => {
  for (const env of [
    { RH_RPC_HTTP: 'secret-token' },
    { RH_RPC_HTTP: 'https://user:secret@host/', RH_PROVIDER_ALIAS: 'https://secret' },
  ]) {
    try {
      loadEnv(env);
      throw new Error('accepted');
    } catch (e) {
      expect(String(e)).not.toContain('secret');
    }
  }
});
test('explicit endpoint and safe alias', () => {
  const result = loadEnv({
    RH_RPC_HTTP: 'https://example.org/key',
    RH_PROVIDER_ALIAS: 'local-provider',
  });
  expect(result.providerAlias).toBe('local-provider');
  expect(result.dataDir).toBe('data');
});

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadChainConfig } from '../../src/config/chain.js';
function withConfig(change: (c: any) => void, check: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'lp-config-'));
  try {
    const c = JSON.parse(readFileSync('config/robinhood.json', 'utf8'));
    change(c);
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify(c));
    check(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test('rejects unknown config fields and identifies safe field paths', () => {
  withConfig(
    (c) => {
      c.pollIntervallMs = 123;
    },
    (path) => expect(() => loadChainConfig(path)).toThrow(/unknown field/),
  );
  withConfig(
    (c) => {
      c.rpcPerSecond = -1;
    },
    (path) => expect(() => loadChainConfig(path)).toThrow(/rpcPerSecond/),
  );
});
test('normalizes all configured addresses and pool hashes', () => {
  withConfig(
    (c) => {
      c.v4PoolIds = c.v4PoolIds.map((s: string) => '0x' + s.slice(2).toUpperCase());
      c.tokens.AMC = '0x' + c.tokens.AMC.slice(2).toUpperCase();
    },
    (path) => {
      const c = loadChainConfig(path);
      expect(c.v4PoolIds.every((s) => s === s.toLowerCase())).toBe(true);
      expect(c.tokens.AMC).toBe(c.tokens.AMC.toLowerCase());
    },
  );
});
test('runtime config permits explicit long-run quota and provider limits', () => {
  withConfig(
    (c) => {
      c.maxRpcCalls = null;
      c.rpcPerSecond = 10;
      c.timeoutMs = 20000;
      c.pollIntervalMs = 3000;
    },
    (path) => expect(loadChainConfig(path).maxRpcCalls).toBeNull(),
  );
});

test('rejects a backfill rate the shared RPC budget would silently swallow', () => {
  withConfig(
    (c) => {
      c.maxBackfillRpcRps = c.rpcPerSecond + 1;
    },
    (path) => expect(() => loadChainConfig(path)).toThrow(/maxBackfillRpcRps/),
  );
  withConfig(
    (c) => {
      c.maxBackfillRpcRps = c.rpcPerSecond;
    },
    (path) => expect(loadChainConfig(path).maxBackfillRpcRps).toBe(5),
  );
});
test('a config without a backfill rate keeps the conservative default', () => {
  withConfig(
    (c) => {
      delete c.maxBackfillRpcRps;
    },
    (path) => expect(loadChainConfig(path).maxBackfillRpcRps).toBe(1),
  );
});
test('the shipped config keeps backfill above the 1 rps break-even', () => {
  // The diagnosis of 2026-09-19 measured 1 rps at roughly break-even against this chain's
  // ~10 blocks/s, so a backlog never drains; the config has to say so explicitly.
  const c = loadChainConfig('config/robinhood.json');
  expect(c.maxBackfillRpcRps).toBeGreaterThan(1);
  expect(c.maxBackfillRpcRps).toBeLessThanOrEqual(c.rpcPerSecond);
});
test('history hint search bounds must be paired and ordered', () => {
  withConfig(
    (c) => {
      c.v4PoolHistoryHints[0].fromBlock = '10';
      c.v4PoolHistoryHints[0].toBlock = '11';
    },
    (path) =>
      expect(loadChainConfig(path).v4PoolHistoryHints[0]).toMatchObject({
        fromBlock: '10',
        toBlock: '11',
      }),
  );
  withConfig(
    (c) => {
      c.v4PoolHistoryHints[0].fromBlock = '10';
      delete c.v4PoolHistoryHints[0].toBlock;
    },
    (path) => expect(() => loadChainConfig(path)).toThrow(),
  );
  withConfig(
    (c) => {
      c.v4PoolHistoryHints[0].fromBlock = '12';
      c.v4PoolHistoryHints[0].toBlock = '11';
    },
    (path) => expect(() => loadChainConfig(path)).toThrow(),
  );
});

test('retention includes the quote margin beyond the dashboard horizon', () => {
  withConfig(
    (c) => {
      c.liveRetentionMinutes = 180;
    },
    (path) => expect(() => loadChainConfig(path)).toThrow(/liveRetentionMinutes/),
  );
});

test('raw retention cannot undercut the configured recovery window', () => {
  withConfig(
    (c) => {
      c.rawRetentionDays = 1;
      c.checkpointRetentionMinutes = 2000;
    },
    (path) => expect(() => loadChainConfig(path)).toThrow(/rawRetentionDays/),
  );
});
