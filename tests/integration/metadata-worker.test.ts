import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { toHex, type Address } from 'viem';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadEnv } from '../../src/config/env.js';
import { loadMetricMetadata } from '../../src/metrics/metadata.js';
import { createMetadataWorker, type MetadataDrain } from '../../src/ops/metadata-worker.js';
import { runRecorder, type RecorderOptions } from '../../src/ops/recorder.js';
import { createShutdownController } from '../../src/ops/shutdown.js';
import { RpcFailure } from '../../src/rpc/errors.js';
import { parseSignalConfig } from '../../src/signals/config.js';
import { openDatabase } from '../../src/storage/database.js';
import {
  METADATA_LEASE_MS,
  metadataQueueFor,
  type MetadataDemand,
} from '../../src/storage/metadata-queue.js';
import {
  METADATA_RETRY_MS,
  applyMetadataLookup,
  enqueueTokenMetadata,
} from '../../src/storage/token-metadata.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';

/**
 * The metadata worker, and the two places the ingest loop meets it.
 *
 * The worker exists so a batch never waits for a decimals observation; what these tests pin is the
 * other half of that trade — the observation still lands, exactly once, and never as a claim the
 * run has not earned. Each test maps to one item of the subplan's matrix: a slow provider, two
 * batches for one address, a reorg mid-lookup, an earlier demand cutting in, a commit that fails, a
 * repair with no new block, an evidence failure, a shutdown, and a run that is not notifying.
 */

const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const SCOPE = 'scope';
/** The watched pair, spelled as text: a 20-byte address is not an exact `number`. */
const AMC = '0x05a3d1cd21d0c88145e82600e62e7e496e0f222b' as Address;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
const addr = (n: number) => toHex(n, { size: 20 }) as Address;
const hash = (n: number) => toHex(n, { size: 32 });
function setup() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}
const anchorOf = (block: bigint | 'latest', at = hash(Number(block))) => ({
  number: block === 'latest' ? 200n : block,
  hash: at,
  timestampSec: 100,
});
const count = (db: ReturnType<typeof setup>, sql: string): number =>
  (db.prepare(sql).get() as { n: number }).n;

/** Wait for a condition an asynchronous chain reaches, without pinning it to a tick count. */
async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was never reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A reader whose first request hangs until the test opens it, so a lookup can be held mid-flight. */
function gatedReader() {
  let open = false;
  const waiting: (() => void)[] = [];
  let started = 0;
  return {
    reader: {
      getAnchor: async (block: bigint | 'latest') => anchorOf(block),
      request: async () => {
        started++;
        if (!open) await new Promise<void>((resolve) => waiting.push(resolve));
        return toHex(6, { size: 32 });
      },
    },
    open: () => {
      open = true;
      for (const resolve of waiting.splice(0)) resolve();
    },
    started: () => started,
  };
}

/** Store a snapshot the way the ingest loop does: inside one transaction, acked on commit. */
function apply(
  db: ReturnType<typeof setup>,
  drain: MetadataDrain,
  nowMs = 0,
): { resolved: number; failed: number; stale: number } {
  const counts = { resolved: 0, failed: 0, stale: 0 };
  db.transaction(() => {
    for (const result of drain.results) {
      const outcome = applyMetadataLookup(db, SCOPE, result, nowMs);
      if (outcome === 'resolved') counts.resolved++;
      else if (outcome === 'failed') counts.failed++;
      else counts.stale++;
    }
  })();
  drain.ack();
  return counts;
}

