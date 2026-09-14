import { createHash } from 'node:crypto';
import { encodeJson } from '../domain/json.js';
import type { MetricEvent, MinuteCoverage } from '../metrics/windows.js';
import { evaluateSignal, initialSignalSnapshot } from '../signals/engine.js';
import type { SignalConfig } from '../signals/config.js';
import type { SignalSnapshot } from '../signals/types.js';
import type { PoolRef } from '../domain/types.js';
import { generateGrid, gridSchema, type SignalGrid } from './experiments.js';
import { evaluateOutcomes, type Outcome } from './outcomes.js';
import type { RollingReplayEvaluation } from './rolling-replay.js';
import { studySplitAt, type StudyPeriods } from './study-config.js';

export type StudySegment = 'train' | 'validation' | 'test';

export interface StudyOutcomeSummary {
  horizonMinutes: 15 | 60 | 180;
  reactionDelayMinutes: 0 | 1 | 5;
  observations: number;
  windows: number;
  complete: number;
  incomplete: number;
  censored: number;
  usdMicrosTotal: string | null;
  swapCountTotal: number | null;
}

export interface StudySegmentReport {
  startSec: number;
  endSec: number;
  evaluations: number;
  alerts: number;
  episodes: number;
  notificationsPerHour: number | null;
  requestedMinutes: number;
  coveredMinutes: number;
  exposureComplete: boolean;
  outcomes: StudyOutcomeSummary[];
}

export interface StudyCandidateReport {
  id: string;
  parameters: {
    absolute1mUsd: number;
    multiple: number;
    confirm5mUsd: number;
    confirmationBars: number;
    cooldownSeconds: number;
  };
  rulesVersion: string;
  selectedOnTrain: boolean;
  frozenHash: string | null;
  status: 'complete' | 'incomplete';
  splits: Record<StudySegment, StudySegmentReport>;
}

export interface StudyExperimentReport {
  gridVersion: string;
  parameters: number;
  selectionRule: string;
  frozen: string[];
  candidates: StudyCandidateReport[];
  issues: string[];
}

interface CandidateAlert {
  pool: PoolRef;
  poolId: string;
  episodeId: string;
  kind: string;
  logicalTimeSec: number;
  segment: StudySegment;
}

function emptySegmentReport(): StudySegmentReport {
  return {
    startSec: 0,
    endSec: 0,
    evaluations: 0,
    alerts: 0,
    episodes: 0,
    notificationsPerHour: null,
    requestedMinutes: 0,
    coveredMinutes: 0,
    exposureComplete: false,
    outcomes: [],
  };
}

function evaluateCandidate(
  rules: SignalConfig,
  evaluations: readonly RollingReplayEvaluation[],
  periods: StudyPeriods,
): CandidateAlert[] {
  const states = new Map<string, SignalSnapshot>();
  const alerts = new Map<string, CandidateAlert>();
  for (const evaluation of evaluations) {
    const segment = studySplitAt(evaluation.at.timestampSec, periods);
    for (const window of evaluation.windows) {
      const minute = window.minutes.find(
        (item) => item.minuteStartSec === Math.floor(evaluation.at.timestampSec / 60) * 60 - 60,
      );
      const decision = evaluateSignal(
        states.get(window.poolId) ?? initialSignalSnapshot(),
        {
          pool: window.pool,
          batchId: `study-${evaluation.at.number}`,
          observedAtMs: evaluation.at.timestampSec * 1000,
          endAnchor: evaluation.at,
          watermarkSec: evaluation.at.timestampSec,
          metrics: window,
          coverage: minute?.status === 'closed' ? 'complete' : 'gap',
          evaluationMode: 'minute-close',
        },
        rules,
      );
      states.set(window.poolId, decision.nextSnapshot);
      if (segment === 'outside') continue;
      for (const draft of decision.alertDrafts ??
        (decision.alertDraft ? [decision.alertDraft] : [])) {
        const sec = draft.logicalTimeSec ?? evaluation.at.timestampSec;
        if (studySplitAt(sec, periods) !== segment) continue;
        const key = [window.poolId, draft.episodeId, draft.kind].join(':');
        const existing = alerts.get(key);
        if (existing && existing.logicalTimeSec <= sec) continue;
        alerts.set(key, {
          pool: window.pool,
          poolId: window.poolId,
          episodeId: draft.episodeId,
          kind: draft.kind,
          logicalTimeSec: sec,
          segment,
        });
      }
    }
  }
  return [...alerts.values()].sort((left, right) => left.logicalTimeSec - right.logicalTimeSec);
}

