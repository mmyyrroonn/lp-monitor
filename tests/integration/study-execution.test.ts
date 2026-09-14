import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { batch, metricInput, swap } from '../helpers/alert-fixture.js';
import { encodeJson } from '../../src/domain/json.js';
import { studyWithConfig } from '../../src/replay/study.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import type { RawLog } from '../../src/domain/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Spikes land inside train, validation and test so candidates can freeze. */
function dataset(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lp-study-exec-'));
  dirs.push(dir);
  const spike = (index: number) =>
    (index >= 8 && index <= 12) || (index >= 20 && index <= 24) || (index >= 50 && index <= 54);
  const logs: RawLog[] = Array.from({ length: 79 }, (_, index) =>
    swap(70 + index * 60, spike(index) ? 30_000 : 2_000),
  );
  const raw = { ...batch('one', logs), previous: null, captureMode: 'live' as const };
  const rawText = encodeJson(raw);
  writeFileSync(join(dir, 'range-one.json'), rawText);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      chainId: 4663,
      scopeId: 's',
      discoveryScope: 's',
      configVersion: 'c',
      assetVersion: 'test',
      batches: [
        {
          id: 'one',
          scopeId: 's',
          accepted: true,
          sha256: createHash('sha256').update(rawText).digest('hex'),
        },
      ],
      replay: {
        version: 1,
        input: {
          configVersion: 'c',
          usdg: metricInput.usdg,
          assets: { version: 'test', rwa: [...metricInput.assets.assets] },
          metadata: metricInput.metadata,
          availableAtSec: 0,
          cohortMode: 'as-of',
        },
      },
    }),
  );
  return { dir, path: join(dir, 'manifest.json') };
}

function studyConfig(
  dir: string,
  manifestPath: string,
  overrides: Record<string, unknown> = {},
): string {
  const configPath = join(dir, 'study.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      chainId: 4663,
      datasetManifest: manifestPath,
      periods: {
        train: { startSec: 300, endSec: 1_200 },
        validation: { startSec: 1_200, endSec: 2_100 },
        test: { startSec: 2_400, endSec: 3_300 },
      },
      cohortMode: 'as-of',
      ruleVersion: initialSignalConfig.version,
      grid: resolve('config/signals.grid.json'),
      mode: 'chain-time',
      cadenceSec: 60,
      warmupMinutes: 0,
      outcomeMinutes: 0,
      ...overrides,
    }),
  );
  return configPath;
}

test('study runs the bounded grid over rolling frames and freezes training candidates', async () => {
  const fixture = dataset();
  const report = await studyWithConfig(
    studyConfig(fixture.dir, fixture.path),
    join(fixture.dir, 'out'),
  );
  expect(report.experiments.parameters).toBe(36);
  expect(report.experiments.candidates).toHaveLength(36);
  expect(report.splitCounts.train).toBeGreaterThan(0);
  expect(report.splitCounts.validation).toBeGreaterThan(0);
  expect(report.splitCounts.test).toBeGreaterThan(0);
  expect(report.effectiveCadenceSec).toBe(60);
  expect(report.issues).not.toContain('period-train-without-evaluations');
  expect(report.experiments.frozen.length).toBeGreaterThan(0);
  const frozen = report.experiments.candidates.find((candidate) => candidate.selectedOnTrain)!;
  expect(frozen.frozenHash).toMatch(/^[0-9a-f]{64}$/);
  expect(frozen.splits.train.alerts).toBeGreaterThan(0);
  const outcomes = frozen.splits.train.outcomes.map((item) => item.horizonMinutes);
  expect(outcomes).toContain(15);
  expect(outcomes).toContain(60);
  expect(outcomes).toContain(180);
  expect(frozen.splits.validation.evaluations).toBeGreaterThan(0);
  expect(frozen.splits.test.evaluations).toBeGreaterThan(0);
  expect(report.conclusion).not.toBe('insufficient-data');
}, 60000);

test('study periods outside the recorded window cannot report completion', async () => {
  const fixture = dataset();
  const report = await studyWithConfig(
    studyConfig(fixture.dir, fixture.path, {
      periods: {
        train: { startSec: 6_000, endSec: 6_600 },
        validation: { startSec: 6_600, endSec: 7_200 },
        test: { startSec: 7_200, endSec: 7_800 },
      },
    }),
    join(fixture.dir, 'out'),
  );
  expect(report.status).toBe('incomplete');
  expect(report.conclusion).toBe('insufficient-data');
  expect(report.issues).toContain('period-train-without-evaluations');
  expect(report.issues).toContain('period-validation-without-evaluations');
  expect(report.issues).toContain('period-test-without-evaluations');
  expect(report.splitCounts).toEqual({ train: 0, validation: 0, test: 0, outside: 79 });
  expect(report.experiments.frozen).toEqual([]);
}, 60000);

test('an unparameterised grid is rejected instead of reporting a completed study', async () => {
  const fixture = dataset();
  writeFileSync(join(fixture.dir, 'empty.grid.json'), JSON.stringify({}));
  const report = await studyWithConfig(
    studyConfig(fixture.dir, fixture.path, { grid: join(fixture.dir, 'empty.grid.json') }),
    join(fixture.dir, 'out'),
  );
  expect(report.status).toBe('incomplete');
  expect(report.issues).toContain('study-grid-unavailable');
  expect(report.experiments.candidates).toEqual([]);
}, 60000);
