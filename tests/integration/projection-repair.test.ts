import { afterEach, expect, test } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, toHex, type Hex } from 'viem';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { SqliteProjectionStore } from '../../src/storage/projection-store.js';
import {
  rawLogKey,
  type RecordedRangeBatch,
  type PersistedPoolRegistration,
} from '../../src/storage/manifest.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import type { RawLog, LogTime } from '../../src/domain/types.js';
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const address = toHex(1, { size: 20 });
const hash = (n: number) => toHex(n, { size: 32 });
const anchor = { number: 120n, hash: hash(120), timestampSec: 180 };
const minute: LogTime = { minuteStartSec: 120, exactTimestampSec: null, source: 'minute-boundary' };
const swap = (n: number): RawLog => ({
  address,
  blockNumber: BigInt(n),
  blockHash: hash(n),
  transactionHash: hash(n + 1000),
  transactionIndex: 0,
  logIndex: 0,
  rawBlockTimestamp: '0x0',
  topics: encodeEventTopics({
    abi: v3PoolAbi,
    eventName: 'Swap',
    args: { sender: address, recipient: address },
  }) as Hex[],
  data: encodeAbiParameters(
    [
      { type: 'int256' },
      { type: 'int256' },
      { type: 'uint160' },
      { type: 'uint128' },
      { type: 'int24' },
    ],
    [2n ** 150n, -90n, 2n ** 96n, 1000n, 0],
  ),
});
const registration = (log: RawLog): PersistedPoolRegistration => ({
  pool: { chainId: 4663, protocol: 'v3', address },
  token0: address,
  token1: toHex(2, { size: 20 }),
  feePips: 3000,
  tickSpacing: 60,
  hooks: toHex(0, { size: 20 }),
  assetVersion: 'test-v1',
  source: 'synthetic',
  discoveredAt: log,
});
function batch(id: string, logs: RawLog[], time = minute, scopeId = 'test'): RecordedRangeBatch {
  return {
    id,
    scopeId,
    fromBlock: 100n,
    toBlock: 120n,
    end: anchor,
    previous: anchor,
    logs,
    observedAtMs: 1,
    captureMode: 'synthetic',
    filterPlanHash: 'test',
    manifestHash: id,
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'test',
      expectedShardIds: ['one'],
      shards: [
        {
          shardId: 'one',
          filterId: 'operation-v3',
          request: { fromBlock: 100n, toBlock: 120n, address: [address], topics: [] },
          status: 'success',
          responseHash: hash(1),
          logKeys: logs.map(rawLogKey),
          logCount: logs.length,
          error: null,
        },
      ],
    },
    logTimes: logs.map((log) => ({ ref: log, time })),
    poolRegistrations: logs.length ? [registration(logs[0]!)] : [],
  };
}
function fixture() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return { db, raw: new SqliteRangeStore(db), projection: new SqliteProjectionStore(db) };
}
test('active set removal rebuilds lastSwap and retains raw evidence; repeated rebuild is deterministic', () => {
  const { db, raw, projection } = fixture();
  const a = swap(105),
    b = swap(110);
  raw.acceptRange(batch('first', [a, b]));
  const first = projection.rebuild('test');
  expect(first.events).toHaveLength(2);
  expect(first.observations[0]?.lastSwap?.ref.blockNumber).toBe(110n);
  expect(projection.read('test')?.events[0]).toEqual(first.events[0]);
  expect(projection.rebuild('test')).toEqual(first);
  raw.acceptRange(batch('second', [a]));
  expect(projection.read('test')).toBeNull();
  const second = projection.rebuild('test');
  expect(second.events).toHaveLength(1);
  expect(second.observations[0]?.lastSwap?.ref.blockNumber).toBe(105n);
  expect(db.prepare('select count(*) as n from raw_logs').get()).toEqual({ n: 2 });
  raw.acceptRange(batch('empty', []));
  expect(projection.rebuild('test').events).toEqual([]);
  expect(projection.read('test')?.observations.every((o) => o.lastSwap === null)).toBe(true);
});
test('retiming at unchanged chain tip invalidates cursor and replaces the old minute', () => {
  const { raw, projection, db } = fixture();
  const a = swap(105);
  raw.acceptRange(batch('a', [a]));
  projection.rebuild('test');
  raw.acceptRange(
    batch('b', [a], { minuteStartSec: 60, exactTimestampSec: 69, source: 'log-verified' }),
  );
  expect(projection.read('test')).toBeNull();
  const next = projection.rebuild('test');
  expect(next.events[0]?.time.minuteStartSec).toBe(60);
  expect(db.prepare('select minute_start_sec from projected_events').all()).toEqual([
    { minute_start_sec: 60 },
  ]);
});
test('transaction failure preserves prior projection and cursor together', () => {
  const { raw, projection, db } = fixture();
  raw.acceptRange(batch('a', [swap(105)]));
  projection.rebuild('test');
  const before = db.prepare('select * from projection_cursors').all();
  raw.acceptRange(batch('b', [swap(110)]));
  db.exec(
    "CREATE TRIGGER fail_cursor BEFORE UPDATE ON projection_cursors BEGIN SELECT RAISE(ABORT, 'test failure'); END",
  );
  expect(() => projection.rebuild('test')).toThrow('test failure');
  expect(db.prepare('select * from projection_cursors').all()).toEqual(before);
  expect(db.prepare('select block_number from projected_events').all()).toEqual([
    { block_number: 105 },
  ]);
  expect(projection.read('test')).toBeNull();
});
test('scope isolation, incomplete raw batch exclusion, and malformed evidence retention', () => {
  const { raw, projection } = fixture();
  const a = swap(105);
  raw.acceptRange(batch('a', [a]));
  raw.acceptRange(batch('other', [swap(111)], minute, 'other'));
  const incomplete = { ...batch('failed', [swap(115)]), completeness: 'incomplete' as const };
  raw.saveRaw(incomplete);
  expect(projection.rebuild('test').events).toHaveLength(1);
  const invalid = { ...swap(110), data: '0x1234' as Hex };
  raw.acceptRange(batch('bad', [a, invalid]));
  const result = projection.rebuild('test');
  expect(result.events).toHaveLength(1);
  expect(
    result.qualityErrors.some((e) => e.raw.data === '0x1234' && e.code === 'invalid-data'),
  ).toBe(true);
  expect(projection.rebuild('other').events).toHaveLength(1);
});
test('registry-only change and rollback invalidate observations despite unchanged original tip', () => {
  const { raw, projection, db } = fixture();
  raw.acceptRange(batch('a', [swap(105), swap(110)]));
  projection.rebuild('test');
  db.prepare('delete from pools where scope_id=?').run('test');
  expect(projection.read('test')).toBeNull();
  expect(projection.rebuild('test').qualityErrors.some((e) => e.code === 'unregistered-pool')).toBe(
    true,
  );
  raw.invalidateAfter('test', { number: 104n, hash: hash(104), timestampSec: 120 });
  expect(projection.read('test')).toBeNull();
  expect(projection.rebuild('test').events).toEqual([]);
});

