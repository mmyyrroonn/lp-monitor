import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { runCli } from '../../src/cli.js';
import { openDashboardFixture, type DashboardFixture } from '../helpers/dashboard-fixture.js';
import {
  DashboardWorkerHarness,
  appendBatch,
  snapshotWorkerInit,
} from '../helpers/dashboard-worker.js';
import type { SnapshotWorkerResponse } from '../../src/dashboard/snapshot-worker.js';
const dirs: string[] = [];
const fixtures: DashboardFixture[] = [];
const harnesses: DashboardWorkerHarness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) await harness.terminate();
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) {
    const base = realpathSync(tmpdir());
    const real = realpathSync(dir);
    if (!real.startsWith(base + sep) || !real.split(sep).at(-1)!.startsWith('p2-ro-'))
      throw Error('cleanup boundary');
    rmSync(real, { recursive: true, force: true });
  }
});

function projectedFixture(): DashboardFixture {
  const fixture = openDashboardFixture();
  fixtures.push(fixture);
  return fixture;
}

function worker(): DashboardWorkerHarness {
  const harness = new DashboardWorkerHarness();
  harnesses.push(harness);
  return harness;
}

/** The persisted facts a reader is allowed to leave exactly as it found them. */
const BUSINESS_TABLES = [
  'raw_logs',
  'active_logs',
  'log_times',
  'pools',
  'accepted_ranges',
  'minute_boundaries',
  'registry_changes',
  'live_events',
  'live_observations',
  'live_quality_errors',
  'live_projection_cursors',
  'live_source_revisions',
  'metric_windows',
] as const;

/**
 * What one connection can see of the database's identity and contents. `total_changes` and
 * `data_version` are that connection's own view, so a single handle read before and after says
 * whether anybody else committed in between — including this reader's own worker.
 */
function databaseIdentity(db: Database.Database) {
  const count = (table: string) =>
    (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
  return {
    schemaVersion: db.pragma('schema_version', { simple: true }),
    totalChanges: db.pragma('total_changes', { simple: true }),
    dataVersion: db.pragma('data_version', { simple: true }),
    rows: Object.fromEntries(BUSINESS_TABLES.map((table) => [table, count(table)])),
  };
}

/** The next answer to a refresh, whatever it is, so a test can speak about either outcome. */
async function refreshed(
  harness: DashboardWorkerHarness,
  key = 'live',
): Promise<Extract<SnapshotWorkerResponse, { type: 'summary' | 'failed' | 'unchanged' }>> {
  return (await harness.next(
    (value) =>
      (value.type === 'summary' && value.key === key) ||
      (value.type === 'unchanged' && value.key === key) ||
      value.type === 'failed',
  )) as Extract<SnapshotWorkerResponse, { type: 'summary' | 'failed' | 'unchanged' }>;
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'p2-ro-'));
  dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const db = openDatabase(path);
  return { dir, path, db };
}
test('readonly database connection rejects writes and inspect does not wait for writer lock', async () => {
  const { path, db } = setup();
  db.exec('BEGIN IMMEDIATE');
  try {
    const reader = openDatabase(path, { readonly: true });
    try {
      expect(reader.readonly).toBe(true);
      expect(() => reader.exec('create table forbidden(x)')).toThrow(/readonly/i);
    } finally {
      reader.close();
    }
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(
      await runCli(['inspect-pool', '--db', path, '--pool', 'amc-usdg-v3'], { environment: {} }),
    ).toBe(4);
    expect(JSON.parse(output.mock.calls.at(-1)![0] as string).status).toBe(
      'projection-stale-or-missing',
    );
  } finally {
    db.exec('ROLLBACK');
    db.close();
  }
}, 15000);
test('stable readonly DELETE-journal snapshot creates no sidecars and preserves bytes', async () => {
  const { dir, path, db } = setup();
  db.pragma('journal_mode=DELETE');
  db.close();
  const before = readFileSync(path);
  chmodSync(path, 0o444);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(
      await runCli(['inspect-pool', '--db', path, '--pool', 'amc-usdg-v3'], { environment: {} }),
    ).toBe(4);
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dir)).toEqual(['db.sqlite']);
  } finally {
    chmodSync(path, 0o666);
  }
});
test('readonly old schema returns configuration error without migrating it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2-ro-'));
  dirs.push(dir);
  const path = join(dir, 'old.sqlite');
  const old = new Database(path);
  old.exec('create table unrelated(x)');
  old.close();
  const before = readFileSync(path);
  await expect(
    runCli(['inspect-pool', '--db', path, '--pool', 'amc-usdg-v3'], { environment: {} }),
  ).rejects.toThrow(/schema|project|migration/i);
  expect(readFileSync(path)).toEqual(before);
  const check = new Database(path, { readonly: true });
  try {
    expect(check.prepare("select name from sqlite_master where type='table'").all()).toEqual([
      { name: 'unrelated' },
    ]);
  } finally {
    check.close();
  }
});
test('empty accepted scope produces actionable incomplete output instead of internal error', async () => {
  const { path, db } = setup();
  db.close();
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runCli(['project', '--db', path, '--rebuild'], { environment: {} })).toBe(4);
  expect(JSON.parse(output.mock.calls.at(-1)![0] as string)).toMatchObject({
    status: 'no-accepted-scope',
    next: expect.stringContaining('ingest/follow'),
  });
});
test('project requires explicit rebuild, and database must be a nonblank file path', async () => {
  const { dir, path, db } = setup();
  db.close();
  await expect(runCli(['project', '--db', path], { environment: {} })).rejects.toThrow(/rebuild/);
  for (const invalid of ['', '   ', dir]) {
    await expect(
      runCli(['project', '--db', invalid, '--rebuild'], { environment: {} }),
    ).rejects.toThrow(/database/i);
  }
});

