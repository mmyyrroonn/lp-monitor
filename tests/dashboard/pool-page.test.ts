import { afterEach, expect, test } from 'vitest';
import { buildDashboardSnapshot } from '../../src/dashboard/snapshot.js';
import { DashboardReadModel, SnapshotExpiredError } from '../../src/dashboard/read-model.js';
import { poolRegistrationId } from '../../src/registry/pools.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';
import type { DashboardPool, WindowName } from '../../src/dashboard/types.js';
import {
  generationInput,
  metricsReport,
  openDashboardFixture,
  poolAddress,
  registrationsOf,
  scaleScenario,
  stocks,
  type DashboardFixture,
} from '../helpers/dashboard-fixture.js';

const WINDOWS: readonly WindowName[] = ['1m', '5m', '15m', '1h'];
const open: DashboardFixture[] = [];
afterEach(() => {
  for (const fixture of open.splice(0)) fixture.close();
});
function fixture(options: Parameters<typeof openDashboardFixture>[0] = {}): DashboardFixture {
  const opened = openDashboardFixture(options);
  open.push(opened);
  return opened;
}

/** The comparator `src/dashboard/web/app.ts` sorts pool cards with, kept character for character. */
function comparePools(window: WindowName) {
  return (a: DashboardPool, b: DashboardPool) => {
    const aa = a.windows[window].txCount,
      bb = b.windows[window].txCount;
    return aa === null || bb === null
      ? aa === bb
        ? a.poolId.localeCompare(b.poolId)
        : aa === null
          ? 1
          : -1
      : bb - aa || a.poolId.localeCompare(b.poolId);
  };
}

function pageWalk(
  model: DashboardReadModel,
  query: { generation: string; tokenAddress: string; window: WindowName; limit: number },
): DashboardPool[] {
  const items: DashboardPool[] = [];
  let offset = 0;
  for (;;) {
    const page = model.pools({ ...query, offset });
    expect(page.offset).toBe(offset);
    expect(page.limit).toBe(query.limit);
    expect(page.window).toBe(query.window);
    expect(page.tokenAddress).toBe(query.tokenAddress.toLowerCase());
    items.push(...page.items);
    if (page.nextOffset === null) break;
    // A page that answers with nothing and still promises more would walk forever; fail loudly
    // rather than hang, because the walk only ends when the offset passes the total.
    expect(page.nextOffset).toBeGreaterThan(offset);
    expect(page.nextOffset).toBe(offset + page.items.length);
    offset = page.nextOffset;
  }
  return items;
}

test('pages reproduce the order and the details the legacy snapshot hands the app', () => {
  const opened = fixture(),
    report = metricsReport(opened),
    legacy = buildDashboardSnapshot(opened.readonly, opened.input, { nowMs: 4900000 }),
    model = new DashboardReadModel();
  model.loadRegistry(registrationsOf(opened));
  const summary = model.publish(generationInput(opened, { report }));
  for (const token of legacy.tokens) {
    for (const window of WINDOWS) {
      const expected = [...token.pools].sort(comparePools(window)),
        items = pageWalk(model, {
          generation: summary.generation!,
          tokenAddress: token.address,
          window,
          limit: 3,
        });
      expect(items.map((pool) => pool.poolId)).toEqual(expected.map((pool) => pool.poolId));
      // Details too: every window, every reason, and the last exact swap time.
      expect(items).toEqual(expected);
    }
  }
});

