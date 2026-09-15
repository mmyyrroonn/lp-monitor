import { afterEach, expect, test, vi } from 'vitest';
import { toHex } from 'viem';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { validateTokenMetadata } from '../../src/storage/token-metadata.js';
import {
  METADATA_LEASE_MS,
  METADATA_REVISION_JOURNAL_LIMIT,
  metadataAddressChanges,
  metadataQueueFor,
  metadataRevision,
  type MetadataDemand,
} from '../../src/storage/metadata-queue.js';
const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const addr = (n: number) => toHex(n, { size: 20 });
const hash = (n: number) => toHex(n, { size: 32 });
const demand = (n: number, blockNumber: bigint, priority: 0 | 1 | 2): MetadataDemand => ({
  address: addr(n),
  blockNumber,
  priority,
});
function setup() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}
type Row = {
  address: string;
  needed_block: number;
  priority: number;
  next_retry_ms: number;
  lease_id: string | null;
  lease_owner: string | null;
  lease_until_ms: number | null;
  updated_at_ms: number;
};
function row(db: ReturnType<typeof setup>, scopeId: string, address: string): Row {
  return db
    .prepare(
      `select address, needed_block, priority, next_retry_ms, lease_id, lease_owner,
         lease_until_ms, updated_at_ms
       from metadata_demand where scope_id = ? and address = ?`,
    )
    .get(scopeId, address.toLowerCase()) as Row;
}
function addresses(db: ReturnType<typeof setup>, scopeId: string): string[] {
  return (
    db
      .prepare('select address from metadata_demand where scope_id = ? order by address')
      .all(scopeId) as { address: string }[]
  ).map((r) => r.address);
}
function failMetadata(db: ReturnType<typeof setup>, address: string, nextRetryMs: number): void {
  db.prepare('insert into token_metadata_failures(address,next_retry_ms,reason) values(?,?,?)').run(
    address.toLowerCase(),
    nextRetryMs,
    'test',
  );
}
function storeMetadata(
  db: ReturnType<typeof setup>,
  n: number,
  decimals: number,
  blockNumber: number,
  blockHash: string,
): void {
  db.prepare(
    'insert into token_metadata(address,decimals,block_number,block_hash) values(?,?,?,?)',
  ).run(addr(n), decimals, blockNumber, blockHash);
}
function journalRevisions(db: ReturnType<typeof setup>): number {
  return (
    db.prepare('select count(distinct revision) as n from metadata_address_changes').get() as {
      n: number;
    }
  ).n;
}
function journalRows(db: ReturnType<typeof setup>): number {
  return (db.prepare('select count(*) as n from metadata_address_changes').get() as { n: number })
    .n;
}

test('a new demand takes its retry deadline from the failures table and now when it never failed', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  failMetadata(db, addr(1), 5_000);
  queue.enqueue('scope', [demand(1, 100n, 0), demand(2, 100n, 0)], 1_000);
  const failed = row(db, 'scope', addr(1));
  expect(failed.next_retry_ms).toBe(5_000);
  expect(failed.needed_block).toBe(100);
  expect(failed.priority).toBe(0);
  expect(failed.lease_id).toBeNull();
  expect(failed.lease_owner).toBeNull();
  expect(failed.lease_until_ms).toBeNull();
  expect(row(db, 'scope', addr(2)).next_retry_ms).toBe(1_000);
  // The failures table keeps its row: it is a backoff input, not the queue.
  expect(db.prepare('select count(*) as n from token_metadata_failures').get()).toEqual({ n: 1 });
});

test('a repeated demand merges into the earliest unresolved demand of that address', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue('scope', [demand(1, 100n, 2)], 0);
  queue.enqueue('scope', [demand(1, 80n, 1)], 1);
  // A later demand never raises the height the address is already waiting for, and the most
  // urgent priority ever asked for is the one that sticks.
  queue.enqueue('scope', [demand(1, 120n, 0)], 2);
  expect(addresses(db, 'scope')).toEqual([addr(1)]);
  const merged = row(db, 'scope', addr(1));
  expect(merged.needed_block).toBe(80);
  expect(merged.priority).toBe(0);
});