function options(dir: string, overrides: Partial<RecorderOptions> = {}): RecorderOptions {
  return {
    command: 'ingest',
    config: loadChainConfig('config/robinhood.json'),
    env: loadEnv({ RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' }),
    watchlistPath: 'config/watchlist.amc.json',
    databasePath: join(dir, 'source.sqlite'),
    outputDirectory: join(dir, 'runs'),
    durationMs: 10_000,
    maxCalls: 10_000,
    evidenceMode: 'off',
    ...overrides,
  };
}

/**
 * The fixture with its decimals call held until the test opens it.
 *
 * `0x313ce567` is the selector `lookupMetadata` sends, so this gates metadata and leaves the
 * anchors, logs and pool-state calls the acquisition side needs untouched. The selector alone is not
 * enough to name a lookup, though: the identity module asks the same question of the watched tokens
 * while the run is still starting (`inspectToken`), and holding that call would hold the whole run
 * before its first block. What tells the two apart is the purpose scope the recorder wraps around a
 * metadata request — the identity probe runs outside it — so counting what went out and what came
 * back is what tells a commit that waited from one that did not.
 */
function gatedFixture(fixture: ReturnType<typeof recorderFixture>) {
  const base = fixture.factory;
  let open = false;
  const waiting: (() => void)[] = [];
  let started = 0;
  let completed = 0;
  const factory = ((env: Parameters<typeof base>[0], limits: Parameters<typeof base>[1]) => {
    const reader = base(env, limits);
    return {
      ...reader,
      request: async (method: string, params: readonly unknown[]) => {
        const call = params[0] as { data?: string } | undefined;
        if (
          method === 'eth_call' &&
          call?.data === '0x313ce567' &&
          reader.meter.currentPurpose === 'metadata'
        ) {
          started++;
          if (!open) await new Promise<void>((resolve) => waiting.push(resolve));
          completed++;
        }
        return reader.request(method, params);
      },
    };
  }) as typeof base;
  return {
    factory,
    open: () => {
      open = true;
      for (const resolve of waiting.splice(0)) resolve();
    },
    started: () => started,
    completed: () => completed,
  };
}

test('a slow metadata lookup never delays the batch that demanded it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-metadata-slow-'));
  const gate = gatedFixture(recorderFixture());
  let drainStarted = false;
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
    if (typeof value === 'string') lines.push(value);
  });
  const run = runRecorder(
    options(dir, {
      command: 'ingest',
      fromBlock: 90n,
      toBlock: 200n,
      readerFactory: (env, limits) => ({
        ...gate.factory(env, limits),
        beginDrain: () => {
          drainStarted = true;
        },
      }),
    }),
  );
  try {
    // A batch logs its timings once it has committed. The decimals call it queued is out and has not
    // come back, which is the whole claim: the commit did not wait for the provider. The demand is
    // queued as the batch commits and the chain is started by the same safe point that ends it, so
    // the log line and the query can arrive in either order — both are before the provider answers.
    await until(() => lines.some((line) => line.includes('"batch-timing"')));
    await until(() => gate.started() === 1);
    // Finalization has a deadline before it waits for the metadata provider.
    await until(() => drainStarted);
    expect(gate.completed()).toBe(0);
  } finally {
    gate.open();
  }
  expect(await run).toBe(0);
  const db = openDatabase(join(dir, 'source.sqlite'));
  dbs.push(db);
  // And the observation is not lost: it is stored by the run's last collection, and the quote asset
  // the valuation depends on is the one that had to land.
  expect(db.prepare('select address, decimals from token_metadata order by address').all()).toEqual(
    [
      { address: AMC, decimals: 18 },
      { address: USDG, decimals: 6 },
    ],
  );
  expect(count(db, 'select count(*) as n from metadata_demand')).toBe(0);
  spy.mockRestore();
});

test('two batches demanding the same address keep one lookup in flight', async () => {
  const db = setup();
  const gate = gatedReader();
  const queue = metadataQueueFor(db);
  const worker = createMetadataWorker({
    db,
    reader: gate.reader,
    scopeId: SCOPE,
    owner: 'run',
    canStart: () => true,
    nowMs: () => 0,
  });
  enqueueTokenMetadata(db, [{ address: addr(1), blockNumber: 10n }], { nowMs: 0, scopeId: SCOPE });
  worker.kick();
  await until(() => gate.started() === 1);
  // The second batch finds the address already queued and already being looked up. It neither opens
  // a second demand nor sends a second query: the queue is one row per address, and the worker is
  // one lookup at a time.
  enqueueTokenMetadata(db, [{ address: addr(1), blockNumber: 10n }], { nowMs: 0, scopeId: SCOPE });
  worker.kick();
  expect(count(db, 'select count(*) as n from metadata_demand')).toBe(1);
  expect(gate.started()).toBe(1);
  expect(queue.stats(SCOPE, 0)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 1 });
  gate.open();
  await worker.drain();
  expect(gate.started()).toBe(1);
  expect(apply(db, worker.prepareDrain())).toEqual({ resolved: 1, failed: 0, stale: 0 });
  expect(db.prepare('select address, decimals, block_number from token_metadata').all()).toEqual([
    { address: addr(1), decimals: 6, block_number: 10 },
  ]);
  expect(queue.stats(SCOPE, 0)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 0 });
});

