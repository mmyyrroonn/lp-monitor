import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, http, toHex, type Hex } from 'viem';
import type { RuntimeEnv } from '../config/env.js';
import type { BlockAnchor, ChainReader, RawLog } from '../domain/types.js';
import { checkedNumber } from '../domain/json.js';
import { RequestMeter } from '../ops/request-meter.js';
import { classifyRpcError, RpcFailure } from './errors.js';
import { RateLimiter } from './rate-limit.js';

const methods = ['eth_chainId', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getCode', 'eth_call'] as const;
export interface ReaderOptions { maxCalls?: number; perSecond?: number; timeoutMs?: number; maxRetries?: number; evidenceFile?: string; fetchFn?: typeof fetch }
export interface EvidenceReader extends ChainReader {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
  meter: RequestMeter; anchors: Map<string, BlockAnchor>; sourceAlias: string;
}
const hex = (value: unknown, bytes?: number): Hex => {
  if (typeof value !== 'string' || !/^0x[\da-f]+$/i.test(value) || (bytes !== undefined && value.length !== 2 + 2 * bytes)) throw new RpcFailure('malformed-response');
  return value as Hex;
};
export function createChainReader(env: RuntimeEnv, options: ReaderOptions = {}): EvidenceReader {
  const meter = new RequestMeter(options.maxCalls ?? 150);
  const limiter = new RateLimiter(options.perSecond ?? 5);
  const anchors = new Map<string, BlockAnchor>();
  const client = createPublicClient({ transport: http(env.httpRpcUrl, {
    retryCount: 0, timeout: options.timeoutMs ?? 10000, batch: false,
    fetchFn: async (input, init) => {
      const response = await (options.fetchFn ?? fetch)(input, init);
      const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { meter.addBytes(chunk.byteLength); controller.enqueue(chunk); },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
    maxResponseBodySize: 10 * 1024 * 1024,
  }) });
  if (options.evidenceFile) mkdirSync(dirname(options.evidenceFile), { recursive: true });
  function save(entry: unknown) {
    if (options.evidenceFile) appendFileSync(options.evidenceFile, JSON.stringify(entry) + '\n');
  }
  async function request(method: string, params: readonly unknown[]): Promise<unknown> {
    if (!(methods as readonly string[]).includes(method)) throw new RpcFailure('read-only-method-denied');
    for (let attempt = 0; ; attempt++) {
      await limiter.acquire(); meter.begin(method, attempt > 0);
      const at = new Date().toISOString(); const started = Date.now();
      try {
        const result: unknown = await client.request({ method, params } as never, { retryCount: 0 });
        // Only successful public chain data is persisted. Provider error text may contain credentials.
        save({ sourceAlias: env.providerAlias, at, method, params, attempt, elapsedMs: Date.now() - started, result });
        return result;
      } catch (error) {
        const failure = classifyRpcError(error);
        if (failure.kind === 'rate-limit') limiter.penalize();
        save({ sourceAlias: env.providerAlias, at, method, params, attempt, elapsedMs: Date.now() - started, error: { kind: failure.kind, status: failure.status } });
        if (!failure.retryable || attempt >= (options.maxRetries ?? 2)) throw failure;
        await delay(500 * 2 ** attempt);
      }
    }
  }
  return {
    request, meter, anchors, sourceAlias: env.providerAlias,
    async getAnchor(block) {
      const result = await request('eth_getBlockByNumber', [block === 'latest' ? block : toHex(block), false]) as Record<string, unknown> | null;
      if (!result) throw new RpcFailure('anchor-missing', 'unsupported');
      const anchor = { number: BigInt(hex(result.number)), hash: hex(result.hash, 32), timestampSec: checkedNumber(BigInt(hex(result.timestamp)), 0) };
      if (typeof block === 'bigint' && anchor.number !== block) throw new RpcFailure('anchor-number-mismatch');
      anchors.set(anchor.number.toString(), anchor); return anchor;
    },
    async getLogs(filter) {
      const result = await request('eth_getLogs', [{ fromBlock: toHex(filter.fromBlock), toBlock: toHex(filter.toBlock), address: filter.address, topics: filter.topics }]);
      if (!Array.isArray(result)) throw new RpcFailure('malformed-logs');
      return result.map((item: Record<string, unknown>): RawLog => {
        const number = BigInt(hex(item.blockNumber));
        if (item.removed === true || number < filter.fromBlock || number > filter.toBlock) throw new RpcFailure('log-range-or-removed');
        const address = hex(item.address, 20);
        if (filter.address.length && !filter.address.some(a => a.toLowerCase() === address.toLowerCase())) throw new RpcFailure('log-address-mismatch');
        if (!Array.isArray(item.topics)) throw new RpcFailure('malformed-topics');
        const topics = item.topics.map(t => hex(t, 32));
        if (filter.topics.some((topic, i) => topic !== null && !(Array.isArray(topic) ? topic : [topic]).includes(topics[i]!))) throw new RpcFailure('log-topic-mismatch');
        if (typeof item.data !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(item.data)) throw new RpcFailure('malformed-log-data');
        return { address, topics, data: item.data as Hex, blockNumber: number,
          blockHash: hex(item.blockHash, 32), transactionHash: hex(item.transactionHash, 32),
          transactionIndex: checkedNumber(BigInt(hex(item.transactionIndex)), 0), logIndex: checkedNumber(BigInt(hex(item.logIndex)), 0),
          rawBlockTimestamp: item.blockTimestamp === undefined || item.blockTimestamp === null ? null : hex(item.blockTimestamp) };
      });
    },
  };
}
