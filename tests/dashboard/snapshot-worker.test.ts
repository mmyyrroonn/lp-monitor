import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  blockAnchor,
  openDashboardFixture,
  poolAddress,
  type DashboardFixture,
} from '../helpers/dashboard-fixture.js';
import {
  DashboardWorkerHarness,
  appendBatch,
  snapshotWorkerInit,
} from '../helpers/dashboard-worker.js';
import {
  createSnapshotWorker,
  type SnapshotWorkerInit,
  type SnapshotWorkerPort,
  type SnapshotWorkerRequest,
  type SnapshotWorkerResponse,
} from '../../src/dashboard/snapshot-worker.js';
import { buildDashboardSnapshot, SNAPSHOT_NOTES } from '../../src/dashboard/snapshot.js';
import { encodeJson } from '../../src/domain/json.js';
import { emptyWorkCounts, openWorkCounts, type WorkCounts } from '../../src/ops/work-counters.js';
import { buildMetricsReport } from '../../src/storage/metric-store.js';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import { LiveProjectionStore } from '../../src/storage/live-projection.js';
import { metadataQueueFor } from '../../src/storage/metadata-queue.js';
import { applyMetadataLookup, enqueueTokenMetadata } from '../../src/storage/token-metadata.js';
import type { MetricMetadata } from '../../src/metrics/metadata.js';
import type { DashboardPool, DashboardSummary, WindowName } from '../../src/dashboard/types.js';

const WINDOWS: readonly WindowName[] = ['1m', '5m', '15m', '1h'];
const fixtures: DashboardFixture[] = [];
const opened: { close(): void }[] = [];
const harnesses: DashboardWorkerHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.terminate();
  for (const worker of opened.splice(0)) worker.close();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function fixture(options: Parameters<typeof openDashboardFixture>[0] = {}): DashboardFixture {
  const source = openDashboardFixture(options);
  fixtures.push(source);
  return source;
}

/** The port the worker answers on, on this thread, so the test can read what it sent. */
class TestPort implements SnapshotWorkerPort {
  readonly messages: SnapshotWorkerResponse[] = [];

  postMessage(value: unknown): void {
    this.messages.push(value as SnapshotWorkerResponse);
  }

  last<T extends SnapshotWorkerResponse['type']>(
    type: T,
  ): Extract<SnapshotWorkerResponse, { type: T }> {
    const found = [...this.messages].reverse().find((message) => message.type === type);
    if (found === undefined) throw new Error(`No ${type} response was posted`);
    return found as Extract<SnapshotWorkerResponse, { type: T }>;
  }

  count(type: SnapshotWorkerResponse['type']): number {
    return this.messages.filter((message) => message.type === type).length;
  }
}

type Running = {
  port: TestPort;
  worker: ReturnType<typeof createSnapshotWorker>;
  send(message: SnapshotWorkerRequest): void;
  summary(key?: string): DashboardSummary;
  /** The structural work of the round `send` last started, counted on this thread. */
  counts(): WorkCounts;
};

/** A worker of this thread over one database, with its own structural work counted. */
function running(
  source: DashboardFixture,
  dbPath = source.path,
  metadata: MetricMetadata = source.input.metadata,
): Running {
  const port = new TestPort(),
    worker = createSnapshotWorker(port);
  opened.push(worker);
  worker.handle({ type: 'init', init: { ...snapshotWorkerInit(source, dbPath), metadata } });
  port.last('ready');
  // Counting stops the moment the round does: every read a test makes afterwards is the test's own
  // oracle work and may not be mistaken for the worker's cost.
  let counted = emptyWorkCounts();
  return {
    port,
    worker,
    send(message) {
      const scope = openWorkCounts();
      worker.handle(message);
      scope.close();
      counted = scope.counts;
    },
    summary(key = 'live') {
      const found = [...port.messages]
        .reverse()
        .find((message) => message.type === 'summary' && message.key === key);
      if (found === undefined || found.type !== 'summary')
        throw new Error(`No summary was published for ${key}`);
      return found.summary;
    },
    counts() {
      return counted;
    },
  };
}

