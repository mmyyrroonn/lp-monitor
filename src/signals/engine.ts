import type { RollingMetric } from '../metrics/rolling.js';
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
function evaluateOne(
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
  if (
    input.coverage !== 'gap' &&
    input.coverage !== 'rechecking' &&
    config.episodeExpiry.enabled &&
    next.lastHeatSec !== undefined &&
    input.watermarkSec - next.lastHeatSec >= config.episodeExpiry.threshold
  ) {
    next.state = 'watch';
    next.episodeId = null;
    next.entryThreshold = null;
    next.lowBuckets = 0;
    next.lastHeatSec = undefined;
    next.lastAlertKind = null;
    next.lastAlertSec = null;
  }
  const rolling = input.metrics.rolling;
  const toMinute = (m: RollingMetric): MinuteMetric => ({
    ...m,
    minuteStartSec: m.startSec,
    fromBlock: null,
    toBlock: null,
    status: m.status,
  });
  const partial = rolling ? toMinute(rolling['1m']) : input.metrics.partialCurrent;
  const currentMinute =
    (rolling ? rolling['1m'].startSec : Math.floor(input.watermarkSec / 60) * 60) -
    (input.evaluationMode === 'minute-close' ? 60 : 0);
  const minute = rolling
    ? partial?.status === 'closed'
      ? partial
      : null
    : input.evaluationMode === 'minute-close'
      ? input.metrics.recentClosed1m?.minuteStartSec === currentMinute &&
        input.metrics.recentClosed1m.status === 'closed'
        ? input.metrics.recentClosed1m
        : null
      : partial && partial.minuteStartSec === currentMinute && partial.status === 'partial'
        ? partial
        : null;
  const five = (
    rolling
      ? input.metrics.rollingHistory5m!.filter(
          (m): m is RollingMetric & AggregateMetric => m.status === 'closed',
        )
      : input.metrics.natural5mBuckets
  )
    .filter(
      (b) =>
        b.status === 'closed' &&
        (rolling || b.startSec % 300 === 0) &&
        b.endSec - b.startSec === 300 &&
        b.endSec <= input.watermarkSec,
    )
    .sort((a, b) => a.startSec - b.startSec);
  const latest = five.at(-1) ?? null;
  const baseline = {
    minute: signalBaseline(
      minute ? sample(minute) : empty(currentMinute, 60),
      (rolling ? input.metrics.rollingHistory1m!.map(toMinute) : input.metrics.minutes).map(sample),
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
    latest.usdMicros !== null &&
    latest.usdMicros >= BigInt(config.confirmConsecutive.threshold) &&
    (config.confirmConsecutive.buckets === 1 ||
      (prevFive !== undefined &&
        prevFive.endSec === latest.startSec &&
        prevFive.usdMicros !== null &&
        prevFive.usdMicros >= BigInt(config.confirmConsecutive.threshold)));
  const matches: RuleMatch[] = [
    {
      ruleId: 'candidate',
      version: config.candidate.version,
      matched: !!candidate,
      reason: !config.candidate.enabled
        ? 'disabled'
        : !absoluteMinute
          ? 'below-absolute-or-unpriced'
          : baseline.minute.status !== 'ready'
            ? [baseline.minute.status, 'absolute-only'].join('/')
            : candidate
              ? 'relative-met'
              : 'below-multiple',
    },
    {
      ruleId: 'confirmRelative',
      version: config.confirmRelative.version,
      matched: !!relative,
      reason: !config.confirmRelative.enabled
        ? 'disabled'
        : baseline.fiveMinute.status !== 'ready'
          ? [baseline.fiveMinute.status, 'relative-unavailable'].join('/')
          : relative
            ? 'relative-met'
            : 'below-absolute-or-multiple',
    },
    {
      ruleId: 'confirmConsecutive',
      version: config.confirmConsecutive.version,
      matched: !!consecutive,
      reason: !config.confirmConsecutive.enabled
        ? 'disabled'
        : consecutive
          ? config.confirmConsecutive.buckets === 1
            ? rolling
              ? 'one-complete-rolling5m'
              : 'one-complete-natural5m'
            : rolling
              ? 'two-consecutive-rolling5m'
              : 'two-consecutive-natural5m'
          : config.confirmConsecutive.buckets === 1
            ? 'no-complete-above-threshold'
            : 'no-two-adjacent-above-threshold',
    },
  ];
  const noAlert = (): SignalDecision => ({ nextSnapshot: next, alertDraft: null, matches });
  if (input.coverage === 'gap' || input.coverage === 'rechecking') {
    return noAlert();
  }
  const fresh =
    latest !== null &&
    latest.endSec === (rolling ? input.watermarkSec : Math.floor(input.watermarkSec / 300) * 300) &&
    (next.lastFiveEndSec === null || latest.endSec > next.lastFiveEndSec);
  let cooled = false;
  if (fresh && rolling) {
    // Count disjoint, adjacent windows, never repeated overlapping polls.
    let lows = 0,
      boundary = latest!.endSec;
    for (const b of [...five].reverse()) {
      if (
        b.endSec !== boundary ||
        (next.lastHeatSec !== undefined && b.startSec < next.lastHeatSec) ||
        next.state !== 'hot' ||
        next.entryThreshold === null ||
        b.usdMicros === null ||
        b.usdMicros * 100n >= next.entryThreshold * BigInt(config.cooling.threshold)
      )
        break;
      lows++;
      boundary = b.startSec;
    }
    next.lowBuckets = lows;
    next.lastFiveEndSec = latest!.endSec;
    if (config.cooling.enabled && lows >= config.cooling.buckets) {
      next.state = 'cooling';
      cooled = true;
    }
  }
  if (fresh && !rolling) {
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
    reasons.push(rolling ? 'consecutive-low-rolling5m' : 'three-complete-low-natural5m');
  } else if (candidate && next.state !== 'hot') {
    kind = 'candidate';
    volume = minute!.usdMicros;
    scale = '1m';
    reasons.push('candidate');
    if (baseline.minute.status !== 'ready') reasons.push(`${baseline.minute.status}/absolute-only`);
    reasons.push(rolling ? 'rolling-1m' : 'partial');
  }
  if (kind === null) return noAlert();
  if (kind === 'hot' || kind === 'reheat') next.lastHeatSec = input.watermarkSec;

  const candidateFingerprint = minute
    ? hash([
        minute.usdMicros?.toString(),
        minute.rawNotional?.raw.toString(),
        minute.swapCount,
        minute.txCount,
        minute.addCount,
        minute.removeCount,
        minute.zeroDeltaCount,
        minute.reasons,
      ])
    : '';
  const sameMinute =
    kind === 'candidate' && next.candidateMinuteStartSec === minute?.minuteStartSec;
  if (sameMinute && next.candidateFingerprint === candidateFingerprint) return noAlert();
  const sameLevel =
    (kind === 'hot' && next.state === 'hot') ||
    (kind === 'candidate' && (next.state === 'candidate' || next.lastAlertKind === 'candidate'));
  if (
    sameLevel &&
    !upgrade &&
    !sameMinute &&
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
      kind === 'candidate' ? currentMinute : latest?.endSec,
      kind,
    ]);

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
  if (kind === 'candidate') {
    next.candidateMinuteStartSec = minute!.minuteStartSec;
    next.candidateFingerprint = candidateFingerprint;
  }
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

/** Evaluate complete history chronologically; receipt metadata remains separate from logical time. */
export function evaluateSignal(
  previous: SignalSnapshot,
  input: SignalInput,
  config: SignalConfig,
): SignalDecision {
  if (input.metrics.rolling) {
    let state =
      previous.configVersion !== null && previous.configVersion !== signalConfigVersion(config)
        ? initialSignalSnapshot()
        : previous;
    const drafts: NonNullable<SignalDecision['alertDraft']>[] = [];
    const evaluations: NonNullable<SignalDecision['evaluations']>[number][] = [];
    if (input.coverage !== 'rechecking')
      for (const m of input.metrics.rollingHistory5m ?? []) {
        if (
          m.status !== 'closed' ||
          m.endSec >= input.watermarkSec ||
          (state.lastFiveEndSec !== null && m.endSec <= state.lastFiveEndSec)
        )
          continue;
        const missing = (duration: number): RollingMetric => ({
          ...m,
          startSec: m.endSec - duration,
          status: 'warming',
          usdMicros: null,
          usdgNotionalRaw: null,
          rawNotional: null,
          swapCount: null,
          txCount: null,
          activeMinutes: null,
          addCount: null,
          removeCount: null,
          zeroDeltaCount: null,
          reasons: ['historical-window-not-materialized'],
        });
        const metrics = {
          ...input.metrics,
          rolling: { '1m': missing(60), '5m': m, '15m': missing(900), '1h': missing(3600) },
          rollingHistory1m: [],
          rollingHistory5m: input.metrics.rollingHistory5m!.filter((p) => p.endSec <= m.endSec),
        };
        const d = evaluateOne(
          state,
          { ...input, metrics, watermarkSec: m.endSec, coverage: 'complete' },
          config,
        );
        state = d.nextSnapshot;
        evaluations.push({ endSec: m.endSec, matches: d.matches });
        if (d.alertDraft)
          drafts.push({
            ...d.alertDraft,
            watermarkSec: input.watermarkSec,
            logicalTimeSec: m.endSec,
            historical: true,
          });
      }
    const result = evaluateOne(state, input, config);
    if (result.alertDraft)
      drafts.push({ ...result.alertDraft, logicalTimeSec: input.watermarkSec, historical: false });
    return { ...result, alertDraft: drafts.at(-1) ?? null, alertDrafts: drafts, evaluations };
  }
  const version = signalConfigVersion(config);
  let state =
    previous.configVersion !== null && previous.configVersion !== version
      ? initialSignalSnapshot()
      : previous;
  const drafts: NonNullable<SignalDecision['alertDraft']>[] = [];
  const evaluations: NonNullable<SignalDecision['evaluations']>[number][] = [];
  const five = input.metrics.natural5mBuckets
    .filter(
      (b) =>
        b.status === 'closed' &&
        b.startSec % 300 === 0 &&
        b.endSec - b.startSec === 300 &&
        b.endSec <= input.watermarkSec,
    )
    .sort((a, b) => a.startSec - b.startSec);
  const closedBoundary = Math.floor(input.watermarkSec / 300) * 300;
  if (input.coverage !== 'rechecking') {
    for (const b of five.filter(
      (b) => state.lastFiveEndSec === null || b.endSec > state.lastFiveEndSec,
    )) {
      const metrics = {
        ...input.metrics,
        partialCurrent: null,
        minutes: input.metrics.minutes.filter((m) => m.minuteStartSec + 60 <= b.endSec),
        natural5mBuckets: five.filter((p) => p.endSec <= b.endSec),
        naturalClosed5m: b,
        recentClosed1m: null,
        recentClosed5x1m: null,
      };
      const decision = evaluateOne(
        state,
        { ...input, coverage: 'complete', watermarkSec: b.endSec, metrics },
        config,
      );
      state = decision.nextSnapshot;
      evaluations.push({ endSec: b.endSec, matches: decision.matches });
      if (decision.alertDraft)
        drafts.push({
          ...decision.alertDraft,
          watermarkSec: input.watermarkSec,
          logicalTimeSec: b.endSec,
          historical: b.endSec < closedBoundary,
        });
    }
  }
  const current = evaluateOne(state, input, config);
  state = current.nextSnapshot;
  if (current.alertDraft)
    drafts.push({ ...current.alertDraft, logicalTimeSec: input.watermarkSec, historical: false });
  return {
    nextSnapshot: state,
    matches: current.matches,
    alertDraft: drafts.at(-1) ?? null,
    alertDrafts: drafts,
    evaluations,
  };
}
