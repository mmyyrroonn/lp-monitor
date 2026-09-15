import { afterEach, expect, test } from 'vitest';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDashboardServer, type DashboardServerOptions } from '../../src/dashboard/server.js';
import {
  SNAPSHOT_DETAIL_CONCURRENCY,
  SnapshotBusyError,
  SnapshotUnavailableError,
  createSnapshotCoordinator,
  type SnapshotCoordinator,
  type SnapshotWorkerLike,
} from '../../src/dashboard/snapshot-coordinator.js';
import { SnapshotExpiredError } from '../../src/dashboard/read-model.js';
import { unavailableHealth } from '../../src/dashboard/snapshot.js';
import {
  address,
  openDashboardFixture,
  stocks,
  type DashboardFixture,
} from '../helpers/dashboard-fixture.js';
import { dashboardWorkerFactory, snapshotWorkerInit } from '../helpers/dashboard-worker.js';
import { emptyWorkCounts, openWorkCounts } from '../../src/ops/work-counters.js';
import type {
  DashboardSummary,
  PoolPage,
  TokenHistory,
  TokenMinute,
  WindowName,
} from '../../src/dashboard/types.js';

const servers: Server[] = [];
const coordinators: SnapshotCoordinator[] = [];
const fixtures: DashboardFixture[] = [];

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((closed) => server.close(() => closed()));
  for (const coordinator of coordinators.splice(0)) await coordinator.close();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A token the fixture really tracks, so a real reader can answer for it. */
const token = stocks.a;
const hex = (value: number) => `0x${value.toString(16).padStart(40, '0')}`;

async function start(options: DashboardServerOptions): Promise<string> {
  const server = createDashboardServer(options);
  servers.push(server);
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The real reader, on its own thread, over a projected fixture database. */
function realCoordinator(source: DashboardFixture): SnapshotCoordinator {
  const coordinator = createSnapshotCoordinator({
    ...snapshotWorkerInit(source),
    workerFactory: dashboardWorkerFactory(),
    // Long enough that nothing but a request can start a round during a test.
    refreshIntervalMs: 60_000,
  });
  coordinators.push(coordinator);
  return coordinator;
}

/** The same ask a page makes, repeated until the reader has published that generation. */
async function waitForGeneration(coordinator: SnapshotCoordinator, at?: number): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    coordinator.refresh(at);
    const generation = coordinator.latest(at).generation;
    if (generation !== null) return generation;
    await delay(20);
  }
  throw new Error('No generation was published in time');
}

function summary(
  generation: string | null,
  overrides: Partial<DashboardSummary> = {},
): DashboardSummary {
  return {
    status: 'ok',
    generatedAtMs: 1_000,
    // Fresh by the shared rule, so a test that wants staleness has to ask for it.
    sourceChainTimeSec: Math.floor(Date.now() / 1000),
    selectedEndSec: 4860,
    availableFromSec: 120,
    sourceHash: 'a'.repeat(64),
    scopeId: 's',
    assetVersion: 'test',
    tokens: [],
    coverage: [],
    health: unavailableHealth(),
    message: null,
    notes: [],
    apiVersion: 2,
    generation,
    refreshing: false,
    ...overrides,
  };
}

function minuteSeries(startMinute: number, count: number): TokenMinute[] {
  return Array.from({ length: count }, (_, index) => ({
    minuteStartSec: (startMinute + index) * 60,
    status: 'closed' as const,
    txCount: index,
    swapCount: index,
    usdMicros: null,
    reasons: [],
  }));
}

type HistoryQuery = { generation: string; address: string };
type PoolsQuery = HistoryQuery & { window: WindowName; offset: number; limit: number };

type Scripted = {
  summary?: (at?: number) => DashboardSummary;
  history?: (query: HistoryQuery) => Promise<TokenHistory>;
  pools?: (query: PoolsQuery) => Promise<PoolPage>;
};

/** A reader a test scripts directly, so the HTTP contract can be read on its own. */
class ScriptedCoordinator implements SnapshotCoordinator {
  readonly refreshes: (number | undefined)[] = [];
  readonly historyQueries: HistoryQuery[] = [];
  readonly poolQueries: PoolsQuery[] = [];
  peakDetailConcurrency = 0;
  #inFlight = 0;

