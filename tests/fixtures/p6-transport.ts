import { readFileSync } from 'node:fs';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  parseAbi,
  toHex,
  type Hex,
} from 'viem';
import type { RawLog } from '../../src/domain/types.js';
import { createChainReader } from '../../src/rpc/client.js';
import { v3FactoryAbi, v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';

const config = JSON.parse(readFileSync('config/robinhood.json', 'utf8'));
const archive = JSON.parse(
  readFileSync('artifacts/p0/raw/2026-09-08T06-10-51-129Z/logs.json', 'utf8'),
) as { address: string; topics: Hex[]; data: Hex }[];
const stateAbi = parseAbi(['function poolManager() view returns (address)']);

export type P6Fault = 'disconnect' | 'rate-limit' | 'malformed-json';

export function createP6TransportFixture() {
  let branch = 0;
  let head = 200n;
  let duplicateLogs = false;
  let nowMs = 0;
  const faults = new Map<string, P6Fault[]>();
  const requests: string[] = [];
  const waits: number[] = [];
  const hash = (height: bigint) =>
    toHex(height + (branch !== 0 && height >= 150n ? BigInt(branch * 10_000) : 0n), {
      size: 32,
    });
  const swap = archive.find((log) => log.address === config.v3Pools[0] && log.topics.length === 3)!;
  const creation = {
    address: config.v3Factory,
    topics: encodeEventTopics({
      abi: v3FactoryAbi,
      eventName: 'PoolCreated',
      args: { token0: config.tokens.AMC, token1: config.tokens.USDG, fee: 3000 },
    }) as Hex[],
    data: encodeAbiParameters([{ type: 'int24' }, { type: 'address' }], [60, config.v3Pools[0]]),
  };
  const logs = (): RawLog[] =>
    [creation, swap, swap].map((log, index) => {
      const height = [90n, 120n, branch === 0 ? 180n : 185n][index]!;
      return {
        ...log,
        blockNumber: height,
        blockHash: hash(height),
        transactionHash: toHex(1_000 + index, { size: 32 }),
        transactionIndex: 0,
        logIndex: index,
        rawBlockTimestamp: null,
      } as RawLog;
    });
  const wireLog = (log: RawLog) => ({
    ...log,
    blockNumber: toHex(log.blockNumber),
    transactionIndex: toHex(log.transactionIndex),
    logIndex: toHex(log.logIndex),
    blockTimestamp: '0x0',
    removed: false,
  });
  const factory: typeof createChainReader = (env, options) =>
    createChainReader(env, {
      ...options,
      perSecond: 100_000,
      maxRetries: 0,
      fetchFn: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          id: number;
          method: string;
          params: unknown[];
        };
        requests.push(request.method);
        const fault = faults.get(request.method)?.shift();
        if (fault === 'disconnect') throw new TypeError('fetch failed: ECONNRESET');
        if (fault === 'rate-limit') return new Response('busy', { status: 429 });
        if (fault === 'malformed-json')
          return new Response('{"jsonrpc":"2.0","result":', { status: 200 });
        const [arg, block] = request.params as [any, any];
        let result: unknown;
        switch (request.method) {
          case 'eth_chainId':
            result = '0x1237';
            break;
          case 'eth_getBlockByNumber': {
            const height = arg === 'latest' ? head : BigInt(arg);
            result = {
              number: toHex(height),
              hash: hash(height),
              timestamp: toHex(1_000n + height),
            };
            break;
          }
          case 'eth_getCode':
            result = BigInt(block) >= 90n ? '0x6000' : '0x';
            break;
          case 'eth_getLogs': {
            const selected = logs()
              .filter(
                (log) =>
                  log.blockNumber >= BigInt(arg.fromBlock) &&
                  log.blockNumber <= BigInt(arg.toBlock) &&
                  (!arg.address?.length ||
                    arg.address.some(
                      (address: string) => address.toLowerCase() === log.address.toLowerCase(),
                    )) &&
                  arg.topics.every(
                    (wanted: string | string[] | null, index: number) =>
                      wanted === null ||
                      (Array.isArray(wanted) ? wanted : [wanted]).some(
                        (value) => value.toLowerCase() === log.topics[index]?.toLowerCase(),
                      ),
                  ),
              )
              .map(wireLog);
            result = duplicateLogs ? [...selected, ...selected] : selected;
            break;
          }
          case 'eth_call':
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
          default:
            throw new Error(`Unexpected fixture method ${request.method}`);
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      },
    });
  return {
    factory,
    requests,
    waits,
    nowMs: () => nowMs,
    sleep: async (ms: number) => {
      waits.push(ms);
      nowMs += ms;
    },
    faultNext(method: string, fault: P6Fault, count = 1) {
      faults.set(method, [...(faults.get(method) ?? []), ...Array<P6Fault>(count).fill(fault)]);
    },
    advanceClock(ms: number) {
      nowMs += ms;
    },
    setHead(value: bigint) {
      head = value;
    },
    fork() {
      branch++;
    },
    setDuplicateLogs(value = true) {
      duplicateLogs = value;
    },
  };
}
