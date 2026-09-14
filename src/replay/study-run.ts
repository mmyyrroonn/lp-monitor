import { createHash } from 'node:crypto';
import { encodeJson } from '../domain/json.js';
import type { MetricEvent, MinuteCoverage } from '../metrics/windows.js';
import { evaluateSignal, initialSignalSnapshot } from '../signals/engine.js';
import type { SignalConfig } from '../signals/config.js';
import type { SignalSnapshot } from '../signals/types.js';
import type { PoolRef } from '../domain/types.js';
import { rawLogKey } from '../storage/manifest.js';
import { poolRegistrationId } from '../registry/pools.js';
import { generateGrid, gridSchema, type SignalGrid } from './experiments.js';
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
  /** Weakest complete window, used by the declared forward-effect criteria. */
  minimumUsdMicros: string | null;
  minimumSwapCount: number | null;
  minimumRelativeMultiple: number | null;
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

/** Study periods are arbitrary seconds while coverage is minute based, so every
 * minute slot that intersects the period must have exactly one complete record. */
function segmentCoverage(
  coverage: readonly MinuteCoverage[],
  scopeId: string,
  startSec: number,
  endSec: number,
): { requestedMinutes: number; coveredMinutes: number } {
  let requestedMinutes = 0;
  let coveredMinutes = 0;
  for (let sec = Math.floor(startSec / 60) * 60; sec < endSec; sec += 60) {
    requestedMinutes++;
    const rows = coverage.filter((item) => item.scopeId === scopeId && item.minuteStartSec === sec);
    if (rows.length === 1 && rows[0]!.complete) coveredMinutes++;
  }
  return { requestedMinutes, coveredMinutes };
}

export interface StudyOutcomeWindow {
  horizonMinutes: 15 | 60 | 180;
  startSec: number;
  endSec: number;
  status: 'complete' | 'incomplete' | 'censored';
  incomplete: boolean;
  censored: boolean;
  reasons: string[];
  coveredMinutes: number;
  expectedMinutes: number;
  usdMicros: bigint | null;
  swapCount: number | null;
  txCount: number | null;
  activeMinutes: number | null;
  longestActiveRunMinutes: number | null;
  observedSwapCount: number;
  observedTxCount: number;
  /** Same-duration window immediately before the trigger, when evaluable. */
  baselineUsdMicros: bigint | null;
  relativeMultiple: number | null;
}

interface WindowEvidence {
  reasons: Set<string>;
  expectedMinutes: number;
  coveredMinutes: number;
  events: MetricEvent[];
}

/** Neither edge of a window can rely on a minute that only partially overlaps
 * it; such events stay unknown instead of being counted as inside. */
function collectWindowEvidence(
  fromSec: number,
  toSec: number,
  candidates: readonly MetricEvent[],
  coverage: {
    minutes: readonly MinuteCoverage[];
    scopeId: string;
    endSec: number;
  },
): WindowEvidence {
  const reasons = new Set<string>();
  let expectedMinutes = 0;
  let coveredMinutes = 0;
  const verifiedEnd = Math.min(toSec, coverage.endSec);
  for (let minute = Math.floor(fromSec / 60) * 60; minute < verifiedEnd; minute += 60) {
    expectedMinutes++;
    const rows = coverage.minutes.filter(
      (item) => item.scopeId === coverage.scopeId && item.minuteStartSec === minute,
    );
    if (rows.length === 1 && rows[0]!.complete) coveredMinutes++;
    else
      reasons.add(
        rows.length === 0
          ? 'missing-minute'
          : rows.length > 1
            ? 'duplicate-minute'
            : 'incomplete-minute',
      );
  }
  const unique = new Map<string, MetricEvent>();
  for (const event of candidates) {
    const time = event.event.time;
    if (time.exactTimestampSec !== null) {
      if (time.exactTimestampSec < fromSec || time.exactTimestampSec >= toSec) continue;
    } else if (time.minuteStartSec !== null) {
      // Fully outside on either side says nothing about this window; only a
      // minute that actually straddles an edge is unprovable here.
      if (time.minuteStartSec + 60 <= fromSec) continue;
      if (time.minuteStartSec >= toSec) continue;
      if (time.minuteStartSec < fromSec || time.minuteStartSec + 60 > toSec) {
        reasons.add('unresolved-event-time');
        continue;
      }
    } else {
      reasons.add('unresolved-event-time');
      continue;
    }
    const key = rawLogKey(event.event.ref);
    const previous = unique.get(key);
    if (previous && encodeJson(previous) !== encodeJson(event)) reasons.add('conflicting-event');
    else unique.set(key, event);
  }
  return { reasons, expectedMinutes, coveredMinutes, events: [...unique.values()] };
}

/** Study outcome windows start at the actual trigger second plus the reaction
 * delay. Events with only minute precision that straddle that second stay
 * unknown instead of being counted as post-trigger activity. */