test('a batch that asks while one lookup is out waits its turn instead of opening a second', async () => {
  const db = setup();
  const gate = gatedReader();
  const queue = metadataQueueFor(db);
  const worker = createMetadataWorker({
    db,
    reader: gate.reader,
    scopeId: SCOPE,
    owner: 'run',
    canStart: () => true,
    nowMs: () => 0,
  });
  enqueueTokenMetadata(db, [{ address: addr(1), blockNumber: 10n }], { nowMs: 0, scopeId: SCOPE });
  worker.kick();
  await until(() => gate.started() === 1);
  // A second batch wants a different address while the first query is still out. It queues and kicks
  // like any batch does, and the kick starts nothing: one token's network sequence at a time, ever.
  // A slow provider therefore delays other metadata, never the acquisition side, and never doubles
  // the requests the run has in flight.
  enqueueTokenMetadata(db, [{ address: addr(2), blockNumber: 10n }], { nowMs: 0, scopeId: SCOPE });
  worker.kick();
  expect(gate.started()).toBe(1);
  expect(queue.stats(SCOPE, 0)).toEqual({ eligible: 1, retryWaiting: 0, inflight: 1 });
  gate.open();
  // Once the chain is free the queued demand is the run's next query, not an abandoned one.
  await worker.drain();
  expect(gate.started()).toBe(2);
  expect(apply(db, worker.prepareDrain())).toEqual({ resolved: 2, failed: 0, stale: 0 });
  expect(db.prepare('select address from token_metadata order by address').all()).toEqual([
    { address: addr(1) },
    { address: addr(2) },
  ]);
  expect(queue.stats(SCOPE, 0)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 0 });
});

test('a reorg during the lookup fails the demand instead of caching a reading of the old branch', async () => {
  const db = setup();
  // The branch moves while the call is out: the anchor before and the anchor after disagree, so the
  // reading is evidence about a block that is no longer this chain's.
  let moved = false;
  const reader = {
    getAnchor: async (block: bigint | 'latest') => anchorOf(block, hash(moved ? 99 : 10)),
    request: async () => {
      moved = true;
      return toHex(6, { size: 32 });
    },
  };
  const queue = metadataQueueFor(db);
  const worker = createMetadataWorker({
    db,
    reader,
    scopeId: SCOPE,
    owner: 'run',
    canStart: () => true,
    nowMs: () => 0,
  });
  enqueueTokenMetadata(db, [{ address: addr(1), blockNumber: 10n }], { nowMs: 0, scopeId: SCOPE });
  worker.kick();
  await worker.drain();
  const drain = worker.prepareDrain();
  expect(drain.results.map((result) => result.failure)).toEqual(['metadata-anchor-changed']);
  expect(apply(db, drain)).toEqual({ resolved: 0, failed: 1, stale: 0 });
  expect(count(db, 'select count(*) as n from token_metadata')).toBe(0);
  expect(db.prepare('select address, reason from token_metadata_failures').all()).toEqual([
    { address: addr(1), reason: 'metadata-anchor-changed' },
  ]);
  // Failed, not forgotten: the demand waits out its backoff and is leasable again after it.
  expect(queue.stats(SCOPE, 0)).toEqual({ eligible: 0, retryWaiting: 1, inflight: 0 });
  expect(queue.stats(SCOPE, METADATA_RETRY_MS)).toEqual({
    eligible: 1,
    retryWaiting: 0,
    inflight: 0,
  });
});

test('an earlier demand that arrives mid-lookup waits for a reading of its own height', async () => {
  const db = setup();
  const gate = gatedReader();
  const queue = metadataQueueFor(db);
  const worker = createMetadataWorker({
    db,
    reader: gate.reader,
    scopeId: SCOPE,
    owner: 'run',
    canStart: () => true,
    nowMs: () => 0,
  });
  enqueueTokenMetadata(db, [{ address: addr(1), blockNumber: 100n }], { nowMs: 0, scopeId: SCOPE });
  worker.kick();
  await until(() => gate.started() === 1);
  // A batch discovers the token was already in use at height 40 while the height-100 lookup is out.
  enqueueTokenMetadata(db, [{ address: addr(1), blockNumber: 40n }], { nowMs: 0, scopeId: SCOPE });
  expect(
    (
      db.prepare('select needed_block from metadata_demand where address = ?').get(addr(1)) as {
        needed_block: number;
      }
    ).needed_block,
  ).toBe(40);
  gate.open();
  await worker.drain();
  expect(apply(db, worker.prepareDrain())).toEqual({ resolved: 1, failed: 0, stale: 0 });
  // The reading at 100 is stored, and the demand at 40 is still queued: decimals carry forward from
  // an anchor, never backward, so a height above a demand cannot answer it.
  expect(db.prepare('select address, block_number from token_metadata').all()).toEqual([
    { address: addr(1), block_number: 100 },
  ]);
  expect(queue.stats(SCOPE, 0)).toEqual({ eligible: 1, retryWaiting: 0, inflight: 0 });
  // The queued demand is answered by the lookup that was sent for it.
  await worker.drain();
  const second = worker.prepareDrain();
  expect(second.results.map((result) => result.lease.demand.blockNumber)).toEqual([40n]);
  expect(apply(db, second)).toEqual({ resolved: 1, failed: 0, stale: 0 });
  expect(queue.stats(SCOPE, 0)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 0 });
});

