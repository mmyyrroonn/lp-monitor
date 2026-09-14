import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { batch, metricInput, registration, swap } from '../helpers/alert-fixture.js';
import { encodeJson } from '../../src/domain/json.js';
import { exportReplayDataset } from '../../src/replay/export.js';
import { readReplayManifest } from '../../src/replay/reader.js';
import { openDatabase } from '../../src/storage/database.js';
import { SqliteRangeStore } from '../../src/storage/raw-store.js';
import type { ReplayInputSnapshot } from '../../src/replay/reader.js';

function snapshot(): ReplayInputSnapshot {
  return {
    configVersion: metricInput.configVersion,
    usdg: metricInput.usdg,
    assets: { version: metricInput.assets.version, rwa: [...metricInput.assets.assets] },
    metadata: metricInput.metadata,
    availableAtSec: 0,
    cohortMode: 'as-of',
  };
}

test('replay export publishes portable v2 gzip segments and reader needs no source DB', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-replay-export-'));
  const sourcePath = join(dir, 'source.sqlite');
  const output = join(dir, 'dataset');
  const source = openDatabase(sourcePath);
  try {
    const recorded = batch('one', [swap(60)]);
    new SqliteRangeStore(source).acceptRange(recorded);
  } finally {
    source.close();
  }
  const before = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  try {
    const result = await exportReplayDataset({
      databasePath: sourcePath,
      outputDirectory: output,
      scopeId: 's',
      fromBlock: 60n,
      toBlock: 4800n,
      mode: 'chain-time',
      cohortMode: 'as-of',
      inputSnapshot: snapshot(),
    });
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(existsSync(result.manifestPath)).toBe(true);
    const parsed = readReplayManifest(result.manifestPath);
    expect(parsed.manifest.version).toBe(2);
    expect(parsed.batches.map((item) => item.id)).toEqual(['one']);
    expect(parsed.issues).toEqual([]);
    const after = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
    expect(after).toBe(before);
    rmSync(sourcePath);
    expect(readReplayManifest(result.manifestPath).batches).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replay export keeps missing input snapshot and compressed corruption explicit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-replay-export-quality-'));
  const sourcePath = join(dir, 'source.sqlite');
  const output = join(dir, 'dataset');
  const source = openDatabase(sourcePath);
  try {
    new SqliteRangeStore(source).acceptRange(batch('one', [swap(60)]));
  } finally {
    source.close();
  }
  try {
    const result = await exportReplayDataset({
      databasePath: sourcePath,
      outputDirectory: output,
      scopeId: 's',
      fromBlock: 60n,
      toBlock: 4800n,
      mode: 'chain-time',
      cohortMode: 'retrospective-cohort',
    });
    expect(result.complete).toBe(false);
    expect(result.issues).toContain('input-snapshot-missing');
    const segmentPath = join(output, 'segments', '000000.json.gz');
    const bytes = readFileSync(segmentPath);
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
    writeFileSync(segmentPath, bytes);
    const parsed = readReplayManifest(join(output, 'manifest.json'));
    expect(parsed.issues.map((issue) => issue.code)).toContain('compressed-artifact-hash-mismatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replay export does not overwrite an existing output directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-replay-export-existing-'));
  const sourcePath = join(dir, 'source.sqlite');
  const output = join(dir, 'dataset');
  const source = openDatabase(sourcePath);
  source.close();
  writeFileSync(output, encodeJson({ existing: true }));
  try {
    await expect(
      exportReplayDataset({
        databasePath: sourcePath,
        outputDirectory: output,
        scopeId: 's',
        fromBlock: 1n,
        toBlock: 1n,
        mode: 'chain-time',
        cohortMode: 'as-of',
        inputSnapshot: snapshot(),
      }),
    ).rejects.toThrow(/already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
