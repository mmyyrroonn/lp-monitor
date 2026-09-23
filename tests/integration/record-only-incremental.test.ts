import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadEnv } from '../../src/config/env.js';
import { runRecorder, type RecorderOptions } from '../../src/ops/recorder.js';
import { openDatabase } from '../../src/storage/database.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';
import { loadAssetVersion } from '../../src/registry/assets.js';
import { computeWatchScopeId } from '../../src/ingest/filter-plan.js';
import { storedPoolKey, storedRegistrationJson } from '../../src/storage/registration-codec.js';
import { CHAIN_ID } from '../../src/domain/chain.js';
import { toHex } from 'viem';
import type { PersistedPoolRegistration } from '../../src/storage/manifest.js';

const CATALOGUE = 2_000;
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lp-record-only-'));
  dirs.push(dir);
  return dir;
}

const hash = (n: number) => toHex(n, { size: 32 });
const token0 = toHex(2, { size: 20 });
const token1 = toHex(3, { size: 20 });

/** Pool registrations nothing in the run may re-read after the first warm batch. */
function seedCatalogue(db: ReturnType<typeof openDatabase>, scopeId: string): void {
  db.prepare(
    `insert or ignore into raw_logs(raw_key, chain_id, block_hash, block_number, transaction_hash,
       transaction_index, log_index, address, topics_json, data, raw_block_timestamp, payload_json)
     values (?, ?, ?, 0, ?, 0, 0, ?, '[]', '0x', null, '{}')`,
  ).run('ballast', CHAIN_ID, hash(0), hash(0), toHex(0, { size: 20 }));
  const { id } = db.prepare('select id from raw_logs where raw_key=?').get('ballast') as {
    id: number;
  };
  const insert = db.prepare(
    `insert into pools(scope_id,pool_key,protocol,discovered_raw_log_id,discovered_block_number,
       discovered_block_hash,payload_json) values(?,?,?,?,?,?,?)`,
  );
  db.transaction(() => {
    for (let index = 0; index < CATALOGUE; index += 1) {
      const registration: PersistedPoolRegistration = {
        pool: { chainId: CHAIN_ID, protocol: 'v3', address: toHex(0x300000 + index, { size: 20 }) },
        token0,
        token1,
        feePips: 3000,
        tickSpacing: 60,
        hooks: toHex(0, { size: 20 }),
        assetVersion: 'test',
        source: 'synthetic',
        discoveredAt: {
          blockNumber: 0n,
          blockHash: hash(0),
          transactionHash: hash(0),
          transactionIndex: 0,
          logIndex: 0,
        },
      };
      insert.run(
        scopeId,
        storedPoolKey(registration),
        'v3',
        id,
        0,
        hash(0),
        storedRegistrationJson(registration),
      );
    }
  })();
}

test('a record-only follow reads the catalogue once and then plans every batch from the registry delta', async () => {
  const dir = workspace();
  const config = loadChainConfig('config/robinhood.json');
  const assets = loadAssetVersion('config/watchlist.amc.json');
  const scopeId = computeWatchScopeId(assets, 'operations', {
    v3Factory: config.v3Factory,
    v4Manager: config.v4Manager,
  });
  const dbPath = join(dir, 'db.sqlite');
  const seeded = openDatabase(dbPath);
  try {
    seedCatalogue(seeded, scopeId);
  } finally {
    seeded.close();
  }
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line) => {
    if (typeof line === 'string') lines.push(line);
  });
  const opts: RecorderOptions = {
    command: 'follow',
    mode: 'record',
    notify: 'none',
    config: { ...config, maxRangeBlocks: 50, overlapBlocks: 10 },
    env: loadEnv({ RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' }),
    watchlistPath: 'config/watchlist.amc.json',
    databasePath: dbPath,
    outputDirectory: join(dir, 'runs'),
    fromBlock: 100n,
    durationMs: 2000,
    maxCalls: 10000,
    evidenceMode: 'off',
    readerFactory: recorderFixture().factory,
  };
  try {
    expect(await runRecorder(opts)).toBe(0);
    const timings = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === 'batch-timing')
      .map((entry) => (entry.counts as { registryRowsRead: number }).registryRowsRead);
    // At least two operation batches, so the second one is a warm batch.
    expect(timings.length).toBeGreaterThanOrEqual(2);
    // The cold batch read the seeded catalogue; every later batch read no registration rows and
    // rebuilt no operation templates. Record-only is not a reason to re-read the world.
    expect(timings[0]).toBeGreaterThanOrEqual(CATALOGUE);
    expect(timings.slice(1)).toEqual(Array.from({ length: timings.length - 1 }, () => 0));
    const rebuilt = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === 'batch-timing')
      .map(
        (entry) => (entry.counts as { operationFilterRebuilds: number }).operationFilterRebuilds,
      );
    expect(rebuilt.slice(1)).toEqual(Array.from({ length: rebuilt.length - 1 }, () => 0));
  } finally {
    expect(
      readFileSync(join(dir, 'runs', readdirSync(join(dir, 'runs'))[0]!, 'manifest.json')),
    ).toBeTruthy();
  }
});
