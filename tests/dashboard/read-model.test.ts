import { afterEach, expect, test } from 'vitest';
import { buildDashboardSnapshot, unavailableHealth } from '../../src/dashboard/snapshot.js';
import {
  aggregateWindow,
  DashboardReadModel,
  generationKey,
  SnapshotExpiredError,
} from '../../src/dashboard/read-model.js';
import { ROLLING_DURATIONS } from '../../src/metrics/rolling.js';
import { poolRegistrationId } from '../../src/registry/pools.js';
import type { MetricCoverage } from '../../src/metrics/coverage.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';
import type { DashboardSummary, WindowName } from '../../src/dashboard/types.js';
import {
  address,
  generationInput,
  hash,
  metricsReport,
  openDashboardFixture,
  poolAddress,
  registrationsOf,
  sampleValuation,
  scaleScenario,
  stocks,
  usdg,
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
function tokenFor(tokens: readonly { address: string }[], address: string): { address: string } {
  const found = tokens.find((token) => token.address.toLowerCase() === address.toLowerCase());
  if (found === undefined) throw new Error(`No token ${address}`);
  return found;
}

test('every stock window, pool count and active count equals the legacy snapshot', () => {
  const opened = fixture(),
    report = metricsReport(opened),
    legacy = buildDashboardSnapshot(opened.readonly, opened.input, { nowMs: 4900000 }),
    model = new DashboardReadModel();
  model.loadRegistry(registrationsOf(opened));
  const summary = model.publish(generationInput(opened, { report }));

  expect(summary.apiVersion).toBe(2);
  expect(summary.generation).toBe(generationKey(generationInput(opened, { report })));
  expect(summary.refreshing).toBe(false);
  expect(summary.status).toBe(legacy.status);
  expect(summary.sourceChainTimeSec).toBe(legacy.sourceChainTimeSec);
  expect(summary.selectedEndSec).toBe(legacy.selectedEndSec);
  expect(summary.availableFromSec).toBe(legacy.availableFromSec);
  expect(summary.coverage).toEqual(legacy.coverage);
  expect(summary.tokens).toHaveLength(legacy.tokens.length);

  for (const [index, token] of summary.tokens.entries()) {
    const previous = legacy.tokens[index]!;
    expect(token.address).toBe(previous.address);
    expect(token.symbol).toBe(previous.symbol);
    expect(token.windows).toEqual(previous.windows);
    expect(token.poolCount).toBe(previous.poolIds.length);
    for (const name of WINDOWS)
      expect(token.activePoolCount[name]).toBe(
        previous.pools.filter((pool) => (pool.windows[name].txCount ?? 0) > 0).length,
      );
    expect(token).not.toHaveProperty('pools');
    expect(token).not.toHaveProperty('poolIds');
    expect(token).not.toHaveProperty('minutes');
  }

  const hot = tokenFor(summary.tokens, stocks.a) as (typeof summary.tokens)[number];
  // Three logs of one transaction inside the window: one transaction, three swaps.
  expect(hot.windows['1m'].current).toMatchObject({ txCount: 1, swapCount: 3, available: true });
  // The shared A/B pool is priced by neither side, so its amount stays unknown while counts do not.
  expect(hot.windows['1m'].previous.usdMicros).toBeNull();
  expect(hot.windows['1m'].previous.swapCount).toBeGreaterThan(0);
  // The idle stock trades nothing, and the stock without pools reports none registered.
  expect(tokenFor(summary.tokens, stocks.d) as never).toMatchObject({
    poolCount: 3,
    windows: { '1m': { current: { available: true, txCount: 0 } } },
  });
  expect(tokenFor(summary.tokens, stocks.c) as never).toMatchObject({
    poolCount: 0,
    windows: { '1m': { current: { available: false, reasons: ['no-registered-pools'] } } },
  });
  // A swap in a window the pool's discovery denies stays a swap; the count stays unknown, so the
  // active count cannot be a swap count.
  const recent = tokenFor(summary.tokens, stocks.e) as (typeof summary.tokens)[number];
  expect(recent.windows['1m'].previous).toMatchObject({
    available: false,
    txCount: null,
    reasons: ['pool-lifetime-incomplete'],
  });
  expect(recent.activePoolCount['1m']).toBe(0);
});

test('history minutes equal the legacy minutes and follow the selected stock only', () => {
  const opened = fixture(),
    report = metricsReport(opened),
    legacy = buildDashboardSnapshot(opened.readonly, opened.input, { nowMs: 4900000 }),
    model = new DashboardReadModel();
  model.loadRegistry(registrationsOf(opened));
  const summary = model.publish(generationInput(opened, { report }));
  for (const [index, token] of legacy.tokens.entries()) {
    const history = model.history({
      generation: summary.generation!,
      tokenAddress: token.address,
    });
    expect(history.generation).toBe(summary.generation);
    expect(history.tokenAddress).toBe(token.address);
    expect(history.minutes).toEqual(token.minutes);
  }
  const other = model.history({
    generation: summary.generation!,
    tokenAddress: stocks.d,
  });
  expect(other.minutes).not.toEqual(
    model.history({ generation: summary.generation!, tokenAddress: stocks.a }).minutes,
  );
});

test('a coverage hole keeps the same windows and minutes as the legacy snapshot', () => {
  const opened = fixture({ dropBoundarySec: 4800 }),
    report = metricsReport(opened),
    legacy = buildDashboardSnapshot(opened.readonly, opened.input, { nowMs: 4900000 }),
    model = new DashboardReadModel();
  model.loadRegistry(registrationsOf(opened));
  const summary = model.publish(generationInput(opened, { report }));
  for (const [index, token] of summary.tokens.entries()) {
    expect(token.windows).toEqual(legacy.tokens[index]!.windows);
    expect(
      model.history({ generation: summary.generation!, tokenAddress: token.address }).minutes,
    ).toEqual(legacy.tokens[index]!.minutes);
  }
  const hot = tokenFor(summary.tokens, stocks.a) as (typeof summary.tokens)[number];
  expect(hot.windows['1m'].current.reasons).toContain('coverage-missing');
  // A window that does not cross the hole keeps its value.
  expect(hot.windows['5m'].previous.available).toBe(true);
});

test('one catalogue index serves every round, and only a touched stock is rescanned', () => {
  const opened = fixture(),
    registrations = registrationsOf(opened),
    report = metricsReport(opened),
    model = new DashboardReadModel(),
    work = openWorkCounts();
  try {
    model.loadRegistry(registrations);
    expect(work.counts.readModelIndexBuilds).toBe(1);
    const afterLoad = work.counts.readModelRegistryScans;
    expect(afterLoad).toBeGreaterThanOrEqual(registrations.length);
    model.publish(generationInput(opened, { report, registryRevision: 1 }));
    const afterFirstPublish = work.counts.readModelRegistryScans;
    expect(afterFirstPublish).toBeGreaterThan(afterLoad);
    // A second round with the same catalogue must not walk it again.
    model.publish(generationInput(opened, { report, registryRevision: 2 }));
    expect(work.counts.readModelRegistryScans).toBe(afterFirstPublish);
    expect(work.counts.readModelIndexBuilds).toBe(1);
    // Only the pools a delta names are rescanned, and only for the stocks they belong to.
    const pool = registrations.find(
      (registration) =>
        registration.pool.protocol === 'v3' && registration.pool.address === poolAddress(4),
    )!;
    model.applyRegistryDelta([{ poolKey: 'p4', before: pool, after: null }]);
    expect(work.counts.readModelRegistryScans).toBe(afterFirstPublish);
    model.publish(generationInput(opened, { report, registryRevision: 3 }));
    const afterDelta = work.counts.readModelRegistryScans;
    // The touched stock rebuilds its own view; the rest of the catalogue is left alone.
    expect(afterDelta - afterFirstPublish).toBeLessThan(registrations.length / 2);
    model.publish(generationInput(opened, { report, registryRevision: 4 }));
    expect(work.counts.readModelRegistryScans).toBe(afterDelta);
  } finally {
    work.close();
  }
});

test('the shared pool belongs to both stocks and a delta moves each count once', () => {
  const opened = fixture(),
    registrations = registrationsOf(opened),
    report = metricsReport(opened),
    model = new DashboardReadModel();
  model.loadRegistry(registrations);
  const first = model.publish(generationInput(opened, { report, registryRevision: 1 }));
  const countOf = (summary: typeof first, address: string) =>
    summary.tokens.find((token) => token.address === address.toLowerCase())!.poolCount;
  expect(countOf(first, stocks.a)).toBe(5);
  expect(countOf(first, stocks.b)).toBe(4);
  const shared = registrations.find(
    (registration) =>
      registration.token0 === stocks.a.toLowerCase() &&
      registration.token1 === stocks.b.toLowerCase(),
  )!;
  model.applyRegistryDelta([{ poolKey: 'shared', before: shared, after: null }]);
  const second = model.publish(generationInput(opened, { report, registryRevision: 2 }));
  expect(countOf(second, stocks.a)).toBe(4);
  expect(countOf(second, stocks.b)).toBe(3);
  // The generation published before the delta keeps the catalogue it was published with.
  expect(countOf(first, stocks.a)).toBe(5);
  expect(countOf(first, stocks.b)).toBe(4);
});

test('retention keeps two live generations and four historical cutoffs, then reports expiry', () => {
  const opened = fixture(),
    report = metricsReport(opened),
    model = new DashboardReadModel();
  model.loadRegistry(registrationsOf(opened));
  const live = [1, 2, 3].map((revision) =>
    model.publish(generationInput(opened, { report, registryRevision: revision })),
  );
  expect(model.has(live[0]!.generation!)).toBe(false);
  expect(model.has(live[1]!.generation!)).toBe(true);
  expect(model.latest()).toBe(live[2]);
  const historical = [119, 179, 239, 299, 359].map((cutoffSec) =>
    model.publish(generationInput(opened, { report, registryRevision: 4, cutoffSec })),
  );
  expect(new Set(historical.map((summary) => summary.generation)).size).toBe(5);
  expect(model.has(historical[0]!.generation!)).toBe(false);
  expect(model.has(historical[4]!.generation!)).toBe(true);
  expect(model.counts().generations).toBe(6);
  expect(() =>
    model.pools({
      generation: historical[0]!.generation!,
      tokenAddress: stocks.a,
      window: '1m',
      offset: 0,
    }),
  ).toThrow(SnapshotExpiredError);
  expect(() =>
    model.history({ generation: historical[0]!.generation!, tokenAddress: stocks.a }),
  ).toThrow(SnapshotExpiredError);
  expect(() => model.history({ generation: 'missing', tokenAddress: stocks.a })).toThrow(/missing/);
  expect(model.has('no-such-generation')).toBe(false);
});

test('refreshing is reported without touching the published data', () => {
  const opened = fixture(),
    report = metricsReport(opened),
    model = new DashboardReadModel();
  model.loadRegistry(registrationsOf(opened));
  expect(model.latest()).toBeNull();
  expect(model.setRefreshing(true)).toBeNull();
  const summary = model.publish(generationInput(opened, { report, refreshing: true }));
  expect(summary.refreshing).toBe(true);
  const marked = model.setRefreshing(false);
  expect(marked).toMatchObject({ generation: summary.generation, refreshing: false });
  expect(marked!.tokens).toBe(summary.tokens);
  expect(marked!.generatedAtMs).toBe(summary.generatedAtMs);
});

test('a generation key is stable, path-free and bounded', () => {
  const parts = {
    scopeId: 's',
    registryScopeId: 's',
    configVersion: 'c',
    assetVersion: 'a',
    sourceHash: 'hash',
    registryRevision: 7,
    metadataRevision: 'm',
    cutoffSec: null,
  };
  expect(generationKey(parts)).toBe(generationKey({ ...parts }));
  expect(generationKey(parts)).toMatch(/^[0-9a-f]{32}$/);
  expect(generationKey(parts).length).toBeLessThanOrEqual(128);
  expect(generationKey({ ...parts, cutoffSec: 359 })).not.toBe(generationKey(parts));
  expect(generationKey({ ...parts, registryRevision: 8 })).not.toBe(generationKey(parts));
  expect(generationKey({ ...parts, sourceHash: null })).not.toBe(generationKey(parts));
});

test('a round republished under the same version rebuilds the pages it replaces', () => {
  const opened = fixture(),
    report = metricsReport(opened),
    registrations = registrationsOf(opened),
    model = new DashboardReadModel(),
    reference = new DashboardReadModel();
  model.loadRegistry(registrations);
  reference.loadRegistry(registrations);
  const input = generationInput(opened, { report }),
    first = model.publish(input),
    query = {
      generation: first.generation!,
      tokenAddress: stocks.a,
      window: '1m' as WindowName,
      offset: 0,
      limit: 3,
    };
  const before = model.pools(query);
  expect(before.items.some((pool) => (pool.windows['1m'].txCount ?? 0) > 0)).toBe(true);
  // Every swap the stock had is moved onto its last pool by id, so that pool becomes the only hot
  // one and the whole ranking changes. That pool is outside the first page while it is cold, which
  // is what makes a page carried over from the previous round visibly wrong rather than coincidental.
  const stock = input.stocks.find((entry) => entry.asset.address === stocks.a)!,
    target = registrations
      .filter((registration) => registration.token0 === stocks.a)
      .sort((left, right) =>
        poolRegistrationId(left).localeCompare(poolRegistrationId(right)),
      )
      .at(-1)!,
    targetId = poolRegistrationId(target);
  expect(before.items.map((pool) => pool.poolId)).not.toContain(targetId);
  // The hot window moves on without the business version moving: the source hash, the registry
  // revision and every other part of the key stay put, so both rounds answer to one generation
  // string while carrying different data. A page or an order cached for the string belongs to the
  // round it was built from, and serving it again would describe a round that no longer exists.
  const stocksAfter = input.stocks.map((entry) =>
      entry === stock
        ? { asset: entry.asset, valuations: entry.valuations.map((v) => ({ ...v, pool: target.pool })) }
        : entry,
    ),
    second = model.publish({ ...input, stocks: stocksAfter }),
    fromScratch = reference.publish({ ...input, stocks: stocksAfter });
  expect(second.generation).toBe(first.generation);
  expect(fromScratch.generation).toBe(first.generation);
  const after = model.pools(query),
    expected = reference.pools(query);
  expect(after.items).toEqual(expected.items);
  expect(after.items[0]!.poolId).toBe(targetId);
  expect(after.items[0]!.windows['1m'].txCount).toBeGreaterThan(0);
  expect(second.tokens.find((token) => token.address === stocks.a)!.activePoolCount['1m']).toBe(1);
});

test('birth groups answer every window exactly as the per-pool rule does', () => {
  const watermark = 4860,
    asset = { symbol: stocks.a, address: stocks.a, identityStatus: 'observed' },
    births = [60, 2000, 4700, 4740, 4800],
    pool = (index: number, birth: number, source: string) => ({
      pool: {
        chainId: 4663 as const,
        protocol: 'v3' as const,
        address: poolAddress(30 + index),
      },
      token0: stocks.a,
      token1: usdg,
      feePips: 3000,
      tickSpacing: 60,
      hooks: address(0),
      discoveredAt: {
        blockHash: hash(birth),
        blockNumber: BigInt(birth),
        transactionHash: hash(0x7000 + index),
        transactionIndex: 0,
        logIndex: 0,
      },
      assetVersion: 'test',
      source,
    }),
    pools = [
      ...births.map((birth, index) => pool(index, birth, 'synthetic')),
      // A seed record carries no discovery height, so it can never deny a window.
      pool(births.length, 9, 'seed-config'),
    ],
    // The highest height belongs to a pool with no event at all: a silent pool still decides
    // whether its stock's window can be read, and the rule it is compared against says so too.
    valuations = [sampleValuation(pools[3]!.pool, 3, 4820)],
    model = new DashboardReadModel();
  model.loadRegistry(pools);
  const rounds: DashboardSummary[] = [];
  // Each round drops the oldest coverage minutes, so heights the previous round still had to weigh
  // leave the cursor behind: a window that was denied becomes answerable, and the answer has to
  // keep matching the rule that asks every pool separately.
  for (const firstMinute of [120, 4800, 4860]) {
    const coverage: MetricCoverage[] = Array.from(
        { length: (watermark - firstMinute) / 60 + 1 },
        (_, index) => {
          const minuteStartSec = firstMinute + index * 60,
            complete = minuteStartSec < watermark;
          return {
            scopeId: 's',
            minuteStartSec,
            fromBlock: BigInt(Math.max(0, minuteStartSec - 60)),
            toBlock: BigInt(Math.max(0, minuteStartSec - 1)),
            complete,
            reasons: complete ? [] : ['watermark-partial'],
          };
        },
      ),
      summary = model.publish({
        scopeId: 's',
        registryScopeId: 's',
        configVersion: 'c',
        assetVersion: 'test',
        sourceHash: `coverage-${firstMinute}`,
        registryRevision: firstMinute,
        metadataRevision: null,
        cutoffSec: null,
        sourceChainTimeSec: watermark,
        selectedEndSec: watermark,
        availableFromSec: firstMinute,
        nowMs: 4900000,
        status: 'ok',
        message: null,
        health: unavailableHealth(),
        notes: [],
        coverage,
        stocks: [{ asset, valuations }],
      });
    rounds.push(summary);
    for (const name of WINDOWS) {
      const duration = ROLLING_DURATIONS[name];
      expect(summary.tokens[0]!.windows[name]).toEqual({
        current: aggregateWindow(
          valuations,
          coverage,
          watermark,
          watermark - duration,
          watermark,
          pools,
        ),
        previous: aggregateWindow(
          valuations,
          coverage,
          watermark,
          watermark - duration * 2,
          watermark - duration,
          pools,
        ),
      });
    }
  }
  // The height of the last pool denies every long window until the coverage reaches it.
  expect(rounds[0]!.tokens[0]!.windows['1h'].current.reasons).toContain('pool-lifetime-incomplete');
  expect(rounds[1]!.tokens[0]!.windows['1m'].current.reasons).toContain('pool-lifetime-incomplete');
  // Once every height is settled the birth can no longer be a reason.
  expect(rounds[2]!.tokens[0]!.windows['1m'].current.reasons).not.toContain(
    'pool-lifetime-incomplete',
  );
});

test('a stock without pools reports nothing registered, not a quiet zero', () => {
  const scenario = scaleScenario({ pools: 3, stocks: 4, active: 0 }),
    model = new DashboardReadModel();
  model.loadRegistry(scenario.registrations);
  const summary = model.publish(scenario.input);
  expect(summary.tokens.map((token) => token.poolCount)).toEqual([1, 1, 1, 0]);
  // Unknown amount is not the same as a known zero, and no pool is not the same as no trades.
  expect(summary.tokens[0]!.windows['1m'].current).toMatchObject({
    available: true,
    txCount: 0,
    swapCount: 0,
    usdMicros: '0',
  });
  expect(summary.tokens[3]!.windows['1m'].current).toMatchObject({
    available: false,
    txCount: null,
    reasons: ['no-registered-pools'],
  });
});

test('194 stocks over 80k pools publish a summary below one mebibyte', () => {
  const scenario = scaleScenario(),
    model = new DashboardReadModel(),
    work = openWorkCounts();
  try {
    const startedAtMs = Date.now();
    model.loadRegistry(scenario.registrations);
    const summary = model.publish(scenario.input);
    const elapsedMs = Date.now() - startedAtMs;
    expect(summary.tokens).toHaveLength(194);
    expect(summary.tokens.every((token) => token.poolCount > 0)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(summary), 'utf8')).toBeLessThan(1024 * 1024);
    expect(work.counts.readModelIndexBuilds).toBe(1);
    // 80k rows loaded once, and one view build per stock: no per-round catalogue walk.
    expect(work.counts.readModelRegistryScans).toBeLessThan(scenario.registrations.length * 3);
    expect(model.counts()).toEqual({ generations: 1, poolPages: 0, indexBuilds: 1 });
    expect(elapsedMs).toBeLessThan(60000);
  } finally {
    work.close();
  }
});

test('the registry must be loaded before anything is published or advanced', () => {
  const model = new DashboardReadModel();
  const opened = fixture();
  expect(() => model.publish(generationInput(opened))).toThrow(/loaded/);
  expect(() => model.applyRegistryDelta([])).toThrow(/loaded/);
  model.loadRegistry([]);
  expect(
    model.publish(generationInput(opened)).tokens.every((token) => token.poolCount === 0),
  ).toBe(true);
});