test('an enqueue records when the demand was last written', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue('scope', [demand(1, 100n, 0)], 1_000);
  expect(row(db, 'scope', addr(1)).updated_at_ms).toBe(1_000);
  queue.enqueue('scope', [demand(1, 100n, 0)], 7_000);
  expect(row(db, 'scope', addr(1)).updated_at_ms).toBe(7_000);
});

test('re-enqueueing never resets a backoff and never disturbs a live lease', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue('scope', [demand(1, 100n, 0)], 0);
  const lease = queue.lease('scope', 0, 'worker')!;
  queue.settle('scope', lease.leaseId, 0, { kind: 'failed', retryAtMs: 90_000 });
  // The address never failed before, so a fresh seed would have used `nowMs` here.
  queue.enqueue('scope', [demand(1, 40n, 0)], 100_000);
  const waited = row(db, 'scope', addr(1));
  expect(waited.next_retry_ms).toBe(90_000);
  expect(waited.needed_block).toBe(40);

  const held = queue.lease('scope', 90_000, 'worker')!;
  queue.enqueue('scope', [demand(1, 20n, 1)], 90_001);
  const live = row(db, 'scope', addr(1));
  expect(live.lease_id).toBe(held.leaseId);
  expect(live.lease_owner).toBe('worker');
  expect(live.lease_until_ms).toBe(90_000 + METADATA_LEASE_MS);
  expect(live.next_retry_ms).toBe(90_000);
  // The demand still merges while the lease is out: the worker answers the height it was sent for.
  expect(live.needed_block).toBe(20);
});

test('lease takes the highest priority, then the earliest height, then the address', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  // Every demand here carries the same retry deadline, which is what the test below covers, so this
  // pins the three tiebreakers under it. Addresses 2 and 3 share priority and height, so only the
  // address makes the order stable.
  queue.enqueue(
    'scope',
    [demand(3, 50n, 0), demand(2, 50n, 0), demand(1, 90n, 0), demand(4, 10n, 1)],
    0,
  );
  const taken = [0, 1, 2, 3].map((_) => queue.lease('scope', 0, 'worker')!.demand.address);
  expect(taken).toEqual([addr(2), addr(3), addr(1), addr(4)]);
  // One row per lease: the four rows are gone from the leasable set, the fifth lease finds nothing.
  expect(addresses(db, 'scope').length).toBe(4);
  expect(queue.lease('scope', 0, 'worker')).toBeNull();
  expect(queue.stats('scope', 0)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 4 });
});

test('a never-attempted demand is leased before demands whose retry deadline already passed', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  // Three equally urgent demands. Two of them are leased and fail, which is what pushes a retry
  // deadline forward on them; the third keeps the `nowMs` it was enqueued at, so it is picked first
  // even though its address sorts last. A failed token cannot starve one nobody has looked at yet.
  queue.enqueue('scope', [demand(1, 100n, 0), demand(2, 100n, 0), demand(3, 100n, 0)], 0);
  // Past the lease taken below, so all three rows are leasable again.
  const now = 40_000;
  const failed = queue.lease('scope', 0, 'worker')!;
  queue.settle('scope', failed.leaseId, 0, { kind: 'failed', retryAtMs: now - 100 });
  const later = queue.lease('scope', 0, 'worker')!;
  queue.settle('scope', later.leaseId, 0, { kind: 'failed', retryAtMs: now - 1 });
  expect([failed.demand.address, later.demand.address]).toEqual([addr(1), addr(2)]);
  expect(row(db, 'scope', addr(1)).next_retry_ms).toBe(now - 100);
  expect(row(db, 'scope', addr(2)).next_retry_ms).toBe(now - 1);
  const order = [0, 1, 2].map((_) => queue.lease('scope', now, 'worker')!.demand.address);
  expect(order).toEqual([addr(3), addr(1), addr(2)]);
  expect(queue.lease('scope', now, 'worker')).toBeNull();
});

