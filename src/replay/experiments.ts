import { z } from 'zod';
import { createHash } from 'node:crypto';
import { initialSignalConfig, parseSignalConfig } from '../signals/config.js';
import { evaluateSignal, initialSignalSnapshot } from '../signals/engine.js';
import type { SignalSnapshot } from '../signals/types.js';
import type { ReplayFrame } from './runner.js';
import type { PoolRef } from '../domain/types.js';
import type { MetricEvent } from '../metrics/windows.js';
import { evaluateOutcomes, type OutcomeCoverage, type Outcome } from './outcomes.js';
import { summarizeOutcomeQuality } from './quality-report.js';

export const gridSchema = z
  .object({
    version: z.string().min(1),
    absolute1mUsd: z.array(z.number().int().positive().safe()).min(1),
    multiples: z.array(z.number().int().positive().safe()).min(1),
    confirm5mUsd: z.array(z.number().int().positive().safe()).min(1),
    confirmationBars: z.array(z.union([z.literal(1), z.literal(2)])).min(1),
    cooldownSeconds: z.literal(300),
    reactionDelaysMinutes: z.array(z.union([z.literal(0), z.literal(1), z.literal(5)])).min(1),
    maxCombinations: z.number().int().min(1).max(512),
  })
  .strict();
export type SignalGrid = z.infer<typeof gridSchema>;
export function generateGrid(value: SignalGrid) {
  const grid = gridSchema.parse(value);
  for (const values of [
    grid.absolute1mUsd,
    grid.multiples,
    grid.confirm5mUsd,
    grid.confirmationBars,
    grid.reactionDelaysMinutes,
  ])
    if (new Set(values).size !== values.length) throw new Error('Duplicate grid parameter');
  const size =
    grid.absolute1mUsd.length *
    grid.multiples.length *
    grid.confirm5mUsd.length *
    grid.confirmationBars.length;
  if (size > grid.maxCombinations) throw new Error('Grid combination limit exceeded');
  return grid.absolute1mUsd.flatMap((absolute1mUsd) =>
    grid.multiples.flatMap((multiple) =>
      grid.confirm5mUsd.flatMap((confirm5mUsd) =>
        grid.confirmationBars.map((confirmationBars) => {
          const parameters = {
            absolute1mUsd,
            multiple,
            confirm5mUsd,
            confirmationBars,
            cooldownSeconds: grid.cooldownSeconds,
          };
          const id = createHash('sha256')
            .update(JSON.stringify({ version: grid.version, ...parameters }))
            .digest('hex')
            .slice(0, 16);
          const rules = parseSignalConfig({
            ...initialSignalConfig,
            version: 'p5-' + id,
            candidate: {
              ...initialSignalConfig.candidate,
              threshold: (BigInt(absolute1mUsd) * 1000000n).toString(),
              multiple,
            },
            // The grid's 1/2 bar axis applies to absolute natural 5m confirmation. A
            // parallel single-bar relative confirmer would bypass the two-bar axis.
            confirmRelative: { ...initialSignalConfig.confirmRelative, enabled: false },
            confirmConsecutive: {
              ...initialSignalConfig.confirmConsecutive,
              threshold: (BigInt(confirm5mUsd) * 1000000n).toString(),
              buckets: confirmationBars,
            },
            cooldown: { ...initialSignalConfig.cooldown, threshold: grid.cooldownSeconds },
          });
          return { id, parameters, rules };
        }),
      ),
    ),
  );
}
export type StudySplit = 'exploration' | 'validation' | 'outside';
const explorationStart = Date.parse('2026-09-03T00:00:00Z') / 1000;
const validationStart = Date.parse('2026-09-06T00:00:00Z') / 1000;
const validationEnd = Date.parse('2026-09-08T00:00:00Z') / 1000;
export function splitAt(sec: number): StudySplit {
  return sec >= explorationStart && sec < validationStart
    ? 'exploration'
    : sec >= validationStart && sec < validationEnd
      ? 'validation'
      : 'outside';
}
export function splitOutcomeEnd(sec: number, endSec: number) {
  return Math.min(
    endSec,
    splitAt(sec) === 'exploration'
      ? validationStart
      : splitAt(sec) === 'validation'
        ? validationEnd
        : endSec,
  );
}
export function dependencyReport(
  rows: readonly { token: string; split: StudySplit; episodes: number | null }[],
) {
  const tokens = [...new Set(rows.map((r) => r.token.toLowerCase()))].sort();
  return {
    crossPeriodTokens: tokens.filter(
      (token) =>
        rows.some((r) => r.token.toLowerCase() === token && r.split === 'exploration') &&
        rows.some((r) => r.token.toLowerCase() === token && r.split === 'validation'),
    ),
    leaveOneTokenOut: tokens.map((excludedToken) => ({
      excludedToken,
      explorationEpisodes: rows
        .filter((r) => r.token.toLowerCase() !== excludedToken && r.split === 'exploration')
        .reduce<number | null>(
          (s, r) => (s === null || r.episodes === null ? null : s + r.episodes),
          0,
        ),
      validationEpisodes: rows
        .filter((r) => r.token.toLowerCase() !== excludedToken && r.split === 'validation')
        .reduce<number | null>(
          (s, r) => (s === null || r.episodes === null ? null : s + r.episodes),
          0,
        ),
    })),
  };
}
export interface ExperimentDataset {
  id: string;
  group: 'named-regression' | 'birth-cohort' | 'preexisting-reheat';
  token: string;
  startSec: number;
  endSec: number;
  frames: readonly ReplayFrame[];
  events: readonly MetricEvent[];
  coverage: OutcomeCoverage;
  selectedPoolIds: readonly string[];
  targets: readonly { pool: PoolRef; role: 'meme-rwa' | 'rwa-usdg' }[];
  complete: boolean;
}
export type ExperimentAlert = {
  id: string;
  datasetId: string;
  group: ExperimentDataset['group'];
  token: string;
  poolId: string;
  kind: string;
  episodeId: string;
  logicalTimeSec: number;
  split: StudySplit;
  outcomes: { role: 'meme-rwa' | 'rwa-usdg'; result: Outcome }[];
};
function evaluateDataset(
  dataset: ExperimentDataset,
  parameter: ReturnType<typeof generateGrid>[number],
  delays: SignalGrid['reactionDelaysMinutes'],
) {
  const states = new Map<string, SignalSnapshot>();
  const alerts: ExperimentAlert[] = [];
  const seenAlertIds = new Set<string>();
  let excludedOutsideFrames = 0;
  const frames = [...dataset.frames].sort((a, b) => a.evaluatedAtSec - b.evaluatedAtSec);
  for (const frame of frames) {
    if (frame.evaluatedAtSec > dataset.endSec) break;
    // Pre-period observations warm the shared state; only their outputs and exposure are excluded.
    if (splitAt(frame.evaluatedAtSec) === 'outside') excludedOutsideFrames++;
    for (const window of frame.metrics.windows) {
      if (!dataset.selectedPoolIds.includes(window.poolId)) continue;
      const minute = window.minutes.find(
        (m) => m.minuteStartSec === Math.floor(frame.evaluatedAtSec / 60) * 60 - 60,
      );
      const decision = evaluateSignal(
        states.get(window.poolId) ?? initialSignalSnapshot(),
        {
          pool: window.pool,
          batchId: frame.batchId,
          observedAtMs: frame.observedAtMs,
          endAnchor: frame.metrics.at,
          watermarkSec: frame.evaluatedAtSec,
          metrics: window,
          coverage: minute?.status === 'closed' ? 'complete' : 'gap',
          evaluationMode: 'minute-close',
        },
        parameter.rules,
      );
      states.set(window.poolId, decision.nextSnapshot);
      for (const draft of decision.alertDrafts ??
        (decision.alertDraft ? [decision.alertDraft] : [])) {
        const sec = draft.logicalTimeSec ?? frame.evaluatedAtSec;
        if (
          sec < dataset.startSec ||
          sec >= dataset.endSec ||
          splitAt(sec) === 'outside' ||
          seenAlertIds.has(draft.id)
        )
          continue;
        seenAlertIds.add(draft.id);
        alerts.push({
          id: draft.id,
          datasetId: dataset.id,
          group: dataset.group,
          token: dataset.token,
          poolId: window.poolId,
          kind: draft.kind,
          episodeId: draft.episodeId,
          logicalTimeSec: sec,
          split: splitAt(sec),
          outcomes: dataset.targets.flatMap((target) =>
            delays.map((reactionDelayMinutes) => ({
              role: target.role,
              result: evaluateOutcomes(
                {
                  pool: target.pool,
                  triggerMinuteStartSec: Math.floor(sec / 60) * 60 - 60,
                  reactionDelayMinutes,
                },
                dataset.events,
                {
                  ...dataset.coverage,
                  endSec: splitOutcomeEnd(sec, dataset.coverage.endSec),
                  integrityComplete: dataset.coverage.integrityComplete ?? dataset.complete,
                },
              ),
            })),
          ),
        });
      }
    }
  }
  return {
    ...summarizeDataset(dataset, alerts, dataset.startSec, dataset.endSec),
    alerts,
    excludedOutsideFrames,
  };
}
function exposure(dataset: ExperimentDataset, startSec: number, endSec: number) {
  const requestedMinutes = Math.max(0, (endSec - startSec) / 60);
  startSec = Math.max(startSec, explorationStart);
  endSec = Math.min(endSec, validationEnd);
  const expectedMinutes = Math.max(0, (endSec - startSec) / 60);
  const excludedOutsideMinutes = requestedMinutes - expectedMinutes;
  const evaluated = new Set(
    dataset.frames
      .filter(
        (frame) => frame.evaluatedAtSec <= endSec && splitAt(frame.evaluatedAtSec) !== 'outside',
      )
      .flatMap((frame) =>
        frame.metrics.windows
          .filter((w) => dataset.selectedPoolIds.includes(w.poolId))
          .flatMap((w) => {
            const target = Math.floor(frame.evaluatedAtSec / 60) * 60 - 60;
            return w.minutes.find((m) => m.minuteStartSec === target)?.status === 'closed'
              ? [`${w.poolId}:${target}`]
              : [];
          }),
      ),
  );
  let coveredMinutes = 0,
    evaluatedMinutes = 0;
  const poolExposure = dataset.selectedPoolIds.map((poolId) => {
    let count = 0;
    for (let minute = startSec; minute < endSec; minute += 60) {
      const rows = dataset.coverage.minutes.filter(
        (m) => m.scopeId === dataset.coverage.scopeId && m.minuteStartSec === minute,
      );
      if (
        rows.length === 1 &&
        rows[0]!.complete &&
        minute + 60 <= dataset.coverage.endSec &&
        evaluated.has(`${poolId}:${minute}`)
      )
        count++;
    }
    return { poolId, coveredMinutes: count };
  });
  for (let minute = startSec; minute < endSec; minute += 60) {
    const rows = dataset.coverage.minutes.filter(
      (m) => m.scopeId === dataset.coverage.scopeId && m.minuteStartSec === minute,
    );
    if (rows.length === 1 && rows[0]!.complete && minute + 60 <= dataset.coverage.endSec)
      coveredMinutes++;
    if (
      dataset.selectedPoolIds.length &&
      dataset.selectedPoolIds.every((id) => evaluated.has(`${id}:${minute}`))
    )
      evaluatedMinutes++;
  }
  const hasEvaluations = dataset.frames.some(
    (frame) =>
      frame.evaluatedAtSec >= startSec &&
      frame.evaluatedAtSec < endSec &&
      frame.metrics.windows.some((w) => dataset.selectedPoolIds.includes(w.poolId)),
  );
  const complete =
    dataset.complete &&
    dataset.coverage.integrityComplete !== false &&
    expectedMinutes > 0 &&
    dataset.selectedPoolIds.length > 0 &&
    coveredMinutes === expectedMinutes &&
    evaluatedMinutes === expectedMinutes;
  return {
    expectedMinutes,
    excludedOutsideMinutes,
    coveredMinutes,
    evaluatedMinutes,
    poolExposure,
    hasEvaluations,
    complete,
  };
}
function summarizeDataset(
  dataset: ExperimentDataset,
  alerts: readonly ExperimentAlert[],
  startSec: number,
  endSec: number,
) {
  const measured = exposure(dataset, startSec, endSec);
  const episodes = new Set(
    alerts
      .filter((a) => ['candidate', 'hot', 'reheat'].includes(a.kind))
      .map((a) => a.poolId + ':' + a.episodeId),
  ).size;
  const observed = measured.hasEvaluations || alerts.length > 0;
  return {
    id: dataset.id,
    group: dataset.group,
    token: dataset.token,
    startSec,
    endSec,
    status: measured.complete ? ('complete' as const) : ('incomplete' as const),
    observedAlarmCount: observed ? alerts.length : null,
    alarmCount: measured.complete ? alerts.length : null,
    episodeCount: measured.complete ? episodes : null,
    observedEpisodeCount: observed ? episodes : null,
    ...measured,
    exposure: { startSec, endSec, ...measured },
    notificationsPerHour: measured.complete
      ? alerts.length / (measured.expectedMinutes / 60)
      : null,
  };
}
/** One earliest alert per source-pool episode, target, and delay. Shared target
 * windows can still overlap: these descriptive observations are not iid samples. */