  constructor(private readonly script: Scripted = {}) {}

  latest(at?: number): DashboardSummary {
    return this.script.summary?.(at) ?? summary(at === undefined ? 'live' : `at-${at}`);
  }

  refresh(at?: number): void {
    this.refreshes.push(at);
  }

  async history(query: HistoryQuery): Promise<TokenHistory> {
    this.historyQueries.push(query);
    this.#inFlight++;
    this.peakDetailConcurrency = Math.max(this.peakDetailConcurrency, this.#inFlight);
    try {
      return await (this.script.history?.(query) ?? {
        generation: query.generation,
        tokenAddress: query.address,
        minutes: minuteSeries(0, 180),
      });
    } finally {
      this.#inFlight--;
    }
  }

  async pools(query: PoolsQuery): Promise<PoolPage> {
    this.poolQueries.push(query);
    this.#inFlight++;
    this.peakDetailConcurrency = Math.max(this.peakDetailConcurrency, this.#inFlight);
    try {
      return await (this.script.pools?.(query) ?? {
        generation: query.generation,
        tokenAddress: query.address,
        window: query.window,
        offset: query.offset,
        limit: query.limit,
        total: 0,
        nextOffset: null,
        items: [],
      });
    } finally {
      this.#inFlight--;
    }
  }

  async close(): Promise<void> {}
}

/**
 * A reader that warms up and then never answers another round. Every summary a viewer asks for
 * has to come from what this side already published, in the time it takes to write a header.
 */
class StuckReader implements SnapshotWorkerLike {
  rounds = 0;
  readonly #listeners = new Map<string, ((value: never) => void)[]>();

  postMessage(value: unknown): void {
    const message = value as { type: string };
    if (message.type === 'init') queueMicrotask(() => this.#emit('message', { type: 'ready' }));
    if (message.type === 'refresh') this.rounds++;
  }

  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: string, listener: (value: never) => void): unknown {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  terminate(): unknown {
    return Promise.resolve(0);
  }

  #emit(event: string, value: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(value as never);
  }
}

async function statusViaRawHost(url: string, host: string): Promise<number | undefined> {
  return new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Every concurrent GET a viewer could fire, timed so the tail is a fact rather than an opinion. */
async function timedGets(
  url: string,
  count: number,
): Promise<{ status: number; body: unknown; p95: number; slowest: number }[]> {
  const answers = await Promise.all(
    Array.from({ length: count }, async () => {
      const started = performance.now();
      const response = await fetch(url);
      const body: unknown = await response.json();
      return { status: response.status, body, ms: performance.now() - started };
    }),
  );
  const sorted = answers.map((answer) => answer.ms).sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
  return answers.map((answer) => ({ ...answer, p95, slowest: sorted.at(-1)! }));
}

test('200 concurrent live summaries are answered from memory without any core computation', async () => {
  const source = openDashboardFixture();
  fixtures.push(source);
  const coordinator = realCoordinator(source);
  const url = await start({ coordinator });
  const generation = await waitForGeneration(coordinator);
  await fetch(`${url}/api/snapshot`); // warm the connection pool before timing anything

  const counts = openWorkCounts();
  const answers = await timedGets(`${url}/api/snapshot`, 200);
  counts.close();

  for (const answer of answers) {
    expect(answer.status).toBe(200);
    expect((answer.body as DashboardSummary).apiVersion).toBe(2);
    expect((answer.body as DashboardSummary).generation).toBe(generation);
    expect((answer.body as DashboardSummary).tokens.length).toBeGreaterThan(0);
  }
  // Reading a published summary is not reading the database: no batch decoding, no valuation and
  // no pool evaluation may happen in this process on the request path.
  expect(counts.counts).toEqual(emptyWorkCounts());
  expect(answers[0]!.p95).toBeLessThan(1000);
}, 40_000);

test('a stuck reader never delays an answer and never accepts a second round', async () => {
  const reader = new StuckReader();
  const coordinator = createSnapshotCoordinator({
    dbPath: 'unused.sqlite',
    scopeId: 's',
    registryScopeId: 's',
    configVersion: 'c',
    assetVersion: 'test',
    assets: [],
    usdg: token,
    metadata: { version: 'test', chainId: 4663 as const, source: 'synthetic', entries: [] },
    workerFactory: () => reader,
    refreshIntervalMs: 60_000,
    initTimeoutMs: 60_000,
    refreshTimeoutMs: 60_000,
  });
  coordinators.push(coordinator);
  const url = await start({ coordinator });
  while (reader.rounds === 0) await delay(5);

  const answers = await timedGets(`${url}/api/snapshot`, 200);

  for (const answer of answers) {
    expect(answer.status).toBe(200);
    // Nothing has been published yet, and the page is told exactly that — not an error.
    expect((answer.body as DashboardSummary).status).toBe('empty');
    expect((answer.body as DashboardSummary).generation).toBeNull();
    expect((answer.body as DashboardSummary).refreshing).toBe(true);
  }
  // The round that never finishes is the only round: every later ask joins it instead of queueing.
  expect(reader.rounds).toBe(1);
  expect(answers[0]!.p95).toBeLessThan(1000);
});

test('a cutoff that is not a minute end is rejected, an unavailable one is a renderable 200', async () => {
  const coordinator = new ScriptedCoordinator({
    summary: (at) =>
      at === undefined
        ? summary('live')
        : summary(null, {
            status: 'error',
            message: '所选时点的快照暂时无法生成。',
            selectedEndSec: at,
          }),
  });
  const url = await start({ coordinator });
  for (const path of [
    '/api/snapshot?at=1.5',
    '/api/snapshot?at=60',
    '/api/snapshot?at=',
    '/api/snapshot?at=-1',
    '/api/snapshot?at=59.0',
    '/api/snapshot?at=9007199254740993',
    '/api/snapshot?x=2',
    '/api/snapshot?at=59&at=119',
  ])
    expect((await fetch(url + path)).status, path).toBe(400);

  const response = await fetch(`${url}/api/snapshot?at=119`);
  const body = (await response.json()) as DashboardSummary;
  expect(response.status).toBe(200);
  expect(body.status).toBe('error');
  expect(body.selectedEndSec).toBe(119);
  expect(typeof body.message).toBe('string');
  expect(body.message!.length).toBeGreaterThan(0);
  expect(JSON.stringify(body)).not.toContain('stack');
  expect(coordinator.refreshes).toEqual([119]);
});

test('the overview batch route fans out over the reader and trims to the newest minutes', async () => {
  const coordinator = new ScriptedCoordinator({
    history: async (query) => ({
      generation: query.generation,
      tokenAddress: query.address,
      minutes: minuteSeries(0, 180),
    }),
  });
  const url = await start({ coordinator });
  const addresses = [stocks.a, stocks.b, stocks.c];
  const response = await fetch(
    `${url}/api/history?generation=g1&addresses=${addresses.join(',')}&minutes=30`,
  );
  const body = (await response.json()) as {
    generation: string;
    minutes: number;
    tokens: { address: string; minutes: TokenMinute[] }[];
  };
  expect(response.status).toBe(200);
  expect(body.generation).toBe('g1');
  expect(body.minutes).toBe(30);
  expect(body.tokens.map((entry) => entry.address)).toEqual(addresses);
  expect(body.tokens[0]!.minutes).toHaveLength(30);
  expect(body.tokens[0]!.minutes[0]!.minuteStartSec).toBe(150 * 60);
  expect(body.tokens[0]!.minutes.at(-1)!.minuteStartSec).toBe(179 * 60);
  // Minutes only ever run forwards; a chart that had to sort them would be a chart that guesses.
  const starts = body.tokens[0]!.minutes.map((entry) => entry.minuteStartSec);
  expect([...starts].sort((a, b) => a - b)).toEqual(starts);
});

test('the batch fans out under a bounded number of reader requests', async () => {
  const coordinator = new ScriptedCoordinator({
    history: async (query) => {
      await delay(5);
      return { generation: query.generation, tokenAddress: query.address, minutes: [] };
    },
  });
  const url = await start({ coordinator });
  const addresses = Array.from({ length: 40 }, (_, index) => hex(0x100 + index));
  const response = await fetch(
    `${url}/api/history?generation=g1&addresses=${addresses.join(',')}&minutes=5`,
  );
  expect(response.status).toBe(200);
  expect(coordinator.historyQueries).toHaveLength(40);
  expect(coordinator.peakDetailConcurrency).toBeLessThanOrEqual(SNAPSHOT_DETAIL_CONCURRENCY);
  // A serial loop would pass the bound above and still be the wrong shape.
  expect(coordinator.peakDetailConcurrency).toBeGreaterThan(1);
});

test('one unanswerable token fails the batch instead of shortening it in silence', async () => {
  const coordinator = new ScriptedCoordinator({
    history: async (query) => {
      if (query.address === stocks.b) throw new SnapshotBusyError();
      return { generation: query.generation, tokenAddress: query.address, minutes: [] };
    },
  });
  const url = await start({ coordinator });
  const response = await fetch(
    `${url}/api/history?generation=g1&addresses=${[stocks.a, stocks.b].join(',')}&minutes=30`,
  );
  const body = (await response.json()) as { code?: string; error: string };
  expect(response.status).toBe(503);
  expect(body.code).toBe('SNAPSHOT_BUSY');
  expect(body.error).toBe('Snapshot is refreshing');
});

test('rejects every batch query that is not exactly one generation, a bounded address list and minutes', async () => {
  const coordinator = new ScriptedCoordinator();
  const url = await start({ coordinator });
  const one = hex(1);
  const tooMany = Array.from({ length: 251 }, (_, index) => hex(0x1000 + index)).join(',');
  for (const path of [
    '/api/history',
    `/api/history?generation=g1`,
    `/api/history?addresses=${one}`,
    `/api/history?generation=&addresses=${one}`,
    `/api/history?generation=${'g'.repeat(129)}&addresses=${one}`,
    `/api/history?generation=g1&addresses=`,
    `/api/history?generation=g1&addresses=nothex`,
    `/api/history?generation=g1&addresses=${one},`,
    `/api/history?generation=g1&addresses=${tooMany}`,
    `/api/history?generation=g1&addresses=${one}&minutes=0`,
    `/api/history?generation=g1&addresses=${one}&minutes=61`,
    `/api/history?generation=g1&addresses=${one}&minutes=1.5`,
    `/api/history?generation=g1&addresses=${one}&minutes=x`,
    `/api/history?generation=g1&addresses=${one}&minutes=5&minutes=6`,
    `/api/history?generation=g1&generation=g2&addresses=${one}`,
    `/api/history?generation=g1&addresses=${one}&at=59`,
  ])
    expect((await fetch(url + path)).status, path).toBe(400);
  expect(coordinator.historyQueries).toHaveLength(0);
});

test('a token page and a token history pass their query through and name failures on the wire', async () => {
  const scripted = new ScriptedCoordinator({
    pools: async (query) => ({
      generation: query.generation,
      tokenAddress: query.address,
      window: query.window,
      offset: query.offset,
      limit: query.limit,
      total: 3,
      nextOffset: null,
      items: [],
    }),
  });
  const url = await start({ coordinator: scripted });
  const page = await fetch(
    `${url}/api/tokens/${stocks.a}/pools?generation=g1&window=15m&offset=20&limit=100`,
  );
  expect(page.status).toBe(200);
  expect(scripted.poolQueries).toEqual([
    { generation: 'g1', address: stocks.a, window: '15m', offset: 20, limit: 100 },
  ]);
  // The default page size is the reader's, and a caller that says nothing gets it.
  const defaults = await fetch(`${url}/api/tokens/${stocks.a}/pools?generation=g1&window=1m`);
  expect(defaults.status).toBe(200);
  expect(scripted.poolQueries.at(-1)).toMatchObject({ offset: 0, limit: 20 });

  const history = await fetch(`${url}/api/tokens/${token}/history?generation=g1`);
  expect(history.status).toBe(200);
  expect((await history.json()) as TokenHistory).toMatchObject({
    generation: 'g1',
    tokenAddress: token,
  });

  const faults = new ScriptedCoordinator({
    history: async () => {
      throw new SnapshotExpiredError('gone');
    },
    pools: async () => {
      throw new SnapshotUnavailableError();
    },
  });
  const faultUrl = await start({ coordinator: faults });
  const expired = await fetch(`${faultUrl}/api/tokens/${token}/history?generation=gone`);
  expect(expired.status).toBe(409);
  expect(await expired.json()).toEqual({ code: 'SNAPSHOT_EXPIRED', error: 'Snapshot expired' });
  const unavailable = await fetch(
    `${faultUrl}/api/tokens/${token}/pools?generation=g1&window=5m&offset=0&limit=20`,
  );
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({
    code: 'SNAPSHOT_UNAVAILABLE',
    error: 'Snapshot is unavailable',
  });
});

test('rejects every detail query that is not one generation and one known window and page', async () => {
  const coordinator = new ScriptedCoordinator();
  const url = await start({ coordinator });
  for (const path of [
    `/api/tokens/${token}/pools`,
    `/api/tokens/${token}/pools?generation=g1`,
    `/api/tokens/${token}/pools?generation=g1&window=2m`,
    `/api/tokens/${token}/pools?generation=g1&window=5m&offset=-1`,
    `/api/tokens/${token}/pools?generation=g1&window=5m&offset=1.5`,
    `/api/tokens/${token}/pools?generation=g1&window=5m&limit=0`,
    `/api/tokens/${token}/pools?generation=g1&window=5m&limit=101`,
    `/api/tokens/${token}/pools?generation=g1&window=5m&limit=10&limit=20`,
    `/api/tokens/${token}/pools?generation=g1&window=5m&at=59`,
    `/api/tokens/${token}/pools?generation=${'g'.repeat(129)}&window=5m`,
    `/api/tokens/nothex/pools?generation=g1&window=5m`,
    `/api/tokens/${token}/history`,
    `/api/tokens/${token}/history?generation=`,
    `/api/tokens/${token}/history?generation=${'g'.repeat(129)}`,
    `/api/tokens/nothex/history?generation=g1`,
    `/api/tokens/${token}/history?generation=g1&offset=0`,
  ])
    expect((await fetch(url + path)).status, path).toBe(400);
  expect(coordinator.poolQueries).toHaveLength(0);
  expect(coordinator.historyQueries).toHaveLength(0);
});

test('the new routes keep the local same-origin, read-only and CSP rules', async () => {
  const coordinator = new ScriptedCoordinator();
  const url = await start({ coordinator });
  const paths = [
    `/api/history?generation=g1&addresses=${token}&minutes=30`,
    `/api/tokens/${token}/pools?generation=g1&window=5m`,
    `/api/tokens/${token}/history?generation=g1`,
  ];
  for (const path of paths) {
    const response = await fetch(url + path);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(url + path, { method: 'POST' })).status).toBe(405);
    expect((await fetch(url + path, { headers: { Origin: 'https://evil.example' } })).status).toBe(
      403,
    );
    expect(await statusViaRawHost(url + path, 'evil.example')).toBe(403);
    const head = await fetch(url + path, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  }
});

test('the worker really answers pages and histories for the generation it published', async () => {
  const source = openDashboardFixture();
  fixtures.push(source);
  const coordinator = realCoordinator(source);
  const url = await start({ coordinator });
  const generation = await waitForGeneration(coordinator);

  // A page walk that neither repeats nor skips: the union of the pages is the whole token.
  const seen = new Set<string>();
  let offset: number | null = 0;
  let total = -1;
  let pages = 0;
  while (offset !== null) {
    const response = await fetch(
      `${url}/api/tokens/${token}/pools?generation=${generation}&window=5m&offset=${offset}&limit=2`,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as PoolPage;
    expect(page.generation).toBe(generation);
    expect(page.tokenAddress).toBe(token);
    for (const item of page.items) {
      expect(seen.has(item.poolId)).toBe(false);
      seen.add(item.poolId);
    }
    total = page.total;
    offset = page.nextOffset;
    pages++;
  }
  expect(pages).toBeGreaterThan(1);
  expect(seen.size).toBe(total);

  const history = await fetch(`${url}/api/tokens/${token}/history?generation=${generation}`);
  expect(history.status).toBe(200);
  const series = (await history.json()) as TokenHistory;
  expect(series.generation).toBe(generation);
  expect(series.tokenAddress).toBe(token);
  expect(series.minutes.length).toBeGreaterThan(0);

  const batch = await fetch(
    `${url}/api/history?generation=${generation}&addresses=${[stocks.a, stocks.b].join(',')}&minutes=15`,
  );
  expect(batch.status).toBe(200);
  const batchBody = (await batch.json()) as {
    generation: string;
    minutes: number;
    tokens: { address: string; minutes: TokenMinute[] }[];
  };
  expect(batchBody.generation).toBe(generation);
  expect(batchBody.tokens).toHaveLength(2);
  for (const entry of batchBody.tokens) {
    expect(entry.minutes.length).toBeLessThanOrEqual(15);
    expect(entry.minutes.map((m) => m.minuteStartSec)).toEqual(
      series.minutes.slice(-entry.minutes.length).map((m) => m.minuteStartSec),
    );
  }

  // A generation nobody holds is named as expired rather than answered with the live one.
  const gone = await fetch(`${url}/api/tokens/${token}/history?generation=g-none`);
  expect(gone.status).toBe(409);
  expect(await gone.json()).toEqual({ code: 'SNAPSHOT_EXPIRED', error: 'Snapshot expired' });
}, 40_000);

test('a historical cutoff is answered by its own generation, and the live one stays live', async () => {
  const source = openDashboardFixture();
  fixtures.push(source);
  const coordinator = realCoordinator(source);
  const url = await start({ coordinator });
  const live = await waitForGeneration(coordinator);
  const cutoff = 4799;
  const historical = await waitForGeneration(coordinator, cutoff);
  expect(historical).not.toBe(live);

  const liveAnswer = (await (await fetch(`${url}/api/snapshot`)).json()) as DashboardSummary;
  const historicalAnswer = (await (
    await fetch(`${url}/api/snapshot?at=${cutoff}`)
  ).json()) as DashboardSummary;
  expect(liveAnswer.generation).toBe(live);
  expect(historicalAnswer.generation).toBe(historical);
  expect(historicalAnswer.selectedEndSec).toBe(cutoff);

  // The chart of a replayed minute is that generation's chart, not the live one's.
  const lens = await fetch(`${url}/api/tokens/${token}/history?generation=${historical}`);
  expect(lens.status).toBe(200);
  const lensBody = (await lens.json()) as TokenHistory;
  expect(lensBody.generation).toBe(historical);
  const liveLens = (await (
    await fetch(`${url}/api/tokens/${token}/history?generation=${live}`)
  ).json()) as TokenHistory;
  expect(liveLens.generation).toBe(live);
  expect(JSON.stringify(lensBody)).not.toContain('stack');
}, 40_000);

test('a detail request that cannot be served in time is a retryable busy, not a hang', async () => {
  const reader = new StuckReader();
  const coordinator = createSnapshotCoordinator({
    dbPath: 'unused.sqlite',
    scopeId: 's',
    registryScopeId: 's',
    configVersion: 'c',
    assetVersion: 'test',
    assets: [],
    usdg: token,
    metadata: { version: 'test', chainId: 4663 as const, source: 'synthetic', entries: [] },
    workerFactory: () => reader,
    refreshIntervalMs: 60_000,
    initTimeoutMs: 60_000,
    refreshTimeoutMs: 60_000,
    detailTimeoutMs: 60,
  });
  coordinators.push(coordinator);
  const url = await start({ coordinator });
  while (reader.rounds === 0) await delay(5);

  const started = performance.now();
  const response = await fetch(`${url}/api/tokens/${token}/history?generation=g1`);
  expect(performance.now() - started).toBeLessThan(5000);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    code: 'SNAPSHOT_BUSY',
    error: 'Snapshot is refreshing',
  });
});

test('no failure body ever carries a stack, a path or a database word', async () => {
  const coordinator = new ScriptedCoordinator({
    history: async () => {
      throw new Error(
        'SQLITE_CANTOPEN: unable to open database file E:\\lp-monitor\\data\\x.sqlite',
      );
    },
  });
  const url = await start({ coordinator });
  const response = await fetch(`${url}/api/tokens/${token}/history?generation=g1`);
  const text = await response.text();
  expect(response.status).toBe(503);
  expect(text).not.toContain('stack');
  expect(text).not.toContain('SQLITE');
  expect(text).not.toContain('lp-monitor');
  expect(text).not.toContain('Error:');
  expect(JSON.parse(text)).toEqual({
    code: 'SNAPSHOT_UNAVAILABLE',
    error: 'Snapshot is unavailable',
  });
});