test('readonly schema validation preserves transient SQLite lock errors', () => {
  const { path, db } = setup();
  db.pragma('journal_mode=DELETE');
  db.exec('BEGIN EXCLUSIVE');
  try {
    expect(() => openDatabase(path, { readonly: true })).toThrow(
      expect.objectContaining({ code: 'SQLITE_BUSY' }),
    );
  } finally {
    db.exec('ROLLBACK');
    db.close();
  }
}, 15000);

test('the dashboard worker reads a projected database without changing it', async () => {
  const fixture = projectedFixture(),
    // One handle read before and after: its own change counters say whether anyone wrote at all.
    watch = openDatabase(fixture.path, { readonly: true });
  try {
    const before = databaseIdentity(watch),
      harness = worker();
    await harness.start(snapshotWorkerInit(fixture));
    harness.send({ type: 'refresh', key: 'live' });
    const published = await refreshed(harness);
    expect(published.type).toBe('summary');
    const generation = published.type === 'summary' ? published.summary.generation! : '';
    const address = fixture.input.assets.assets[0]!.address;
    harness.send({
      type: 'poolPage',
      id: 1,
      generation,
      address,
      window: '5m',
      offset: 0,
      limit: 20,
    });
    expect((await harness.next((value) => value.type === 'page')).type).toBe('page');
    harness.send({ type: 'tokenHistory', id: 2, generation, address });
    expect((await harness.next((value) => value.type === 'history')).type).toBe('history');
    await harness.terminate();
    expect(databaseIdentity(watch)).toEqual(before);
  } finally {
    watch.close();
  }
});

test('a write committed while the reader is live moves the generation and leaves the old page alone', async () => {
  const fixture = projectedFixture(),
    harness = worker(),
    address = fixture.input.assets.assets[0]!.address;
  await harness.start(snapshotWorkerInit(fixture));
  harness.send({ type: 'refresh', key: 'live' });
  const first = await refreshed(harness);
  expect(first.type).toBe('summary');
  const generation = first.type === 'summary' ? first.summary.generation! : '';
  harness.send({
    type: 'poolPage',
    id: 1,
    generation,
    address,
    window: '5m',
    offset: 0,
    limit: 100,
  });
  const served = (await harness.next((value) => value.type === 'page')) as Extract<
    SnapshotWorkerResponse,
    { type: 'page' }
  >;

  // The writer commits a whole range, projection included, while the reader is running.
  appendBatch(fixture, {
    events: [{ pool: 13, block: 4860, tx: 201, usdgUnits: 5000 }],
    discovered: [{ index: 13, token0: address, token1: fixture.input.usdg }],
    toBlock: 4900,
    boundaryFromSec: 4920,
    boundaryToSec: 4920,
  });

  harness.send({ type: 'refresh', key: 'live' });
  const second = await refreshed(harness);
  expect(second.type).toBe('summary');
  expect(second.type === 'summary' && second.summary.generation).not.toBe(generation);
  // The generation already served is answered from the catalogue it was published against.
  harness.send({
    type: 'poolPage',
    id: 2,
    generation,
    address,
    window: '5m',
    offset: 0,
    limit: 100,
  });
  const again = (await harness.next((value) => value.type === 'page')) as Extract<
    SnapshotWorkerResponse,
    { type: 'page' }
  >;
  expect(again.page).toEqual(served.page);
  // While the newer one has moved on, so the page really did change underneath.
  const moved = second.type === 'summary' ? second.summary.generation! : '';
  harness.send({
    type: 'poolPage',
    id: 3,
    generation: moved,
    address,
    window: '5m',
    offset: 0,
    limit: 100,
  });
  const current = (await harness.next(
    (value) => value.type === 'page' && value.id === 3,
  )) as Extract<SnapshotWorkerResponse, { type: 'page' }>;
  expect(current.page.total).toBe(served.page.total + 1);
  await harness.terminate();
});
