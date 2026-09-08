import { test, expect, vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import { createChainReader } from '../../src/rpc/client.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  parseAbi,
  toHex,
  toEventSelector,
  type Hex,
} from 'viem';
import { v3PoolAbi, v3FactoryAbi } from '../../src/protocols/uniswap-v3/abi.js';
import { v4ManagerAbi } from '../../src/protocols/uniswap-v4/abi.js';
type RpcLog = { address: string; topics: Hex[]; data: Hex; [key: string]: unknown };
function successfulRun(command: 'probe' | 'capture') {
  const dir = mkdtempSync(join(tmpdir(), 'p0-success-'));
  const config = JSON.parse(readFileSync('config/robinhood.json', 'utf8'));
  config.deploymentCandidateBlock = '90';
  config.v4PoolHistoryHints = config.v4PoolHistoryHints.map((h: { poolId: string }) => ({
    poolId: h.poolId,
    timestampSec: 1010,
  }));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(config));
  const archive = JSON.parse(
    readFileSync('artifacts/p0/raw/2026-09-08T06-10-51-129Z/logs.json', 'utf8'),
  ) as RpcLog[];
  const topic = (abi: typeof v3PoolAbi | typeof v4ManagerAbi, name: string) => {
    const event = abi.find((e) => e.type === 'event' && e.name === name);
    if (!event || event.type !== 'event') throw new Error('Missing event');
    return toEventSelector(event);
  };
  const selected = [
    archive.find((l) => l.topics[0] === topic(v3PoolAbi, 'Swap'))!,
    archive.find((l) => l.topics[0] === topic(v4ManagerAbi, 'Swap'))!,
    archive.find((l) => l.topics[0] === topic(v4ManagerAbi, 'ModifyLiquidity'))!,
    ...config.v4PoolIds.map((id: string) =>
      archive.find((l) => l.topics[0] === topic(v4ManagerAbi, 'Initialize') && l.topics[1] === id)!,
    ),
  ];
  const logs = selected.map((l, i) => ({
    ...l,
    blockNumber: '0x64',
    blockHash: toHex(100n, { size: 32 }),
    blockTimestamp: toHex(1010),
    transactionIndex: toHex(i),
    logIndex: toHex(i),
  }));
  const stateViewAbi = parseAbi(['function poolManager() view returns (address)']);
  const factory: typeof createChainReader = (env, options) =>
    createChainReader(env, {
      ...options,
      perSecond: 10000,
      fetchFn: async (_input, init) => {
        const request = JSON.parse(init!.body as string);
        const [arg, block] = request.params;
        let result: unknown;
        switch (request.method) {
          case 'eth_chainId':
            result = '0x1237';
            break;
          case 'eth_getBlockByNumber': {
            const n = arg === 'latest' ? 500n : BigInt(arg);
            result = {
              number: toHex(n),
              hash: toHex(n, { size: 32 }),
              timestamp: toHex(n === 0n ? 0 : 1000 + Number(n / 10n)),
            };
            break;
          }
          case 'eth_getCode':
            result = BigInt(block) >= 90n ? '0x6000' : '0x';
            break;
          case 'eth_getLogs':
            result = logs.filter(
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
                abi: stateViewAbi,
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
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      },
    });
  return {
    dir,
    path,
    factory,
    args: [
      command,
      '--config',
      path,
      '--out',
      join(dir, command === 'probe' ? 'report.json' : 'capture'),
      ...(command === 'capture' ? ['--from-block', '90', '--to-block', '110'] : []),
    ],
  };
}
test.each(['probe', 'capture'] as const)(
  'CLI %s completes real orchestration with synthetic RPC responses and exits zero',
  async (command) => {
    const fixture = successfulRun(command);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const exit = await runCli(fixture.args, {
        environment: { RH_RPC_HTTP: 'https://synthetic.invalid' },
        readerFactory: fixture.factory,
      });
      expect(exit).toBe(0);
      const output = JSON.parse(log.mock.calls.at(-1)![0] as string);
      expect(
        command === 'probe'
          ? output.requiredPassed && output.identityPassed
          : output.acceptancePassed,
      ).toBe(true);
      expect(output.meter.calls).toBeLessThanOrEqual(150);
    } finally {
      log.mockRestore();
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  },
);
test.each(['capture', 'probe'] as const)(
  'CLI %s close failure preserves primary RPC error plus evidence failure',
  async (command) => {
    const fixture = successfulRun(command);
    const factory: typeof createChainReader = (env, options) =>
      createChainReader(env, {
        ...options,
        maxRetries: 0,
        evidenceMaxBytes: 1,
        fetchFn: async () => new Response('Unavailable', { status: 503 }),
      });
    try {
      await expect(
        runCli(fixture.args, {
          environment: { RH_RPC_HTTP: 'https://synthetic.invalid' },
          readerFactory: factory,
        }),
      ).rejects.toMatchObject({
        kind: 'http-transient',
        evidenceFailure: { kind: 'evidence-capacity' },
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  },
);

test('closing the same evidence failure never creates a self-referencing diagnostic', async () => {
  const fixture = successfulRun('capture');
  const factory: typeof createChainReader = (env, options) =>
    createChainReader(env, {
      ...options,
      evidenceMaxBytes: 1,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { number: '0x64', hash: toHex(100n, { size: 32 }), timestamp: '0x3e8' },
          }),
        ),
    });
  try {
    const error = await runCli(fixture.args, {
      environment: { RH_RPC_HTTP: 'https://synthetic.invalid' },
      readerFactory: factory,
    }).catch((e) => e);
    expect(error.kind).toBe('evidence-capacity');
    expect(error.evidenceFailure).not.toBe(error);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

import { RpcFailure } from '../../src/rpc/errors.js';
test('incomplete capture retains exit 4 when evidence close also fails', async () => {
  const fixture = successfulRun('capture');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  const evidenceFailure = new RpcFailure('evidence-write');
  const factory: typeof createChainReader = (env, options) => {
    const reader = fixture.factory(env, options);
    return {
      ...reader,
      getLogs: async () => {
        const error = new RpcFailure('timeout-or-network', 'unknown', true);
        error.evidenceFailure = evidenceFailure;
        throw error;
      },
      close: async () => {
        await reader.close();
        throw evidenceFailure;
      },
    };
  };
  try {
    await expect(
      runCli(fixture.args, {
        environment: { RH_RPC_HTTP: 'https://synthetic.invalid' },
        readerFactory: factory,
      }),
    ).resolves.toBe(4);
    const report = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(report.failures).toContain('primary:timeout-or-network');
    expect(report.failures).toContain('primary:evidence:evidence-write');
  } finally {
    output.mockRestore();
    diagnostic.mockRestore();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
