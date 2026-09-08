import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionResult,
  encodeEventTopics,
  encodeAbiParameters,
  erc20Abi,
  parseAbi,
  toHex,
  type Hex,
} from 'viem';
import { runCli } from '../../src/cli.js';
import { createChainReader } from '../../src/rpc/client.js';
import { v3PoolAbi, v3FactoryAbi } from '../../src/protocols/uniswap-v3/abi.js';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { loadAssetVersion } from '../../src/registry/assets.js';
import { computeWatchScopeId } from '../../src/ingest/filter-plan.js';
const config = JSON.parse(readFileSync('config/robinhood.json', 'utf8'));
const archive = JSON.parse(
  readFileSync('artifacts/p0/raw/2026-09-08T06-10-51-129Z/logs.json', 'utf8'),
) as { address: string; topics: Hex[]; data: Hex }[];
const stateAbi = parseAbi(['function poolManager() view returns (address)']);
const zero = '0x0000000000000000000000000000000000000000';
function fixture() {
  let branch = 0;
  let limited = false;
  let head = 200n;
  const requests: string[] = [];
  const hash = (n: bigint) => toHex(n + (branch && n >= 150n ? 10000n : 0n), { size: 32 });
  const swap = archive.find((l) => l.address === config.v3Pools[0] && l.topics.length === 3)!;
  const creation: { address: string; topics: Hex[]; data: Hex } = {
    address: config.v3Factory,
    topics: encodeEventTopics({
      abi: v3FactoryAbi,
      eventName: 'PoolCreated',
      args: { token0: config.tokens.AMC, token1: config.tokens.USDG, fee: 3000 },
    }) as Hex[],
    data: encodeAbiParameters([{ type: 'int24' }, { type: 'address' }], [60, config.v3Pools[0]]),
  };
  const logs = () =>
    [creation, swap, swap].map((l, i) => {
      const n = [90n, 120n, branch ? 185n : 180n][i]!;
      return {
        ...l,
        blockNumber: toHex(n),
        blockHash: hash(n),
        transactionHash: toHex(1000 + i, { size: 32 }),
        transactionIndex: '0x0',
        logIndex: toHex(i),
        blockTimestamp: '0x0',
        removed: false,
      };
    });
  const factory: typeof createChainReader = (env, options) =>
    createChainReader(env, {
      ...options,
      perSecond: 100000,
      maxRetries: 0,
      fetchFn: async (_input, init) => {
        const req = JSON.parse(init!.body as string);
        requests.push(req.method);
        if (limited && req.method === 'eth_getLogs') return new Response('busy', { status: 503 });
        const [arg, block] = req.params;
        let result: unknown;
        switch (req.method) {
          case 'eth_chainId':
            result = '0x1237';
            break;
          case 'eth_getBlockByNumber': {
            const n = arg === 'latest' ? head : BigInt(arg);
            result = { number: toHex(n), hash: hash(n), timestamp: toHex(1000n + n) };
            break;
          }
          case 'eth_getCode':
            result = BigInt(block) >= 90n ? '0x6000' : '0x';
            break;
          case 'eth_getLogs':
            result = logs().filter(
              (l) =>
                BigInt(l.blockNumber) >= BigInt(arg.fromBlock) &&
                BigInt(l.blockNumber) <= BigInt(arg.toBlock) &&
                (!arg.address?.length || arg.address.includes(l.address)) &&
                arg.topics.every(
                  (t: string | string[] | null, i: number) =>
                    t === null || (Array.isArray(t) ? t : [t]).includes(l.topics[i]!),
                ),
            );
            break;
          case 'eth_call': {
            if (arg.to === config.stateView)
              result = encodeFunctionResult({
                abi: stateAbi,
                functionName: 'poolManager',
                result: config.v4Manager,
              });
            else if (Object.values(config.tokens).includes(arg.to))
              result = encodeFunctionResult({
                abi: erc20Abi,
                functionName: 'decimals',
                result: 18,
              });
            else if (arg.to === config.v3Factory)
              result = encodeFunctionResult({
                abi: v3FactoryAbi,
                functionName: 'getPool',
                result: config.v3Pools[0],
              });
            else {
              const call = decodeFunctionData({ abi: v3PoolAbi, data: arg.data });
              const returns = {
                factory: config.v3Factory,
                token0: config.tokens.AMC,
                token1: config.tokens.USDG,
                fee: 3000,
              };
              result = encodeFunctionResult({
                abi: v3PoolAbi,
                functionName: call.functionName,
                result: returns[call.functionName as keyof typeof returns],
              } as never);
            }
            break;
          }
          default:
            throw new Error('Unexpected method');
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
      },
    });
  return {
    factory,
    requests,
    fork: () => {
      branch = 1;
    },
    fail: () => {
      limited = true;
    },
    advance: () => {
      head = 220n;
    },
  };
}
test('ingest persists actual orchestration, restarts idempotently and rebuilds a fork into its new minute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-recorder-'));
  const f = fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const args = [
    'ingest',
    '--from-block',
    '100',
    '--to-block',
    '200',
    '--db',
    join(dir, 'db.sqlite'),
    '--out',
    join(dir, 'runs'),
    '--evidence',
    'off',
  ];
  const scope = computeWatchScopeId(loadAssetVersion('config/watchlist.amc.json'), 'operations', {
    v3Factory: config.v3Factory,
    v4Manager: config.v4Manager,
  });
  const inspect = () => {
    const db = openDatabase(join(dir, 'db.sqlite'));
    const s = new SqliteRangeStore(db);
    try {
      return {
        tip: s.acceptedTip(scope),
        logs: s.activeLogs(scope),
        times: [...s.logTimes(scope).values()],
      };
    } finally {
      db.close();
    }
  };
  try {
    expect(
      await runCli(args, {
        environment: { RH_RPC_HTTP: 'https://fixture.invalid' },
        readerFactory: f.factory,
      }),
    ).toBe(0);
    const before = inspect();
    expect(before.tip?.number).toBe(200n);
    expect(before.logs).toHaveLength(2);
    expect(
      before.times.every((t) => t.source === 'minute-boundary' && t.exactTimestampSec === null),
    ).toBe(true);
    expect(
      await runCli(args, {
        environment: { RH_RPC_HTTP: 'https://fixture.invalid' },
        readerFactory: f.factory,
      }),
    ).toBe(0);
    expect(inspect()).toEqual(before);
    const damaged = openDatabase(join(dir, 'db.sqlite'));
    damaged.prepare('delete from log_times where scope_id = ?').run(scope);
    damaged.close();
    expect(
      await runCli(args, {
        environment: { RH_RPC_HTTP: 'https://fixture.invalid' },
        readerFactory: f.factory,
      }),
    ).toBe(0);
    expect(inspect().times).toEqual(before.times);
    f.fork();
    expect(
      await runCli(args, {
        environment: { RH_RPC_HTTP: 'https://fixture.invalid' },
        readerFactory: f.factory,
      }),
    ).toBe(0);
    const after = inspect();
    expect(after.logs.some((l) => l.blockNumber === 185n)).toBe(true);
    expect(after.logs.some((l) => l.blockNumber === 180n)).toBe(false);
    const manifests = readdirSync(join(dir, 'runs')).map((p) =>
      JSON.parse(readFileSync(join(dir, 'runs', p, 'manifest.json'), 'utf8')),
    );
    expect(manifests.at(-1).follow.reorgs).toBe(1);
    expect(manifests.at(-1).counts.endpointAnchors).toBeGreaterThan(0);
    expect(manifests.at(-1).maxLogsPerResponse).toBeNull();
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
test('failed discovery cannot enable operation scope and emits incomplete manifest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-incomplete-'));
  const f = fixture();
  f.fail();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await runCli(
      [
        'ingest',
        '--from-block',
        '100',
        '--to-block',
        '200',
        '--db',
        join(dir, 'db.sqlite'),
        '--out',
        join(dir, 'runs'),
        '--evidence',
        'off',
      ],
      { environment: { RH_RPC_HTTP: 'https://fixture.invalid' }, readerFactory: f.factory },
    );
    expect(code).not.toBe(0);
    const folder = readdirSync(join(dir, 'runs'))[0]!;
    const manifest = JSON.parse(readFileSync(join(dir, 'runs', folder, 'manifest.json'), 'utf8'));
    expect(manifest.discoveryComplete).toBe(false);
    expect(manifest.acceptedTip).toBeNull();
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('initial run record failure still closes resources and writes a failed manifest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-run-failure-'));
  const f = fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const insertion = vi.spyOn(SqliteRangeStore.prototype, 'recordRun').mockImplementationOnce(() => {
    throw new Error('run insert failed');
  });
  let closed = 0;
  const factory: typeof createChainReader = (env, options) => {
    const r = f.factory(env, options);
    const close = r.close.bind(r);
    r.close = async () => {
      closed++;
      await close();
    };
    return r;
  };
  try {
    const result = await runCli(
      [
        'ingest',
        '--from-block',
        '100',
        '--to-block',
        '200',
        '--db',
        join(dir, 'db.sqlite'),
        '--out',
        join(dir, 'runs'),
        '--evidence',
        'off',
      ],
      { environment: { RH_RPC_HTTP: 'https://fixture.invalid' }, readerFactory: factory },
    );
    expect(result).toBe(1);
    expect(closed).toBe(1);
    const folder = readdirSync(join(dir, 'runs'))[0]!;
    expect(
      JSON.parse(readFileSync(join(dir, 'runs', folder, 'manifest.json'), 'utf8')).status,
    ).toBe('failed');
  } finally {
    insertion.mockRestore();
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
