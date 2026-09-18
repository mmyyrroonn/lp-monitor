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
/**
 * `cancel` is the hook that reports a body reader going away, but Node's TransformStream resolves
 * to the DOM lib's `Transformer`, which predates the member. @types/node already declares it on the
 * same interface, so naming it here keeps the callback typed instead of cast.
 */
type BodyTransformer = Transformer<Uint8Array, Uint8Array> & { cancel?: () => void };
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
  // One budget for both halves of a request: viem spends it waiting for response headers, and the
  // watchdog below spends the same number idling between body chunks. A second knob would ask the
  // operator for two answers to one question -- "how long may this provider make no progress".
  const timeoutMs = options.timeoutMs ?? 10000;
  const client = createPublicClient({
    transport: http(env.httpRpcUrl, {
      retryCount: 0,
      timeout: timeoutMs,
      batch: false,
      fetchFn: async (input, init) => {
        const abort = new AbortController();
        // viem disarms its own timeout the instant the headers land: withTimeout clears its timer
        // in a finally around the fetch that awaits them. Nothing below is bounded by it, so a body
        // that stops producing data holds its socket until undici's 300s default -- long enough to
        // stall a strictly serial follow loop for minutes. Carry our own signal into the real fetch
        // so the watchdog can abandon the connection rather than merely stop reading it.
        const signal = init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal;
        const response = await (options.fetchFn ?? fetch)(input, { ...init, signal });
        let errorBody: ((failure: RpcFailure) => void) | undefined;
        let watchdog: NodeJS.Timeout | undefined;
        const disarm = () => {
          if (watchdog !== undefined) clearTimeout(watchdog);
          watchdog = undefined;
        };
        // An idle budget, not a total one: the timer restarts on every chunk, so a legitimately
        // slow multi-megabyte getLogs response is never killed for taking long, only for going
        // quiet. A non-positive timeout means "no timeout" exactly as it does in viem.
        const arm = () => {
          if (timeoutMs <= 0) return;
          disarm();
          watchdog = setTimeout(() => {
            watchdog = undefined;
            const failure = new RpcFailure('timeout-or-network', 'unknown', true);
            try {
              // Error our readable first, so the caller classifies the failure we chose rather than
              // whatever the abort surfaces. Then abort regardless: erroring alone would leave the
              // underlying body read running and its connection ESTABLISHED, which is the symptom.
              errorBody?.(failure);
            } finally {
              abort.abort(failure);
            }
          }, timeoutMs);
          // A watchdog must never be the reason the process stays up. The socket it is watching
          // already holds the loop open while the read is genuinely outstanding, so unref costs it
          // nothing but lets a recorder shut down without waiting out a timer nothing will observe.
          (watchdog as { unref?: () => void }).unref?.();
        };
        const watched: BodyTransformer = {
          start(controller) {
            errorBody = (failure) => controller.error(failure);
            arm();
          },
          transform(chunk, controller) {
            meter.addBytes(chunk.byteLength);
            controller.enqueue(chunk);
            arm();
          },
          flush() {
            disarm();
          },
          cancel() {
            // The reader went away or the upstream errored: no further chunk can arrive, so the
            // watchdog has nothing left to time and the connection nothing left to serve.
            disarm();
            abort.abort();
          },
        };
        const body = response.body?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>(watched),
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
          // The backoff below exists to space out the retry that follows it. When the budget is
          // spent the error is thrown instead, and delaying every other call sharing this limiter
          // buys nothing: the caller is already in charge of when to come back.
          const retryFollows = failure.retryable && attempt < (options.maxRetries ?? 2);
          if (failure.kind === 'rate-limit') limiter.penalize();
          else if (retryFollows) limiter.defer(500 * 2 ** attempt);
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
          if (!retryFollows) throw failure;
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