/** The comparator `src/dashboard/web/app.ts` sorts its pool cards with, kept character for character. */
function comparePools(window: WindowName) {
  return (left: DashboardPool, right: DashboardPool) => {
    const a = left.windows[window].txCount,
      b = right.windows[window].txCount;
    return a === null || b === null
      ? a === b
        ? left.poolId.localeCompare(right.poolId)
        : a === null
          ? 1
          : -1
      : b - a || left.poolId.localeCompare(right.poolId);
  };
}

/** Everything a summary claims about the data, against the legacy snapshot of the same rows. */
function expectSameAsLegacy(
  summary: DashboardSummary,
  legacy: ReturnType<typeof buildDashboardSnapshot>,
): void {
  expect(summary.status).toBe(legacy.status);
  expect(summary.message).toBe(legacy.message);
  expect(summary.notes).toEqual(legacy.notes);
  expect(summary.scopeId).toBe(legacy.scopeId);
  expect(summary.assetVersion).toBe(legacy.assetVersion);
  expect(summary.sourceChainTimeSec).toBe(legacy.sourceChainTimeSec);
  expect(summary.selectedEndSec).toBe(legacy.selectedEndSec);
  expect(summary.availableFromSec).toBe(legacy.availableFromSec);
  expect(summary.coverage).toEqual(legacy.coverage);
  expect(summary.tokens).toHaveLength(legacy.tokens.length);
  for (const [index, token] of legacy.tokens.entries()) {
    const held = summary.tokens[index]!;
    expect(held.address).toBe(token.address);
    expect(held.symbol).toBe(token.symbol);
    expect(held.windows).toEqual(token.windows);
    // The catalogue's own count, not the bounded round's: `poolIds` is what the full read reports.
    expect(held.poolCount).toBe(token.poolIds.length);
    for (const name of WINDOWS)
      expect(held.activePoolCount[name]).toBe(
        token.pools.filter(
          (pool) => pool.windows[name].available && (pool.windows[name].txCount ?? 0) > 0,
        ).length,
      );
  }
}

function liveEventRows(source: DashboardFixture, where = '1=1'): number {
  // Every log in this fixture states a minute, so the unknown-minute half of the window rule has
  // nothing to keep. The test says so out loud instead of assuming it silently.
  expect(
    source.readonly
      .prepare(
        'select count(*) as n from live_events where scope_id=? and minute_start_sec is null',
      )
      .get(source.input.scopeId),
  ).toEqual({ n: 0 });
  return (
    source.readonly
      .prepare(`select count(*) as n from live_events where scope_id=? and ${where}`)
      .get(source.input.scopeId) as { n: number }
  ).n;
}

/** The pools a bounded read still holds an event for, derived from the rows rather than the index. */
function windowPools(source: DashboardFixture, sinceSec: number): string[] {
  return (
    source.readonly
      .prepare(
        `select distinct pool_id from live_events
           where scope_id=? and pool_id is not null and minute_start_sec >= ? order by pool_id`,
      )
      .all(source.input.scopeId, sinceSec) as { pool_id: string }[]
  ).map((row) => row.pool_id);
}

/** The selection is part of the report's own identity, so the hash names the pools it evaluated. */
function hashForSelection(
  source: DashboardFixture,
  report: ReturnType<typeof buildMetricsReport>,
  selection: readonly string[],
): string {
  return createHash('sha256')
    .update(
      encodeJson({
        version: report.version,
        projectionSourceHash: report.projectionSourceHash,
        usdg: source.input.usdg,
        assets: source.input.assets.assets,
        coverage: report.coverage,
        metadata: report.metadata,
        metadataConflicts: report.metadataConflicts,
        selection: [...selection].sort(),
      }),
    )
    .digest('hex');
}