test('a live lease is never handed out twice and expires into a different lease', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue('scope', [demand(1, 100n, 0)], 0);
  const first = queue.lease('scope', 0, 'worker')!;
  expect(first.expiresAtMs).toBe(METADATA_LEASE_MS);
  expect(queue.lease('scope', METADATA_LEASE_MS - 1, 'other')).toBeNull();
  const second = queue.lease('scope', METADATA_LEASE_MS, 'other')!;
  expect(second.leaseId).not.toBe(first.leaseId);
  expect(second.demand).toEqual(first.demand);
  expect(second.owner).toBe('other');
  expect(row(db, 'scope', addr(1)).lease_owner).toBe('other');
});

test('a stale lease id settles nothing', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue('scope', [demand(1, 100n, 0)], 0);
  const stale = queue.lease('scope', 0, 'worker')!;
  const fresh = queue.lease('scope', METADATA_LEASE_MS, 'other')!;
  const before = row(db, 'scope', addr(1));
  expect(queue.settle('scope', stale.leaseId, METADATA_LEASE_MS, { kind: 'requeue' })).toBeNull();
  expect(
    queue.settle('scope', 'not-a-lease', 0, { kind: 'resolved', anchorBlock: 100n }),
  ).toBeNull();
  expect(row(db, 'scope', addr(1))).toEqual(before);
  // A lease that was already settled is stale too: the second settle must not act twice.
  expect(queue.settle('scope', fresh.leaseId, 0, { kind: 'requeue' })).not.toBeNull();
  expect(queue.settle('scope', fresh.leaseId, 0, { kind: 'requeue' })).toBeNull();
});

test('a result read at the demanded height deletes the demand', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue('scope', [demand(1, 100n, 0)], 0);
  const lease = queue.lease('scope', 0, 'worker')!;
  expect(queue.settle('scope', lease.leaseId, 0, { kind: 'resolved', anchorBlock: 100n })).toEqual({
    address: addr(1),
    blockNumber: 100n,
    priority: 0,
  });
  expect(addresses(db, 'scope')).toEqual([]);
  expect(queue.stats('scope', 0)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 0 });
});

test('a demand that arrives at an earlier height while a lease is out stays queued', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue('scope', [demand(1, 100n, 0)], 0);
  const lease = queue.lease('scope', 0, 'worker')!;
  expect(lease.demand.blockNumber).toBe(100n);
  // A concurrent batch discovers the token was already needed at height 40. The reading this lease
  // is about to take is at 100 — above the new demand — and `decimalsAt` answers a height from the
  // last anchor *at or below* it: an anchor at 100 says nothing about the token at 40. So the result
  // covers the demand it was read for and leaves the earlier one waiting for its own query.
  queue.enqueue('scope', [demand(1, 40n, 0)], 10);
  expect(row(db, 'scope', addr(1)).needed_block).toBe(40);
  expect(queue.settle('scope', lease.leaseId, 10, { kind: 'resolved', anchorBlock: 100n })).toEqual(
    {
      address: addr(1),
      blockNumber: 40n,
      priority: 0,
    },
  );
  const kept = row(db, 'scope', addr(1));
  expect(kept.needed_block).toBe(40);
  expect(kept.next_retry_ms).toBe(0);
  expect(kept.lease_id).toBeNull();
  expect(kept.lease_owner).toBeNull();
  expect(kept.lease_until_ms).toBeNull();
  // Leasable at once, and the next lease is for the height that is still unanswered.
  const next = queue.lease('scope', 10, 'worker')!;
  expect(next.leaseId).not.toBe(lease.leaseId);
  expect(next.demand.blockNumber).toBe(40n);
});

test('a failed result waits out its deadline even at priority zero', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue('scope', [demand(1, 100n, 0)], 0);
  const lease = queue.lease('scope', 0, 'worker')!;
  expect(queue.settle('scope', lease.leaseId, 0, { kind: 'failed', retryAtMs: 5_000 })).toEqual({
    address: addr(1),
    blockNumber: 100n,
    priority: 0,
  });
  expect(row(db, 'scope', addr(1)).next_retry_ms).toBe(5_000);
  expect(queue.lease('scope', 4_999, 'worker')).toBeNull();
  const retry = queue.lease('scope', 5_000, 'worker')!;
  // A shorter deadline for the same demand never pulls the retry forward.
  queue.settle('scope', retry.leaseId, 5_000, { kind: 'failed', retryAtMs: 1_000 });
  expect(row(db, 'scope', addr(1)).next_retry_ms).toBe(5_000);
  expect(addresses(db, 'scope')).toEqual([addr(1)]);
});

