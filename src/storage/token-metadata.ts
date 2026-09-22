import type Database from 'better-sqlite3';
import { toHex, type Address } from 'viem';
import type { BlockAnchor } from '../domain/types.js';
import { decimalsAt, type MetricMetadata } from '../metrics/metadata.js';
import { RpcFailure, classifyRpcError } from '../rpc/errors.js';
import {
  metadataJournalPresent,
  metadataQueueFor,
  metadataRevision,
  type MetadataDemand,
  type MetadataLease,
} from './metadata-queue.js';

export type MetadataReader = {
  getAnchor(block: bigint | 'latest'): Promise<BlockAnchor>;
  request(method: string, params: readonly unknown[]): Promise<unknown>;
};
type Reader = MetadataReader;
/**
 * One address that needs a decimals observation, and the height it is needed at.
 *
 * `priority` is the plan's scale: 0 the valuation this round is missing, 1 a quote it depends on, 2
 * a monitored asset's startup warmup. It orders leases; it never shortens a backoff.
 */
export type TokenMetadataTarget = { address: Address; blockNumber: bigint; priority?: 0 | 1 | 2 };
/** The scope token-metadata demands are queued under when a caller does not name one. */
export const DEFAULT_METADATA_SCOPE_ID = 'live';
export type TokenMetadataUpdate = {
  attempted: number;
  resolved: number;
  failed: number;
  eligible: number;
  retryWaiting: number;
  inflight: number;
};
const empty: MetricMetadata = {
  version: 'onchain-v1',
  chainId: 4663,
  source: 'eth_call decimals at anchored block',
  entries: [],
};
function hasCache(db: Database.Database) {
  return !!db
    .prepare("select 1 from sqlite_master where type='table' and name='token_metadata'")
    .get();
}
type CacheMemo = {
  readonly seed: MetricMetadata;
  readonly version: string;
  readonly length: number;
  readonly revision: number;
  readonly metadata: MetricMetadata;
};

/** The cache last built for a database, keyed on everything its build read. */
const cacheMemo = new WeakMap<Database.Database, CacheMemo>();

/**
 * The seed plus every stored observation, as one cache.
 *
 * Building it is O(rows + entries) and — the expensive half — it hands `decimalsAt` a new object to
 * index. The live path rebuilds this every round from the same seed, so the answer is memoized on
 * the durable metadata revision: while that counter does not move, neither `token_metadata` nor the
 * invalid anchors changed, and the identical cache comes back as the identical object, whose index
 * the swap path then reuses instead of rebuilding per round.
 *
 * A database that predates the journal cannot report a change at all (its revision is always 0), so
 * it is never memoized: a readonly handle on an old file would otherwise pin the first answer it
 * happened to build, and a later writer that migrated the file could not move it.
 */
export function readCachedMetricMetadata(
  db: Database.Database,
  seed: MetricMetadata,
): MetricMetadata {
  if (!hasCache(db)) return seed;
  const revision = metadataJournalPresent(db) ? metadataRevision(db) : null;
  const memo = cacheMemo.get(db);
  if (
    revision !== null &&
    memo !== undefined &&
    memo.seed === seed &&
    memo.version === seed.version &&
    memo.length === seed.entries.length &&
    memo.revision === revision
  )
    return memo.metadata;
  const rows = db
    .prepare(
      'select address,decimals,block_number,block_hash from token_metadata order by block_number,address',
    )
    .all() as { address: string; decimals: number; block_number: number; block_hash: string }[];
  const invalidRows = db
    .prepare('select block_number,block_hash from token_metadata_invalid_anchors')
    .all() as { block_number: number; block_hash: string }[];
  if (!rows.length && !invalidRows.length) return remember(db, revision, seed, seed);
  const invalid = new Set(
    invalidRows.map((r) => String(r.block_number) + ':' + r.block_hash.toLowerCase()),
  );
  const merged = new Map(
    seed.entries
      .filter((e) => !invalid.has(e.observedAtBlock + ':' + e.blockHash.toLowerCase()))
      .map((e) => [e.address + ':' + e.observedAtBlock, e]),
  );
  for (const row of rows)
    merged.set(row.address + ':' + row.block_number, {
      address: row.address,
      decimals: row.decimals,
      observedAtBlock: String(row.block_number),
      blockHash: row.block_hash,
    });
  return remember(db, revision, seed, {
    ...seed,
    version: seed.version + '+onchain-v1',
    source: seed.source + '; recorder token_metadata',
    entries: [...merged.values()],
  });
}