test('switching the window changes the order the same way the comparator does', () => {
  const opened = fixture(),
    report = metricsReport(opened),
    legacy = buildDashboardSnapshot(opened.readonly, opened.input, { nowMs: 4900000 }),
    model = new DashboardReadModel();
  model.loadRegistry(registrationsOf(opened));
  const summary = model.publish(generationInput(opened, { report }));
  const orderOf = (window: WindowName) =>
    pageWalk(model, {
      generation: summary.generation!,
      tokenAddress: stocks.a,
      window,
      limit: 10,
    }).map((pool) => pool.poolId);
  const legacyOrder = (window: WindowName) => {
    const token = legacy.tokens.find((entry) => entry.address === stocks.a.toLowerCase())!;
    return [...token.pools].sort(comparePools(window)).map((pool) => pool.poolId);
  };
  for (const window of WINDOWS) expect(orderOf(window)).toEqual(legacyOrder(window));
  expect(orderOf('1m')).not.toEqual(orderOf('1h'));
  // The walk covers cold pools too, not only the ones with a transaction.
  const cold = pageWalk(model, {
    generation: summary.generation!,
    tokenAddress: stocks.a,
    window: '1m',
    limit: 10,
  });
  expect(cold.some((pool) => pool.windows['1m'].txCount === 0)).toBe(true);
});

test('an offset past the end is an empty page with an unchanged total', () => {
  const opened = fixture(),
    report = metricsReport(opened),
    model = new DashboardReadModel();
  model.loadRegistry(registrationsOf(opened));
  const summary = model.publish(generationInput(opened, { report }));
  const page = model.pools({
    generation: summary.generation!,
    tokenAddress: stocks.a,
    window: '1m',
    offset: 500,
  });
  expect(page.items).toEqual([]);
  expect(page.total).toBe(5);
  expect(page.nextOffset).toBeNull();
  const last = model.pools({
    generation: summary.generation!,
    tokenAddress: stocks.a,
    window: '1m',
    offset: 4,
  });
  expect(last.items).toHaveLength(1);
  expect(last.nextOffset).toBeNull();
});

test('invalid queries are refused and the default limit is twenty', () => {
  const opened = fixture(),
    report = metricsReport(opened),
    model = new DashboardReadModel();
  model.loadRegistry(registrationsOf(opened));
  const summary = model.publish(generationInput(opened, { report })),
    generation = summary.generation!,
    base = { generation, tokenAddress: stocks.a, window: '1m' as WindowName, offset: 0 };
  expect(model.pools(base).limit).toBe(20);
  expect(model.pools({ ...base, limit: 100 }).items).toHaveLength(5);
  expect(() => model.pools({ ...base, window: '2m' as WindowName })).toThrow(RangeError);
  expect(() => model.pools({ ...base, offset: -1 })).toThrow(RangeError);
  expect(() => model.pools({ ...base, offset: 1.5 })).toThrow(RangeError);
  expect(() => model.pools({ ...base, limit: 0 })).toThrow(RangeError);
  expect(() => model.pools({ ...base, limit: 101 })).toThrow(RangeError);
  expect(() => model.pools({ ...base, limit: 2.5 })).toThrow(RangeError);
  expect(() => model.pools({ ...base, tokenAddress: '0xnot-an-address' })).toThrow(RangeError);
  expect(() => model.pools({ ...base, generation: 'x'.repeat(129) })).toThrow(RangeError);
  expect(() => model.pools({ ...base, generation: '' })).toThrow(RangeError);
  expect(() => model.history({ generation, tokenAddress: '0xnot-an-address' })).toThrow(RangeError);
});

test('an expired generation fails with its own name and nothing else', () => {
  const opened = fixture(),
    report = metricsReport(opened),
    model = new DashboardReadModel();
  model.loadRegistry(registrationsOf(opened));
  model.publish(generationInput(opened, { report }));
  const gone = 'a'.repeat(32);
  try {
    model.pools({ generation: gone, tokenAddress: stocks.a, window: '1m', offset: 0 });
    expect.unreachable('an expired generation must not answer');
  } catch (error) {
    expect(error).toBeInstanceOf(SnapshotExpiredError);
    expect((error as Error).message).toContain(gone);
    expect((error as Error).message).not.toContain('/');
    expect((error as Error).message).not.toMatch(/select |from |\.sqlite/i);
  }
});