test('a requeue makes the demand eligible at once', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue('scope', [demand(1, 100n, 0)], 0);
  const lease = queue.lease('scope', 0, 'worker')!;
  queue.settle('scope', lease.leaseId, 0, { kind: 'failed', retryAtMs: 90_000 });
  expect(queue.stats('scope', 0)).toEqual({ eligible: 0, retryWaiting: 1, inflight: 0 });
  const retry = queue.lease('scope', 90_000, 'worker')!;
  expect(queue.settle('scope', retry.leaseId, 90_000, { kind: 'requeue' })).toEqual({
    address: addr(1),
    blockNumber: 100n,
    priority: 0,
  });
  const requeued = row(db, 'scope', addr(1));
  expect(requeued.next_retry_ms).toBe(0);
  expect(requeued.lease_id).toBeNull();
  expect(queue.stats('scope', 90_000)).toEqual({ eligible: 1, retryWaiting: 0, inflight: 0 });
});

test('stats partitions the scope rows exactly', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue('scope', [demand(1, 100n, 0), demand(2, 100n, 0), demand(3, 100n, 0)], 0);
  const failed = queue.lease('scope', 0, 'worker')!;
  queue.settle('scope', failed.leaseId, 0, { kind: 'failed', retryAtMs: 60_000 });
  queue.lease('scope', 0, 'worker')!;
  expect(queue.stats('scope', 0)).toEqual({ eligible: 1, retryWaiting: 1, inflight: 1 });
  const stats = queue.stats('scope', 0);
  expect(stats.eligible + stats.retryWaiting + stats.inflight).toBe(addresses(db, 'scope').length);
  // A live lease outranks its own retry deadline: the row is in flight, never also waiting. Only a
  // raw write can build that state, because nothing is leased while it is still waiting.
  queue.enqueue('held', [demand(9, 100n, 0)], 0);
  const leased = queue.lease('held', 0, 'worker')!;
  db.prepare(
    'update metadata_demand set next_retry_ms = ? where scope_id = ? and lease_id = ?',
  ).run(9_999, 'held', leased.leaseId);
  expect(queue.stats('held', 0)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 1 });
  expect(queue.stats('empty', 0)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 0 });
});

test('two interleaved scopes never touch each other rows', () => {
  const db = setup(),
    queue = metadataQueueFor(db);
  queue.enqueue('a', [demand(1, 100n, 0)], 0);
  queue.enqueue('b', [demand(1, 100n, 0), demand(2, 50n, 0)], 0);
  const a = queue.lease('a', 0, 'worker')!;
  const b = queue.lease('b', 0, 'worker')!;
  expect(b.demand.address).toBe(addr(2));
  queue.settle('a', a.leaseId, 0, { kind: 'resolved', anchorBlock: 100n });
  // The same address is one demand per scope: settling it in `a` leaves `b`'s row untouched.
  expect(addresses(db, 'a')).toEqual([]);
  expect(addresses(db, 'b')).toEqual([addr(1), addr(2)]);
  expect(row(db, 'b', addr(2)).lease_id).toBe(b.leaseId);
  expect(queue.stats('b', 0)).toEqual({ eligible: 1, retryWaiting: 0, inflight: 1 });
});

test('a fresh database starts at revision zero with an empty journal', () => {
  const db = setup();
  expect(metadataRevision(db)).toBe(0);
  expect(metadataAddressChanges(db, 0)).toEqual({ revision: 0, addresses: [], complete: true });
});

