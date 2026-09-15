import type Database from 'better-sqlite3';
import { metadataQueueFor } from '../storage/metadata-queue.js';
import {
  lookupMetadata,
  type MetadataLookupResult,
  type MetadataReader,
} from '../storage/token-metadata.js';

/**
 * The token-metadata lookups the ingest loop no longer waits for.
 *
 * A decimals observation costs two anchors and a call, and the batch that needed it used to pay for
 * them before it could commit. This worker moves that round trip off the critical path: the ingest
 * loop leases a demand at a safe point and walks on, the lookup completes beside it, and the result
 * waits in memory until a transaction of the loop's own making is ready to store it.
 *
 * Three properties make that safe to run next to the loop. It is single-flight — one token's
 * network sequence at a time, ever — so a slow provider delays other metadata instead of the
 * batch. It leases through the queue, so a result whose lease was taken over while it was out is
 * refused rather than applied (see `applyMetadataLookup`). And it writes nothing: the only mutable
 * state here is the ready buffer, which a caller drains inside its own transaction and then either
 * acks or rolls back.
 *
 * Every request goes through the reader the caller handed in, which carries the run's purpose
 * scope, provider limiter, request budget, deadline and evidence flush; this module never builds a
 * client of its own and never opens a transaction.
 */

/** How many tokens one kick takes on before the next safe point has to ask for more. */
export const METADATA_KICK_LIMIT = 16;

/**
 * How many lookups the end-of-run drain may start, at most.
 *
 * A backstop rather than a budget. The queue holds one row per address a run has demanded, so its
 * size is the real bound on a drain, and a reader that cannot make progress ends one through the
 * budget or deadline error the worker already treats as fatal. What this number is for is the queue
 * that somehow keeps refilling: nothing then holds the process open at exit.
 */
export const METADATA_DRAIN_LIMIT = 256;

/** What a drained batch of results was, and what the caller may do with it. */
export type MetadataDrain = {
  results: readonly MetadataLookupResult[];
  /** The snapshot is durable: remove exactly these results, keeping any that arrived meanwhile. */
  ack(): void;
  /** The snapshot is not durable: keep it, and the next attempt finds it again. */
  rollback(): void;
};

export interface MetadataWorker {
  /** Start work if idle, then return at once. A running chain is left alone. */
  kick(): void;
  /** Take the finished results, without waiting for the ones still in flight. */
  prepareDrain(): MetadataDrain;
  /** The lookups this worker has started, counted when each one's first request went out. */
  attempted(): number;
  /** The error that stopped this worker, or null. The main loop owns reporting it. */
  fatalError(): unknown | null;
  /**
   * Answer the demands this run queued and never collected, then return.
   *
   * A run that finishes on its own reaches no later safe point, so the observations it paid for are
   * still waiting in the ready buffer for a transaction that will never come: the last batch
   * committed before the lookups it kicked were out. This is that run's last collection, and it is
   * the only lookup that starts without the caller having just finished a safe point.
   *
   * It stops at the first of three things, and none of them is an error the caller has to handle: a
   * shutdown request, a critical error the worker recorded, or a kick that started nothing because
   * the remaining demands are leased or waiting out a backoff. Whatever it collected is in the ready
   * buffer, for `prepareDrain` to store exactly as a batch would.
   */
  drain(max?: number): Promise<void>;
  /** Stop starting work and wait for the request already in flight. */
  stop(): Promise<void>;
}

export type MetadataWorkerOptions = {
  db: Database.Database;
  reader: MetadataReader;
  scopeId: string;
  /** The lease owner recorded on the queue row; the run id, so a stuck lease names its run. */
  owner: string;
  /**
   * Whether the acquisition side is idle enough for one more token's round trip.
   *
   * Asked before every lease, not only at the start of a chain: a batch that begins while a chain
   * is between tokens pauses it, and the request already in flight is allowed to finish.
   */
  canStart: () => boolean;
  /** An outside stop request — shutdown — that ends the chain at its next safe point. */
  isStopping?: () => boolean;
  limit?: number;
  nowMs?: () => number;
};

export function createMetadataWorker(options: MetadataWorkerOptions): MetadataWorker {
  const { db, reader, scopeId, owner } = options;
  const limit = options.limit ?? METADATA_KICK_LIMIT;
  const nowMs = options.nowMs ?? Date.now;
  // Results are identified by the order they were born in, not by their position in an array: an
  // ack removes the entries it was handed and nothing else, so a result that completed during the
  // transaction it is about to be stored by is still there for the next one.
  const ready = new Map<number, MetadataLookupResult>();
  let seq = 0;
  let attempts = 0;
  let fatal: unknown = null;
  let stopping = false;
  let chain: Promise<void> | null = null;
  const stoppingNow = () => stopping || options.isStopping?.() === true;

  const run = async (): Promise<void> => {
    try {
      for (let started = 0; started < limit; started++) {
        if (stoppingNow() || !options.canStart()) return;
        const lease = metadataQueueFor(db).lease(scopeId, nowMs(), owner);
        if (lease === null) return;
        // Counted where the query starts rather than where a row lands: a request the caller's
        // budget or deadline cuts short really did go out, and its demand stays queued for a
        // lookup that can finish.
        attempts++;
        const result = await lookupMetadata(reader, lease);
        ready.set(seq++, result);
      }
    } catch (error) {
      // Nothing here is a token's own failure: a contract that reverts comes back as a value. What
      // arrives as a throw is the run's problem — budget, deadline, a closed reader, a failed
      // evidence write, shutdown — and swallowing it would turn a failed run into a quiet one.
      fatal = error;
    }
  };

  const kick = (): void => {
    if (stoppingNow() || fatal !== null || chain !== null) return;
    if (!options.canStart()) return;
    // The chain starts synchronously: the first lease is taken here, in the caller's own safe
    // point, rather than from a timer that would race the acquisition side for the wire.
    chain = run().finally(() => {
      chain = null;
    });
  };

  return {
    kick,
    async drain(max = METADATA_DRAIN_LIMIT) {
      const target = attempts + max;
      while (attempts < target && !stoppingNow() && fatal === null) {
        // A lookup the loop kicked may still be out — the drain's first job is to let it land in the
        // buffer, which is also what leaves the chain free for the next kick.
        if (chain !== null) {
          await chain;
          continue;
        }
        const before = attempts;
        kick();
        // `kick` declined: the caller is busy with a batch, or the worker is stopping. Either way
        // this drain has nothing it may start.
        if (chain === null) return;
        await chain;
        // The chain leased nothing: what is still queued is leased elsewhere or waiting out a
        // backoff, and kicking again would spin without spending a request.
        if (attempts === before) return;
      }
    },
    prepareDrain() {
      const ids = [...ready.keys()];
      const results = ids.map((id) => ready.get(id)!);
      return {
        results,
        ack: () => {
          for (const id of ids) ready.delete(id);
        },
        // A no-op is the whole behaviour: the snapshot was never removed, so a transaction that
        // rolled back finds the same results waiting for its next attempt.
        rollback: () => {},
      };
    },
    attempted: () => attempts,
    fatalError: () => fatal,
    async stop() {
      stopping = true;
      // Bounded by the request already in flight, which the reader's own deadline ends. Anything
      // still ready is left where it is: an unpersisted observation is recoverable — its demand is
      // still queued — while one claimed as durable would not be.
      await chain;
    },
  };
}
