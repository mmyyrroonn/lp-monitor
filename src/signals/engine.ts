import { createHash } from 'node:crypto';
import { poolRegistrationId } from '../registry/pools.js';
import type { AggregateMetric, MinuteMetric } from '../metrics/windows.js';
import { meetsMultiple, signalBaseline, type BaselineSample } from './baseline.js';
import { signalConfigVersion, type SignalConfig } from './config.js';
import type { AlertKind, RuleMatch, SignalDecision, SignalInput, SignalSnapshot } from './types.js';
export function initialSignalSnapshot(): SignalSnapshot {
  return {
    state: 'watch',
    episodeId: null,
    configVersion: null,
    lastAlertSec: null,
    lastAlertVolume: null,
    lastAlertScale: null,
    lastFiveEndSec: null,
    lowBuckets: 0,
    entryThreshold: null,
    lastAlertKind: null,
    alertSequence: 0,
  };
}
function sample(m: MinuteMetric | AggregateMetric): BaselineSample {
  return {
    startSec: 'startSec' in m ? m.startSec : m.minuteStartSec,
    endSec: 'endSec' in m ? m.endSec : m.minuteStartSec + 60,
    status: m.status,
    value: m.usdMicros ?? m.rawNotional?.raw ?? null,
    unit:
      m.usdMicros !== null
        ? 'usdMicros'
        : m.rawNotional
          ? `raw:${m.rawNotional.token.toLowerCase()}`
          : null,
  };
}
const empty = (startSec: number, duration: number): BaselineSample => ({
  startSec,
  endSec: startSec + duration,
  status: 'warming',
  value: null,
  unit: null,
});
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function evaluateSignal(
  previous: SignalSnapshot,
  input: SignalInput,
  config: SignalConfig,
): SignalDecision {
  const version = signalConfigVersion(config);
  const next = {
    ...(previous.configVersion !== null && previous.configVersion !== version
      ? initialSignalSnapshot()
      : previous),
    configVersion: version,
  };
  const partial = input.metrics.partialCurrent;
  const currentMinute = Math.floor(input.watermarkSec / 60) * 60;
  const minute =
    partial && partial.minuteStartSec === currentMinute && partial.status === 'partial'
      ? partial
      : null;
  const five = input.metrics.natural5mBuckets
    .filter(
      (b) =>
        b.status === 'closed' &&
        b.startSec % 300 === 0 &&
        b.endSec - b.startSec === 300 &&
        b.endSec <= input.watermarkSec,
    )
    .sort((a, b) => a.startSec - b.startSec);
  const latest = five.at(-1) ?? null;
  const baseline = {
    minute: signalBaseline(
      minute ? sample(minute) : empty(currentMinute, 60),
      input.metrics.minutes.map(sample),
      config.candidate.samples,
    ),
    fiveMinute: signalBaseline(
      latest ? sample(latest) : empty(currentMinute, 300),
      five.map(sample),
      config.confirmRelative.samples,
    ),
  };
  const absoluteMinute =
    minute?.usdMicros !== null &&
    minute?.usdMicros !== undefined &&
    minute.usdMicros >= BigInt(config.candidate.threshold);
  const candidate =
    config.candidate.enabled &&
    absoluteMinute &&
    (baseline.minute.status === 'warming' ||
      baseline.minute.status === 'zero-baseline' ||
      meetsMultiple(minute!.usdMicros, baseline.minute, config.candidate.multiple));
  const relative =
    config.confirmRelative.enabled &&
    latest?.usdMicros !== null &&
    latest?.usdMicros !== undefined &&
    latest.usdMicros >= BigInt(config.confirmRelative.threshold) &&
    meetsMultiple(latest.usdMicros, baseline.fiveMinute, config.confirmRelative.multiple);
  const prevFive = five.at(-2);
  const consecutive =
    config.confirmConsecutive.enabled &&
    latest !== null &&
    prevFive !== undefined &&
    prevFive.endSec === latest.startSec &&
    latest.usdMicros !== null &&
    prevFive.usdMicros !== null &&
    latest.usdMicros >= BigInt(config.confirmConsecutive.threshold) &&
    prevFive.usdMicros >= BigInt(config.confirmConsecutive.threshold);
  const matches: RuleMatch[] = [
    {
      ruleId: 'candidate',
      version: config.candidate.version,
      matched: !!candidate,
      reason: 'minute-absolute-and-relative',
    },
    {
      ruleId: 'confirmRelative',
      version: config.confirmRelative.version,
      matched: !!relative,
      reason: 'natural5m-absolute-and-relative',
    },
    {
      ruleId: 'confirmConsecutive',
      version: config.confirmConsecutive.version,
      matched: !!consecutive,
      reason: 'two-consecutive-natural5m',
    },
  ];
  const noAlert = (): SignalDecision => ({ nextSnapshot: next, alertDraft: null, matches });
  if (input.coverage === 'gap' || input.coverage === 'rechecking') {
    next.lowBuckets = 0;
    return noAlert();
  }
  const fresh =
    latest !== null &&
    latest.endSec === Math.floor(input.watermarkSec / 300) * 300 &&
    (next.lastFiveEndSec === null || latest.endSec > next.lastFiveEndSec);
  let cooled = false;
  if (fresh) {
    for (const b of five.filter((b) =>
      next.lastFiveEndSec === null ? b === latest : b.endSec > next.lastFiveEndSec,
    )) {
      const adjacent = next.lastFiveEndSec !== null && b.startSec === next.lastFiveEndSec;
      const low =
        next.state === 'hot' &&
        next.entryThreshold !== null &&
        b.usdMicros !== null &&
        b.usdMicros * 100n < next.entryThreshold * BigInt(config.cooling.threshold);
      next.lowBuckets = low ? (adjacent ? next.lowBuckets : 0) + 1 : 0;
      next.lastFiveEndSec = b.endSec;
      if (config.cooling.enabled && next.lowBuckets >= config.cooling.buckets) {
        next.state = 'cooling';
        cooled = true;
      }
    }
  }
  const upgrade =
    fresh &&
    next.state === 'hot' &&
    config.upgrade.enabled &&
    next.lastAlertScale === '5m' &&
    latest?.usdMicros !== null &&
    latest?.usdMicros !== undefined &&
    next.lastAlertVolume !== null &&
    latest.usdMicros >= next.lastAlertVolume * BigInt(config.upgrade.threshold);
  let kind: AlertKind | null = null;
  let volume: bigint | null = null;
  let scale: '1m' | '5m' = '5m';
  const reasons: string[] = [];
  if (fresh && (relative || consecutive || upgrade)) {
    kind = next.state === 'cooling' ? 'reheat' : 'hot';
    volume = latest!.usdMicros;
    if (relative) reasons.push('confirmRelative');
    if (consecutive) reasons.push('confirmConsecutive');
  } else if (cooled) {
    kind = 'cooling';
    volume = latest!.usdMicros;
    reasons.push('three-complete-low-natural5m');
  } else if (candidate && next.state !== 'hot') {
    kind = 'candidate';
    volume = minute!.usdMicros;
    scale = '1m';
    reasons.push('candidate');
    if (baseline.minute.status !== 'ready') reasons.push(`${baseline.minute.status}/absolute-only`);
    reasons.push('partial');
  }
  if (kind === null) return noAlert();

  const sameLevel =
    (kind === 'hot' && next.state === 'hot') ||
    (kind === 'candidate' && (next.state === 'candidate' || next.lastAlertKind === 'candidate'));
  if (
    sameLevel &&
    !upgrade &&
    config.cooldown.enabled &&
    next.lastAlertSec !== null &&
    input.watermarkSec - next.lastAlertSec < config.cooldown.threshold
  )
    return noAlert();
  if (upgrade) reasons.push('upgrade');
  if (next.episodeId === null || kind === 'reheat')
    next.episodeId = hash([
      input.epoch ?? '',
      version,
      poolRegistrationId({ pool: input.pool }),
      input.batchId,
      input.endAnchor.hash,
      kind,
    ]);
  next.alertSequence++;
  const id = hash([
    input.pool.chainId,
    poolRegistrationId({ pool: input.pool }),
    version,
    next.episodeId,
    kind,
  ]);
  if (kind === 'hot' || kind === 'reheat') {
    if (next.state !== 'hot')
      next.entryThreshold = BigInt(
        relative ? config.confirmRelative.threshold : config.confirmConsecutive.threshold,
      );
    next.state = 'hot';
  } else if (kind === 'candidate' && next.state !== 'cooling') next.state = 'candidate';
  next.lastAlertSec = input.watermarkSec;
  next.lastAlertVolume = volume;
  next.lastAlertScale = scale;
  next.lastAlertKind = kind;
  return {
    nextSnapshot: next,
    matches,
    alertDraft: {
      id,
      revision: 1,
      status: 'provisional',
      kind,
      pool: input.pool,
      poolId: poolRegistrationId({ pool: input.pool }),
      ruleVersion: version,
      episodeId: next.episodeId,
      atBatchId: input.batchId,
      observedAtMs: input.observedAtMs,
      endAnchor: input.endAnchor,
      watermarkSec: input.watermarkSec,
      reasons,
      metrics: input.metrics,
      coverage: input.coverage,
      presentation: input.presentation,
      baseline,
    },
  };
}
