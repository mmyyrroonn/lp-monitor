import { Worker } from 'node:worker_threads';
import type { Address } from 'viem';
import {
  POOLS,
  address,
  blockAnchor,
  dashboardBatch,
  hash,
  poolAddress,
  stocks,
  swapLog,
  usdg,
  type DashboardFixture,
  type FixtureEvent,
} from './dashboard-fixture.js';
import type {
  SnapshotWorkerInit,
  SnapshotWorkerRequest,
  SnapshotWorkerResponse,
} from '../../src/dashboard/snapshot-worker.js';
import type { SnapshotWorkerLike } from '../../src/dashboard/snapshot-coordinator.js';
import { LiveProjectionStore } from '../../src/storage/live-projection.js';
import { rawLogKey, type RecordedRangeBatch } from '../../src/storage/manifest.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';

/** The real worker module, loaded through the repository's own TypeScript entry point. */
const WORKER_ENTRY = new URL('../../src/dashboard/snapshot-worker.ts', import.meta.url);
const LOADER = new URL('./tsx-worker-loader.mjs', import.meta.url).href;

/**
 * A factory a coordinator can be built with: every worker it starts is a real thread running the
 * shipped module. The built artifact uses the same module by path, which the build check exercises.
 */
export function dashboardWorkerFactory(): () => SnapshotWorkerLike {
  return () =>
    new Worker(WORKER_ENTRY, { execArgv: ['--import', LOADER] }) as unknown as SnapshotWorkerLike;
}

/**
 * A real `worker_threads` worker running the real module, driven by messages.
 *
 * TypeScript is loaded by the same `tsx` the repository already uses for its own CLI, so the test
 * exercises the shipped file rather than a copy of its body. The built artifact is exercised
 * separately by the build check.
 */
export class DashboardWorkerHarness {
  readonly #worker: Worker;
  readonly #inbox: SnapshotWorkerResponse[] = [];
  readonly #waiters: {
    match: (response: SnapshotWorkerResponse) => boolean;
    settle: (response: SnapshotWorkerResponse) => void;
    fail: (error: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  readonly #exits: number[] = [];
  readonly sent: SnapshotWorkerRequest[] = [];

  constructor() {
    this.#worker = dashboardWorkerFactory()() as Worker;
    this.#worker.on('message', (value: unknown) => this.#deliver(value as SnapshotWorkerResponse));
    this.#worker.on('error', (error: Error) => this.#failAll(error));
    this.#worker.on('exit', (code: number) => {
      this.#exits.push(code);
      this.#failAll(new Error(`Snapshot worker exited with code ${code}`));
    });
  }

  get exits(): readonly number[] {
    return this.#exits;
  }

  send(message: SnapshotWorkerRequest): void {
    this.sent.push(message);
    this.#worker.postMessage(message);
  }

  /** The next response that matches, in arrival order; responses nobody claimed are kept. */
  next(
    match: (response: SnapshotWorkerResponse) => boolean = () => true,
    timeoutMs = 30000,
  ): Promise<SnapshotWorkerResponse> {
    const queued = this.#inbox.findIndex(match);
    if (queued >= 0) return Promise.resolve(this.#inbox.splice(queued, 1)[0]!);
    return new Promise<SnapshotWorkerResponse>((settle, fail) => {
      const timer = setTimeout(
        () => fail(new Error('Timed out waiting for a snapshot worker response')),
        timeoutMs,
      );
      this.#waiters.push({ match, settle, fail, timer });
    });
  }

  /** Start the worker and wait for the catalogue it loaded. Throws the code on a failed init. */
  async start(init: SnapshotWorkerInit): Promise<void> {
    this.send({ type: 'init', init });
    const response = await this.next((value) => value.type === 'ready' || value.type === 'failed');
    if (response.type !== 'ready')
      throw new Error(
        `Snapshot worker did not start: ${response.type === 'failed' ? response.code : response.type}`,
      );
  }

  async terminate(): Promise<void> {
    this.send({ type: 'close' });
    this.#failAll(new Error('Snapshot worker closed'));
    await this.#worker.terminate();
  }

  #deliver(response: SnapshotWorkerResponse): void {
    const index = this.#waiters.findIndex((waiter) => waiter.match(response));
    if (index < 0) {
      this.#inbox.push(response);
      return;
    }
    const waiter = this.#waiters.splice(index, 1)[0]!;
    clearTimeout(waiter.timer);
    waiter.settle(response);
  }

  #failAll(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.fail(error);
    }
  }
}

/** The serializable init a worker is started with: no class, map or database handle crosses. */
export function snapshotWorkerInit(
  source: DashboardFixture,
  dbPath = source.path,
): SnapshotWorkerInit {
  const input = source.input;
  return {
    dbPath,
    scopeId: input.scopeId,
    registryScopeId: input.registryScopeId,
    configVersion: input.configVersion,
    assetVersion: input.assets.version,
    assets: input.assets.assets,
    usdg: input.usdg,
    metadata: input.metadata,
  };
}