test('a schema that predates the revision tables reads as revision zero and no journal', () => {
  // A readonly handle on an older file never runs the migration, so the readers have to answer
  // without the tables instead of assuming them. The tables below are what 008 created.
  const db = new Database(':memory:');
  dbs.push(db);
  db.exec(
    `create table token_metadata(address text not null, decimals integer not null,
       block_number integer not null, block_hash text not null, primary key(address,block_number));
     create table token_metadata_invalid_anchors(block_number integer not null,
       block_hash text not null, primary key(block_number,block_hash));`,
  );
  expect(metadataRevision(db)).toBe(0);
  expect(metadataAddressChanges(db, 0)).toBeNull();
  // Metadata can still be written to that schema; there is simply nothing to journal it to.
  db.prepare(
    'insert into token_metadata(address,decimals,block_number,block_hash) values(?,?,?,?)',
  ).run(addr(1), 6, 10, hash(10));
  expect(metadataRevision(db)).toBe(0);
  expect(metadataAddressChanges(db, 0)).toBeNull();
});

test('storing metadata bumps the revision and journals the lowercase address', () => {
  const db = setup();
  // A checksummed spelling is one address: the journal is keyed by the lowercase form.
  const mixed = toHex(0xabcdef, { size: 20 }).toUpperCase();
  db.prepare(
    'insert into token_metadata(address,decimals,block_number,block_hash) values(?,?,?,?)',
  ).run(mixed, 6, 10, hash(10));
  expect(metadataRevision(db)).toBe(1);
  const changes = metadataAddressChanges(db, 0)!;
  expect(changes.addresses).toEqual([mixed.toLowerCase()]);
  expect(changes.revision).toBe(1);
  expect(changes.complete).toBe(true);
});

test('an insert or ignore that ignores does not bump the revision', () => {
  const db = setup();
  storeMetadata(db, 1, 6, 10, hash(10));
  const revision = metadataRevision(db);
  db.prepare(
    'insert or ignore into token_metadata(address,decimals,block_number,block_hash) values(?,?,?,?)',
  ).run(addr(1), 6, 10, hash(10));
  expect(metadataRevision(db)).toBe(revision);
  expect(metadataAddressChanges(db, revision)).toEqual({
    revision,
    addresses: [],
    complete: true,
  });
});

test('the upsert that rewrites a stored observation bumps the revision', () => {
  const db = setup();
  storeMetadata(db, 1, 6, 10, hash(10));
  const revision = metadataRevision(db);
  db.prepare(
    `insert into token_metadata(address,decimals,block_number,block_hash) values(?,?,?,?)
     on conflict(address,block_number) do update set decimals=excluded.decimals,
       block_hash=excluded.block_hash`,
  ).run(addr(1), 18, 10, hash(11));
  expect(metadataRevision(db)).toBe(revision + 1);
  expect(metadataAddressChanges(db, revision)!.addresses).toEqual([addr(1)]);
  expect(
    db
      .prepare('select decimals from token_metadata where address = ? and block_number = ?')
      .get(addr(1), 10),
  ).toEqual({ decimals: 18 });
});

test('deleting metadata by height journals every address it removed', () => {
  const db = setup();
  storeMetadata(db, 1, 6, 10, hash(10));
  storeMetadata(db, 2, 6, 20, hash(20));
  storeMetadata(db, 3, 6, 30, hash(30));
  const revision = metadataRevision(db);
  db.prepare('delete from token_metadata where block_number >= ?').run(20);
  expect(metadataRevision(db)).toBe(revision + 2);
  expect([...metadataAddressChanges(db, revision)!.addresses].sort()).toEqual([addr(2), addr(3)]);
  expect(db.prepare('select address from token_metadata').all()).toEqual([{ address: addr(1) }]);
});

test('an invalid anchor names the rows at that height and admits the seed may be affected', () => {
  const db = setup();
  storeMetadata(db, 1, 6, 10, hash(10));
  storeMetadata(db, 2, 18, 10, hash(10));
  storeMetadata(db, 3, 6, 20, hash(20));
  const revision = metadataRevision(db);
  db.prepare(
    'insert or ignore into token_metadata_invalid_anchors(block_number,block_hash) values(?,?)',
  ).run(10, hash(99));
  const changes = metadataAddressChanges(db, revision)!;
  expect([...changes.addresses].sort()).toEqual([addr(1), addr(2)]);
  // The stored rows are named, but the seed file's own entry at height 10 loses its anchor too and
  // no table holds that address: a reader cannot narrow its rebuild to the list above.
  expect(changes.complete).toBe(false);
});