test('offline CLI projects, inspects minute precision, rejects stale state and never needs RPC', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { vi } = await import('vitest');
  const { runCli } = await import('../../src/cli.js');
  const { loadChainConfig } = await import('../../src/config/chain.js');
  const { loadAssetVersion } = await import('../../src/registry/assets.js');
  const { computeWatchScopeId } = await import('../../src/ingest/filter-plan.js');
  const dir = mkdtempSync(join(tmpdir(), 'p2-cli-'));
  const dbPath = join(dir, 'test.sqlite');
  const config = loadChainConfig('config/robinhood.json');
  config.v3Pools = [toHex(3, { size: 20 }), address];
  config.tokens = { AMC: address, USDG: toHex(2, { size: 20 }) };
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const scope = computeWatchScopeId(
    loadAssetVersion('config/watchlist.amc.json'),
    'operations',
    config,
  );
  const db = openDatabase(dbPath);
  const raw = new SqliteRangeStore(db);
  raw.acceptRange(batch('cli', [swap(105)], minute, scope));
  db.close();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const environment = {};
  const rpc = vi.fn(() => {
    throw new Error('RPC forbidden');
  });
  try {
    expect(
      await runCli(['project', '--db', dbPath, '--config', configPath, '--rebuild'], {
        environment,
        readerFactory: rpc,
      }),
    ).toBe(0);
    expect(
      await runCli(
        ['inspect-pool', '--db', dbPath, '--config', configPath, '--pool', 'amc-usdg-v3'],
        { environment, readerFactory: rpc },
      ),
    ).toBe(0);
    const output = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(output.observation.lastSwap.liquidityAfter).toBe('1000');
    expect(output.observation.lastSwap.time.exactTimestampSec).toBeNull();
    expect(output.timing).toBe('minute');
    expect(output.currentPoolStateKnown).toBe(false);

    const withErrors = openDatabase(dbPath);
    const unknown = { ...swap(106), address: toHex(777, { size: 20 }) };
    const badPoolLog = { ...swap(107), data: '0x1234' as Hex };
    const errorBatch = batch('cli-errors', [swap(105), unknown, badPoolLog], minute, scope);
    errorBatch.manifest.shards[0]!.request.address = [address, unknown.address];
    new SqliteRangeStore(withErrors).acceptRange(errorBatch);
    withErrors.close();
    expect(
      await runCli(['project', '--db', dbPath, '--config', configPath, '--rebuild'], {
        environment,
      }),
    ).toBe(4);
    expect(
      await runCli(
        ['inspect-pool', '--db', dbPath, '--config', configPath, '--pool', 'amc-usdg-v3'],
        { environment },
      ),
    ).toBe(4);
    const separated = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(separated.poolQualityErrors.map((e: { code: string }) => e.code)).toEqual([
      'invalid-data',
    ]);
    expect(separated.scopeQualityErrors.map((e: { code: string }) => e.code)).toEqual([
      'unregistered-pool',
    ]);
    const changed = openDatabase(dbPath);
    new SqliteRangeStore(changed).acceptRange(batch('cli2', [swap(110)], minute, scope));
    changed.close();
    expect(
      await runCli(
        ['inspect-pool', '--db', dbPath, '--config', configPath, '--pool', 'amc-usdg-v3'],
        { environment, readerFactory: rpc },
      ),
    ).toBe(4);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).status).toBe(
      'projection-stale-or-missing',
    );
    expect(rpc).not.toHaveBeenCalled();
    await expect(
      runCli(['project', '--db', join(dir, 'missing.sqlite')], { environment }),
    ).rejects.toThrow(/database/i);
    await expect(runCli(['inspect-pool', '--db', dbPath], { environment })).rejects.toThrow(
      /pool/i,
    );
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V4 same-block discovery and swap use registry scope, then registry rollback makes projection stale', async () => {
  const { Interface } = await import('ethers');
  const { v4ManagerAbi } = await import('../../src/protocols/uniswap-v4/abi.js');
  const { computeV4PoolId } = await import('../../src/protocols/uniswap-v4/pool-key.js');
  const { discoverPools } = await import('../../src/protocols/uniswap-v4/discover.js');
  const abi = new Interface(v4ManagerAbi);
  const key = {
    currency0: address,
    currency1: toHex(2, { size: 20 }),
    fee: 0x800000,
    tickSpacing: 60,
    hooks: toHex(0, { size: 20 }),
  };
  const poolId = computeV4PoolId(key);
  const emit = (name: string, values: unknown[], index: number): RawLog => {
    const encoded = abi.encodeEventLog(abi.getEvent(name)!, values);
    return {
      ...swap(105),
      address: toHex(9, { size: 20 }),
      topics: encoded.topics as Hex[],
      data: encoded.data as Hex,
      logIndex: index,
    };
  };
  const init = emit(
    'Initialize',
    [poolId, key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks, 2n ** 96n, 0],
    0,
  );
  const trade = emit('Swap', [poolId, address, -100n, 90n, 2n ** 96n, 1000n, 0, 4200], 1);
  const { raw, projection } = fixture();
  const make = (
    id: string,
    scope: string,
    logs: RawLog[],
    regs: RecordedRangeBatch['poolRegistrations'],
    family: string,
  ) => {
    const value = batch(id, logs, minute, scope);
    value.poolRegistrations = regs;
    value.manifest.shards[0]!.filterId = family;
    value.manifest.shards[0]!.request.address = [init.address];
    return value;
  };
  raw.acceptRange(
    make('discovery', 'registry', [init], discoverPools([init], 'test-v4'), 'discovery-v4'),
  );
  raw.acceptRange(make('operations', 'operations', [init, trade], [], 'operation-v4'));
  const result = projection.rebuild('operations', 'registry');
  expect(result.qualityErrors).toEqual([]);
  expect(result.events.map((e) => e.kind)).toEqual(['initialize', 'swap']);
  expect(result.observations[0]!.lastSwap).toMatchObject({
    rawAmount0: -100n,
    rawAmount1: 90n,
    amountIn: 100n,
    amountOut: 90n,
    effectiveSwapFeePips: 4200,
  });
  expect(projection.read('operations', 'registry')).toEqual(result);
  raw.invalidateAfter('registry', { number: 104n, hash: hash(104), timestampSec: 120 });
  expect(projection.read('operations', 'registry')).toBeNull();
  const unregistered = projection.rebuild('operations', 'registry');
  expect(unregistered.events).toEqual([]);
  expect(unregistered.qualityErrors).toHaveLength(2);
});

