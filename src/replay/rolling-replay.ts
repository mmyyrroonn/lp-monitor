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
  evaluations: RollingReplayEvaluation[];
  issues: string[];
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
  const watermarks = orderedWatermarks(options.watermarks, mode);
  const evaluations: RollingReplayEvaluation[] = [];
  const issues: string[] = [];
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
  return { version: 1, mode, cadenceSec, evaluations, issues };
}

export const rollingReplay = runRollingReplay;
export type RollingReplayLogTime = LogTime;