test('a worker round answers the legacy snapshot and reads the catalogue once', () => {
  const source = fixture(),
    run = running(source);
  run.send({ type: 'refresh', key: 'live' });
  const summary = run.summary(),
    legacy = buildDashboardSnapshot(source.readonly, source.input);
  expectSameAsLegacy(summary, legacy);
  expect(summary.apiVersion).toBe(2);
  expect(summary.generation).toMatch(/^[0-9a-f]{32}$/);
  // The watermark is the first second of a minute that is still running, so the live generation's
  // windows end on the last whole minute instead of on the watermark itself.
  expect(summary.sourceChainTimeSec).toBe(4860);
  expect(summary.selectedEndSec).toBe(4859);
  // The one catalogue read happened, and it happened inside the first round.
  expect(run.counts().registryRowsRead).toBeGreaterThan(0);
  run.send({ type: 'refresh', key: 'live' });
  expect(run.port.last('unchanged').key).toBe('live');
  // Nothing moved, so the round reads nothing at all: not one catalogue row, not one event row.
  expect(run.counts()).toEqual(emptyWorkCounts());
});

test('a round after a write values the new swap and re-decodes no history', () => {
  const source = fixture(),
    run = running(source);
  run.send({ type: 'refresh', key: 'live' });
  const before = run.summary();
  expect(run.counts().valuationComputes).toBeGreaterThan(1);
  appendBatch(source, {
    events: [{ pool: 1, block: 4860, tx: 201, usdgUnits: 5000 }],
    toBlock: 4900,
    boundaryFromSec: 4920,
    boundaryToSec: 4920,
  });
  run.send({ type: 'refresh', key: 'live' });
  const after = run.summary(),
    counts = run.counts();
  expect(run.port.count('unchanged')).toBe(0);
  expect(after.generation).not.toBe(before.generation);
  // The window grew by exactly one swap, and that swap is the only thing valued again.
  expect(counts.valuationComputes).toBe(1);
  // The round re-derived its window from the rows, but only the window's rows — never the history.
  expect(counts.liveEventRowsRead).toBe(liveEventRows(source));
  expectSameAsLegacy(after, buildDashboardSnapshot(source.readonly, source.input));
});

test('a round that moves only the watermark republishes and re-reads no history', () => {
  const source = fixture();
  // The same shape the window test uses: a range whose chain time leaves the fixture's earliest
  // logs below the horizon, so the round's own event read is a strict subset of the scope's rows
  // and "read the window" cannot be mistaken for "read everything".
  appendBatch(source, {
    events: [
      { pool: 1, block: 11000, tx: 301, usdgUnits: 1000 },
      { pool: 9, block: 11010, tx: 302, usdgUnits: 2000 },
      { pool: 9, block: 11020, tx: 303, usdgUnits: 3000 },
      { pool: 10, block: 11030, tx: 304, usdgUnits: 4000 },
    ],
    toBlock: 11040,
    boundaryFromSec: 120,
    boundaryToSec: 11040,
  });
  const run = running(source);
  run.send({ type: 'refresh', key: 'live' });
  const before = run.summary();
  // A batch that accepts a range and adds no swap at all: the chain moved, the data did not. A
  // reader that watched only the rows would answer `unchanged` here, and the page would keep saying
  // the chain had not been heard from since the previous watermark.
  appendBatch(source, { events: [], toBlock: 11100, boundaryFromSec: 11160, boundaryToSec: 11160 });
  run.send({ type: 'refresh', key: 'live' });
  const after = run.summary(),
    counts = run.counts(),
    legacy = buildDashboardSnapshot(source.readonly, source.input),
    sinceSec = Math.floor(legacy.sourceChainTimeSec! / 60) * 60 - 180 * 60;
  expect(run.port.count('unchanged')).toBe(0);
  expect(after.generation).not.toBe(before.generation);
  expect(after.sourceChainTimeSec!).toBeGreaterThan(before.sourceChainTimeSec!);
  expectSameAsLegacy(after, legacy);
  // The round republished without valuing anything again: no event in its window is new or revised.
  expect(counts.valuationComputes).toBe(0);
  // And it paid for its own window's rows, not for the scope's whole history.
  expect(counts.liveEventRowsRead).toBe(
    liveEventRows(source, `minute_start_sec >= ${sinceSec - 120}`),
  );
  expect(counts.liveEventRowsRead).toBeLessThan(liveEventRows(source));
});