test('internal decoder failures abort projection replacement and preserve all prior rows', async () => {
  const helpers = await import('../../src/protocols/event-log.js');
  const { vi } = await import('vitest');
  const { raw, projection, db } = fixture();
  raw.acceptRange(batch('first', [swap(105)]));
  projection.rebuild('test');
  const before = db.prepare('select * from projection_cursors').all();
  raw.acceptRange(batch('second', [swap(110)]));
  const sentinel = new TypeError('injected helper defect');
  const mock = vi.spyOn(helpers, 'eventRef').mockImplementation(() => {
    throw sentinel;
  });
  try {
    expect(() => projection.rebuild('test')).toThrow(sentinel);
    expect(db.prepare('select * from projection_cursors').all()).toEqual(before);
    expect(db.prepare('select block_number from projected_events').all()).toEqual([
      { block_number: 105 },
    ]);
  } finally {
    mock.mockRestore();
  }
});
test('projection insert tolerates unrelated nullable columns and rejects obsolete version', () => {
  const { raw, projection, db } = fixture();
  raw.acceptRange(batch('first', [swap(105)]));
  for (const table of [
    'projected_events',
    'pool_observations',
    'projection_quality_errors',
    'projection_cursors',
  ])
    db.exec('alter table ' + table + ' add column future_annotation TEXT');
  const result = projection.rebuild('test');
  expect(result.events).toHaveLength(1);
  const row = db.prepare('select payload_json from projection_cursors').get() as {
    payload_json: string;
  };
  const old = JSON.parse(row.payload_json);
  old.version = 'p2-v1';
  db.prepare('update projection_cursors set projection_version=?,payload_json=?').run(
    'p2-v1',
    JSON.stringify(old),
  );
  expect(projection.read('test')).toBeNull();
});