function segmentCoverage(
  coverage: readonly MinuteCoverage[],
  scopeId: string,
  startSec: number,
  endSec: number,
): { requestedMinutes: number; coveredMinutes: number } {
  const requestedMinutes = Math.max(0, (endSec - startSec) / 60);
  let coveredMinutes = 0;
  for (let sec = startSec; sec < endSec; sec += 60) {
    const rows = coverage.filter((item) => item.scopeId === scopeId && item.minuteStartSec === sec);
    if (rows.length === 1 && rows[0]!.complete && sec + 60 <= endSec) coveredMinutes++;
  }
  return { requestedMinutes, coveredMinutes };
}

function summarizeOutcomes(
  alerts: readonly CandidateAlert[],
  events: readonly MetricEvent[],
  coverage: readonly MinuteCoverage[],
  scopeId: string,
  endSec: number,
  integrityComplete: boolean,
): StudyOutcomeSummary[] {
  const groups = new Map<
    string,
    { horizon: 15 | 60 | 180; delay: 0 | 1 | 5; results: Outcome[] }
  >();
  for (const alert of alerts)
    for (const delay of [0, 1, 5] as const) {
      const outcome = evaluateOutcomes(
        {
          pool: alert.pool,
          triggerMinuteStartSec: Math.floor(alert.logicalTimeSec / 60) * 60 - 60,
          reactionDelayMinutes: delay,
        },
        events,
        { minutes: coverage, scopeId, endSec, integrityComplete },
      );
      for (const window of outcome.windows) {
        const key = `${window.horizonMinutes}:${delay}`;
        const group = groups.get(key) ?? { horizon: window.horizonMinutes, delay, results: [] };
        group.results.push(outcome);
        groups.set(key, group);
      }
    }
  return [...groups.values()]
    .map((group) => {
      const windows = group.results.flatMap((outcome) =>
        outcome.windows.filter((window) => window.horizonMinutes === group.horizon),
      );
      const completed = windows.filter((window) => window.status === 'complete');
      const usd = completed.flatMap((window) =>
        window.usdMicros === null ? [] : [window.usdMicros],
      );
      const swaps = completed.flatMap((window) =>
        window.swapCount === null ? [] : [window.swapCount],
      );
      return {
        horizonMinutes: group.horizon,
        reactionDelayMinutes: group.delay,
        observations: windows.length,
        windows: windows.length,
        complete: completed.length,
        incomplete: windows.filter((window) => window.status === 'incomplete').length,
        censored: windows.filter((window) => window.censored).length,
        usdMicrosTotal:
          completed.length > 0 && usd.length === completed.length
            ? usd.reduce((sum, value) => sum + value, 0n).toString()
            : null,
        swapCountTotal:
          completed.length > 0 && swaps.length === completed.length
            ? swaps.reduce((sum, value) => sum + value, 0)
            : null,
      };
    })
    .sort(
      (left, right) =>
        left.horizonMinutes - right.horizonMinutes ||
        left.reactionDelayMinutes - right.reactionDelayMinutes,
    );
}

/** Runs the bounded parameter grid over the same rolling frames as the live
 * rule, freezes training candidates and reports validation/test outcomes
 * clipped so a training outcome never crosses into the next segment. */