test('a reader values with the metadata revision it was built with', () => {
  const source = fixture(),
    // The operator's cache, reloaded: a new revision, and one observation revised with it. The
    // config file the CLI reads is the only way a reader is told which decimals to value with.
    revised: MetricMetadata = {
      ...source.input.metadata,
      version: 'test-2',
      entries: source.input.metadata.entries.map((entry) =>
        entry.address === source.input.usdg ? { ...entry, decimals: 8 } : entry,
      ),
    },
    run = running(source),
    revisedRun = running(source, source.path, revised);
  run.send({ type: 'refresh', key: 'live' });
  revisedRun.send({ type: 'refresh', key: 'live' });
  const plain = run.summary(),
    revisedSummary = revisedRun.summary(),
    plainLegacy = buildDashboardSnapshot(source.readonly, source.input),
    revisedLegacy = buildDashboardSnapshot(source.readonly, {
      ...source.input,
      metadata: revised,
    });
  expectSameAsLegacy(plain, plainLegacy);
  expectSameAsLegacy(revisedSummary, revisedLegacy);
  // The revision reached the page, and it is the one this reader was handed: the USDG side of every
  // swap is read at its decimals, which is a hundredfold difference in the number the page shows.
  const plainUsd = plain.tokens[0]!.windows['1m'].current.usdMicros,
    revisedUsd = revisedSummary.tokens[0]!.windows['1m'].current.usdMicros;
  expect(revisedUsd).toBe(revisedLegacy.tokens[0]!.windows['1m'].current.usdMicros);
  expect(plainUsd).toBe(plainLegacy.tokens[0]!.windows['1m'].current.usdMicros);
  expect(revisedUsd).not.toBe(plainUsd);
  // Two readers over the same rows are two different reports, and each says which one it is.
  expect(revisedSummary.sourceHash).not.toBe(plain.sourceHash);
  // A reader cannot be re-initialized onto another revision, so the metadata revision it holds —
  // and therefore the one its change detection can see — is fixed for its whole life.
  revisedRun.worker.handle({ type: 'init', init: snapshotWorkerInit(source) });
  expect(revisedRun.port.last('failed')).toEqual({
    type: 'failed',
    code: 'SNAPSHOT_BAD_REQUEST',
  });
});

test('a metadata revision under a still watermark is published, not deduplicated', () => {
  const source = fixture(),
    run = running(source);
  run.send({ type: 'refresh', key: 'live' });
  const before = run.summary(),
    legacyBefore = buildDashboardSnapshot(source.readonly, source.input);
  // The live pipeline's own write for one leased demand: enqueued, leased, answered. Nothing about
  // the chain moves — no block, no log, no cursor, no registry row — only what a USD figure is
  // read with, and the merged metadata is an input to every round's valuation.
  const now = Date.now(),
    enqueued = enqueueTokenMetadata(
      source.db,
      [{ address: source.input.usdg, blockNumber: 0n, priority: 0 }],
      { nowMs: now },
    ),
    lease = metadataQueueFor(source.db).lease('live', now, 'test');
  expect(enqueued).toBe(1);
  expect(
    applyMetadataLookup(
      source.db,
      'live',
      { lease: lease!, anchor: blockAnchor(0), decimals: 8, failure: null },
      now,
    ),
  ).toBe('resolved');
  const legacyAfter = buildDashboardSnapshot(source.readonly, source.input),
    // A bounded round's identity is the full read's hash with its own selection folded in, so the
    // oracle for it is the same one the window test uses rather than the unselected legacy hash.
    report = buildMetricsReport(source.readonly, source.input, {
      live: { historyMinutes: 180 },
      includeAssetValuations: true,
    }),
    sinceSec = Math.floor(report.at.timestampSec / 60) * 60 - 180 * 60,
    selected = windowPools(source, sinceSec - 120);
  // The reading really did move the number the page shows, so the round below has something to
  // publish: the USDG side of every swap is read at its decimals.
  expect(legacyAfter.tokens[0]!.windows['1m'].current.usdMicros).not.toBe(
    legacyBefore.tokens[0]!.windows['1m'].current.usdMicros,
  );
  run.send({ type: 'refresh', key: 'live' });
  const after = run.summary();
  expect(run.port.count('unchanged')).toBe(0);
  expect(after.generation).not.toBe(before.generation);
  expect(run.counts().valuationComputes).toBeGreaterThan(0);
  expect(after.sourceHash).toBe(hashForSelection(source, report, selected));
  expect(after.sourceHash).not.toBe(before.sourceHash);
  expectSameAsLegacy(after, legacyAfter);
});