function distributions(alerts: readonly ExperimentAlert[]) {
  const observations = new Map<
    string,
    { alert: ExperimentAlert; outcome: ExperimentAlert['outcomes'][number] }
  >();
  for (const alert of [...alerts].sort((a, b) => a.logicalTimeSec - b.logicalTimeSec)) {
    if (!['candidate', 'hot', 'reheat'].includes(alert.kind)) continue;
    for (const outcome of alert.outcomes) {
      const key = [
        alert.datasetId,
        alert.poolId,
        alert.episodeId,
        outcome.role,
        outcome.result.poolId,
        outcome.result.reactionDelayMinutes,
      ].join(':');
      if (!observations.has(key)) observations.set(key, { alert, outcome });
    }
  }
  const groups = new Map<
    string,
    {
      role: 'meme-rwa' | 'rwa-usdg';
      poolId: string;
      reactionDelayMinutes: 0 | 1 | 5;
      outcomes: Outcome[];
    }
  >();
  for (const { outcome } of observations.values()) {
    const key = [outcome.role, outcome.result.poolId, outcome.result.reactionDelayMinutes].join(
      ':',
    );
    const group = groups.get(key) ?? {
      role: outcome.role,
      poolId: outcome.result.poolId,
      reactionDelayMinutes: outcome.result.reactionDelayMinutes,
      outcomes: [],
    };
    group.outcomes.push(outcome.result);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) =>
    ([15, 60, 180] as const).map((horizonMinutes) => {
      const windows = group.outcomes.flatMap((o) =>
        o.windows.filter((w) => w.horizonMinutes === horizonMinutes),
      );
      const values = windows
        .flatMap((w) => (w.usdMicros === null ? [] : [w.usdMicros]))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const active = windows.flatMap((w) => (w.activeMinutes === null ? [] : [w.activeMinutes]));
      return {
        role: group.role,
        poolId: group.poolId,
        reactionDelayMinutes: group.reactionDelayMinutes,
        horizonMinutes,
        n: values.length,
        total: windows.length,
        minUsdMicros: values[0] ?? null,
        maxUsdMicros: values.at(-1) ?? null,
        complete: windows.filter((w) => w.status === 'complete').length,
        incomplete: windows.filter((w) => w.incomplete).length,
        censored: windows.filter((w) => w.censored).length,
        activeMinutesRange: active.length
          ? { min: Math.min(...active), max: Math.max(...active) }
          : null,
        sampleUnit: 'earliest-source-pool-episode-alert',
        independentSamples: false,
      };
    }),
  );
}
/** Reuses rules-independent offline P3 frames; every grid row is retained. */
export function compareExperiments(datasets: readonly ExperimentDataset[], value: SignalGrid) {
  const grid = gridSchema.parse(value);
  const parameters = generateGrid(grid);
  const baseline = parameters[0]
    ? datasets.map((d) => evaluateDataset(d, { ...parameters[0]!, rules: initialSignalConfig }, []))
    : [];
  return parameters.map((parameter) => {
    const results = datasets.map((d) => evaluateDataset(d, parameter, grid.reactionDelaysMinutes));
    const allAlerts = results.flatMap((r) => r.alerts);
    const splitSummaries = (['exploration', 'validation'] as const).map((split) => {
      const lo = split === 'exploration' ? explorationStart : validationStart,
        hi = split === 'exploration' ? validationStart : validationEnd;
      const rows = datasets.flatMap((d) => {
        const startSec = Math.max(d.startSec, lo),
          endSec = Math.min(d.endSec, hi);
        if (startSec >= endSec) return [];
        const alerts = allAlerts.filter((a) => a.datasetId === d.id && a.split === split);
        return [
          {
            ...summarizeDataset(d, alerts, startSec, endSec),
            outcomeDistributions: distributions(alerts),
          },
        ];
      });
      return {
        split,
        datasets: rows,
        // An aggregate is meaningful only for a single dataset: named cases and
        // cohort pools may overlap in calendar exposure and target outcomes.
        observedAlarmCount: rows.length === 1 ? rows[0]!.observedAlarmCount : null,
        alarmCount: rows.length === 1 ? rows[0]!.alarmCount : null,
        episodeCount: rows.length === 1 ? rows[0]!.episodeCount : null,
        notificationsPerHour: rows.length === 1 ? rows[0]!.notificationsPerHour : null,
      };
    });
    const dependencyRows = splitSummaries.flatMap((s) =>
      s.datasets.map((d) => ({ token: d.token, split: s.split, episodes: d.observedEpisodeCount })),
    );
    const dependencies = dependencyReport(dependencyRows);
    const firstAlertComparisons = datasets.flatMap((d, index) =>
      d.selectedPoolIds.map((poolId) => {
        const first = (alerts: readonly ExperimentAlert[]) =>
          alerts
            .filter((a) => a.poolId === poolId && ['candidate', 'hot', 'reheat'].includes(a.kind))
            .reduce<number | null>(
              (min, a) => (min === null || a.logicalTimeSec < min ? a.logicalTimeSec : min),
              null,
            );
        const candidateFirstSec = first(results[index]!.alerts),
          baselineFirstSec = first(baseline[index]!.alerts);
        return {
          datasetId: d.id,
          group: d.group,
          poolId,
          candidateFirstSec,
          baselineFirstSec,
          deltaSeconds:
            candidateFirstSec === null || baselineFirstSec === null
              ? null
              : candidateFirstSec - baselineFirstSec,
          baselineVersion: initialSignalConfig.version,
          mode: 'minute-close',
          interpretation:
            'descriptive offline emission time; positive delta means later; not earliest realtime discovery',
        };
      }),
    );
    const sensitivity = dependencies.leaveOneTokenOut.map((row) => {
      const retained = splitSummaries.map((s) => ({
        split: s.split,
        datasets: s.datasets.filter((d) => d.token.toLowerCase() !== row.excludedToken),
      }));
      const populationEpisodes = (split: StudySplit) => {
        const populations = retained
          .find((s) => s.split === split)!
          .datasets.filter((d) => d.group !== 'named-regression');
        // No cohort evidence is unavailable, even when named cases are present.
        return populations.length
          ? populations.reduce<number | null>(
              (sum, d) =>
                sum === null || d.observedEpisodeCount === null
                  ? null
                  : sum + d.observedEpisodeCount,
              0,
            )
          : null;
      };
      return {
        excludedToken: row.excludedToken,
        explorationEpisodes: populationEpisodes('exploration'),
        validationEpisodes: populationEpisodes('validation'),
        episodeCountScope: 'cohort-datasets-only',
        splitSummaries: retained,
        independentSamples: false,
      };
    });
    return {
      id: parameter.id,
      parameters: parameter.parameters,
      rules: parameter.rules,
      status:
        results.length && results.every((r) => r.status === 'complete')
          ? ('complete' as const)
          : ('incomplete' as const),
      alarmCount: results.length === 1 ? results[0]!.alarmCount : null,
      observedAlarmCount: results.length === 1 ? results[0]!.observedAlarmCount : null,
      notificationsPerHour: results.length === 1 ? results[0]!.notificationsPerHour : null,
      datasets: results,
      splitSummaries,
      firstAlertComparisons,
      dependencies: { ...dependencies, leaveOneTokenOut: sensitivity },
      quality: summarizeOutcomeQuality(
        allAlerts.flatMap((a) => a.outcomes.map((o) => o.result)),
        null,
      ),
      outcomeDistributions: splitSummaries.flatMap((s) =>
        s.datasets.flatMap((d) =>
          d.outcomeDistributions.map((o) => ({
            datasetId: d.id,
            group: d.group,
            split: s.split,
            ...o,
          })),
        ),
      ),
      feeConfidence: 'not-estimated',
      selectedAsWinner: false,
    };
  });
}
