import { readFileSync } from 'node:fs';
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
import { createChainReader } from '../../src/rpc/client.js';
import { v3PoolAbi, v3FactoryAbi } from '../../src/protocols/uniswap-v3/abi.js';
const config = JSON.parse(readFileSync('config/robinhood.json', 'utf8'));
const archive = JSON.parse(
  readFileSync('artifacts/p0/raw/2026-09-08T06-10-51-129Z/logs.json', 'utf8'),
) as { address: string; topics: Hex[]; data: Hex }[];
const stateAbi = parseAbi(['function poolManager() view returns (address)']);
const zero = '0x0000000000000000000000000000000000000000';
export function recorderFixture() {
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
      maxBackfillRpcRps: 100000,
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
                result: arg.to === config.tokens.USDG ? 6 : 18,
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