test('a database without the source revisions cannot publish, and fails as the legacy read does', () => {
  const source = fixture(),
    oldPath = join(dirname(source.path), 'no-source-revisions.sqlite');
  source.db.exec(`vacuum into '${oldPath.replace(/'/g, "''")}'`);
  const old = openDatabase(oldPath);
  old.exec('drop table live_source_revisions');
  old.close();
  const legacy = openDatabase(oldPath, { readonly: true });
  opened.push(legacy);
  const run = running(source, oldPath);
  // The window read prepares against that table, so a file without it has no window and therefore no
  // generation: the round is reported as a failure rather than answered with an invented summary.
  // This is what makes the missing-table branch unreachable for any round that publishes — the file
  // fails here, at the one read every round takes, instead of quietly reporting a stale projection.
  run.send({ type: 'refresh', key: 'live' });
  expect(run.port.last('failed')).toEqual({ type: 'failed', code: 'SNAPSHOT_ERROR' });
  expect(run.port.count('summary')).toBe(0);
  expect(JSON.stringify(run.port.messages)).not.toContain(dirname(source.path));
  // The round threw inside its own read transaction; the reader survives it and answers again.
  run.send({ type: 'refresh', key: 'live' });
  expect(run.port.last('failed')).toEqual({ type: 'failed', code: 'SNAPSHOT_ERROR' });
  // And the legacy read of the same rows fails the same way, so this is the file's own state rather
  // than something this reader introduced.
  expect(() => buildDashboardSnapshot(legacy, source.input)).toThrow(
    /no such table: live_source_revisions/,
  );
});

test('a database without the durable metadata journal still publishes and still deduplicates', () => {
  const source = fixture(),
    oldPath = join(dirname(source.path), 'no-metadata-journal.sqlite');
  source.db.exec(`vacuum into '${oldPath.replace(/'/g, "''")}'`);
  const old = openDatabase(oldPath);
  // The schema before the metadata queue: durable observations exist, the revision that journals
  // them does not. A revision read here is always 0, so the token keeps the seed version it was
  // built with instead of pinning itself to a counter this file can never move.
  old.exec('drop table metadata_revision');
  old.exec('drop table metadata_address_changes');
  old.close();
  const run = running(source, oldPath),
    legacy = openDatabase(oldPath, { readonly: true });
  opened.push(legacy);
  run.send({ type: 'refresh', key: 'live' });
  expectSameAsLegacy(run.summary(), buildDashboardSnapshot(legacy, source.input));
  // The fallback costs the reader nothing: a round with nothing new still answers `unchanged`.
  run.send({ type: 'refresh', key: 'live' });
  expect(run.port.last('unchanged').key).toBe('live');
  expect(run.port.count('failed')).toBe(0);
});

test('a generation published before a delta keeps its own answers', () => {
  const source = fixture(),
    run = running(source);
  run.send({ type: 'refresh', key: 'live' });
  const before = run.summary(),
    address = source.input.assets.assets[0]!.address;
  appendBatch(source, {
    events: [{ pool: 13, block: 4860, tx: 201, usdgUnits: 5000 }],
    discovered: [
      { index: 13, token0: source.input.assets.assets[0]!.address, token1: source.input.usdg },
    ],
    toBlock: 4900,
    boundaryFromSec: 4920,
    boundaryToSec: 4920,
  });
  run.send({ type: 'refresh', key: 'live' });
  const after = run.summary(),
    legacy = buildDashboardSnapshot(source.readonly, source.input);
  expect(after.generation).not.toBe(before.generation);
  expect(after.tokens[0]!.poolCount).toBe(before.tokens[0]!.poolCount + 1);
  // The generation already handed out still answers with the catalogue it was published against.
  run.send({
    type: 'poolPage',
    id: 1,
    generation: before.generation!,
    address,
    window: '5m',
    offset: 0,
    limit: 100,
  });
  expect(run.port.last('page').page.total).toBe(before.tokens[0]!.poolCount);
  run.send({
    type: 'poolPage',
    id: 2,
    generation: after.generation!,
    address,
    window: '5m',
    offset: 0,
    limit: 100,
  });
  expect(run.port.last('page').page.total).toBe(legacy.tokens[0]!.poolIds.length);
  expectSameAsLegacy(after, legacy);
});