test('a page builds only the pools it returns, and repeats come from the cache', () => {
  const opened = fixture(),
    report = metricsReport(opened),
    model = new DashboardReadModel(),
    work = openWorkCounts();
  try {
    model.loadRegistry(registrationsOf(opened));
    const summary = model.publish(generationInput(opened, { report })),
      query = {
        generation: summary.generation!,
        tokenAddress: stocks.a,
        window: '1m' as WindowName,
        offset: 0,
        limit: 3,
      };
    const first = model.pools(query);
    expect(first.items).toHaveLength(3);
    expect(work.counts.readModelPoolsBuilt).toBe(3);
    expect(work.counts.readModelPageCacheHits).toBe(0);
    const again = model.pools(query);
    expect(again).toBe(first);
    expect(work.counts.readModelPoolsBuilt).toBe(3);
    expect(work.counts.readModelPageCacheHits).toBe(1);
    expect(model.counts().poolPages).toBe(1);
    // The cache is bounded: eighty distinct pages leave at most sixty-four behind.
    for (let limit = 1; limit <= 20; limit++)
      for (const window of WINDOWS) model.pools({ ...query, window, limit });
    expect(model.counts().poolPages).toBeLessThanOrEqual(64);
  } finally {
    work.close();
  }
});

test('194 stocks over 80k pools page the whole catalogue, twenty at a time', () => {
  const scenario = scaleScenario(),
    model = new DashboardReadModel(),
    work = openWorkCounts();
  try {
    model.loadRegistry(scenario.registrations);
    const summary = model.publish(scenario.input),
      address = scenario.input.stocks[0]!.asset.address,
      generation = summary.generation!;
    const first = model.pools({
      generation,
      tokenAddress: address,
      window: '5m',
      offset: 0,
      limit: 20,
    });
    expect(first.items).toHaveLength(20);
    expect(work.counts.readModelPoolsBuilt).toBe(20);
    const second = model.pools({
      generation,
      tokenAddress: address,
      window: '5m',
      offset: first.nextOffset!,
      limit: 20,
    });
    expect(second.items).toHaveLength(20);
    expect(new Set([...first.items, ...second.items].map((pool) => pool.poolId)).size).toBe(40);
    // Every registered pool of the stock is reachable through the pages, hot or not.
    const items = pageWalk(model, { generation, tokenAddress: address, window: '5m', limit: 20 });
    const expected = scenario.registrations
      .filter((registration) => registration.token0 === address.toLowerCase())
      .map(poolRegistrationId)
      .sort((left, right) => left.localeCompare(right));
    expect(items.map((pool) => pool.poolId).sort((l, r) => l.localeCompare(r))).toEqual(expected);
    expect(new Set(items.map((pool) => pool.poolId)).size).toBe(items.length);
    expect(first.items.every((pool) => pool.windows['5m'].txCount !== null)).toBe(true);
    expect(work.counts.readModelPoolsBuilt).toBe(items.length);
  } finally {
    work.close();
  }
});

