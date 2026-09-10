import { expect, it } from 'vitest';
import {
  generateGrid,
  splitAt,
  splitOutcomeEnd,
  dependencyReport,
  compareExperiments,
} from '../../src/replay/experiments.js';
import type { ReplayFrame } from '../../src/replay/runner.js';
import { buildMinuteMetrics } from '../../src/metrics/windows.js';
import { registration } from '../helpers/alert-fixture.js';

const grid = {
  version: 'p5-grid-v1',
  absolute1mUsd: [10000, 20000, 50000],
  multiples: [3, 5, 10],
  confirm5mUsd: [50000, 100000],
  confirmationBars: [1, 2] as (1 | 2)[],
  cooldownSeconds: 300 as const,
  reactionDelaysMinutes: [0, 1, 5] as (0 | 1 | 5)[],
  maxCombinations: 36,
};
it('enumerates all 36 configurations and rejects a cap instead of silently dropping combinations', () => {
  const params = generateGrid(grid);
  expect(params).toHaveLength(36);
  expect(new Set(params.map((p) => p.id)).size).toBe(36);
  expect(params[0]!.rules.candidate.threshold).toBe('10000000000');
  expect(params[0]!.rules.confirmConsecutive.buckets).toBe(1);
  expect(() => generateGrid({ ...grid, maxCombinations: 35 })).toThrow(/limit/);
});
it('time split is half-open and exploration outcomes cannot consume validation data', () => {
  const boundary = Date.parse('2026-09-06T00:00:00Z') / 1000;
  expect(splitAt(boundary - 1)).toBe('exploration');
  expect(splitAt(boundary)).toBe('validation');
  expect(splitAt(Date.parse('2026-09-08T00:00:00Z') / 1000)).toBe('outside');
  expect(splitOutcomeEnd(boundary - 60, boundary + 10000)).toBe(boundary);
});
it('reports tokens repeated across periods and leave-one-token-out counts without manufacturing independent samples', () => {
  const result = dependencyReport([
    { token: '0xa', split: 'exploration', episodes: 1 },
    { token: '0xa', split: 'validation', episodes: 2 },
    { token: '0xb', split: 'validation', episodes: 1 },
  ]);
  expect(result.crossPeriodTokens).toEqual(['0xa']);
  expect(result.leaveOneTokenOut.find((x) => x.excludedToken === '0xa')).toMatchObject({
    validationEpisodes: 1,
    explorationEpisodes: 0,
  });
});
it('empty history produces every grid row with unknown rates and outcomes, never a winning rule', () => {
  const result = compareExperiments([], grid);
  expect(result).toHaveLength(36);
  expect(result[0]).toMatchObject({
    status: 'incomplete',
    alarmCount: null,
    notificationsPerHour: null,
  });
});

it('unknown token episode evidence stays unknown in leave-one-out counts', () => {
  const result = dependencyReport([
    { token: 'a', split: 'validation', episodes: null },
    { token: 'b', split: 'validation', episodes: 2 },
  ]);
  expect(
    result.leaveOneTokenOut.find((r) => r.excludedToken === 'b')!.validationEpisodes,
  ).toBeNull();
});

it('retains named-case token dependence and descriptive exclusions without inventing population counts', () => {
  const named = (id: string, token: string, start: string) => ({
    id,
    token,
    group: 'named-regression' as const,
    startSec: Date.parse(start) / 1000,
    endSec: Date.parse(start) / 1000 + 60,
    frames: [],
    events: [],
    coverage: { minutes: [], scopeId: 's', endSec: Date.parse(start) / 1000 + 60 },
    selectedPoolIds: [],
    targets: [],
    complete: false,
  });
  const row = compareExperiments(
    [
      named('meme-early', 'MEME', '2026-09-04T00:00:00Z'),
      named('meme-reheat', 'meme', '2026-09-06T00:00:00Z'),
      named('other', 'other', '2026-09-06T00:00:00Z'),
    ],
    grid,
  )[0]!;
  expect(row.dependencies.crossPeriodTokens).toEqual(['meme']);
  const excluded = row.dependencies.leaveOneTokenOut.find((r) => r.excludedToken === 'meme')!;
  expect(excluded).toMatchObject({ explorationEpisodes: null, validationEpisodes: null });
  expect(excluded.splitSummaries[0]!.datasets).toEqual([]);
  expect(excluded.splitSummaries[1]!.datasets).toMatchObject([
    { id: 'other', group: 'named-regression', observedAlarmCount: null },
  ]);
});