test('a window that has moved on selects the pools it still holds, not the catalogue', () => {
  const source = fixture();
  // One range whose chain time puts every discovery log below the horizon, so the round's own pool
  // set is a strict subset of the catalogue and the two cannot be mistaken for each other.
  appendBatch(source, {
    events: [
      { pool: 1, block: 11000, tx: 301, usdgUnits: 1000 },
      { pool: 9, block: 11010, tx: 302, usdgUnits: 2000 },
      { pool: 9, block: 11020, tx: 303, usdgUnits: 3000 },
      { pool: 10, block: 11030, tx: 304, usdgUnits: 4000 },
    ],
    toBlock: 11040,
    boundaryFromSec: 120,
    boundaryToSec: 11040,
  });
  const run = running(source);
  run.send({ type: 'refresh', key: 'live' });
  const summary = run.summary(),
    legacy = buildDashboardSnapshot(source.readonly, source.input),
    report = buildMetricsReport(source.readonly, source.input, {
      live: { historyMinutes: 180 },
      includeAssetValuations: true,
    }),
    sinceSec = Math.floor(report.at.timestampSec / 60) * 60 - 180 * 60,
    selected = windowPools(source, sinceSec - 120),
    catalogue = (
      source.readonly
        .prepare('select count(*) as n from pools where scope_id=?')
        .get(source.input.scopeId) as { n: number }
    ).n;
  expectSameAsLegacy(summary, legacy);
  // The catalogue is still the whole catalogue: every registered pool is counted for its stock.
  expect(legacy.tokens[0]!.poolIds.length).toBe(5);
  expect(summary.tokens[0]!.poolCount).toBe(5);
  // While the round itself evaluated only the window's pools, and said so in its own identity.
  expect(selected.length).toBeGreaterThan(0);
  expect(selected.length).toBeLessThan(catalogue);
  expect(run.counts().evaluatedPools).toBe(selected.length);
  expect(run.counts().liveEventRowsRead).toBe(
    liveEventRows(source, `minute_start_sec >= ${sinceSec - 120}`),
  );
  expect(summary.sourceHash).toBe(hashForSelection(source, report, selected));
  expect(summary.sourceHash).not.toBe(legacy.sourceHash);
});

test('the published summary carries the shared notes and the round it was asked for', () => {
  const source = fixture(),
    run = running(source);
  run.send({ type: 'refresh', key: 'live' });
  const live = run.summary();
  for (const note of SNAPSHOT_NOTES) expect(live.notes).toContain(note);
  // A bounded round's own footnotes may not reach a summary that reports the whole catalogue.
  expect(live.notes.some((note) => note.startsWith('Selected-pool report:'))).toBe(false);
  // A historical cutoff is its own generation, and the live one never answers for it.
  run.send({ type: 'refresh', key: '4679', at: 4679 });
  const historical = run.summary('4679');
  expect(historical.generation).not.toBe(live.generation);
  expect(historical.selectedEndSec).toBe(4679);
  expectSameAsLegacy(
    historical,
    buildDashboardSnapshot(source.readonly, source.input, { at: 4679 }),
  );
});

test('a page and a history answer from the generation they name, and an unknown one expires', () => {
  const source = fixture(),
    run = running(source);
  run.send({ type: 'refresh', key: 'live' });
  const summary = run.summary(),
    legacy = buildDashboardSnapshot(source.readonly, source.input),
    address = legacy.tokens[0]!.address;
  run.send({
    type: 'poolPage',
    id: 7,
    generation: summary.generation!,
    address,
    window: '5m',
    offset: 0,
    limit: 3,
  });
  expect(run.port.last('page').page.items).toEqual(
    [...legacy.tokens[0]!.pools].sort(comparePools('5m')).slice(0, 3),
  );
  run.send({ type: 'tokenHistory', id: 8, generation: summary.generation!, address });
  expect(run.port.last('history').history.minutes).toEqual(legacy.tokens[0]!.minutes);
  run.send({
    type: 'poolPage',
    id: 9,
    generation: 'f'.repeat(32),
    address,
    window: '5m',
    offset: 0,
    limit: 3,
  });
  expect(run.port.last('expired').id).toBe(9);
  run.send({
    type: 'poolPage',
    id: 10,
    generation: summary.generation!,
    address: 'not-an-address',
    window: '5m',
    offset: 0,
    limit: 3,
  });
  expect(run.port.last('failed')).toEqual({ type: 'failed', id: 10, code: 'SNAPSHOT_BAD_REQUEST' });
});