test('a batch that fails to commit keeps its results, and the retry is refused once its lease is gone', async () => {
  const db = setup();
  const gate = gatedReader();
  const queue = metadataQueueFor(db);
  let now = 0;
  const worker = createMetadataWorker({
    db,
    reader: gate.reader,
    scopeId: SCOPE,
    owner: 'run',
    canStart: () => true,
    nowMs: () => now,
  });
  enqueueTokenMetadata(db, [{ address: addr(1), blockNumber: 10n }], { nowMs: 0, scopeId: SCOPE });
  worker.kick();
  await until(() => gate.started() === 1);
  gate.open();
  await worker.drain();
  const first = worker.prepareDrain();
  expect(first.results).toHaveLength(1);
  // The transaction that would have stored it rolled back. Nothing was acked, nothing was written,
  // and the demand was never claimed as answered.
  expect(count(db, 'select count(*) as n from token_metadata')).toBe(0);
  expect(worker.prepareDrain().results).toEqual(first.results);
  expect(queue.stats(SCOPE, now)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 1 });
  // The retry: the lease the result came back under expires, the demand is leasable again, and the
  // next attempt reads it for itself. The stale result is still in the buffer, and it is refused —
  // it writes neither an observation nor a backoff against the holder that now owns the demand.
  now += METADATA_LEASE_MS;
  await worker.drain();
  const second = worker.prepareDrain();
  expect(second.results).toHaveLength(2);
  expect(gate.started()).toBe(2);
  expect(apply(db, second, now)).toEqual({ resolved: 1, failed: 0, stale: 1 });
  expect(db.prepare('select address, decimals from token_metadata').all()).toEqual([
    { address: addr(1), decimals: 6 },
  ]);
  expect(count(db, 'select count(*) as n from token_metadata_failures')).toBe(0);
  expect(queue.stats(SCOPE, now)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 0 });
});

test('an ack removes the snapshot it was handed and not what completed beside it', async () => {
  const db = setup();
  const queue = metadataQueueFor(db);
  const waiting: (() => void)[] = [];
  let sent = 0;
  const worker = createMetadataWorker({
    db,
    reader: {
      getAnchor: async (block: bigint | 'latest') => anchorOf(block),
      request: async () => {
        sent++;
        // The first lookup finishes on its own; the second is held, so it cannot be part of the
        // snapshot the first one is already in.
        if (sent === 2) await new Promise<void>((resolve) => waiting.push(resolve));
        return toHex(6, { size: 32 });
      },
    },
    scopeId: SCOPE,
    owner: 'run',
    canStart: () => true,
    nowMs: () => 0,
  });
  enqueueTokenMetadata(
    db,
    [
      { address: addr(1), blockNumber: 10n },
      { address: addr(2), blockNumber: 10n },
    ],
    { nowMs: 0, scopeId: SCOPE },
  );
  worker.kick();
  await until(() => sent === 2);
  const inFlight = worker.prepareDrain();
  expect(inFlight.results.map((result) => result.lease.demand.address)).toEqual([addr(1)]);
  waiting.shift()?.();
  await worker.drain();
  // Both results are ready, and the transaction that stores them is the caller's. It was handed the
  // snapshot taken before the second one landed.
  const snapshot = worker.prepareDrain();
  expect(snapshot.results.map((result) => result.lease.demand.address)).toEqual([addr(1), addr(2)]);
  apply(db, inFlight);
  // The ack removed what that transaction stored. The result that completed while it was being
  // stored is still there for the next one: a buffer cleared wholesale would have thrown it away,
  // and with it a query the run has already paid for.
  expect(worker.prepareDrain().results.map((result) => result.lease.demand.address)).toEqual([
    addr(2),
  ]);
  expect(queue.stats(SCOPE, 0)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 1 });
});