/** Store a build for reuse, unless this database cannot report a change. */
function remember(
  db: Database.Database,
  revision: number | null,
  seed: MetricMetadata,
  metadata: MetricMetadata,
): MetricMetadata {
  if (revision !== null)
    cacheMemo.set(db, {
      seed,
      version: seed.version,
      length: seed.entries.length,
      revision,
      metadata,
    });
  return metadata;
}
function critical(error: unknown): void {
  const failure = classifyRpcError(error);
  if (
    ['budget', 'deadline', 'aborted', 'reader-closed', 'evidence-write'].includes(failure.kind) ||
    failure.evidenceFailure ||
    (error instanceof Error && error.constructor.name === 'ShutdownRequested')
  )
    throw error;
}
export async function validateTokenMetadata(
  db: Database.Database,
  reader: Reader,
  seed: MetricMetadata = empty,
): Promise<void> {
  if (!hasCache(db)) return;
  const rows = db.prepare('select distinct block_number,block_hash from token_metadata').all() as {
    block_number: number;
    block_hash: string;
  }[];
  const stored = new Set(
    rows.map((r) => String(r.block_number) + ':' + r.block_hash.toLowerCase()),
  );
  rows.push(
    ...seed.entries.map((e) => ({
      block_number: Number(e.observedAtBlock),
      block_hash: e.blockHash,
    })),
  );
  const byHeight = new Map<number, Set<string>>();
  for (const row of rows)
    byHeight.set(
      row.block_number,
      new Set([...(byHeight.get(row.block_number) ?? []), row.block_hash.toLowerCase()]),
    );
  for (const [height, hashes] of byHeight) {
    const anchor = await reader.getAnchor(BigInt(height));
    db.transaction(() => {
      for (const hash of hashes) {
        if (anchor.hash.toLowerCase() !== hash) {
          db.prepare(
            'insert or ignore into token_metadata_invalid_anchors(block_number,block_hash) values(?,?)',
          ).run(height, hash);
          if (stored.has(String(height) + ':' + hash)) {
            db.prepare('delete from token_metadata where block_number>=?').run(height);
            db.prepare('delete from token_metadata_failures').run();
          }
        } else
          db.prepare(
            'delete from token_metadata_invalid_anchors where block_number=? and block_hash=?',
          ).run(height, hash);
      }
    })();
  }
}
/** How long a failed lookup waits before the same demand is leasable again. */
export const METADATA_RETRY_MS = 60_000;

/** What one leased lookup found. `failure` is an RPC failure kind or `metadata-anchor-changed`. */
export type MetadataLookupResult = {
  lease: MetadataLease;
  anchor: BlockAnchor | null;
  decimals: number | null;
  failure: string | null;
};

/**
 * One leased demand's network round trip: anchor before, the call, anchor after.
 *
 * It writes nothing and holds no transaction, which is what lets a caller run it on the ingest
 * loop's critical path (the synchronous refresh below) or beside it (the metadata worker). A
 * failure comes back as a value, except for the critical kinds — budget, deadline, closed reader,
 * evidence failure, shutdown — which are the caller's to act on and never a token's own failure.
 */
export async function lookupMetadata(
  reader: Reader,
  lease: MetadataLease,
): Promise<MetadataLookupResult> {
  const height = lease.demand.blockNumber;
  const failed = (failure: string): MetadataLookupResult => ({
    lease,
    anchor: null,
    decimals: null,
    failure,
  });
  let before: BlockAnchor;
  try {
    before = await reader.getAnchor(height);
  } catch (error) {
    critical(error);
    return failed(classifyRpcError(error).kind);
  }
  try {
    const raw = await reader.request('eth_call', [
      { to: lease.demand.address, data: '0x313ce567' },
      toHex(height),
    ]);
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw) || BigInt(raw) > 255n)
      throw new RpcFailure('invalid-decimals');
    const decimals = Number(BigInt(raw));
    const after = await reader.getAnchor(height);
    // The reading is evidence about this height only if the branch held still across it: the same
    // block number has to carry the same hash before and after the call.
    if (
      before.number !== height ||
      after.number !== height ||
      before.hash.toLowerCase() !== after.hash.toLowerCase()
    )
      return failed('metadata-anchor-changed');
    return { lease, anchor: after, decimals, failure: null };
  } catch (error) {
    critical(error);
    return failed(classifyRpcError(error).kind);
  }
}

