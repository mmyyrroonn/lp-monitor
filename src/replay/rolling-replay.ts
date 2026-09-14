import type { BlockAnchor, LogTime, PoolRef } from '../domain/types.js';
import {
  buildRollingMetrics,
  inRollingWindow,
  ROLLING_DURATIONS,
  type RollingWindowName,
} from '../metrics/rolling.js';
import type { MetricEvent, MinuteCoverage, PoolMetricWindows } from '../metrics/windows.js';
import { studySplitAt, type StudyPeriods } from './study-config.js';

export interface RollingWindowResult {
  fromSec: number;
  toSec: number;
  selected: MetricEvent[];
  unknown: MetricEvent[];
}

export function rollingWindow(
  events: readonly MetricEvent[],
  duration: RollingWindowName | number,
  atSec: number,
): RollingWindowResult {
  const durationSec = typeof duration === 'number' ? duration : ROLLING_DURATIONS[duration];
  if (!Number.isSafeInteger(durationSec) || durationSec <= 0 || !Number.isSafeInteger(atSec))
    throw new RangeError('Rolling window requires positive duration and safe time');
  const fromSec = atSec - durationSec;
  const selected: MetricEvent[] = [];
  const unknown: MetricEvent[] = [];
  for (const event of events) {
    const result = inRollingWindow(event.event.time, fromSec, atSec, true);
    if (result === true) selected.push(event);
    else if (result === null) unknown.push(event);
  }
  return { fromSec, toSec: atSec, selected, unknown };
}

export interface RollingReplayEvaluation {
  at: BlockAnchor;
  split: 'train' | 'validation' | 'test' | 'outside' | null;
  windows: PoolMetricWindows[];
  unknown: boolean;
}

export interface RollingReplayOptions {
  events: readonly MetricEvent[];
  coverage: readonly MinuteCoverage[];
  watermarks: readonly BlockAnchor[];
  mode?: 'chain-time' | 'recorded-observed';
  cadenceSec?: number;
  periods?: StudyPeriods;
  pools?: readonly { pool: PoolRef; discoveredAtBlock: bigint | null; rawToken: string | null }[];
  minimumOneMinuteSamples?: number;
  minimumFiveMinuteSamples?: number;
}

export interface RollingReplayResult {
  version: 1;
  mode: 'chain-time' | 'recorded-observed';
  cadenceSec: number;
  effectiveCadenceSec: number | null;
  cadenceGapCount: number;
  cadenceGaps: CadenceGap[];
  evaluations: RollingReplayEvaluation[];
  issues: string[];
}

export interface CadenceGap {
  fromSec: number;
  toSec: number;
}

export interface CadencePlan {
  points: BlockAnchor[];
  requestedCadenceSec: number;
  effectiveCadenceSec: number | null;
  gaps: CadenceGap[];
  unprovable: boolean;
}

const MAX_REPORTED_CADENCE_GAPS = 32;

/** A single interval at the requested spacing does not prove the plan; every
 * consecutive pair must meet the cadence or the uncovered interval is reported. */
function cadenceGaps(points: readonly BlockAnchor[], cadenceSec: number): CadenceGap[] {
  const gaps: CadenceGap[] = [];
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    if (current.timestampSec - previous.timestampSec > cadenceSec)
      gaps.push({ fromSec: previous.timestampSec + cadenceSec, toSec: current.timestampSec });
  }
  return gaps;
}

function minimumSpacing(points: readonly BlockAnchor[]): number | null {
  let minimum: number | null = null;
  for (let index = 1; index < points.length; index++) {
    const gap = points[index]!.timestampSec - points[index - 1]!.timestampSec;
    if (gap > 0 && (minimum === null || gap < minimum)) minimum = gap;
  }
  return minimum;
}

/** Evaluation points must come from provable chain time. Minute watermarks and
 * exact event timestamps are used; when the requested cadence cannot be met the
 * plan says so instead of fabricating intermediate anchors. */
