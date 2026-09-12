import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { openDatabase } from '../../src/storage/database.js';
import { runCli } from '../../src/cli.js';
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    const base = realpathSync(tmpdir()),
      target = realpathSync(dir);
    if (!target.startsWith(base + sep) || !target.split(sep).at(-1)!.startsWith('p3-cli-'))
      throw new Error('cleanup boundary');
    rmSync(target, { recursive: true });
  }
});
test('metrics and rank are offline and reject stale/missing P2 projections with exit 4', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p3-cli-'));
  dirs.push(dir);
  const path = join(dir, 'test.sqlite');
  const db = openDatabase(path);
  db.pragma('journal_mode=DELETE');
  db.close();
  const bytes = readFileSync(path),
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const readerFactory = vi.fn(() => {
    throw new Error('No RPC allowed');
  });
  expect(
    await runCli(['metrics', '--db', path, '--rwa', 'AMC', '--window', '5m'], {
      environment: {},
      readerFactory,
    }),
  ).toBe(4);
  expect(
    await runCli(['rank', '--db', path, '--sort', 'volume5mClosed'], {
      environment: {},
      readerFactory,
    }),
  ).toBe(4);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string).status).toBe(
    'projection-stale-or-missing',
  );
  expect(readerFactory).not.toHaveBeenCalled();
  expect(readFileSync(path)).toEqual(bytes);
});
test.each(['1m', '5m', '15m', '1h'])('accepts rolling window %s', async (window) => {
  const dir = mkdtempSync(join(tmpdir(), 'p3-cli-'));
  dirs.push(dir);
  const path = join(dir, 'test.sqlite');
  const db = openDatabase(path);
  db.close();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runCli(['metrics', '--db', path, '--window', window], { environment: {} })).toBe(4);
});
test('P3 validates selectors, windows, sort and nonexistent db without creating it', async () => {
  for (const args of [
    ['metrics', '--window', '60s'],
    ['rank', '--sort', 'apy'],
    ['metrics', '--rwa', 'UNKNOWN'],
    ['metrics', '--db', ''],
    ['metrics', '--db', 'data/not-a-p3-database.sqlite'],
    ['rank', '--rwa', 'AMC'],
    ['metrics', '--sort', 'volume5mClosed'],
  ])
    await expect(runCli(args, { environment: {} })).rejects.toThrow();
});
