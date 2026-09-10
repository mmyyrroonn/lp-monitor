import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../../src/cli.js';
import { study } from '../../src/replay/study.js';
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it('study is offline and writes all 36 missing-data results plus immutable previous runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'study-'));
  dirs.push(dir);
  const cases = JSON.parse(readFileSync('config/history.cases.json', 'utf8'));
  cases.manifests = ['missing.json'];
  const path = join(dir, 'cases.json');
  writeFileSync(path, JSON.stringify(cases));
  const fetch = vi.fn(() => {
    throw new Error('network forbidden');
  });
  vi.stubGlobal('fetch', fetch);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await runCli(
    ['study', '--cases', path, '--grid', 'config/signals.grid.json', '--out', dir],
    { environment: {} },
  );
  expect(code).toBe(4);
  const result = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
  expect(result.status).toBe('incomplete');
  expect(result.experiments).toHaveLength(36);
  expect(result.cases).toHaveLength(7);
  expect(result.sources[0].status).toBe('unavailable');
  expect(result.experiments[0].alarmCount).toBeNull();
  const old = result.outputDirectory;
  const next = await study(path, 'config/signals.grid.json', dir);
  expect(next.outputDirectory).not.toBe(old);
  expect(existsSync(join(old, 'results.json'))).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalled();
});
it('rejects invalid historical time windows before reading raw sources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'study-'));
  dirs.push(dir);
  const cases = JSON.parse(readFileSync('config/history.cases.json', 'utf8'));
  cases.cases[0].endUtc = cases.cases[0].startUtc;
  const path = join(dir, 'cases.json');
  writeFileSync(path, JSON.stringify(cases));
  await expect(study(path, 'config/signals.grid.json', dir)).rejects.toThrow(/interval/);
});

it('actual portable history retains births and starts their exposure after the birth minute', async () => {
  const { replayFixture, replayFixtureDirs } = await import('../helpers/replay-fixture.js');
  const fixture = replayFixture();
  dirs.push(...replayFixtureDirs.splice(0));
  const cases = JSON.parse(readFileSync('config/history.cases.json', 'utf8'));
  const { registration } = await import('../helpers/alert-fixture.js');
  cases.manifests = ['manifest.json'];
  cases.quoteAddress = registration.token1;
  cases.cohort = {
    ...cases.cohort,
    rwaAddress: registration.token0,
    startUtc: '1970-01-01T00:01:00Z',
    endUtc: '1970-01-01T00:10:00Z',
  };
  cases.cases = [];
  const path = join(fixture.dir, 'cases.json');
  writeFileSync(path, JSON.stringify(cases));
  const report = await study(path, 'config/signals.grid.json', fixture.dir);
  expect(report.cohorts[0]!.observedBirthCount).toBe(1);
  expect(report.cohorts[0]!.cohortMode).toBe('as-of');
  expect(report.cohorts[0]!.registryVersion).toBe(fixture.manifest.replay!.input.assets.version);
  expect(report.cohorts[0]!.births[0]!.historyComplete).toBe(true);
  expect(readFileSync(join(report.outputDirectory, 'report.md'), 'utf8')).toContain('（as-of）');
  expect(report.method.primaryReactionDelaysMinutes).toEqual([1, 5]);
  const birth = report.experiments[0]!.datasets.find((d) => d.group === 'birth-cohort')!;
  expect(birth.exposure.startSec).toBe(180);
  expect(birth.exposure.endSec).toBe(600);
  expect(report.cohorts[0]!.births[0]!.censored).toBe(true);
});
it('cohort history completeness uses the selected observed intersection and correct scope', async () => {
  const { cohortHistoryComplete } = await import('../../src/replay/study.js');
  const { replay } = await import('../../src/replay/runner.js');
  const { initialSignalConfig } = await import('../../src/signals/config.js');
  const { replayFixture, replayFixtureDirs } = await import('../helpers/replay-fixture.js');
  const fixture = replayFixture();
  dirs.push(...replayFixtureDirs.splice(0));
  const report = await replay(fixture.path, initialSignalConfig, 'recorded-observed');
  expect(cohortHistoryComplete(report, 120, 120, 600)).toBe(true);
  expect(
    cohortHistoryComplete(
      { ...report, coverage: report.coverage.filter((m) => m.minuteStartSec !== 300) },
      120,
      120,
      600,
    ),
  ).toBe(false);
  expect(
    cohortHistoryComplete(
      { ...report, coverage: report.coverage.map((m) => ({ ...m, scopeId: 'wrong' })) },
      120,
      120,
      600,
    ),
  ).toBe(false);
  expect(cohortHistoryComplete(report, 4800, 120, 4860)).toBe(false);
});

