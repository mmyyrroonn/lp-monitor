import * as signalEngine from '../../src/signals/engine.js';
import { afterEach, expect, it, vi } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { replayFixture, replayFixtureDirs } from '../helpers/replay-fixture.js';
import { swap, registration } from '../helpers/alert-fixture.js';
import { replay } from '../../src/replay/runner.js';
import { encodeJson } from '../../src/domain/json.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import {
  compareExperiments,
  type ExperimentDataset,
  type SignalGrid,
} from '../../src/replay/experiments.js';
import { poolRegistrationId } from '../../src/registry/pools.js';
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of replayFixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const grid: SignalGrid = {
  version: 'test',
  absolute1mUsd: [10000],
  multiples: [3],
  confirm5mUsd: [50000],
  confirmationBars: [1, 2],
  cooldownSeconds: 300,
  reactionDelaysMinutes: [0, 1, 5],
  maxCombinations: 2,
};
async function dataset(
  offset = Date.parse('2026-09-05T23:30:00Z') / 1000,
): Promise<ExperimentDataset> {
  const x = replayFixture();
  x.raw.logs = Array.from({ length: 79 }, (_, i) =>
    swap(70 + i * 60, i >= 23 && i <= 27 ? 24000 : 2000),
  );
  x.raw.end.timestampSec += offset;
  x.raw.observedAtMs += offset * 1000;
  x.raw.boundaries = x.raw.boundaries!.map((b) => ({
    ...b,
    timestampSec: b.timestampSec + offset,
    before: { ...b.before, timestampSec: b.before.timestampSec + offset },
    at: { ...b.at, timestampSec: b.at.timestampSec + offset },
  }));
  x.raw.logTimes = x.raw.logTimes!.map((t, i) => ({
    ref: x.raw.logs[i]!,
    time: {
      ...t.time,
      minuteStartSec: t.time.minuteStartSec! + offset,
      exactTimestampSec:
        t.time.exactTimestampSec === null ? null : t.time.exactTimestampSec + offset,
    },
  }));
  const raw = encodeJson(x.raw);
  x.manifest.batches[0]!.sha256 = createHash('sha256').update(raw).digest('hex');
  writeFileSync(join(x.dir, 'range-one.json'), raw);
  writeFileSync(x.path, JSON.stringify(x.manifest));
  const report = await replay(x.path, initialSignalConfig, 'minute-close');
  expect(report.status).toBe('complete');
  return {
    id: 'fixture',
    group: 'birth-cohort',
    token: registration.token0,
    startSec: offset + 180,
    endSec: offset + 4860,
    frames: report.frames,
    events: report.metricEvents,
    coverage: {
      minutes: report.coverage,
      scopeId: 's',
      endSec: offset + 4860,
      integrityComplete: true,
    },
    selectedPoolIds: [poolRegistrationId(registration)],
    targets: [{ pool: registration.pool, role: 'rwa-usdg' }],
    complete: true,
  };
}
it('actual replay frames compare one/two confirmations, per-split results and delayed future target windows', async () => {
  const source = await dataset();
  const results = compareExperiments([source], grid);
  const one = results[0]!,
    two = results[1]!;
  expect(one.datasets[0]!.alerts.some((a) => a.kind === 'hot')).toBe(true);
  expect(two.datasets[0]!.alerts.some((a) => a.kind === 'hot')).toBe(false);
  const hot = one.datasets[0]!.alerts.find((a) => a.kind === 'hot')!;
  expect(hot.outcomes.map((o) => o.result.reactionDelayMinutes)).toEqual([0, 1, 5]);
  expect(
    hot.outcomes[1]!.result.windows[0]!.startSec - hot.outcomes[0]!.result.windows[0]!.startSec,
  ).toBe(60);
  expect(one.splitSummaries.map((s) => s.split)).toEqual(['exploration', 'validation']);
  expect(one.splitSummaries[1]!.observedAlarmCount).toBeGreaterThan(0);
  expect(one.firstAlertComparisons[0]!.candidateFirstSec).not.toBeNull();
});
it('duplicate closed minutes cannot cancel missing minutes in a complete exposure denominator', async () => {
  const source = await dataset();
  const duplicate = {
    ...source,
    coverage: {
      ...source.coverage,
      minutes: [...source.coverage.minutes.slice(1), source.coverage.minutes[1]!],
    },
  };
  const result = compareExperiments([duplicate], grid)[0]!;
  expect(result.datasets[0]!.status).toBe('incomplete');
  expect(result.datasets[0]!.notificationsPerHour).toBeNull();
});