test('an old database without the journal is read and followed, never migrated', () => {
  const source = fixture(),
    oldPath = join(dirname(source.path), 'no-journal.sqlite');
  source.db.exec(`vacuum into '${oldPath.replace(/'/g, "''")}'`);
  const old = openDatabase(oldPath);
  old.exec('drop table registry_changes');
  old.close();
  const run = running(source, oldPath);
  run.send({ type: 'refresh', key: 'live' });
  const legacy = buildDashboardSnapshot(source.readonly, source.input);
  expectSameAsLegacy(run.summary(), legacy);
  // A catalogue read per round is the price of a file that cannot name what moved — never a write.
  const writer = openDatabase(oldPath);
  try {
    appendBatch(
      { ...source, db: writer },
      {
        events: [{ pool: 13, block: 4860, tx: 201, usdgUnits: 5000 }],
        discovered: [
          { index: 13, token0: source.input.assets.assets[0]!.address, token1: source.input.usdg },
        ],
        toBlock: 4900,
        boundaryFromSec: 4920,
        boundaryToSec: 4920,
      },
    );
  } finally {
    writer.close();
  }
  run.send({ type: 'refresh', key: 'live' });
  expect(run.counts().registryRowsRead).toBeGreaterThan(0);
  expect(run.summary().tokens[0]!.poolCount).toBe(legacy.tokens[0]!.poolIds.length + 1);
  expect(run.port.count('failed')).toBe(0);
});

test('a missing file is named without leaking a path, and the worker stays usable', () => {
  const source = fixture(),
    port = new TestPort(),
    worker = createSnapshotWorker(port);
  opened.push(worker);
  worker.handle({ type: 'init', init: snapshotWorkerInit(source, `${source.path}.absent`) });
  expect(port.last('failed')).toEqual({ type: 'failed', code: 'SNAPSHOT_NO_DATABASE' });
  expect(JSON.stringify(port.messages)).not.toContain(dirname(source.path));
  worker.handle({ type: 'refresh', key: 'live' });
  expect(port.last('failed')).toEqual({ type: 'failed', code: 'SNAPSHOT_UNAVAILABLE' });
});

test('a real worker thread runs the shipped module and answers a refresh', async () => {
  const source = fixture(),
    harness = new DashboardWorkerHarness();
  harnesses.push(harness);
  await harness.start(snapshotWorkerInit(source));
  harness.send({ type: 'refresh', key: 'live' });
  const response = await harness.next(
    (value) => value.type === 'summary' || value.type === 'failed',
  );
  expect(response.type).toBe('summary');
  expectSameAsLegacy(
    (response as Extract<SnapshotWorkerResponse, { type: 'summary' }>).summary,
    buildDashboardSnapshot(source.readonly, source.input),
  );
  await harness.terminate();
  expect(harness.exits.length).toBeGreaterThan(0);
});