it.each([false, true])(
  'discovery denominator stays independent of operation gaps without trusting missing hashes (%s)',
  async (missingDiscoveryHash) => {
    const { replayFixture, replayFixtureDirs, refreshFixtureManifest } =
      await import('../helpers/replay-fixture.js');
    const { encodeJson } = await import('../../src/domain/json.js');
    const { registration } = await import('../helpers/alert-fixture.js');
    const fixture = replayFixture();
    dirs.push(...replayFixtureDirs.splice(0));
    writeFileSync(
      join(fixture.dir, 'discovery-discovery.json'),
      encodeJson({ ...fixture.raw, id: 'discovery', scopeId: 'd' }),
    );
    writeFileSync(
      join(fixture.dir, 'range-one.json'),
      encodeJson({
        ...fixture.raw,
        boundaries: fixture.raw.boundaries!.filter((b) => b.timestampSec !== 300),
      }),
    );
    fixture.manifest.discoveryScope = 'd';
    fixture.manifest.batches.unshift({ id: 'discovery', scopeId: 'd', accepted: true });
    writeFileSync(fixture.path, JSON.stringify(fixture.manifest));
    refreshFixtureManifest(fixture.path);
    if (missingDiscoveryHash) {
      const manifest = JSON.parse(readFileSync(fixture.path, 'utf8'));
      delete manifest.batches[0].sha256;
      writeFileSync(fixture.path, JSON.stringify(manifest));
    }
    const cases = JSON.parse(readFileSync('config/history.cases.json', 'utf8'));
    cases.manifests = ['manifest.json'];
    cases.quoteAddress = registration.token1;
    cases.cohort = {
      ...cases.cohort,
      rwaAddress: registration.token0,
      startUtc: '1970-01-01T00:02:00Z',
      endUtc: '1970-01-01T00:10:00Z',
    };
    cases.cases = [];
    const path = join(fixture.dir, 'cases.json');
    writeFileSync(path, JSON.stringify(cases));
    const report = await study(path, 'config/signals.grid.json', fixture.dir);
    expect(report.cohorts[0]!.denominator).toBe(missingDiscoveryHash ? null : 1);
    expect(report.cohorts[0]!.births[0]!.historyComplete).toBe(false);
    expect(report.status).toBe('incomplete');
  },
);

it.each([120, 600])(
  'cohort as-of classification requires snapshot availability at cohort start (%s)',
  async (availableAtSec) => {
    const { replayFixture, replayFixtureDirs } = await import('../helpers/replay-fixture.js');
    const { registration } = await import('../helpers/alert-fixture.js');
    const fixture = replayFixture();
    dirs.push(...replayFixtureDirs.splice(0));
    fixture.manifest.replay!.input.availableAtSec = availableAtSec;
    writeFileSync(fixture.path, JSON.stringify(fixture.manifest));
    const cases = JSON.parse(readFileSync('config/history.cases.json', 'utf8'));
    cases.manifests = ['manifest.json'];
    cases.quoteAddress = registration.token1;
    cases.cohort = {
      ...cases.cohort,
      rwaAddress: registration.token0,
      startUtc: '1970-01-01T00:02:00Z',
      endUtc: '1970-01-01T00:10:00Z',
    };
    cases.cases = [];
    const path = join(fixture.dir, 'cases.json');
    writeFileSync(path, JSON.stringify(cases));
    const report = await study(path, 'config/signals.grid.json', fixture.dir);
    const expectedMode = availableAtSec <= 120 ? 'as-of' : 'retrospective-cohort';
    expect(report.cohorts[0]!.observedBirthCount).toBe(1);
    expect(report.cohorts[0]!.cohortMode).toBe(expectedMode);
    expect(report.cohorts[0]!.registryVersion).toBe(
      availableAtSec <= 120
        ? fixture.manifest.replay!.input.assets.version
        : cases.cohort.registryVersion,
    );
    expect(readFileSync(join(report.outputDirectory, 'report.md'), 'utf8')).toContain(
      '（' + expectedMode + '）',
    );
  },
);