test('metadata that lands with no new block repairs the pools it re-priced, without a new range', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-metadata-repair-'));
  const gate = gatedFixture(recorderFixture());
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
    if (typeof value === 'string') lines.push(value);
  });
  const shutdown = createShutdownController(new EventEmitter());
  const run = runRecorder(
    options(dir, {
      command: 'follow',
      fromBlock: 90n,
      notify: 'local',
      metricMetadata: loadMetricMetadata('config/metric-metadata.json'),
      signalConfig: parseSignalConfig(
        JSON.parse(readFileSync('config/signals.initial.json', 'utf8')),
      ),
      readerFactory: gate.factory,
      shutdown,
    }),
  );
  let settled = false;
  void run.then(() => {
    settled = true;
  });
  try {
    // The first round commits with the quote asset's decimals still unknown, and the observation
    // arrives afterwards: the fixture's head never moves, so what repair the metadata implies has to
    // happen with no new block behind it.
    await until(() => lines.some((line) => line.includes('"batch-timing"')));
    gate.open();
    await until(() =>
      lines.some((line) => line.includes('token-metadata') && line.includes('"resolved": 1')),
    );
    expect(settled).toBe(false);
  } finally {
    gate.open();
    shutdown.request('SIGINT');
    shutdown.dispose();
  }
  expect(await run).toBe(0);
  const db = openDatabase(join(dir, 'source.sqlite'));
  dbs.push(db);
  // The repair round is not a range: it accepts nothing, and its evaluations are the re-priced
  // pools re-issued from the block that changed.
  expect(
    count(db, "select count(*) as n from signal_evaluations where batch_id like 'metadata-%'"),
  ).toBeGreaterThan(0);
  expect(
    count(db, "select count(*) as n from accepted_ranges where batch_id like 'metadata-%'"),
  ).toBe(0);
  expect(count(db, 'select count(*) as n from token_metadata')).toBeGreaterThan(0);
  spy.mockRestore();
});

test.each([
  ['evidence-write', 'anchor'],
  ['evidence-write', 'call'],
  ['aborted', 'anchor'],
  ['aborted', 'call'],
])(
  '%s during metadata %s stops the worker without recording a token failure',
  async (kind, phase) => {
    const db = setup();
    const failure = new RpcFailure(kind!);
    const queue = metadataQueueFor(db);
    const worker = createMetadataWorker({
      db,
      reader: {
        getAnchor: async (block) => {
          if (phase === 'anchor') throw failure;
          return anchorOf(block, hash(10));
        },
        request: async () => {
          throw failure;
        },
      },
      scopeId: SCOPE,
      owner: 'run',
      canStart: () => true,
      nowMs: () => 0,
    });
    enqueueTokenMetadata(db, [{ address: addr(1), blockNumber: 10n }], {
      nowMs: 0,
      scopeId: SCOPE,
    });
    worker.kick();
    await worker.drain();
    // The error belongs to the run, not to the token: it is kept for the main loop to report, and the
    // worker starts nothing more.
    expect(worker.fatalError()).toBe(failure);
    expect(worker.attempted()).toBe(1);
    expect(worker.prepareDrain().results).toEqual([]);
    worker.kick();
    await worker.drain();
    expect(worker.attempted()).toBe(1);
    // Nothing was recorded as a token failure: an evidence write that did not happen is not evidence
    // that this token has no decimals. The demand is still held by the lease that went out.
    expect(count(db, 'select count(*) as n from token_metadata_failures')).toBe(0);
    expect(count(db, 'select count(*) as n from token_metadata')).toBe(0);
    expect(queue.stats(SCOPE, 0)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 1 });
  },
);

