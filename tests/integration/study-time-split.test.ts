import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { studyWithConfig } from '../../src/replay/study.js';

test('study config keeps a missing dataset incomplete without contacting a provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-study-config-'));
  const configPath = join(dir, 'study.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      chainId: 4663,
      datasetManifest: 'missing/manifest.json',
      periods: {
        train: { startSec: 100, endSec: 200 },
        validation: { startSec: 200, endSec: 300 },
        test: { startSec: 300, endSec: 400 },
      },
      cohortMode: 'retrospective-cohort',
      ruleVersion: 'p4-v2',
      grid: resolve('config/signals.grid.json'),
      mode: 'chain-time',
      cadenceSec: 10,
      warmupMinutes: 180,
      outcomeMinutes: 180,
    }),
  );
  try {
    const report = await studyWithConfig(configPath, join(dir, 'out'));
    expect(report.status).toBe('incomplete');
    expect(report.conclusion).toBe('insufficient-data');
    expect(report.issues).toContain('dataset-manifest-missing');
    expect(report.onlineRuleChanged).toBe(false);
    expect(report.splitCounts).toEqual({ train: 0, validation: 0, test: 0, outside: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
