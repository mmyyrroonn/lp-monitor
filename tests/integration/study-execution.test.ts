import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { toHex } from 'viem';
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
function dataset(options: { secondPool?: 'steady' | 'single' } = {}): {
  dir: string;
  path: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'lp-study-exec-'));
  dirs.push(dir);
  const spike = (index: number) =>
    (index >= 8 && index <= 12) || (index >= 20 && index <= 24) || (index >= 50 && index <= 54);
  const logs: RawLog[] = Array.from({ length: 79 }, (_, index) =>
    swap(70 + index * 60, spike(index) ? 30_000 : 2_000),
  );
  const secondPool = ('0x' + '44'.repeat(20)) as `0x${string}`;
  if (options.secondPool)
    for (let index = 0; index < 79; index++) {
      const block = 70 + index * 60;
      const hot = index >= 20 && index <= 24;
      // 'single' fires one validation spike and has no forward activity after it.
      if (options.secondPool === 'single' && index !== 20) continue;
      logs.push({
        ...swap(block, hot ? 30_000 : 2_000),
        address: secondPool,
        logIndex: 1,
        transactionHash: toHex(20_000 + block, { size: 32 }),
      });
    }
  const base = batch('one', logs);
  const twoPool = options.secondPool
    ? {
        manifest: {
          ...base.manifest,
          shards: base.manifest.shards.map((shard) => ({
            ...shard,
            request: { ...shard.request, address: [...shard.request.address, secondPool] },
          })),
        },
        poolRegistrations: [
          base.poolRegistrations![0]!,
          {
            pool: { chainId: 4663 as const, protocol: 'v3' as const, address: secondPool },
            token0: metricInput.assets.assets[0]!.address,
            token1: metricInput.usdg,
            feePips: 3000,
            tickSpacing: 60,
            hooks: ('0x' + '00'.repeat(20)) as `0x${string}`,
            discoveredAt: logs.find((log) => log.address === secondPool)!,
            assetVersion: 'test',
            source: 'synthetic' as const,
          },
        ],
      }
    : {};
  const raw = { ...base, ...twoPool, previous: null, captureMode: 'live' as const };
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

test('candidate support requires evaluable validation outcome windows', async () => {
  const periods = {
    train: { startSec: 300, endSec: 1_200 },
    validation: { startSec: 1_300, endSec: 2_300 },
    test: { startSec: 3_000, endSec: 4_000 },
  };
  const censoredFixture = dataset({ secondPool: 'steady' });
  const censored = await studyWithConfig(
    studyConfig(censoredFixture.dir, censoredFixture.path, { periods }),
    join(censoredFixture.dir, 'out-censored'),
  );
  const frozen = censored.experiments.candidates.find((candidate) => candidate.selectedOnTrain)!;
  expect(frozen.splits.validation.episodes).toBeGreaterThan(0);
  // Every 60-minute validation window reaches past the recorded data end.
  expect(
    frozen.splits.validation.outcomes.find((item) => item.horizonMinutes === 60)?.complete ?? 0,
  ).toBe(0);
  expect(censored.validationSatisfied).toBe(false);
  expect(censored.issues).toContain('validation-requirement-not-met');
  expect(censored.conclusion).toBe('insufficient-evidence');
  expect(censored.status).toBe('incomplete');

  const evaluableFixture = dataset({ secondPool: 'steady' });
  const evaluable = await studyWithConfig(
    studyConfig(evaluableFixture.dir, evaluableFixture.path, {
      periods,
      validation: { primaryHorizonMinutes: 15, minimumCompleteOutcomeWindows: 1 },
    }),
    join(evaluableFixture.dir, 'out-evaluable'),
  );
  expect(evaluable.validationSatisfied).toBe(true);
  expect(evaluable.conclusion).toBe('candidate-supported');
  expect(evaluable.status).toBe('complete');
}, 180_000);

test('a complete but inactive forward window cannot support a candidate', async () => {
  const fixture = dataset({ secondPool: 'single' });
  const report = await studyWithConfig(
    studyConfig(fixture.dir, fixture.path, {
      periods: {
        train: { startSec: 300, endSec: 1_200 },
        validation: { startSec: 1_300, endSec: 2_600 },
        test: { startSec: 3_000, endSec: 4_000 },
      },
      validation: { primaryHorizonMinutes: 15, minimumCompleteOutcomeWindows: 1 },
    }),
    join(fixture.dir, 'out'),
  );
  const frozen = report.experiments.candidates.filter((candidate) => candidate.selectedOnTrain);
  expect(frozen.length).toBeGreaterThan(0);
  const observed = frozen.filter((candidate) => candidate.splits.validation.episodes > 0);
  expect(observed.length).toBeGreaterThan(0);
  const primary = observed[0]!.splits.validation.outcomes.find(
    (item) => item.horizonMinutes === 15 && item.reactionDelayMinutes === 1,
  )!;
  // The window is evaluable, but no trade follows the trigger.
  expect(primary.complete).toBeGreaterThan(0);
  expect(primary.minimumSwapCount).toBe(0);
  expect(primary.minimumUsdMicros).toBe('0');
  expect(report.validationRequirement.minimumForwardSwapCount).toBe(1);
  expect(report.validationSatisfied).toBe(false);
  expect(report.issues).toContain('validation-requirement-not-met');
  expect(report.conclusion).toBe('insufficient-evidence');
}, 180_000);

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
