import { afterEach, expect, test, vi } from 'vitest';
import {
  createSnapshotCoordinator,
  SNAPSHOT_FAULT_VISIBILITY_MS,
  SnapshotBusyError,
  type SnapshotCoordinator,
  type SnapshotCoordinatorOptions,
  type SnapshotWorkerLike,
} from '../../src/dashboard/snapshot-coordinator.js';
import { SnapshotExpiredError } from '../../src/dashboard/read-model.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import {
  address,
  openDashboardFixture,
  type DashboardFixture,
} from '../helpers/dashboard-fixture.js';
import { dashboardWorkerFactory } from '../helpers/dashboard-worker.js';
import { emptyWorkCounts, openWorkCounts } from '../../src/ops/work-counters.js';
import type { DashboardSummary, PoolPage, TokenHistory } from '../../src/dashboard/types.js';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { runDashboardCli } from '../../src/dashboard/cli.js';

const coordinators: SnapshotCoordinator[] = [];
const fixtures: DashboardFixture[] = [];

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const token = address(0x21);

/** A summary with nothing in it but the fields this side is allowed to depend on. */
function summary(generation: string, overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    status: 'ok',
    generatedAtMs: 1_000,
    // Fresh by the shared rule, so a test that cares about staleness has to say so itself.
    sourceChainTimeSec: Math.floor(Date.now() / 1000),
    selectedEndSec: 4860,
    availableFromSec: 120,
    sourceHash: 'a'.repeat(64),
    scopeId: 's',
    assetVersion: 'test',
    tokens: [],
    coverage: [],
    health: {
      status: 'unavailable',
      updatedAtMs: null,
      headLagBlocks: null,
      headLagSeconds: null,
      coverage: null,
    },
    message: null,
    notes: [],
    apiVersion: 2,
    generation,
    refreshing: false,
    ...overrides,
  };
}

function emptyPage(generation: string): PoolPage {
  return {
    generation,
    tokenAddress: token,
    window: '5m',
    offset: 0,
    limit: 20,
    total: 0,
    nextOffset: null,
    items: [],
  };
}

function emptyHistory(generation: string): TokenHistory {
  return { generation, tokenAddress: token, minutes: [] };
}

type RefreshRequest = { type: 'refresh'; key: string; at?: number };

/** A worker this test drives by hand: every reply arrives exactly when the test says so. */
class FakeWorker implements SnapshotWorkerLike {
  readonly sent: { type: string; [key: string]: unknown }[] = [];
  readonly #listeners = new Map<string, Set<(value: unknown) => void>>();
  /** What this worker answers an init with; set before the coordinator is built. */
  initReply: 'ready' | 'no-database' | 'unavailable' | 'incompatible' = 'ready';
  terminateCount = 0;
  /** Answers a refresh request; a test leaves it unset to let a round hang. */
  onRefresh: ((request: RefreshRequest) => void) | null = null;

  postMessage(value: unknown): void {
    const message = value as { type: string };
    this.sent.push(message);
    if (message.type === 'init' && this.initReply === 'ready')
      queueMicrotask(() => this.emit('message', { type: 'ready', scopeId: 's' }));
    if (message.type === 'init' && this.initReply === 'no-database')
      queueMicrotask(() => this.emit('message', { type: 'failed', code: 'SNAPSHOT_NO_DATABASE' }));
    if (message.type === 'init' && this.initReply === 'unavailable')
      queueMicrotask(() => this.emit('message', { type: 'failed', code: 'SNAPSHOT_UNAVAILABLE' }));
    if (message.type === 'init' && this.initReply === 'incompatible')
      queueMicrotask(() =>
        this.emit('message', { type: 'failed', code: 'SNAPSHOT_INCOMPATIBLE_DATABASE' }),
      );
    if (message.type === 'refresh') this.onRefresh?.(message as RefreshRequest);
  }