test('a shutdown stops new lookups and leaves the interrupted demand recoverable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-metadata-stop-'));
  const gate = gatedFixture(recorderFixture());
  const shutdown = createShutdownController(new EventEmitter());
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const run = runRecorder(
    options(dir, {
      command: 'follow',
      fromBlock: 90n,
      readerFactory: gate.factory,
      shutdown,
    }),
  );
  try {
    await until(() => gate.started() === 1);
    shutdown.request('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(gate.started()).toBe(1);
  } finally {
    gate.open();
    shutdown.dispose();
  }
  // A stop is not a failure: the run ends through the shutdown path and the promise it was holding
  // settles instead of surfacing as an unhandled rejection.
  expect(await run).toBe(0);
  // Nothing new was leased while the request was still out, and nothing followed it once it came
  // back: the worker refuses a lease as soon as the run is stopping.
  expect(gate.started()).toBe(1);
  const db = openDatabase(join(dir, 'source.sqlite'));
  dbs.push(db);
  // The interrupted lookup is not claimed as an answer. Its call came back, but the branch it was
  // read at is never checked — the stop refuses that request — so the reading is not an observation
  // and nothing stores it, and it is not recorded as a token that failed either. The demand is still
  // queued, still held by the lease that went out, and the next run can lease it once that lease
  // expires: an unpaid claim is recoverable, a false one would not be.
  expect(count(db, 'select count(*) as n from token_metadata')).toBe(0);
  expect(count(db, 'select count(*) as n from token_metadata_failures')).toBe(0);
  const demands = count(db, 'select count(*) as n from metadata_demand');
  expect(demands).toBeGreaterThan(1);
  expect(count(db, 'select count(*) as n from metadata_demand where lease_id is not null')).toBe(1);
  const scope = (
    db.prepare('select scope_id from metadata_demand limit 1').get() as { scope_id: string }
  ).scope_id;
  expect(metadataQueueFor(db).stats(scope, Date.now())).toEqual({
    eligible: demands - 1,
    retryWaiting: 0,
    inflight: 1,
  });
  expect(metadataQueueFor(db).stats(scope, Date.now() + METADATA_LEASE_MS)).toEqual({
    eligible: demands,
    retryWaiting: 0,
    inflight: 0,
  });
  spy.mockRestore();
});

test('a run that is not notifying stores metadata without writing a single sink row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-metadata-quiet-'));
  const gate = gatedFixture(recorderFixture());
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
    if (typeof value === 'string') lines.push(value);
  });
  const shutdown = createShutdownController(new EventEmitter());
  const run = runRecorder(
    options(dir, {
      command: 'follow',
      fromBlock: 90n,
      readerFactory: gate.factory,
      shutdown,
    }),
  );
  let settled = false;
  void run.then(() => {
    settled = true;
  });
  try {
    await until(() => lines.some((line) => line.includes('"batch-timing"')));
    gate.open();
    // Applied at the poll gap while the run is still going, which is what makes this a test of the
    // metadata path rather than of the run's last collection.
    await until(() =>
      lines.some((line) => line.includes('token-metadata') && line.includes('"resolved": 1')),
    );
    expect(settled).toBe(false);
  } finally {
    gate.open();
    shutdown.request('SIGINT');
    shutdown.dispose();
  }
  expect(await run).toBe(0);
  const db = openDatabase(join(dir, 'source.sqlite'));
  dbs.push(db);
  expect(count(db, 'select count(*) as n from token_metadata')).toBeGreaterThan(0);
  // Storage is not signalling: nothing was evaluated, nothing was queued for delivery, and the sink
  // file was never even created.
  expect(count(db, 'select count(*) as n from signal_evaluations')).toBe(0);
  expect(count(db, 'select count(*) as n from alerts')).toBe(0);
  expect(count(db, 'select count(*) as n from alert_outbox')).toBe(0);
  expect(existsSync(join(dir, 'source.sqlite.alerts.jsonl'))).toBe(false);
  spy.mockRestore();
});

/** The queue is one row per address, and a settled row is gone rather than marked. */
test('a demand is never left behind in the queue after its reading is stored', async () => {
  const db = setup();
  const gate = gatedReader();
  const queue = metadataQueueFor(db);
  const demands: MetadataDemand[] = [
    { address: addr(1), blockNumber: 10n, priority: 0 },
    { address: addr(2), blockNumber: 10n, priority: 1 },
    { address: addr(3), blockNumber: 20n, priority: 2 },
  ];
  const worker = createMetadataWorker({
    db,
    reader: gate.reader,
    scopeId: SCOPE,
    owner: 'run',
    canStart: () => true,
    nowMs: () => 0,
  });
  enqueueTokenMetadata(db, demands, { nowMs: 0, scopeId: SCOPE });
  worker.kick();
  await until(() => gate.started() === 1);
  gate.open();
  await worker.drain();
  expect(gate.started()).toBe(3);
  expect(apply(db, worker.prepareDrain())).toEqual({ resolved: 3, failed: 0, stale: 0 });
  expect(db.prepare('select address from token_metadata order by address').all()).toEqual([
    { address: addr(1) },
    { address: addr(2) },
    { address: addr(3) },
  ]);
  expect(queue.stats(SCOPE, 0)).toEqual({ eligible: 0, retryWaiting: 0, inflight: 0 });
  expect(count(db, 'select count(*) as n from metadata_demand')).toBe(0);
});