export function cadenceWatermarks(
  watermarks: readonly BlockAnchor[],
  events: readonly MetricEvent[],
  cadenceSec: number,
  mode: 'chain-time' | 'recorded-observed' = 'chain-time',
): CadencePlan {
  if (!Number.isSafeInteger(cadenceSec) || cadenceSec <= 0)
    throw new RangeError('Rolling replay cadence must be a positive safe integer');
  if (mode === 'recorded-observed') {
    const gaps = cadenceGaps(watermarks, cadenceSec);
    return {
      points: [...watermarks],
      requestedCadenceSec: cadenceSec,
      effectiveCadenceSec: minimumSpacing(watermarks),
      gaps,
      unprovable: gaps.length > 0,
    };
  }
  const candidates: BlockAnchor[] = [...watermarks];
  for (const event of events) {
    if (event.event.time.exactTimestampSec === null) continue;
    candidates.push({
      number: event.event.ref.blockNumber,
      hash: event.event.ref.blockHash,
      timestampSec: event.event.time.exactTimestampSec,
    });
  }
  const byTimestamp = new Map<number, BlockAnchor>();
  for (const point of candidates) {
    const existing = byTimestamp.get(point.timestampSec);
    if (!existing || point.number > existing.number) byTimestamp.set(point.timestampSec, point);
  }
  const sorted = [...byTimestamp.values()].sort((left, right) =>
    left.timestampSec !== right.timestampSec
      ? left.timestampSec - right.timestampSec
      : left.number < right.number
        ? -1
        : left.number > right.number
          ? 1
          : 0,
  );
  const points: BlockAnchor[] = [];
  for (const point of sorted) {
    const last = points.at(-1);
    // Keep the first provable point of each cadence bucket and skip the rest.
    if (last && point.timestampSec - last.timestampSec < cadenceSec) continue;
    points.push(point);
  }
  const gaps = cadenceGaps(points, cadenceSec);
  return {
    points,
    requestedCadenceSec: cadenceSec,
    effectiveCadenceSec: minimumSpacing(points),
    gaps,
    unprovable: gaps.length > 0,
  };
}

function orderedWatermarks(
  watermarks: readonly BlockAnchor[],
  mode: RollingReplayOptions['mode'],
): BlockAnchor[] {
  const result =
    mode === 'recorded-observed'
      ? [...watermarks]
      : [...watermarks].sort((a, b) => {
          if (a.timestampSec !== b.timestampSec) return a.timestampSec - b.timestampSec;
          return a.number < b.number ? -1 : a.number > b.number ? 1 : 0;
        });
  for (let index = 1; index < result.length; index++) {
    const previous = result[index - 1]!;
    const current = result[index]!;
    if (current.number < previous.number || current.timestampSec < previous.timestampSec)
      throw new Error('Rolling replay watermark moves backwards');
  }
  return result;
}

export function runRollingReplay(options: RollingReplayOptions): RollingReplayResult {
  const mode = options.mode ?? 'chain-time';
  const cadenceSec = options.cadenceSec ?? 10;
  if (!Number.isSafeInteger(cadenceSec) || cadenceSec <= 0)
    throw new RangeError('Rolling replay cadence must be a positive safe integer');
  const ordered = orderedWatermarks(options.watermarks, mode);
  const plan = cadenceWatermarks(ordered, options.events, cadenceSec, mode);
  const watermarks = orderedWatermarks(plan.points, mode);
  const evaluations: RollingReplayEvaluation[] = [];
  const issues: string[] = [];
  const cadenceGapCount = plan.gaps.length;
  if (plan.unprovable) {
    const first = plan.gaps[0]!;
    issues.push(
      `evaluation-cadence-unprovable: requested ${cadenceSec}s, minimum spacing ${plan.effectiveCadenceSec ?? 'unknown'}s, ${cadenceGapCount} uncovered interval(s), first ${first.fromSec}-${first.toSec}`,
    );
  }
  let previousAt = -Infinity;
  for (const watermark of watermarks) {
    if (watermark.timestampSec < previousAt) throw new Error('Rolling replay time moves backwards');
    previousAt = watermark.timestampSec;
    const events = options.events.filter(
      (event) =>
        event.event.ref.blockNumber <= watermark.number &&
        (event.event.time.exactTimestampSec === null ||
          event.event.time.exactTimestampSec <= watermark.timestampSec),
    );
    const coverage = options.coverage.filter(
      (item) => item.minuteStartSec <= Math.floor(watermark.timestampSec / 60) * 60,
    );
    const windows = buildRollingMetrics(events, coverage, watermark, {
      pools: options.pools,
      minimumOneMinuteSamples: options.minimumOneMinuteSamples,
      minimumFiveMinuteSamples: options.minimumFiveMinuteSamples,
    });
    const unknown = windows.some((window) =>
      Object.values(window.rolling ?? {}).some((metric) => metric.status !== 'closed'),
    );
    evaluations.push({
      at: watermark,
      split: options.periods ? studySplitAt(watermark.timestampSec, options.periods) : null,
      windows,
      unknown,
    });
    if (mode === 'chain-time' && evaluations.length > 1) {
      const prior = evaluations[evaluations.length - 2]!.at;
      if (watermark.timestampSec - prior.timestampSec < cadenceSec)
        issues.push('evaluation-cadence-irregular');
    }
  }
  if (mode === 'recorded-observed' && options.watermarks.length === 0)
    issues.push('recorded-observed-no-evaluations');
  return {
    version: 1,
    mode,
    cadenceSec,
    effectiveCadenceSec: plan.effectiveCadenceSec,
    cadenceGapCount,
    cadenceGaps: plan.gaps.slice(0, MAX_REPORTED_CADENCE_GAPS),
    evaluations,
    issues,
  };
}

export const rollingReplay = runRollingReplay;
export type RollingReplayLogTime = LogTime;