test('dropping an invalid anchor reports a change that could affect any address', () => {
  const db = setup();
  storeMetadata(db, 1, 6, 10, hash(10));
  db.prepare(
    'insert or ignore into token_metadata_invalid_anchors(block_number,block_hash) values(?,?)',
  ).run(10, hash(99));
  const revision = metadataRevision(db);
  db.prepare('delete from token_metadata_invalid_anchors where block_number = ?').run(10);
  const changes = metadataAddressChanges(db, revision)!;
  expect(changes.addresses).toEqual([]);
  expect(changes.complete).toBe(false);
});

test('a real anchor check names the addresses stored at the height it invalidated', async () => {
  const db = setup(),
    rpc = {
      // The stored row is the one the chain agrees with; only the seed file's entry is forked.
      getAnchor: vi.fn(async (n: bigint | 'latest') => ({
        number: BigInt(n),
        hash: hash(Number(n)),
        timestampSec: 100,
      })),
      request: vi.fn(),
    };
  storeMetadata(db, 1, 6, 10, hash(10));
  const revision = metadataRevision(db);
  const seed = {
    version: 'test',
    chainId: 4663 as const,
    source: 'test',
    entries: [{ address: addr(9), decimals: 8, observedAtBlock: '10', blockHash: hash(99) }],
  };
  await validateTokenMetadata(db, rpc, seed);
  const changes = metadataAddressChanges(db, revision)!;
  // The invalid anchor was recorded while the address still had a row at that height, and nothing
  // was deleted: the address is named because its stored observation is no longer trustworthy.
  expect(changes.addresses).toEqual([addr(1)]);
  expect(changes.complete).toBe(false);
  expect(db.prepare('select address from token_metadata').all()).toEqual([{ address: addr(1) }]);
});

test('changes since zero name every address that moved, and a caught up position names none', () => {
  const db = setup();
  storeMetadata(db, 1, 6, 10, hash(10));
  storeMetadata(db, 2, 6, 20, hash(20));
  storeMetadata(db, 3, 6, 30, hash(30));
  db.prepare('delete from token_metadata where block_number = ?').run(20);
  const all = metadataAddressChanges(db, 0)!;
  expect([...all.addresses].sort()).toEqual([addr(1), addr(2), addr(3)]);
  expect(all.revision).toBe(metadataRevision(db));
  expect(all.complete).toBe(true);
  expect(metadataAddressChanges(db, all.revision)).toEqual({
    revision: all.revision,
    addresses: [],
    complete: true,
  });
});

test('a position older than the retained journal window is answered with null', () => {
  const db = setup();
  for (let i = 0; i < METADATA_REVISION_JOURNAL_LIMIT + 4; i++)
    storeMetadata(db, i + 1, 6, 10, hash(10));
  const revision = metadataRevision(db);
  expect(revision).toBe(METADATA_REVISION_JOURNAL_LIMIT + 4);
  expect(metadataAddressChanges(db, 0)).toBeNull();
  expect(journalRevisions(db)).toBe(METADATA_REVISION_JOURNAL_LIMIT);
  // The oldest position that can still be answered is the one the window still holds.
  const oldest = revision - METADATA_REVISION_JOURNAL_LIMIT;
  expect(metadataAddressChanges(db, oldest)!.addresses.length).toBe(
    METADATA_REVISION_JOURNAL_LIMIT,
  );
  expect(metadataAddressChanges(db, oldest - 1)).toBeNull();
});

test('reads neither add journal rows nor move the revision', () => {
  const db = setup();
  storeMetadata(db, 1, 6, 10, hash(10));
  db.prepare(
    'insert or ignore into token_metadata_invalid_anchors(block_number,block_hash) values(?,?)',
  ).run(10, hash(99));
  const revision = metadataRevision(db),
    rows = journalRows(db);
  const first = metadataAddressChanges(db, 0)!;
  for (let i = 0; i < 100; i++) {
    expect(metadataRevision(db)).toBe(revision);
    expect(metadataAddressChanges(db, 0)).toEqual(first);
  }
  expect(metadataRevision(db)).toBe(revision);
  expect(journalRows(db)).toBe(rows);
});
