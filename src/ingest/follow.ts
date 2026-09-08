import type { BlockAnchor, ChainReader, RangeChangeSet } from '../domain/types.js';
import { RpcFailure } from '../rpc/errors.js';
import { findMatchingCheckpoint } from './reorg.js';
import { warmupStart } from './checkpoint.js';
import { ingestHealth } from '../ops/health.js';

export interface FollowStore {
  acceptedTip(scopeId: string): BlockAnchor | null;
  checkpoints(scopeId: string): readonly BlockAnchor[];
  invalidateAfter(scopeId: string, anchor: BlockAnchor): RangeChangeSet | void;
  resetForWarmup(scopeId: string): RangeChangeSet | void;
  pruneCheckpoints(scopeId: string, minTimestampSec: number): void;
}
export interface FollowOptions {
  scopeId: string;
  startBlock: bigint;
  toBlock?: bigint;
  oneShot?: boolean;
  pollIntervalMs?: number;
  maxRangeBlocks?: number;
  overlapBlocks?: number;
  warmupMinutes?: number;
  checkpointRetentionMinutes?: number;
  deploymentFloor?: bigint;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  recordRange: (
    fromBlock: bigint,
    end: BlockAnchor,
    previous: BlockAnchor | null,
  ) => Promise<RangeChangeSet | null>;
  onChanges?: (changes: RangeChangeSet, cause: 'range' | 'reorg' | 'warmup') => void;
  onProgress?: (health: ReturnType<typeof ingestHealth>) => void;
  onRecovery?: (anchor: BlockAnchor | null) => Promise<void>;
}
const activeScopes = new WeakMap<FollowStore, Set<string>>();
export async function follow(
  reader: ChainReader,
  store: FollowStore,
  stopAtMs: number,
  options: FollowOptions,
) {
  const now = options.nowMs ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const poll = options.pollIntervalMs ?? 2000;
  const maxRange = options.maxRangeBlocks ?? 1000;
  const overlap = options.overlapBlocks ?? 20;
  const retention = options.checkpointRetentionMinutes ?? 180;
  if (
    ![poll, maxRange, retention].every((n) => Number.isSafeInteger(n) && n > 0) ||
    !Number.isSafeInteger(overlap) ||
    overlap < 0 ||
    overlap >= maxRange
  )
    throw new RangeError('Invalid polling/range/overlap settings');
  if (
    options.startBlock < 0n ||
    (options.toBlock !== undefined && options.toBlock < options.startBlock) ||
    !Number.isFinite(stopAtMs)
  )
    throw new RangeError('Invalid follow bounds');
  const scopes = activeScopes.get(store) ?? new Set<string>();
  if (scopes.has(options.scopeId)) throw new Error('Scope cursor already has an active recorder');
  scopes.add(options.scopeId);
  activeScopes.set(store, scopes);
  const result = {
    acceptedRanges: 0,
    reorgs: 0,
    warmupResets: 0,
    failures: [] as string[],
    complete: true,
  };
  let start = options.startBlock;
  let explicitNext = options.oneShot && options.toBlock !== undefined ? start : undefined;
  try {
    do {
      let gap = false;
      try {
        let head = await reader.getAnchor('latest');
        let targetHeight =
          options.toBlock === undefined || options.toBlock > head.number
            ? head.number
            : options.toBlock;
        let target = targetHeight === head.number ? head : await reader.getAnchor(targetHeight);
        for (;;) {
          if (now() >= stopAtMs) break;
          let previous = store.acceptedTip(options.scopeId);
          if (previous) {
            const current = await reader.getAnchor(previous.number);
            if (
              current.number !== previous.number ||
              current.hash.toLowerCase() !== previous.hash.toLowerCase() ||
              current.timestampSec !== previous.timestampSec
            ) {
              const match = await findMatchingCheckpoint(
                reader,
                store.checkpoints(options.scopeId),
              );
              result.reorgs++;
              if (match) {
                const changes = store.invalidateAfter(options.scopeId, match);
                if (changes) options.onChanges?.(changes, 'reorg');
              } else {
                const nextStart = await warmupStart(
                  reader,
                  head,
                  options.deploymentFloor ?? 0n,
                  options.warmupMinutes ?? 60,
                );
                const changes = store.resetForWarmup(options.scopeId);
                if (changes) options.onChanges?.(changes, 'warmup');
                start = nextStart;
                result.warmupResets++;
              }
              if (explicitNext !== undefined) explicitNext = start;
              await options.onRecovery?.(match);
              if (now() >= stopAtMs) break;
              head = await reader.getAnchor('latest');
              targetHeight =
                options.toBlock === undefined || options.toBlock > head.number
                  ? head.number
                  : options.toBlock;
              target = targetHeight === head.number ? head : await reader.getAnchor(targetHeight);
              continue;
            }
          }
          const candidate =
            explicitNext ?? (previous ? previous.number - BigInt(overlap) + 1n : start);
          const from = candidate > start ? candidate : start;
          if (from > target.number) break;
          const limit = from + BigInt(maxRange) - 1n;
          const end = limit < target.number ? await reader.getAnchor(limit) : target;
          if (now() >= stopAtMs) break;
          const changes = await options.recordRange(from, end, previous);
          if (!changes) {
            gap = true;
            result.failures.push('incomplete-range');
            break;
          }
          const accepted = store.acceptedTip(options.scopeId);
          const expectedTip = previous && previous.number > end.number ? previous : end;
          if (
            !accepted ||
            accepted.number !== expectedTip.number ||
            accepted.hash.toLowerCase() !== expectedTip.hash.toLowerCase()
          )
            throw new Error('Recorder did not commit the expected cursor');
          if (explicitNext !== undefined) explicitNext = end.number + 1n;
          result.acceptedRanges++;
          options.onChanges?.(changes, 'range');
          store.pruneCheckpoints(options.scopeId, Math.max(0, head.timestampSec - retention * 60));
          if (end.number >= target.number) break;
        }
        if (
          (store.acceptedTip(options.scopeId)?.number ?? -1n) < target.number &&
          start <= target.number
        )
          gap = true;
        if (explicitNext !== undefined && explicitNext <= target.number) gap = true;
        options.onProgress?.(ingestHealth(head, store.acceptedTip(options.scopeId), gap));
        if (
          options.toBlock !== undefined &&
          (store.acceptedTip(options.scopeId)?.number ?? -1n) < options.toBlock
        )
          gap = true;
      } catch (error) {
        if (
          !(error instanceof RpcFailure) ||
          error.kind === 'budget' ||
          error.evidenceFailure ||
          (!error.retryable && !['anchor-changed', 'anchor-conflict'].includes(error.kind))
        )
          throw error;
        result.failures.push(error.kind);
        gap = true;
      }
      result.complete = !gap;
      if (options.oneShot || now() >= stopAtMs) break;
      await sleep(Math.min(poll, Math.max(0, stopAtMs - now())));
    } while (now() < stopAtMs);
    return result;
  } finally {
    scopes.delete(options.scopeId);
  }
}
