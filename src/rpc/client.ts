import { createPublicClient, http, toHex, type Hex } from 'viem';
import type { RuntimeEnv } from '../config/env.js';
import type { ChainReader, RawLog } from '../domain/types.js';
import { checkedNumber } from '../domain/json.js';
import { RequestMeter } from './request-meter.js';
import { classifyRpcError, RpcFailure } from './errors.js';
import { RateLimiter } from './rate-limit.js';
import { EvidenceWriter, type EvidenceOptions } from './evidence-writer.js';

const methods = [
  'eth_chainId',
  'eth_getBlockByNumber',
  'eth_getLogs',
  'eth_getCode',
  'eth_call',
] as const;
export interface ReaderOptions extends EvidenceOptions {
  maxCalls?: number | null;
  deadlineMs?: number;
  maxConcurrentRpc?: number;
  maxBackfillRpcRps?: number;
  perSecond?: number;
  timeoutMs?: number;
  maxRetries?: number;
  evidenceFile?: string;
  fetchFn?: typeof fetch;
}
export interface EvidenceReader extends ChainReader {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
  meter: RequestMeter;
  sourceAlias: string;
}
const hex = (value: unknown, bytes?: number): Hex => {
  if (
    typeof value !== 'string' ||
    !/^0x[\da-f]+$/i.test(value) ||
    (bytes !== undefined && value.length !== 2 + 2 * bytes)
  )
    throw new RpcFailure('malformed-response');
  return value.toLowerCase() as Hex;
};
export function createChainReader(
  env: RuntimeEnv,
  options: ReaderOptions = {},
): EvidenceReader & { flush(): Promise<void>; close(): Promise<void> } {
  const meter = new RequestMeter(options.maxCalls === undefined ? 150 : options.maxCalls);
  const limiter = new RateLimiter(options.perSecond ?? 5, options.maxConcurrentRpc ?? 2);
  const backfillLimiter = new RateLimiter(options.maxBackfillRpcRps ?? 1, 1);
  let queued = 0;
  let active = 0;
  const writer = new EvidenceWriter(options);
  let closed = false;
  if (options.deadlineMs !== undefined && !Number.isFinite(options.deadlineMs))
    throw new RangeError('Invalid RPC deadline');
  const assertRequestAllowed = () => {
    meter.assertAvailable();
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)
      throw new RpcFailure('deadline');
  };
  const client = createPublicClient({
    transport: http(env.httpRpcUrl, {
      retryCount: 0,
      timeout: options.timeoutMs ?? 10000,
      batch: false,
      fetchFn: async (input, init) => {
        const response = await (options.fetchFn ?? fetch)(input, init);
        const body = response.body?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              meter.addBytes(chunk.byteLength);
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body ?? null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
      maxResponseBodySize: 10 * 1024 * 1024,
    }),
  });
  async function performRequest(method: string, params: readonly unknown[]): Promise<unknown> {
    if (!(methods as readonly string[]).includes(method))
      throw new RpcFailure('read-only-method-denied');
    for (let attempt = 0; ; attempt++) {
      assertRequestAllowed();
      queued++;
      meter.recordQueueWait(0, queued);
      const queuedAt = Date.now();
      const release = await limiter.enter();
      let dispatched = false;
      try {
        assertRequestAllowed();
        let transport!: Promise<unknown>;
        await limiter.acquire(
          () => assertRequestAllowed(),
          () => {
            assertRequestAllowed();
            meter.begin(method, attempt > 0);
            queued--;
            dispatched = true;
            meter.recordQueueWait(Date.now() - queuedAt, queued);
            active++;
            meter.recordConcurrency(active);
            transport = meter.trackAttempt(method, attempt > 0, async () => {
              try {
                return await client.request({ method, params } as never, { retryCount: 0 });
              } finally {
                active--;
                meter.recordConcurrency(active);
              }
            });
          },
          meter.isBackfill ? backfillLimiter : undefined,
        );
        const at = new Date().toISOString();
        const started = Date.now();
        let result: unknown;
        try {
          result = await transport;
          if (result === undefined) throw new RpcFailure('malformed-response');
        } catch (error) {
          const failure = classifyRpcError(error);
          if (failure.kind === 'rate-limit') limiter.penalize();
          else if (failure.retryable) limiter.defer(500 * 2 ** attempt);
          try {
            await writer.write({
              sourceAlias: env.providerAlias,
              at,
              method,
              params,
              attempt,
              elapsedMs: Date.now() - started,
              error: { kind: failure.kind, status: failure.status },
            });
          } catch (evidenceError) {
            // Evidence failure must not change the transport classification or retry budget.
            failure.evidenceFailure =
              evidenceError instanceof RpcFailure
                ? evidenceError
                : new RpcFailure('evidence-write');
          }
          if (!failure.retryable || attempt >= (options.maxRetries ?? 2)) throw failure;
          continue;
        }
        limiter.succeed();
        await writer.write({
          sourceAlias: env.providerAlias,
          at,
          method,
          params,
          attempt,
          elapsedMs: Date.now() - started,
          result,
        });
        return result;
      } finally {
        if (!dispatched) {
          queued--;
          meter.recordQueueWait(Date.now() - queuedAt, queued);
        }
        release();
      }
    }
  }
  const pending = new Set<Promise<unknown>>();
  function request(method: string, params: readonly unknown[]): Promise<unknown> {
    if (closed) return Promise.reject(new RpcFailure('reader-closed'));
    const work = performRequest(method, params);
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }
  async function flush(): Promise<void> {
    await Promise.allSettled([...pending]);
    await writer.flush();
  }
  return {
    request,
    flush,
    close: async () => {
      closed = true;
      await flush();
      await writer.close();
    },
    meter,
    sourceAlias: env.providerAlias,
    async getAnchor(block) {
      const result = (await request('eth_getBlockByNumber', [
        block === 'latest' ? block : toHex(block),
        false,
      ])) as Record<string, unknown> | null;
      if (!result) throw new RpcFailure('anchor-missing', 'unsupported');
      const anchor = {
        number: BigInt(hex(result.number)),
        hash: hex(result.hash, 32),
        timestampSec: checkedNumber(BigInt(hex(result.timestamp)), 0),
      };
      if (typeof block === 'bigint' && anchor.number !== block)
        throw new RpcFailure('anchor-number-mismatch');
      return anchor;
    },
    async getLogs(filter) {
      const result = await request('eth_getLogs', [
        {
          fromBlock: toHex(filter.fromBlock),
          toBlock: toHex(filter.toBlock),
          address: filter.address,
          topics: filter.topics,
        },
      ]);
      if (!Array.isArray(result)) throw new RpcFailure('malformed-logs');
      return result.map((item: Record<string, unknown>): RawLog => {
        const number = BigInt(hex(item.blockNumber));
        if (item.removed === true || number < filter.fromBlock || number > filter.toBlock)
          throw new RpcFailure('log-range-or-removed');
        const address = hex(item.address, 20);
        if (
          filter.address.length &&
          !filter.address.some((a) => a.toLowerCase() === address.toLowerCase())
        )
          throw new RpcFailure('log-address-mismatch');
        if (!Array.isArray(item.topics)) throw new RpcFailure('malformed-topics');
        const topics = item.topics.map((t) => hex(t, 32));
        if (
          filter.topics.some(
            (topic, i) =>
              topic !== null &&
              !(Array.isArray(topic) ? topic : [topic]).some((t) => t.toLowerCase() === topics[i]),
          )
        )
          throw new RpcFailure('log-topic-mismatch');
        if (typeof item.data !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(item.data))
          throw new RpcFailure('malformed-log-data');
        return {
          address,
          topics,
          data: item.data.toLowerCase() as Hex,
          blockNumber: number,
          blockHash: hex(item.blockHash, 32),
          transactionHash: hex(item.transactionHash, 32),
          transactionIndex: checkedNumber(BigInt(hex(item.transactionIndex)), 0),
          logIndex: checkedNumber(BigInt(hex(item.logIndex)), 0),
          rawBlockTimestamp:
            item.blockTimestamp === undefined || item.blockTimestamp === null
              ? null
              : hex(item.blockTimestamp),
        };
      });
    },
  };
}