test('archived zero-sided Swap preserves post-state through projection and SQLite without replacing lastSwap', async () => {
  const { readFileSync } = await import('node:fs');
  const { Interface } = await import('ethers');
  const { v4ManagerAbi } = await import('../../src/protocols/uniswap-v4/abi.js');
  const values = JSON.parse(
    readFileSync('artifacts/p0/raw/2026-09-08T06-10-51-129Z/logs.json', 'utf8'),
  ) as (Omit<RawLog, 'blockNumber'> & { blockNumber: string })[];
  const archived = values.find((l) => l.blockNumber === '57465603' && l.logIndex === 3)!;
  const zero: RawLog = { ...archived, blockNumber: BigInt(archived.blockNumber) };
  const abi = new Interface(v4ManagerAbi);
  const encoded = abi.encodeEventLog(abi.getEvent('Swap')!, [
    zero.topics[1],
    address,
    -100n,
    90n,
    2n ** 96n,
    1000n,
    0,
    3000,
  ]);
  // Earlier trade, registration and time are synthetic test inputs; the zero-sided raw log is archived unchanged.
  const earlier: RawLog = {
    ...zero,
    logIndex: 2,
    topics: encoded.topics as Hex[],
    data: encoded.data as Hex,
  };
  const reg: PersistedPoolRegistration = {
    ...registration(earlier),
    pool: { chainId: 4663, protocol: 'v4', manager: zero.address, poolId: zero.topics[1]! },
    feePips: 0x800000,
    source: 'synthetic-metadata',
  };
  const b = batch('real-zero', [earlier, zero], {
    minuteStartSec: 120,
    exactTimestampSec: null,
    source: 'minute-boundary',
  });
  b.fromBlock = zero.blockNumber;
  b.toBlock = zero.blockNumber;
  b.end = { number: zero.blockNumber, hash: zero.blockHash, timestampSec: 180 };
  b.previous = null;
  b.poolRegistrations = [reg];
  const shard = b.manifest.shards[0]!;
  shard.filterId = 'operation-v4';
  shard.request = {
    fromBlock: zero.blockNumber,
    toBlock: zero.blockNumber,
    address: [zero.address],
    topics: [],
  };
  const { raw, projection, db } = fixture();
  raw.acceptRange(b);
  const result = projection.rebuild('test');
  expect(result.qualityErrors).toEqual([]);
  expect(result.events.map((e) => e.kind)).toEqual(['swap', 'swap-nontrade']);
  const retained = result.events[1]!;
  if (retained.kind !== 'swap-nontrade') throw Error('expected nontrade');
  expect(retained.ref).toMatchObject({ blockNumber: 57465603n, logIndex: 3 });
  expect(retained.decoded).toEqual({
    eventName: 'Swap',
    amount0: '-1',
    amount1: '0',
    sqrtPriceX96: '6723590767295199506134079760391',
    liquidity: '242871927514263989673',
    tick: '88825',
    fee: '0',
  });
  expect(result.observations[0]!.lastSwap).toEqual(result.events[0]);
  expect(projection.read('test')).toEqual(result);
  const persisted = db
    .prepare("select payload_json from projected_events where kind='swap-nontrade'")
    .get() as { payload_json: string };
  expect(JSON.parse(persisted.payload_json).decoded).toEqual(retained.decoded);
});