  on(event: string, listener: (value: never) => void): unknown {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener as (value: unknown) => void);
    this.#listeners.set(event, set);
    return this;
  }

  terminate(): unknown {
    this.terminateCount++;
    return Promise.resolve(0);
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(value);
  }

  refreshes(): RefreshRequest[] {
    return this.sent.filter((message) => message.type === 'refresh') as RefreshRequest[];
  }

  last(type: string): { type: string; [key: string]: unknown } | undefined {
    return [...this.sent].reverse().find((message) => message.type === type);
  }
}

type Harness = {
  coordinator: SnapshotCoordinator;
  /** Every worker this coordinator started, in order. */
  workers: FakeWorker[];
  worker: FakeWorker;
};

function harness(
  overrides: Partial<SnapshotCoordinatorOptions> = {},
  configure?: (worker: FakeWorker) => void,
): Harness {
  const workers: FakeWorker[] = [];
  const coordinator = createSnapshotCoordinator({
    dbPath: 'no-such-directory/fake.sqlite',
    scopeId: 's',
    registryScopeId: 's',
    configVersion: 'c',
    assetVersion: 'test',
    assets: [{ symbol: 'A', address: token, identityStatus: 'observed' }],
    usdg: address(3),
    metadata: { version: 'test', chainId: 4663, source: 'synthetic', entries: [] },
    workerFactory: () => {
      const worker = new FakeWorker();
      configure?.(worker);
      workers.push(worker);
      return worker;
    },
    ...overrides,
  });
  coordinators.push(coordinator);
  return { coordinator, workers, worker: workers[0]! };
}

const pageQuery = { generation: 'g1', address: token, window: '5m' as const, offset: 0, limit: 20 };

test('latest answers from memory before any generation exists', async () => {
  const { worker, coordinator } = harness();
  const value = coordinator.latest();
  // Synchronous by construction: a value, not something to await.
  expect(value).not.toBeInstanceOf(Promise);
  expect(value).toMatchObject({
    apiVersion: 2,
    generation: null,
    refreshing: true,
    status: 'empty',
    message: '正在生成首个快照',
    tokens: [],
  });
  await Promise.resolve();
  expect(worker.sent[0]!.type).toBe('init');
  // The reader is asked once for a first summary, without any caller asking for one.
  expect(worker.refreshes()).toHaveLength(1);
});

test('a published summary is answered without waiting for the worker again', async () => {
  const { worker, coordinator } = harness();
  await Promise.resolve();
  worker.emit('message', { type: 'summary', key: 'live', summary: summary('g1') });
  const first = coordinator.latest();
  expect(first.generation).toBe('g1');
  expect(first.refreshing).toBe(false);
  // A round is in flight that will never answer: the answer is still the published one.
  worker.onRefresh = null;
  coordinator.refresh();
  const held = coordinator.latest();
  expect(held.generation).toBe('g1');
  expect(held.generatedAtMs).toBe(first.generatedAtMs);
  expect(held.refreshing).toBe(true);
  const before = Date.now();
  coordinator.latest();
  expect(Date.now() - before).toBeLessThan(50);
});

test('repeated refresh never starts a second round', async () => {
  const { worker, coordinator } = harness();
  await Promise.resolve();
  worker.onRefresh = null;
  for (let round = 0; round < 5; round++) coordinator.refresh();
  expect(worker.refreshes()).toHaveLength(1);
  // The backlog was one request, not five: answering it leaves exactly one more.
  worker.emit('message', { type: 'summary', key: 'live', summary: summary('g1') });
  expect(worker.refreshes()).toHaveLength(2);
});

test('an interval keeps asking, and the worker is the one that says nothing moved', async () => {
  const { worker, coordinator } = harness({ refreshIntervalMs: 15 }, (created) => {
    created.onRefresh = (request) =>
      created.emit('message', { type: 'unchanged', key: request.key });
  });
  await Promise.resolve();
  await delay(80);
  expect(worker.refreshes().length).toBeGreaterThan(1);
  expect(worker.refreshes().every((request) => request.key === 'live')).toBe(true);
});

test('an old watermark goes stale on the clock, not on the next publication', async () => {
  const { worker, coordinator } = harness({ refreshIntervalMs: 10_000 });
  await Promise.resolve();
  worker.emit('message', {
    type: 'summary',
    key: 'live',
    summary: summary('g1', { sourceChainTimeSec: Math.floor(Date.now() / 1000) - 3600 }),
  });
  const held = coordinator.latest();
  expect(held.status).toBe('stale');
  expect(held.message).toBe('链上数据已超过 60 秒未更新；当前显示保留的观测数据。');
});

