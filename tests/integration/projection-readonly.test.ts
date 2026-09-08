import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/database.js';
import { runCli } from '../../src/cli.js';
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    const base = realpathSync(tmpdir());
    const real = realpathSync(dir);
    if (!real.startsWith(base + sep) || !real.split(sep).at(-1)!.startsWith('p2-ro-'))
      throw Error('cleanup boundary');
    rmSync(real, { recursive: true, force: true });
  }
});
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
