import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { batch, metricInput, swap } from '../helpers/alert-fixture.js';
import { exportReplayDataset } from '../../src/replay/export.js';
import { readReplayManifest, type ReplayInputSnapshot } from '../../src/replay/reader.js';
import { replay } from '../../src/replay/runner.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import type { RecordedRangeBatch } from '../../src/storage/manifest.js';

function snapshot(): ReplayInputSnapshot {
  return {
    configVersion: metricInput.configVersion,
    usdg: metricInput.usdg,
    assets: { version: metricInput.assets.version, rwa: [...metricInput.assets.assets] },
    metadata: metricInput.metadata,
    availableAtSec: 0,
    cohortMode: 'retrospective-cohort',
  };
}

/** Mimic the recorder order: transport bytes first, minute evidence second. */
function recordLikeRecorder(path: string): void {
  const db = openDatabase(path);
  try {
    const store = new SqliteRangeStore(db);
    const timed = batch('one', [swap(60), swap(120)]);
    const { logTimes: _times, boundaries: _boundaries, anchors: _anchors, ...transport } = timed;
    store.saveRaw(transport as RecordedRangeBatch, { compact: true });
    store.acceptRange(timed);
  } finally {
    db.close();
  }
}

test('export assembles derived minute evidence instead of dropping resolved times', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-export-evidence-'));
  const sourcePath = join(dir, 'source.sqlite');
  try {
    recordLikeRecorder(sourcePath);
    const result = await exportReplayDataset({
      databasePath: sourcePath,
      outputDirectory: join(dir, 'dataset'),
      scopeId: 's',
      fromBlock: 60n,
      toBlock: 4800n,
      mode: 'chain-time',
      cohortMode: 'retrospective-cohort',
      inputSnapshot: snapshot(),
    });
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
      export: { timeQuality: { derivedTimes: number; unresolvedLogs: number } };
      segments: { path: string }[];
    };
    expect(manifest.export.timeQuality.unresolvedLogs).toBe(0);
    expect(manifest.export.timeQuality.derivedTimes).toBeGreaterThan(0);
    const segment = JSON.parse(
      gunzipSync(readFileSync(join(dir, 'dataset', manifest.segments[0]!.path))).toString('utf8'),
    ) as RecordedRangeBatch;
    expect(segment.logTimes?.length).toBe(segment.logs.length);
    expect(segment.logTimes?.every((item) => item.time.minuteStartSec !== null)).toBe(true);
    expect((segment.boundaries ?? []).length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export gaps reach the reader and keep replay incomplete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-export-gap-'));
  const sourcePath = join(dir, 'source.sqlite');
  try {
    recordLikeRecorder(sourcePath);
    const result = await exportReplayDataset({
      databasePath: sourcePath,
      outputDirectory: join(dir, 'dataset'),
      scopeId: 's',
      fromBlock: 60n,
      toBlock: 6000n,
      mode: 'chain-time',
      cohortMode: 'retrospective-cohort',
      inputSnapshot: snapshot(),
    });
    expect(result.complete).toBe(false);
    expect(result.issues).toContain('coverage:4801-6000:accepted-coverage-missing');
    const parsed = readReplayManifest(result.manifestPath);
    const codes = parsed.issues.map((issue) => issue.code);
    expect(codes).toContain('coverage');
    expect(codes).toContain('declared-range-coverage-missing');
    const report = await replay(result.manifestPath, initialSignalConfig, 'minute-close');
    expect(report.status).toBe('incomplete');
    expect(report.integrity.issues.map((issue) => issue.code)).toContain(
      'declared-range-coverage-missing',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recorded-observed exports mark backfilled minute evidence as unavailable at capture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-export-observed-'));
  const sourcePath = join(dir, 'source.sqlite');
  try {
    recordLikeRecorder(sourcePath);
    const result = await exportReplayDataset({
      databasePath: sourcePath,
      outputDirectory: join(dir, 'dataset'),
      scopeId: 's',
      fromBlock: 60n,
      toBlock: 4800n,
      mode: 'recorded-observed',
      cohortMode: 'retrospective-cohort',
      inputSnapshot: snapshot(),
    });
    expect(result.complete).toBe(false);
    expect(result.issues).toContain('recorded-observed:derived-time-not-recorded-at-capture');
    expect(readReplayManifest(result.manifestPath).issues.map((issue) => issue.code)).toContain(
      'recorded-observed-derived-time',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