test('a stuck round is abandoned: the old summary stays and the reader is dropped', async () => {
  const { worker, coordinator, workers } = harness({
    refreshTimeoutMs: 20,
    initTimeoutMs: 40,
    restartCooldownMs: 5000,
  });
  await Promise.resolve();
  worker.emit('message', { type: 'summary', key: 'live', summary: summary('g1') });
  worker.onRefresh = null;
  coordinator.refresh();
  const page = coordinator.pools(pageQuery);
  await delay(60);
  await expect(page).rejects.toBeInstanceOf(SnapshotBusyError);
  expect(worker.terminateCount).toBe(1);
  // The published generation survives the fault, and says why it is not being replaced.
  const held = coordinator.latest();
  expect(held.generation).toBe('g1');
  expect(held.status).toBe('stale');
  expect(held.message).toBe('快照刷新超时，正在显示上一次结果。');
  // The replacement is on the cooldown, not on the next tick.
  expect(workers).toHaveLength(1);
});

test('a restart storm is impossible: one reader per cooldown, no more', async () => {
  const { coordinator, workers } = harness({
    refreshTimeoutMs: 5,
    initTimeoutMs: 5,
    restartCooldownMs: 200,
    refreshIntervalMs: 5,
  });
  await delay(100);
  expect(workers.length).toBe(1);
  await delay(160);
  // The cooldown has passed once, so exactly one replacement was started — not forty.
  expect(workers.length).toBe(2);
  expect(coordinator.latest().status).toBe('empty');
});

test('details are capped, deduplicated and never left hanging', async () => {
  const { worker, coordinator } = harness({ detailConcurrency: 2, detailTimeoutMs: 30 });
  await Promise.resolve();
  worker.emit('message', { type: 'summary', key: 'live', summary: summary('g1') });
  const first = coordinator.pools(pageQuery);
  const firstId = worker.last('poolPage')!.id;
  // The same page asked twice is one request, waiting on one answer.
  expect(coordinator.pools(pageQuery)).toBe(first);
  const other = coordinator.pools({ ...pageQuery, offset: 20 });
  const otherId = worker.last('poolPage')!.id;
  expect(otherId).not.toBe(firstId);
  await expect(coordinator.pools({ ...pageQuery, offset: 40 })).rejects.toBeInstanceOf(
    SnapshotBusyError,
  );
  worker.emit('message', { type: 'page', id: firstId, page: emptyPage('g1') });
  await expect(first).resolves.toMatchObject({ generation: 'g1' });
  // The other one is never answered: it is released with a retryable error, not left waiting.
  await expect(other).rejects.toBeInstanceOf(SnapshotBusyError);
});

test('a page and a history answer from the worker, and an expired generation is named', async () => {
  const { worker, coordinator } = harness();
  await Promise.resolve();
  worker.emit('message', { type: 'summary', key: 'live', summary: summary('g1') });
  worker.onRefresh = null;
  const page = coordinator.pools(pageQuery);
  worker.emit('message', { type: 'page', id: worker.last('poolPage')!.id, page: emptyPage('g1') });
  await expect(page).resolves.toEqual(emptyPage('g1'));

  const history = coordinator.history({ generation: 'g1', address: token });
  worker.emit('message', {
    type: 'history',
    id: worker.last('tokenHistory')!.id,
    history: emptyHistory('g1'),
  });
  await expect(history).resolves.toEqual(emptyHistory('g1'));

  const expired = coordinator.pools({ ...pageQuery, generation: 'gone' });
  worker.emit('message', { type: 'expired', id: worker.last('poolPage')!.id });
  await expect(expired).rejects.toBeInstanceOf(SnapshotExpiredError);
});