/**
 * What became of one applied lookup.
 *
 * `resolved` and `failed` are the two answers a token gave. The other two are results that never
 * became an answer: `stale-lease` when the row is no longer held under this lease id, and
 * `stale-branch` when it is, but the durable record says the anchor the reading was taken at is not
 * this branch. Neither is a statement about the token, so a caller counts them as neither.
 */
export type MetadataApplyOutcome = 'resolved' | 'failed' | 'stale-lease' | 'stale-branch';

/**
 * Whether the durable record still puts this anchor on the branch the cache is storing.
 *
 * `validateTokenMetadata` records every `(height, hash)` it found the chain disagreeing with, and a
 * row keyed to one of those pairs would be merged into the cache and served as an observation of a
 * height whose block hash the store has already rejected. The check reads a table only that
 * validation writes; it costs no request.
 */
function anchorOnBranch(db: Database.Database, anchor: BlockAnchor): boolean {
  return (
    db
      .prepare(
        'select 1 from token_metadata_invalid_anchors where block_number = ? and block_hash = ?',
      )
      .get(Number(anchor.number), anchor.hash.toLowerCase()) === undefined
  );
}

/**
 * Persist one lookup's result and settle its lease, inside the caller's transaction.
 *
 * Two validations stand between a result and the store, both asked before the first write because
 * neither leaves a trace a later statement could undo.
 *
 * The lease is asked first: only the row's *current* lease id may settle it, so a result that comes
 * back after its lease expired, was re-leased or was re-queued is dropped whole — it writes neither
 * an observation nor a backoff for a holder that has since lost its turn. The branch comes second:
 * a reading anchored where the invalidation record sees a different block is a reading of a fork,
 * so its lease is handed back for an immediate re-lookup instead of being held to expiry.
 *
 * The demand side of the validation is `settle`'s own coverage predicate — a result completes the
 * demand it actually covers and leaves an earlier one queued — so nothing here has to compare
 * heights. The row and its deadline move in the caller's transaction, so a rollback leaves the
 * demand queued rather than claiming an answer that did not become durable.
 */
export function applyMetadataLookup(
  db: Database.Database,
  scopeId: string,
  lookup: MetadataLookupResult,
  nowMs: number,
): MetadataApplyOutcome {
  const address = lookup.lease.demand.address;
  const leaseId = lookup.lease.leaseId;
  const queue = metadataQueueFor(db);
  const anchor = lookup.anchor;
  const decimals = lookup.decimals;
  return db.transaction((): MetadataApplyOutcome => {
    if (!queue.holdsLease(scopeId, address, leaseId)) return 'stale-lease';
    if (anchor !== null && decimals !== null && lookup.failure === null) {
      if (!anchorOnBranch(db, anchor)) {
        queue.settle(scopeId, leaseId, nowMs, { kind: 'requeue' });
        return 'stale-branch';
      }
      db.prepare(
        'insert into token_metadata(address,decimals,block_number,block_hash) values(?,?,?,?) on conflict(address,block_number) do update set decimals=excluded.decimals,block_hash=excluded.block_hash',
      ).run(address, decimals, Number(anchor.number), anchor.hash.toLowerCase());
      db.prepare('delete from token_metadata_failures where address=?').run(address);
      queue.settle(scopeId, leaseId, nowMs, { kind: 'resolved', anchorBlock: anchor.number });
      return 'resolved';
    }
    // The failures table stays the backoff input a fresh queue reads from, and the queue row carries
    // the same deadline so a restarted process inherits one number rather than two.
    const retryAtMs = nowMs + METADATA_RETRY_MS;
    db.prepare(
      'insert into token_metadata_failures(address,next_retry_ms,reason) values(?,?,?) on conflict(address) do update set next_retry_ms=excluded.next_retry_ms,reason=excluded.reason',
    ).run(address, retryAtMs, lookup.failure ?? 'unknown');
    queue.settle(scopeId, leaseId, nowMs, { kind: 'failed', retryAtMs });
    return 'failed';
  })();
}