export function evaluateStudyOutcomeWindows(
  triggerSec: number,
  pool: PoolRef,
  reactionDelayMinutes: 0 | 1 | 5,
  futureEvents: readonly MetricEvent[],
  coverage: {
    minutes: readonly MinuteCoverage[];
    scopeId: string;
    endSec: number;
    integrityComplete: boolean;
  },
): StudyOutcomeWindow[] {
  if (!Number.isSafeInteger(triggerSec) || triggerSec < 0)
    throw new RangeError('Study outcome trigger must be a non-negative safe second');
  const poolId = poolRegistrationId({ pool });
  const startSec = triggerSec + reactionDelayMinutes * 60;
  const candidates = futureEvents.filter(
    (event) =>
      event.event.kind === 'swap' &&
      event.event.pool !== null &&
      poolRegistrationId({ pool: event.event.pool }) === poolId &&
      (event.scopeId === undefined || event.scopeId === coverage.scopeId),
  );
  const usdTotal = (events: readonly MetricEvent[]): bigint | null =>
    events.every((event) => event.usdMicros !== null)
      ? events.reduce((sum, event) => sum + event.usdMicros!, 0n)
      : null;
  const evaluable = (evidence: WindowEvidence): boolean =>
    evidence.reasons.size === 0 && evidence.coveredMinutes === evidence.expectedMinutes;
  return ([15, 60, 180] as const).map((horizonMinutes) => {
    const endSec = startSec + horizonMinutes * 60;
    const censored = endSec > coverage.endSec;
    const boundEnd = Math.min(endSec, coverage.endSec);
    const forward = collectWindowEvidence(startSec, boundEnd, candidates, coverage);
    const reasons = new Set(forward.reasons);
    if (coverage.integrityComplete === false) reasons.add('input-integrity-incomplete');
    const incomplete = reasons.size > 0;
    const complete = !incomplete && !censored && forward.coveredMinutes === forward.expectedMinutes;
    const events = forward.events;
    const transactions = new Set(
      events.map((event) => event.event.ref.transactionHash.toLowerCase()),
    );
    const active = new Set(events.flatMap((event) => event.event.time.minuteStartSec ?? []));
    // Iterate the same minute slots as the coverage check so the last
    // intersecting minute is never dropped from the persistence statistics.
    let longest = 0;
    let run = 0;
    for (let minute = Math.floor(startSec / 60) * 60; minute < boundEnd; minute += 60) {
      run = active.has(minute) ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    // The baseline is the window immediately before the trigger itself; only the
    // forward window moves with the reaction delay.
    const baselineFrom = triggerSec - horizonMinutes * 60;
    const baseline =
      baselineFrom >= 0
        ? collectWindowEvidence(baselineFrom, triggerSec, candidates, coverage)
        : null;
    const forwardUsd = complete ? usdTotal(events) : null;
    const baselineUsd = baseline && evaluable(baseline) ? usdTotal(baseline.events) : null;
    return {
      horizonMinutes,
      startSec,
      endSec,
      status: incomplete ? 'incomplete' : censored ? 'censored' : 'complete',
      incomplete,
      censored,
      reasons: [...reasons, ...(censored ? ['right-censored'] : [])].sort(),
      coveredMinutes: forward.coveredMinutes,
      expectedMinutes: forward.expectedMinutes,
      usdMicros: forwardUsd,
      swapCount: complete ? events.length : null,
      txCount: complete ? transactions.size : null,
      activeMinutes: complete ? active.size : null,
      longestActiveRunMinutes: complete ? longest : null,
      observedSwapCount: events.length,
      observedTxCount: transactions.size,
      baselineUsdMicros: baselineUsd,
      relativeMultiple:
        forwardUsd !== null && baselineUsd !== null && baselineUsd > 0n
          ? Number(forwardUsd) / Number(baselineUsd)
          : null,
    };
  });
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
    { horizon: 15 | 60 | 180; delay: 0 | 1 | 5; windows: StudyOutcomeWindow[] }
  >();
  for (const alert of alerts)
    for (const delay of [0, 1, 5] as const) {
      const windows = evaluateStudyOutcomeWindows(alert.logicalTimeSec, alert.pool, delay, events, {
        minutes: coverage,
        scopeId,
        endSec,
        integrityComplete,
      });
      for (const window of windows) {
        const key = `${window.horizonMinutes}:${delay}`;
        const group = groups.get(key) ?? { horizon: window.horizonMinutes, delay, windows: [] };
        group.windows.push(window);
        groups.set(key, group);
      }
    }
  return [...groups.values()]
    .map((group) => {
      const windows = group.windows;
      const completed = windows.filter((window) => window.status === 'complete');
      const usd = completed.flatMap((window) =>
        window.usdMicros === null ? [] : [window.usdMicros],
      );
      const swaps = completed.flatMap((window) =>
        window.swapCount === null ? [] : [window.swapCount],
      );
      const multiples = completed.flatMap((window) =>
        window.relativeMultiple === null ? [] : [window.relativeMultiple],
      );
      return {
        horizonMinutes: group.horizon,
        reactionDelayMinutes: group.delay,
        observations: group.windows.length,
        windows: group.windows.length,
        complete: completed.length,
        incomplete: group.windows.filter((window) => window.status === 'incomplete').length,
        censored: group.windows.filter((window) => window.censored).length,
        usdMicrosTotal:
          completed.length > 0 && usd.length === completed.length
            ? usd.reduce((sum, value) => sum + value, 0n).toString()
            : null,
        swapCountTotal:
          completed.length > 0 && swaps.length === completed.length
            ? swaps.reduce((sum, value) => sum + value, 0)
            : null,
        minimumUsdMicros:
          completed.length > 0 && usd.length === completed.length
            ? usd.reduce((min, value) => (value < min ? value : min)).toString()
            : null,
        minimumSwapCount:
          completed.length > 0 && swaps.length === completed.length
            ? swaps.reduce((min, value) => (value < min ? value : min))
            : null,
        minimumRelativeMultiple:
          completed.length > 0 && multiples.length === completed.length
            ? multiples.reduce((min, value) => (value < min ? value : min))
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