it('separates overlapping named cases and shared targets, deduplicates episode outcomes and preserves missing frames', async () => {
  const source = await dataset();
  const named = { ...source, id: 'named', group: 'named-regression' as const };
  const missing = { ...source, id: 'missing', frames: [] };
  const row = compareExperiments([source, named, missing], grid)[0]!;
  expect(row.observedAlarmCount).toBeNull();
  expect(row.splitSummaries[0]!.observedAlarmCount).toBeNull();
  expect(row.datasets.find((d) => d.id === 'missing')).toMatchObject({
    status: 'incomplete',
    observedAlarmCount: null,
    alarmCount: null,
  });
  const split = row.splitSummaries[0]!;
  expect(split.datasets.map((d) => d.id)).toEqual(['fixture', 'named', 'missing']);
  const sourceSummary = split.datasets[0]!;
  expect(sourceSummary.coveredMinutes).toBe(sourceSummary.expectedMinutes);
  expect(sourceSummary.evaluatedMinutes).toBe(sourceSummary.expectedMinutes);
  const dist = sourceSummary.outcomeDistributions.find(
    (d) => d.reactionDelayMinutes === 0 && d.horizonMinutes === 15,
  )!;
  expect(dist.poolId).toBe(poolRegistrationId(registration));
  expect(dist.total).toBe(sourceSummary.observedEpisodeCount);
  expect(dist.independentSamples).toBe(false);
  expect(row.firstAlertComparisons[0]!.deltaSeconds).toBe(
    row.firstAlertComparisons[0]!.candidateFirstSec! -
      row.firstAlertComparisons[0]!.baselineFirstSec!,
  );
  expect(
    row.dependencies.leaveOneTokenOut[0]!.splitSummaries.every((s) => s.datasets.length === 0),
  ).toBe(true);
});
it('complete observed zero-alert frames retain real zero and valid exposure', async () => {
  const source = await dataset();
  const row = compareExperiments([source], {
    ...grid,
    absolute1mUsd: [999999999],
    multiples: [999999999],
    confirm5mUsd: [999999999],
  })[0]!;
  expect(row.datasets[0]).toMatchObject({
    status: 'complete',
    alarmCount: 0,
    observedAlarmCount: 0,
    notificationsPerHour: 0,
  });
});
it('retains a birth with no remaining evaluation interval as incomplete with unknown counts', async () => {
  const source = await dataset();
  const endBirth = { ...source, startSec: source.endSec, frames: [] };
  expect(compareExperiments([endBirth], grid)[0]!.datasets[0]).toMatchObject({
    status: 'incomplete',
    observedAlarmCount: null,
    alarmCount: null,
    notificationsPerHour: null,
    exposure: { startSec: source.endSec, endSec: source.endSec, expectedMinutes: 0 },
  });
});
it('same-episode spikes count one alert identity rather than two payload revisions', async () => {
  const source = await dataset();
  const windows = source.frames.flatMap((f) => f.metrics.windows);
  const hotMinute = windows.find(
    (w) => (w.recentClosed1m?.usdMicros ?? 0n) >= 20000000000n,
  )!.recentClosed1m!;
  const selected = source.frames.slice(0, 20).map((frame, index) => ({
    ...frame,
    metrics: {
      ...frame.metrics,
      windows: frame.metrics.windows.map((w) => {
        const target = Math.floor(frame.evaluatedAtSec / 60) * 60 - 60;
        const current = {
          ...hotMinute,
          minuteStartSec: target,
          usdMicros: index === 2 || index === 12 ? 24000000000n : 1n,
        };
        return { ...w, minutes: [current], recentClosed1m: current, natural5mBuckets: [] };
      }),
    },
  }));
  const row = compareExperiments(
    [{ ...source, frames: selected, endSec: selected.at(-1)!.evaluatedAtSec + 60 }],
    { ...grid, confirmationBars: [2], confirm5mUsd: [999999999] },
  )[0]!;
  expect(row.datasets[0]!.alerts).toHaveLength(1);
  expect(row.datasets[0]!.observedAlarmCount).toBe(1);
});
it('outside-period inputs contribute neither alerts, outcomes nor evaluated exposure', async () => {
  const source = await dataset(Date.parse('2026-09-10T00:00:00Z') / 1000);
  const row = compareExperiments([source], grid)[0]!;
  expect(row.datasets[0]!.alerts).toHaveLength(0);
  expect(row.datasets[0]!.evaluatedMinutes).toBe(0);
  expect(row.datasets[0]!.notificationsPerHour).toBeNull();
  expect(row.quality.horizons.every((h) => h.total === 0)).toBe(true);
});
it('a stale recentClosed1m cannot stand in for the target gap minute', async () => {
  const source = await dataset();
  const latest = source.frames.at(-1)!;
  const target = Math.floor(latest.evaluatedAtSec / 60) * 60 - 60;
  const changed = {
    ...latest,
    metrics: {
      ...latest.metrics,
      windows: latest.metrics.windows.map((w) => ({
        ...w,
        minutes: w.minutes.map((m) =>
          m.minuteStartSec === target ? { ...m, status: 'gap' as const } : m,
        ),
        recentClosed1m: w.minutes.find((m) => m.minuteStartSec === target - 60) ?? null,
      })),
    },
  };
  const original = signalEngine.evaluateSignal;
  const seen: string[] = [];
  vi.spyOn(signalEngine, 'evaluateSignal').mockImplementation((previous, input, config) => {
    if (input.watermarkSec === latest.evaluatedAtSec) seen.push(input.coverage);
    return original(previous, input, config);
  });
  const row = compareExperiments(
    [{ ...source, frames: [...source.frames.slice(0, -1), changed] }],
    grid,
  )[0]!;
  expect(new Set(seen)).toEqual(new Set(['gap']));
  expect(row.datasets[0]!.evaluatedMinutes).toBeLessThan(row.datasets[0]!.expectedMinutes);
});
it('partial outside exposure is excluded from rates and completeness denominators', async () => {
  const source = await dataset(Date.parse('2026-09-02T23:30:00Z') / 1000);
  const row = compareExperiments([source], grid)[0]!;
  const d = row.datasets[0]!;
  const start = Date.parse('2026-09-03T00:00:00Z') / 1000;
  expect(d.expectedMinutes).toBe((source.endSec - start) / 60);
  expect(d.excludedOutsideMinutes).toBe((start - source.startSec) / 60);
  expect(d.status).toBe('complete');
  expect(d.notificationsPerHour).toBe(d.alarmCount! / (d.expectedMinutes / 60));
  expect(d.alerts.every((a) => a.split !== 'outside')).toBe(true);
});
it('pre-period hot warmup advances state while its alerts remain outside statistics', async () => {
  const source = await dataset();
  const start = Date.parse('2026-09-03T00:00:00Z') / 1000;
  const template = source.frames[20]!;
  const base = template.metrics.windows[0]!;
  const sample = base.recentClosed1m!;
  const bar = {
    ...base.natural5mBuckets.at(-1)!,
    startSec: start - 600,
    endSec: start - 300,
    usdMicros: 120000000000n,
  };
  const frames = [start - 300, start + 60].map((sec) => ({
    ...template,
    batchId: 'warm-' + sec,
    evaluatedAtSec: sec,
    observedAtMs: sec * 1000,
    metrics: {
      ...template.metrics,
      at: { ...template.metrics.at, timestampSec: sec },
      windows: [
        {
          ...base,
          natural5mBuckets: [bar],
          minutes: [{ ...sample, minuteStartSec: sec - 60, usdMicros: 1n }],
          recentClosed1m: { ...sample, minuteStartSec: sec - 60, usdMicros: 1n },
        },
      ],
    },
  }));
  const seen: string[] = [];
  const original = signalEngine.evaluateSignal;
  vi.spyOn(signalEngine, 'evaluateSignal').mockImplementation((previous, input, config) => {
    if (input.watermarkSec === start + 60) seen.push(previous.state);
    return original(previous, input, config);
  });
  const row = compareExperiments([{ ...source, frames, startSec: start, endSec: start + 120 }], {
    ...grid,
    confirmationBars: [1],
  })[0]!;
  expect(seen.at(-1)).toBe('hot');
  expect(row.datasets[0]!.alerts).toHaveLength(0);
  expect(row.datasets[0]!.excludedOutsideFrames).toBe(1);
});
