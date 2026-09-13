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
export interface FollowResult {
  acceptedRanges: number;
  reorgs: number;
  warmupResets: number;
  failures: string[];
  complete: boolean;
}
export interface FollowOptions {
  scopeId: string;
  startBlock: bigint;
  /** Latest mode never backfills history when a reorg has no matching checkpoint. */
  recoverAtHead?: boolean;
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
  shouldStop?: () => boolean;
  onStateChange?: (state: 'healthy' | 'degraded') => void;
  onWait?: (elapsedMs: number) => void;
  onFailure?: () => void;
  onResult?: (result: FollowResult) => void;
  recordRange: (
    fromBlock: bigint,
    end: BlockAnchor,
    previous: BlockAnchor | null,
    head: BlockAnchor,
    acquisitionStartedAtMs: number,
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
  const stopping = () => now() >= stopAtMs || options.shouldStop?.() === true;
  let state: 'healthy' | 'degraded' | null = null;
  const publishState = (next: 'healthy' | 'degraded') => {
    if (state !== next) {
      state = next;
      options.onStateChange?.(next);
    }
  };
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
  const result: FollowResult = {
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
      if (stopping()) {
        result.complete = false;
        break;
      }
      let gap = false;
      try {
        let acquisitionStartedAtMs = now();
        let head = await reader.getAnchor('latest');
        let targetHeight =
          options.toBlock === undefined || options.toBlock > head.number
            ? head.number
            : options.toBlock;
        let target = targetHeight === head.number ? head : await reader.getAnchor(targetHeight);
        for (;;) {
          if (stopping()) break;
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
                const nextStart = options.recoverAtHead
                  ? head.number
                  : await warmupStart(
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
              if (stopping()) break;
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
          if (stopping()) break;
          const changes = await options.recordRange(
            from,
            end,
            previous,
            head,
            acquisitionStartedAtMs,
          );
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
          acquisitionStartedAtMs = now();
        }
        if (
          (store.acceptedTip(options.scopeId)?.number ?? -1n) < target.number &&
          start <= target.number
        )
          gap = true;
        if (explicitNext !== undefined && explicitNext <= target.number) gap = true;

        if (
          options.toBlock !== undefined &&
          (store.acceptedTip(options.scopeId)?.number ?? -1n) < options.toBlock
        )
          gap = true;
        if (!options.shouldStop?.() || !gap) publishState(gap ? 'degraded' : 'healthy');
        options.onProgress?.(ingestHealth(head, store.acceptedTip(options.scopeId), gap));
      } catch (error) {
        if (!options.shouldStop?.()) {
          publishState('degraded');
          options.onFailure?.();
        }
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
      if (!options.shouldStop?.() || !gap) publishState(gap ? 'degraded' : 'healthy');
      if (options.oneShot || stopping()) break;
      const waitingAt = now();
      await sleep(Math.min(poll, Math.max(0, stopAtMs - now())));
      options.onWait?.(Math.max(0, now() - waitingAt));
    } while (!stopping());
    return result;
  } catch (error) {
    result.complete = false;
    throw error;
  } finally {
    scopes.delete(options.scopeId);
    options.onResult?.({ ...result, failures: [...result.failures] });
  }
}