test('a generation published before a delta keeps its own pages and history', () => {
  const opened = fixture(),
    report = metricsReport(opened),
    registrations = registrationsOf(opened),
    legacy = buildDashboardSnapshot(opened.readonly, opened.input, { nowMs: 4900000 }),
    model = new DashboardReadModel();
  model.loadRegistry(registrations);
  const first = model.publish(generationInput(opened, { report, registryRevision: 1 }));
  const walk = (generation: string, address: string) =>
    pageWalk(model, { generation, tokenAddress: address, window: '1m', limit: 2 });
  const beforeA = walk(first.generation!, stocks.a),
    beforeB = walk(first.generation!, stocks.b),
    beforeHistory = model.history({ generation: first.generation!, tokenAddress: stocks.e });
  expect(beforeHistory.minutes).toEqual(legacy.tokens[4]!.minutes);

  const byAddress = (index: number) =>
    registrations.find(
      (registration) =>
        registration.pool.protocol === 'v3' && registration.pool.address === poolAddress(index),
    )!;
  const removed = byAddress(3),
    moved = byAddress(4),
    recent = byAddress(12);
  model.applyRegistryDelta([
    { poolKey: 'p3', before: removed, after: null },
    { poolKey: 'p4', before: moved, after: { ...moved, token1: stocks.b } },
    { poolKey: 'p12', before: recent, after: null },
  ]);

  // The older generation answers from the catalogue it was published with, overlay included.
  expect(walk(first.generation!, stocks.a)).toEqual(beforeA);
  expect(walk(first.generation!, stocks.b)).toEqual(beforeB);
  expect(model.history({ generation: first.generation!, tokenAddress: stocks.e }).minutes).toEqual(
    beforeHistory.minutes,
  );
  expect(
    model.pools({
      generation: first.generation!,
      tokenAddress: stocks.a,
      window: '1m',
      offset: 0,
      limit: 20,
    }).total,
  ).toBe(5);

  const second = model.publish(generationInput(opened, { report, registryRevision: 2 })),
    newA = walk(second.generation!, stocks.a),
    newB = walk(second.generation!, stocks.b);
  expect(newA).toHaveLength(beforeA.length - 1);
  expect(newA.map((pool) => pool.poolId)).not.toContain(poolRegistrationId(removed));
  expect(new Set(newB.map((pool) => pool.poolId))).toEqual(
    new Set([...beforeB.map((pool) => pool.poolId), poolRegistrationId(moved)]),
  );
  // The moved pool shows its new pair in the new generation and its old one in the older one.
  expect(newB.find((pool) => pool.poolId === poolRegistrationId(moved))!.token1).toBe(
    stocks.b.toLowerCase(),
  );
  expect(beforeA.find((pool) => pool.poolId === poolRegistrationId(moved))!.token1).toBe(
    moved.token1,
  );
  const newHistory = model.history({ generation: second.generation!, tokenAddress: stocks.e });
  expect(
    newHistory.minutes.some((minute) => minute.reasons.includes('pool-lifetime-incomplete')),
  ).toBe(false);
  expect(newHistory.minutes.every((minute) => minute.reasons.includes('no-registered-pools'))).toBe(
    true,
  );
});

test('a re-published generation picks up the delta and never mixes two versions', () => {
  const opened = fixture(),
    report = metricsReport(opened),
    registrations = registrationsOf(opened),
    model = new DashboardReadModel();
  model.loadRegistry(registrations);
  const first = model.publish(generationInput(opened, { report, registryRevision: 1 }));
  const added = {
    ...registrations[0]!,
    pool: { chainId: 4663 as const, protocol: 'v3' as const, address: poolAddress(20) },
    token0: stocks.a,
    token1: stocks.d,
    discoveredAt: {
      ...registrations[0]!.discoveredAt,
      transactionHash: registrations[0]!.discoveredAt.transactionHash,
    },
  };
  model.applyRegistryDelta([{ poolKey: 'new', before: null, after: added }]);
  const second = model.publish(generationInput(opened, { report, registryRevision: 2 }));
  expect(second.tokens.find((token) => token.address === stocks.a)!.poolCount).toBe(6);
  expect(first.tokens.find((token) => token.address === stocks.a)!.poolCount).toBe(5);
  const page = model.pools({
    generation: second.generation!,
    tokenAddress: stocks.a,
    window: '1m',
    offset: 0,
    limit: 20,
  });
  expect(page.total).toBe(6);
  expect(page.items.map((pool) => pool.poolId)).toContain(poolRegistrationId(added));
  expect(
    model.pools({
      generation: first.generation!,
      tokenAddress: stocks.a,
      window: '1m',
      offset: 0,
      limit: 20,
    }).total,
  ).toBe(5);
});