/** The pool the extension batch discovers, so a reader has one identity that really moved. */
export const DISCOVERED_POOL = { index: 13, token0: stocks.a, token1: usdg } as const;

export type AppendOptions = {
  events: readonly FixtureEvent[];
  /** Pools whose discovery log is one of `events`, so the batch registers them as new. */
  discovered?: readonly { index: number; token0: Address; token1: Address }[];
  toBlock: number;
  /** Chain time the batch closes at; defaults to the block number plus a minute. */
  toTimestampSec?: number;
  boundaryFromSec: number;
  boundaryToSec: number;
};

/**
 * Accept one more range on the fixture's writable connection and project it, the way the follow
 * loop does: a recorded batch, then the live projection sync that derives `live_events`.
 *
 * Minute boundaries are stated explicitly because the window rule reads them: a minute boundary is
 * what places an event inside or outside a bounded read, so a test that wants a bounded window has
 * to say where the minutes are.
 */
export function appendBatch(fixture: DashboardFixture, options: AppendOptions): void {
  const raw = new SqliteRangeStore(fixture.db),
    previous = raw.acceptedTip(fixture.input.scopeId);
  if (previous === null) throw new Error('The fixture has no accepted tip to extend');
  const scopeId = fixture.input.scopeId,
    toBlock = BigInt(options.toBlock),
    fromBlock = previous.number + 1n,
    logs = options.events.map(swapLog),
    byBlock = [...logs];
  const batch: RecordedRangeBatch = {
    ...dashboardBatch(),
    // Named after the range it covers: a batch id is immutable once stored, so two extensions of one
    // fixture have to be two batches rather than the same one accepted twice.
    id: `extend-${toBlock}`,
    scopeId,
    fromBlock,
    toBlock,
    end: {
      number: toBlock,
      hash: hash(Number(toBlock)),
      timestampSec: options.toTimestampSec ?? Number(toBlock) + 60,
    },
    previous,
    logs,
    observedAtMs: 200000,
    manifestHash: `extend-${toBlock}`,
    manifest: {
      version: 1,
      filterVersion: 'f',
      expectedShardIds: ['one'],
      shards: [
        {
          shardId: 'one',
          filterId: 'operation-v3',
          request: {
            fromBlock,
            toBlock,
            address: [
              ...POOLS.map((pool) => poolAddress(pool.index)),
              ...(options.discovered ?? []).map((pool) => poolAddress(pool.index)),
            ],
            topics: [],
          },
          status: 'success',
          responseHash: 'h2',
          error: null,
          logKeys: logs.map(rawLogKey),
          logCount: logs.length,
        },
      ],
    },
    poolRegistrations: [
      ...(dashboardBatch().poolRegistrations ?? []),
      ...(options.discovered ?? []).flatMap((pool) => {
        const poolAddressValue = poolAddress(pool.index).toLowerCase(),
          log = byBlock.find((candidate) => candidate.address.toLowerCase() === poolAddressValue);
        if (log === undefined) return [];
        return [
          {
            pool: {
              chainId: 4663 as const,
              protocol: 'v3' as const,
              address: poolAddress(pool.index),
            },
            token0: pool.token0,
            token1: pool.token1,
            feePips: 3000,
            tickSpacing: 60,
            hooks: address(0),
            discoveredAt: log,
            assetVersion: 'test',
            source: 'synthetic' as const,
          },
        ];
      }),
    ],
    logTimes: logs.map((ref) => ({
      ref,
      time: {
        minuteStartSec: Math.floor((Number(ref.blockNumber) + 60) / 60) * 60,
        exactTimestampSec: Number(ref.blockNumber) + 60,
        source: 'log-verified' as const,
      },
    })),
    boundaries: minuteBoundaries(options.boundaryFromSec, options.boundaryToSec),
  };
  raw.acceptRange(batch);
  new LiveProjectionStore(fixture.db).sync(
    scopeId,
    fixture.input.registryScopeId,
    fixture.input.configVersion,
  );
}

/** The boundaries one minute apart a range states, in the fixture's own convention. */
function minuteBoundaries(fromSec: number, toSec: number) {
  const boundaries = [];
  for (let timestampSec = fromSec; timestampSec <= toSec; timestampSec += 60) {
    const firstBlock = BigInt(timestampSec - 60);
    boundaries.push({
      timestampSec,
      firstBlock,
      before: blockAnchor(Number(firstBlock) - 1),
      at: blockAnchor(Number(firstBlock)),
    });
  }
  return boundaries;
}