test('removing one scope registration retains the pool until its last registration is removed', () => {
  const source = fixture();
  source.input.registryScopeId = 'registry';
  source.db.exec(`insert into pools
    select 'registry',pool_key,protocol,discovered_raw_log_id,discovered_block_number,
           discovered_block_hash,payload_json from pools where scope_id='s'`);
  // Establish the fixture's initial projection for this scope pair before starting the reader.
  source.db.prepare('delete from live_projection_cursors where scope_id=?').run('s');
  new LiveProjectionStore(source.db).sync('s', 'registry', 'c');
  const run = running(source);
  run.send({ type: 'refresh', key: 'live' });
  const before = run.summary();
  expect(before.tokens[0]!.poolCount).toBe(5);
  const key = source.db
    .prepare(
      `select pool_key from pools where scope_id='s'
    and json_extract(payload_json,'$.pool.address')=?`,
    )
    .pluck()
    .get(poolAddress(1));
  source.db.prepare('delete from pools where scope_id=? and pool_key=?').run('registry', key);
  new LiveProjectionStore(source.db).sync('s', 'registry', 'c');
  run.send({ type: 'refresh', key: 'live' });
  expect(run.port.count('failed')).toBe(0);
  expect(run.summary().tokens[0]!.poolCount).toBe(5);
  expectSameAsLegacy(run.summary(), buildDashboardSnapshot(source.readonly, source.input));
  const retained = run.summary();
  source.db.prepare('delete from pools where scope_id=? and pool_key=?').run('s', key);
  new LiveProjectionStore(source.db).sync('s', 'registry', 'c');
  run.send({ type: 'refresh', key: 'live' });
  expect(run.summary().tokens[0]!.poolCount).toBe(4);
  // The retained generation before the final deletion still owns the pool.
  run.send({
    type: 'poolPage',
    id: 71,
    generation: retained.generation!,
    address: before.tokens[0]!.address,
    window: '5m',
    offset: 0,
    limit: 100,
  });
  expect(run.port.last('page').page.total).toBe(5);
});

test('removing an older discovery row retains a rediscovered pool in the same scope', () => {
  const source = fixture(),
    run = running(source);
  run.send({ type: 'refresh', key: 'live' });
  const original = source.db
    .prepare(
      `select pool_key,discovered_raw_log_id from pools
    where scope_id='s' and json_extract(payload_json,'$.pool.address')=?`,
    )
    .get(poolAddress(1)) as { pool_key: string; discovered_raw_log_id: number };
  appendBatch(source, {
    events: [{ pool: 1, block: 4860, tx: 921, usdgUnits: 1000 }],
    discovered: [
      { index: 1, token0: source.input.assets.assets[0]!.address, token1: source.input.usdg },
    ],
    toBlock: 4900,
    boundaryFromSec: 4920,
    boundaryToSec: 4920,
  });
  run.send({ type: 'refresh', key: 'live' });
  expect(
    source.db
      .prepare('select count(*) from pools where scope_id=? and pool_key=?')
      .pluck()
      .get('s', original.pool_key),
  ).toBe(2);
  source.db
    .prepare('delete from pools where scope_id=? and pool_key=? and discovered_raw_log_id=?')
    .run('s', original.pool_key, original.discovered_raw_log_id);
  new LiveProjectionStore(source.db).sync('s', 's', 'c');
  run.send({ type: 'refresh', key: 'live' });
  expect(run.port.count('failed')).toBe(0);
  expect(run.summary().tokens[0]!.poolCount).toBe(5);
  expectSameAsLegacy(run.summary(), buildDashboardSnapshot(source.readonly, source.input));
});

test('a writer between startup catalogue reads and journal capture is consumed on refresh', () => {
  const source = fixture();
  const original = SqliteRangeStore.prototype.pools;
  let calls = 0;
  // A different WAL connection commits after the reader obtained its catalogue rows. With a
  // consistent startup read snapshot its journal cursor must still precede this deletion.
  const spy = vi.spyOn(SqliteRangeStore.prototype, 'pools').mockImplementation(function (
    this: SqliteRangeStore,
    scopeId,
  ) {
    const rows = original.call(this, scopeId);
    if (++calls === 2)
      source.db
        .prepare(
          `delete from pools where scope_id='s'
      and json_extract(payload_json,'$.pool.address')=?`,
        )
        .run(poolAddress(1));
    return rows;
  });
  let run: Running;
  try {
    run = running(source);
  } finally {
    spy.mockRestore();
  }
  new LiveProjectionStore(source.db).sync('s', 's', 'c');
  run.send({ type: 'refresh', key: 'live' });
  expect(run.port.count('failed')).toBe(0);
  expect(run.summary().tokens[0]!.poolCount).toBe(4);
  expectSameAsLegacy(run.summary(), buildDashboardSnapshot(source.readonly, source.input));
  run.send({ type: 'refresh', key: 'live' });
  expect(run.port.last('unchanged').key).toBe('live');
});