test('a historical cutoff is never answered with the live summary', async () => {
  const { worker, coordinator } = harness();
  await Promise.resolve();
  worker.emit('message', { type: 'summary', key: 'live', summary: summary('g1') });
  worker.onRefresh = (request) =>
    queueMicrotask(() =>
      worker.emit('message', {
        type: 'summary',
        key: request.key,
        summary: summary('g-at', { selectedEndSec: request.at! }),
      }),
    );
  coordinator.refresh(4679);
  // Until its own generation exists the cutoff is pending, and the live summary is not offered.
  expect(coordinator.latest(4679)).toMatchObject({ generation: null, refreshing: true });
  await delay(5);
  expect(coordinator.latest(4679)).toMatchObject({ generation: 'g-at', selectedEndSec: 4679 });
  // The live answer did not move, and the historical one did not replace it.
  expect(coordinator.latest().generation).toBe('g1');
  expect(worker.last('refresh')).toMatchObject({ type: 'refresh', key: '4679', at: 4679 });
});

test('a reader that cannot open the database says so honestly and keeps trying', async () => {
  const { worker, coordinator } = harness({ restartCooldownMs: 5000 }, (created) => {
    created.initReply = 'no-database';
  });
  await delay(20);
  const value = coordinator.latest();
  expect(value.status).toBe('empty');
  expect(value.generation).toBeNull();
  expect(value.message).toBe('尚无本地数据库；请先运行已有的有界采集流程。');
  expect(JSON.stringify(value)).not.toContain('fake.sqlite');
  // A file that cannot be read is not the same answer as a file that is not there.
  expect(worker.sent.some((message) => message.type === 'init')).toBe(true);
});

test('an unreadable database is an error, not an empty one', async () => {
  const { coordinator } = harness({ restartCooldownMs: 5000 }, (created) => {
    created.initReply = 'unavailable';
  });
  await delay(20);
  expect(coordinator.latest()).toMatchObject({
    status: 'error',
    generation: null,
    message: '无法读取本地数据；请检查数据库与配置版本。',
  });
});

test('a database this reader can never read is named, not waited on', async () => {
  const { coordinator } = harness({ restartCooldownMs: 5000 }, (created) => {
    created.initReply = 'incompatible';
  });
  await delay(20);
  // The file exists and is readable; what it lacks is the projection every round begins with. That
  // is a property of the file, so no restart can change it and no budget is worth spending on one.
  expect(coordinator.latest()).toMatchObject({
    status: 'error',
    generation: null,
    refreshing: false,
    message: '本地数据库缺少实时投影表；请指向 recorder 正在写入的数据库。',
  });
});

test('a first snapshot that never arrives becomes a stated fault, not an endless wait', async () => {
  let clock = 1_000_000;
  const { coordinator } = harness(
    { now: () => clock, refreshIntervalMs: 60_000, restartCooldownMs: 60_000 },
    (created) => {
      // The reader warms up and then every round it runs fails: a fault with no restart to blame.
      created.onRefresh = () =>
        queueMicrotask(() => created.emit('message', { type: 'failed', code: 'SNAPSHOT_ERROR' }));
    },
  );
  await delay(20);
  // Below the budget the page still says it is generating, because a reader that has just started
  // failing may still be about to succeed, and a page that cried wolf on every transient is worse.
  expect(coordinator.latest()).toMatchObject({ status: 'empty', message: '正在生成首个快照' });
  clock += SNAPSHOT_FAULT_VISIBILITY_MS - 1;
  expect(coordinator.latest()).toMatchObject({ status: 'empty', message: '正在生成首个快照' });
  // Past it, and with nothing ever published, "generating" is no longer a true statement.
  clock += 1;
  expect(coordinator.latest()).toMatchObject({
    status: 'error',
    generation: null,
    message: '实时数据暂时不可用，尚未生成任何结果。',
  });
});