/**
 * Demand metadata for these targets, without spending a request.
 *
 * The targets are demands, not a work list: an address the cache already answers is never queued,
 * and a demand the round does not reach stays queued for the next one. That is the difference from
 * the deferred counter this replaces — a slow provider no longer costs the addresses it did not get
 * to, and nothing has to rebuild a full candidate list to find them again.
 *
 * Split out from the lookup loop below because the two have different callers: the ingest loop
 * demands at a safe point and lets a worker do the asking, while the synchronous path does both.
 */
export function enqueueTokenMetadata(
  db: Database.Database,
  targets: readonly TokenMetadataTarget[],
  options: { nowMs?: number; seed?: MetricMetadata; scopeId?: string } = {},
): number {
  const now = options.nowMs ?? Date.now();
  const scopeId = options.scopeId ?? DEFAULT_METADATA_SCOPE_ID;
  const cached = readCachedMetricMetadata(db, options.seed ?? empty);
  const unique = new Map<string, MetadataDemand>();
  for (const target of targets) {
    const address = target.address.toLowerCase() as Address;
    if (
      !/^0x[0-9a-f]{40}$/.test(address) ||
      target.blockNumber < 0n ||
      target.blockNumber > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new RangeError('Invalid metadata target');
    // Native currency has no ERC20 contract to query.
    if (address === toHex(0, { size: 20 })) continue;
    const priority = target.priority ?? 0;
    const old = unique.get(address);
    if (old === undefined)
      unique.set(address, { address, blockNumber: target.blockNumber, priority });
    else {
      // The earliest height is the one an answer has to cover, and the most urgent priority any
      // caller gave is the one that sticks. The queue merges the same way across rounds.
      if (target.blockNumber < old.blockNumber) old.blockNumber = target.blockNumber;
      if (priority < old.priority) old.priority = priority;
    }
  }
  const demands: MetadataDemand[] = [];
  for (const demand of unique.values())
    if (decimalsAt(cached, demand.address, demand.blockNumber) === null) demands.push(demand);
  metadataQueueFor(db).enqueue(scopeId, demands, now);
  return demands.length;
}

/**
 * Demand metadata for these targets, then answer as many demands as the request budget allows.
 *
 * The synchronous composition: queue the demands and lease them one by one in this same call. The
 * live pipeline uses the two halves separately — `enqueueTokenMetadata` at the safe point that
 * decides what is missing, and `createMetadataWorker` for the network — so that a batch never waits
 * for a provider, but a caller with nothing else to do still has one function to call.
 */
export async function refreshTokenMetadata(
  db: Database.Database,
  reader: Reader,
  targets: readonly TokenMetadataTarget[],
  options: {
    nowMs?: number;
    maxTokens?: number;
    seed?: MetricMetadata;
    scopeId?: string;
    owner?: string;
  } = {},
): Promise<TokenMetadataUpdate> {
  const now = options.nowMs ?? Date.now(),
    max = options.maxTokens ?? 16;
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('Invalid metadata lookup limit');
  const scopeId = options.scopeId ?? DEFAULT_METADATA_SCOPE_ID;
  const queue = metadataQueueFor(db);
  const attempts = { attempted: 0, resolved: 0, failed: 0 };
  enqueueTokenMetadata(db, targets, {
    nowMs: now,
    ...(options.seed ? { seed: options.seed } : {}),
    scopeId,
  });
  while (attempts.attempted < max) {
    const lease = queue.lease(scopeId, now, options.owner ?? 'refresh');
    if (lease === null) break;
    // Counted when the query starts, not when a row lands: an attempt a critical error interrupts
    // really did spend the request, and an unsettled lease expires on its own.
    attempts.attempted++;
    const outcome = applyMetadataLookup(db, scopeId, await lookupMetadata(reader, lease), now);
    if (outcome === 'resolved') attempts.resolved++;
    else if (outcome === 'failed') attempts.failed++;
  }
  return { ...attempts, ...queue.stats(scopeId, now) };
}