export function runStudyExperiments(options: {
  grid: unknown;
  evaluations: readonly RollingReplayEvaluation[];
  events: readonly MetricEvent[];
  coverage: readonly MinuteCoverage[];
  scopeId: string;
  periods: StudyPeriods;
  integrityComplete: boolean;
  maxFrozen?: number;
}): StudyExperimentReport {
  const grid: SignalGrid = gridSchema.parse(options.grid);
  const parameters = generateGrid(grid);
  const issues: string[] = [];
  const candidates: StudyCandidateReport[] = parameters.map((parameter) => {
    const alerts = evaluateCandidate(parameter.rules, options.evaluations, options.periods);
    const splits = {
      train: emptySegmentReport(),
      validation: emptySegmentReport(),
      test: emptySegmentReport(),
    } as Record<StudySegment, StudySegmentReport>;
    for (const segment of ['train', 'validation', 'test'] as const) {
      const period = options.periods[segment];
      const inSegment = alerts.filter((alert) => alert.segment === segment);
      const evaluations = options.evaluations.filter((evaluation) => {
        const split = studySplitAt(evaluation.at.timestampSec, options.periods);
        return split === segment;
      }).length;
      const { requestedMinutes, coveredMinutes } = segmentCoverage(
        options.coverage,
        options.scopeId,
        period.startSec,
        period.endSec,
      );
      const episodes = new Set(inSegment.map((alert) => alert.poolId + ':' + alert.episodeId)).size;
      const exposureComplete =
        requestedMinutes > 0 && coveredMinutes === requestedMinutes && options.integrityComplete;
      splits[segment] = {
        startSec: period.startSec,
        endSec: period.endSec,
        evaluations,
        alerts: inSegment.length,
        episodes,
        notificationsPerHour: exposureComplete ? inSegment.length / (requestedMinutes / 60) : null,
        requestedMinutes,
        coveredMinutes,
        exposureComplete,
        outcomes:
          inSegment.length === 0
            ? []
            : summarizeOutcomes(
                inSegment,
                options.events,
                options.coverage,
                options.scopeId,
                Math.min(period.endSec, options.coverage.at(-1)?.minuteStartSec ?? period.endSec),
                options.integrityComplete,
              ),
      };
    }
    const complete = (['train', 'validation', 'test'] as const).every(
      (segment) => splits[segment].exposureComplete,
    );
    return {
      id: parameter.id,
      parameters: parameter.parameters,
      rulesVersion: parameter.rules.version,
      selectedOnTrain: false,
      frozenHash: null,
      status: complete ? ('complete' as const) : ('incomplete' as const),
      splits,
    };
  });
  const incomplete = candidates.filter((candidate) => candidate.status === 'incomplete').length;
  if (incomplete > 0) issues.push(`candidate-exposure-incomplete:${incomplete}`);
  const ranked = candidates
    .filter(
      (candidate) => candidate.splits.train.exposureComplete && candidate.splits.train.episodes > 0,
    )
    .sort(
      (left, right) =>
        right.splits.train.episodes - left.splits.train.episodes ||
        left.splits.train.alerts - right.splits.train.alerts ||
        left.id.localeCompare(right.id),
    );
  const frozen = ranked.slice(0, options.maxFrozen ?? 3).map((candidate) => candidate.id);
  for (const candidate of candidates) {
    if (!frozen.includes(candidate.id)) continue;
    candidate.selectedOnTrain = true;
    candidate.frozenHash = createHash('sha256')
      .update(encodeJson({ id: candidate.id, parameters: candidate.parameters }))
      .digest('hex');
  }
  if (frozen.length === 0) issues.push('no-train-candidate-frozen');
  return {
    gridVersion: grid.version,
    parameters: candidates.length,
    selectionRule:
      'train episodes per hour desc, then train alerts asc, then id; frozen candidates are replayed unchanged on validation and test',
    frozen,
    candidates,
    issues,
  };
}