test('a worker that throws is reported to the log, and never described on the page', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let clock = 2_000_000;
  try {
    const { worker, coordinator } = harness(
      { now: () => clock, restartCooldownMs: 60_000 },
      (created) => {
        created.initReply = 'ready';
      },
    );
    await Promise.resolve();
    const failure = new Error('thread died holding an internal detail');
    worker.emit('error', failure);
    // The stack the page may never be shown is exactly what the log has to have: the thread's own
    // failure is the only account of why it left, and dropping it is what made this undiagnosable.
    expect(errors).toHaveBeenCalledWith('dashboard snapshot reader failed:', failure);
    expect(worker.terminateCount).toBe(1);
    expect(JSON.stringify(coordinator.latest())).not.toContain('internal detail');
    // The same budget applies to a reader that died as to one whose rounds fail.
    clock += SNAPSHOT_FAULT_VISIBILITY_MS;
    expect(coordinator.latest()).toMatchObject({
      status: 'error',
      message: '实时数据暂时不可用，尚未生成任何结果。',
    });
  } finally {
    errors.mockRestore();
  }
});

test('closing releases the worker and every waiting caller', async () => {
  const { worker, coordinator } = harness({ detailTimeoutMs: 5000 });
  await Promise.resolve();
  worker.emit('message', { type: 'summary', key: 'live', summary: summary('g1') });
  const page = coordinator.pools(pageQuery);
  await coordinator.close();
  await expect(page).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' });
  expect(worker.terminateCount).toBe(1);
  expect(worker.sent.at(-1)).toMatchObject({ type: 'close' });
  await expect(coordinator.pools(pageQuery)).rejects.toMatchObject({
    code: 'SNAPSHOT_UNAVAILABLE',
  });
  // What was already published is still answered: closing is not a reason to forget it.
  expect(coordinator.latest().generation).toBe('g1');
});

test('a GET is answered from memory while the worker does the computing', async () => {
  const source = openDashboardFixture();
  fixtures.push(source);
  const input = source.input;
  const coordinator = createSnapshotCoordinator({
    dbPath: source.path,
    scopeId: input.scopeId,
    registryScopeId: input.registryScopeId,
    configVersion: input.configVersion,
    assetVersion: input.assets.version,
    assets: input.assets.assets,
    usdg: input.usdg,
    metadata: input.metadata,
    // The real reader, on its own thread, over the real projected database.
    workerFactory: dashboardWorkerFactory(),
    refreshIntervalMs: 20,
  });
  coordinators.push(coordinator);
  const server = createDashboardServer({ coordinator });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const port = (server.address() as AddressInfo).port;
  try {
    const deadline = Date.now() + 30000;
    while (coordinator.latest().generation === null && Date.now() < deadline) await delay(20);
    const generation = coordinator.latest().generation;
    expect(generation).not.toBeNull();

    // Everything the request does in THIS process is counted, and it must be nothing: the batch
    // decoding, the swap valuation and the pool evaluation all belong to the worker's thread.
    const counts = openWorkCounts();
    const response = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
    const body = await response.json();
    counts.close();
    expect(response.status).toBe(200);
    expect(body.apiVersion).toBe(2);
    expect(body.generation).toBe(generation);
    expect(body.tokens.length).toBeGreaterThan(0);
    expect(counts.counts).toEqual(emptyWorkCounts());
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
    await coordinator.close();
  }
}, 40000);

test('the dashboard command releases its reader when it cannot start', async () => {
  const source = openDashboardFixture();
  fixtures.push(source);
  // A port that is already taken is the one startup failure reachable without a signal, and the
  // exit code it produces is the same `finish` that SIGINT/SIGTERM resolve with.
  const occupied = createNetServer();
  await new Promise<void>((listening) => occupied.listen(0, '127.0.0.1', listening));
  const port = (occupied.address() as AddressInfo).port;
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const code = await runDashboardCli(
      ['dashboard', '--db', source.path, '--port', String(port)],
      {},
      { workerFactory: dashboardWorkerFactory() },
    );
    expect(code).toBe(2);
    expect(errors).toHaveBeenCalled();
    // The coordinator released its reader: nothing is left holding the process open.
    const handles = (
      process as unknown as { _getActiveHandles(): { constructor?: { name?: string } }[] }
    )._getActiveHandles();
    expect(handles.filter((handle) => handle.constructor?.name === 'Worker')).toHaveLength(0);
  } finally {
    errors.mockRestore();
    await new Promise<void>((closed) => occupied.close(() => closed()));
  }
}, 30000);
