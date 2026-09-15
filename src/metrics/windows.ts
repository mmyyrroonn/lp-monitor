import type { BlockAnchor, PoolEvent, PoolRef } from '../domain/types.js';
import { countWork } from '../ops/work-counters.js';
import { poolRegistrationId } from '../registry/pools.js';
import { RollingVolumeBaseline, volumeBaseline } from './baseline.js';

export type RawNotional = { readonly token: string; readonly raw: bigint };
export type MetricEvent = {
  readonly event: PoolEvent;
  readonly usdMicros: bigint | null;
  readonly usdgNotionalRaw: bigint | null;
  readonly rawNotional?: RawNotional | null;
  readonly scopeId?: string;
};
export type MinuteCoverage = {
  readonly scopeId: string;
  readonly minuteStartSec: number;
  readonly fromBlock: bigint | null;
  readonly toBlock: bigint | null;
  readonly complete: boolean;
  readonly reasons: readonly string[];
};
export type MinuteStatus = 'closed' | 'partial' | 'gap' | 'warming';
export type MinuteMetric = {
  readonly minuteStartSec: number;
  readonly status: MinuteStatus;
  readonly fromBlock: bigint | null;
  readonly toBlock: bigint | null;
  readonly reasons: readonly string[];
  readonly usdMicros: bigint | null;
  readonly usdgNotionalRaw: bigint | null;
  readonly rawNotional: RawNotional | null;
  readonly swapCount: number | null;
  readonly txCount: number | null;
  readonly addCount: number | null;
  readonly removeCount: number | null;
  readonly zeroDeltaCount: number | null;
  readonly activeMinutes: number | null;
  readonly baselineSampleCount: number;
  readonly baselineMedian: bigint | null;
  readonly baselineMedianNumerator: bigint | null;
  readonly baselineMedianDenominator: bigint | null;
  readonly baselineUnit: string | null;
  readonly volumeMultiplier: number | null;
};
export type AggregateMetric = {
  readonly startSec: number;
  readonly endSec: number;
  readonly status: 'closed';
  readonly usdMicros: bigint | null;
  readonly usdgNotionalRaw: bigint | null;
  readonly rawNotional: RawNotional | null;
  readonly swapCount: number;
  readonly txCount: number;
  readonly addCount: number;
  readonly removeCount: number;
  readonly zeroDeltaCount: number;
  readonly activeMinutes: number;
  readonly baselineSampleCount: number;
  readonly baselineMedian: bigint | null;
  readonly baselineMedianNumerator: bigint | null;
  readonly baselineMedianDenominator: bigint | null;
  readonly baselineUnit: string | null;
  readonly volumeMultiplier: number | null;
};
export type UnknownTimeBlockCount = {
  readonly blockNumber: bigint;
  readonly eventCount: number;
  readonly swapCount: number;
  readonly txCount: number;
  readonly addCount: number;
  readonly removeCount: number;
  readonly zeroDeltaCount: number;
};
export type PoolMetricWindows = {
  readonly rolling?: import('./rolling.js').RollingWindows;
  readonly rollingHistory1m?: readonly import('./rolling.js').RollingMetric[];
  readonly rollingHistory5m?: readonly import('./rolling.js').RollingMetric[];
  readonly pool: PoolRef;
  readonly poolId: string;
  readonly minutes: readonly MinuteMetric[];
  readonly natural5mBuckets: readonly AggregateMetric[];
  readonly partialCurrent: MinuteMetric | null;
  readonly recentClosed1m: MinuteMetric | null;
  readonly recentClosed5x1m: AggregateMetric | null;
  readonly naturalClosed5m: AggregateMetric | null;
  readonly unknownTimeBlockCounts: readonly UnknownTimeBlockCount[];
};
export type MetricWindow = PoolMetricWindows;
export type MetricMemo = <T>(
  key: string,
  minuteStartSec: number,
  input: unknown,
  compute: () => T,
) => T;
export type BuildMinuteMetricOptions = {
  readonly internalMinutesOnly?: boolean;
  readonly memo?: MetricMemo;
  readonly pools?: readonly {
    pool: PoolRef;
    discoveredAtBlock: bigint | null;
    rawToken: string | null;
  }[];
  readonly minimumOneMinuteSamples?: number;
  readonly minimumFiveMinuteSamples?: number;
  readonly oneMinuteBaselineLimit?: number;
  readonly fiveMinuteBaselineLimit?: number;
};

type WindowCore = Omit<PoolMetricWindows, 'pool' | 'poolId' | 'unknownTimeBlockCounts'>;

type PoolGroup = {
  pool: PoolRef;
  events: MetricEvent[];
  unknown: Map<bigint, MetricEvent[]>;
  rawToken: string | null;
  discoveredAtBlock: bigint | null;
};

export function buildMinuteMetrics(
  activeEvents: readonly MetricEvent[],
  coverage: readonly MinuteCoverage[],
  watermark: BlockAnchor,
  options: BuildMinuteMetricOptions = {},
): readonly PoolMetricWindows[] {
  const minuteMinimumSamples = options.minimumOneMinuteSamples ?? 60;
  const fiveMinuteMinimumSamples = options.minimumFiveMinuteSamples ?? 12;
  const oneMinuteLimit = options.oneMinuteBaselineLimit ?? 60;
  const fiveMinuteLimit = options.fiveMinuteBaselineLimit ?? 12;
  const groups = new Map<string, PoolGroup>();
  for (const p of options.pools ?? [])
    groups.set(poolRegistrationId(p), { ...p, events: [], unknown: new Map() });
  for (const metricEvent of activeEvents) {
    const pool = metricEvent.event.pool;
    if (pool === null) continue;
    const poolId = poolRegistrationId({ pool });
    const group = groups.get(poolId) ?? {
      pool,
      events: [],
      unknown: new Map<bigint, MetricEvent[]>(),
      rawToken: metricEvent.rawNotional?.token ?? null,
      discoveredAtBlock: null,
    };
    if (metricEvent.event.time.minuteStartSec === null) {
      const block = metricEvent.event.ref.blockNumber;
      const unresolved = group.unknown.get(block) ?? [];
      unresolved.push(metricEvent);
      group.unknown.set(block, unresolved);
    } else group.events.push(metricEvent);
    if (group.rawToken === null && metricEvent.rawNotional)
      group.rawToken = metricEvent.rawNotional.token;
    groups.set(poolId, group);
  }

  const currentMinute = Math.floor(watermark.timestampSec / 60) * 60;
  // Inputs are fixed only within this call. Unknown-time events do not select known coverage.
  const dormantCoverage = selectCoverage([], coverage);
  const earliestDormantBlock = dormantCoverage.reduce<bigint | null>(
    (earliest, item) =>
      item.fromBlock === null
        ? earliest
        : earliest === null || item.fromBlock < earliest
          ? item.fromBlock
          : earliest,
    null,
  );
  const dormantWindows = new Map<string, WindowCore>();
  // One entry per pool whose windows are assembled below.
  countWork('evaluatedPools', groups.size);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([poolId, group]) => {
      const withIdentity = (core: WindowCore): PoolMetricWindows => ({
        pool: group.pool,
        poolId,
        ...core,
        unknownTimeBlockCounts: [...group.unknown.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([blockNumber, unresolved]) => unknownBlockMetric(blockNumber, unresolved)),
      });
      // Birth is irrelevant only when no covered fromBlock precedes it. Keep token casing exact.
      const birth =
        group.discoveredAtBlock === null ||
        earliestDormantBlock === null ||
        group.discoveredAtBlock <= earliestDormantBlock
          ? null
          : group.discoveredAtBlock.toString();
      const memoKey = group.events.length === 0 ? JSON.stringify([group.rawToken, birth]) : null;
      const cached = memoKey === null ? undefined : dormantWindows.get(memoKey);
      if (cached) return withIdentity(cached);
      const coverageForPool =
        group.events.length === 0 ? dormantCoverage : selectCoverage(group.events, coverage);
      const starts = new Set(coverageForPool.map((item) => item.minuteStartSec));
      for (const item of group.events) starts.add(item.event.time.minuteStartSec!);
      starts.add(currentMinute);
      const eventByMinute = new Map<number, MetricEvent[]>();
      for (const item of group.events) {
        const start = item.event.time.minuteStartSec!;
        const bucket = eventByMinute.get(start) ?? [];
        bucket.push(item);
        eventByMinute.set(start, bucket);
      }
      const coverageByMinute = new Map(coverageForPool.map((item) => [item.minuteStartSec, item]));
      const minutes: MinuteMetric[] = [...starts]
        .sort((a, b) => a - b)
        .map((start) => {
          const events = eventByMinute.get(start) ?? [];
          const covered = coverageByMinute.get(start);
          const compute = () =>
            minuteMetric(
              start,
              currentMinute,
              events,
              covered,
              group.rawToken,
              group.discoveredAtBlock,
            );
          // Cache unbaselined contributions. Baseline application creates new objects.
          return options.memo && group.events.length > 0
            ? options.memo(
                'minute:' + poolId + ':' + start,
                start,
                {
                  events,
                  covered,
                  current: start === currentMinute,
                  rawToken: group.rawToken,
                  birth: group.discoveredAtBlock,
                },
                compute,
              )
            : compute();
        });
      applyMinuteBaselines(minutes, minuteMinimumSamples, oneMinuteLimit);
      const natural5mBuckets = options.internalMinutesOnly
        ? []
        : buildNaturalBuckets(
            minutes,
            eventByMinute,
            fiveMinuteMinimumSamples,
            fiveMinuteLimit,
            options.memo
              ? (key, at, input, compute) => options.memo!(poolId + ':' + key, at, input, compute)
              : undefined,
          );
      const closed = minutes.filter(
        (item) => item.status === 'closed' && item.minuteStartSec < currentMinute,
      );
      const recentClosed1m = closed.at(-1) ?? null;
      const recentClosed5x1m = options.internalMinutesOnly
        ? null
        : recentFive(
            minutes,
            eventByMinute,
            currentMinute,
            fiveMinuteMinimumSamples,
            fiveMinuteLimit,
            options.memo
              ? (key, at, input, compute) => options.memo!(poolId + ':' + key, at, input, compute)
              : undefined,
          );
      const naturalClosed5m =
        natural5mBuckets.filter((item) => item.endSec <= currentMinute).at(-1) ?? null;
      const core: WindowCore = {
        minutes,
        natural5mBuckets,
        partialCurrent: minutes.find((item) => item.minuteStartSec === currentMinute) ?? null,
        recentClosed1m,
        recentClosed5x1m,
        naturalClosed5m,
      };
      // Baseline construction has finished; only readonly output is shared between pools.
      if (memoKey !== null) dormantWindows.set(memoKey, core);
      return withIdentity(core);
    });
}

function selectCoverage(
  events: readonly MetricEvent[],
  coverage: readonly MinuteCoverage[],
): readonly MinuteCoverage[] {
  const scopes = new Set(
    events.map((item) => item.scopeId).filter((item): item is string => item !== undefined),
  );
  if (scopes.size === 1) return coverage.filter((item) => scopes.has(item.scopeId));
  const allScopes = new Set(coverage.map((item) => item.scopeId));
  return allScopes.size <= 1 ? coverage : [];
}

function minuteMetric(
  start: number,
  currentMinute: number,
  events: readonly MetricEvent[],
  coverage: MinuteCoverage | undefined,
  rawToken: string | null,
  discoveredAtBlock: bigint | null,
): MinuteMetric {
  const beforeBirth =
    discoveredAtBlock !== null &&
    coverage?.fromBlock !== null &&
    coverage?.fromBlock !== undefined &&
    coverage.fromBlock < discoveredAtBlock;
  const prefixValid =
    coverage !== undefined &&
    coverage.fromBlock !== null &&
    coverage.toBlock !== null &&
    (coverage.complete || coverage.reasons.every((r) => r === 'watermark-partial'));
  // A newly registered pool can already have observed activity in the current
  // prefix. Expose that partial evidence, but never close or baseline its
  // incomplete birth minute (or manufacture any pre-birth zero history).
  const bornInCurrentPrefix =
    start === currentMinute &&
    prefixValid &&
    beforeBirth &&
    discoveredAtBlock !== null &&
    coverage?.toBlock !== null &&
    coverage?.toBlock !== undefined &&
    discoveredAtBlock <= coverage.toBlock;
  const status: MinuteStatus =
    beforeBirth && !bornInCurrentPrefix
      ? 'warming'
      : start === currentMinute
        ? prefixValid
          ? 'partial'
          : coverage
            ? 'gap'
            : 'warming'
        : coverage?.complete && coverage.fromBlock !== null && coverage.toBlock !== null
          ? 'closed'
          : coverage
            ? 'gap'
            : 'warming';
  if (status === 'gap' || status === 'warming') {
    return {
      minuteStartSec: start,
      status,
      fromBlock: coverage?.fromBlock ?? null,
      toBlock: coverage?.toBlock ?? null,
      reasons: beforeBirth
        ? ['pool-lifetime-incomplete']
        : (coverage?.reasons ?? ['coverage-missing']),
      usdMicros: null,
      usdgNotionalRaw: null,
      rawNotional: null,
      swapCount: null,
      txCount: null,
      addCount: null,
      removeCount: null,
      zeroDeltaCount: null,
      activeMinutes: null,
      baselineSampleCount: 0,
      baselineMedian: null,
      baselineMedianNumerator: null,
      baselineMedianDenominator: null,
      baselineUnit: null,
      volumeMultiplier: null,
    };
  }
  const swaps = events.filter((item) => item.event.kind === 'swap');
  const liquidity = events.filter((item) => item.event.kind === 'liquidity');
  const usdValues = swaps.map((item) => item.usdMicros);
  const usdgValues = swaps.map((item) => item.usdgNotionalRaw);
  return {
    minuteStartSec: start,
    status,
    fromBlock: coverage?.fromBlock ?? null,
    toBlock: coverage?.toBlock ?? null,
    reasons:
      status === 'partial'
        ? [
            ...(coverage?.reasons ?? []),
            'watermark-before-minute-end',
            ...(bornInCurrentPrefix ? ['pool-born-in-current-minute'] : []),
          ]
        : [],
    usdMicros: sumValued(usdValues),
    usdgNotionalRaw: sumValued(usdgValues),
    rawNotional:
      swaps.length === 0 && rawToken !== null
        ? { token: rawToken.toLowerCase(), raw: 0n }
        : sumRaw(swaps.map((item) => item.rawNotional ?? null)),
    swapCount: swaps.length,
    txCount: new Set(swaps.map((item) => item.event.ref.transactionHash.toLowerCase())).size,
    addCount: liquidity.filter((item) => item.event.kind === 'liquidity' && item.event.delta > 0n)
      .length,
    removeCount: liquidity.filter(
      (item) => item.event.kind === 'liquidity' && item.event.delta < 0n,
    ).length,
    zeroDeltaCount: liquidity.filter(
      (item) => item.event.kind === 'liquidity' && item.event.delta === 0n,
    ).length,
    activeMinutes: swaps.length > 0 ? 1 : 0,
    baselineSampleCount: 0,
    baselineMedian: null,
    baselineMedianNumerator: null,
    baselineMedianDenominator: null,
    baselineUnit: null,
    volumeMultiplier: null,
  };
}

function sumValued(values: readonly (bigint | null)[]): bigint | null {
  if (values.length === 0) return 0n;
  if (values.some((value) => value === null)) return null;
  return values.reduce<bigint>((sum, value) => sum + value!, 0n);
}
function sumRaw(values: readonly (RawNotional | null)[]): RawNotional | null {
  if (values.length === 0 || values.some((item) => item === null)) return null;
  const token = values[0]!.token.toLowerCase();
  if (values.some((item) => item!.token.toLowerCase() !== token)) return null;
  return { token, raw: values.reduce((sum, item) => sum + item!.raw, 0n) };
}
function comparableVolume(item: Pick<MinuteMetric, 'usdMicros' | 'rawNotional'>): bigint | null {
  return item.usdMicros ?? item.rawNotional?.raw ?? null;
}
function sameScale(a: MinuteMetric, b: MinuteMetric): boolean {
  if (a.usdMicros !== null) return b.usdMicros !== null;
  return (
    a.usdMicros === null &&
    a.rawNotional !== null &&
    a.rawNotional.token.toLowerCase() === b.rawNotional?.token.toLowerCase()
  );
}
function applyMinuteBaselines(minutes: MinuteMetric[], minimum: number, limit: number): void {
  const rolling = new RollingVolumeBaseline(minimum, limit);
  for (let index = 0; index < minutes.length; index++) {
    const current = minutes[index]!;
    const rawUnit = current.rawNotional?.token.toLowerCase() ?? null;
    const baseline = rolling.next({
      eligible: current.status === 'closed',
      unit: current.usdMicros !== null ? 'usdMicros' : rawUnit === null ? null : 'raw:' + rawUnit,
      current: comparableVolume(current),
      history: [
        ...(current.usdMicros !== null ? [{ unit: 'usdMicros', value: current.usdMicros }] : []),
        ...(current.rawNotional !== null
          ? [{ unit: 'raw:' + rawUnit, value: current.rawNotional.raw }]
          : []),
      ],
    });
    if (baseline === null) continue;
    minutes[index] = {
      ...current,
      baselineSampleCount: baseline.sampleCount,
      baselineMedian: baseline.median,
      baselineMedianNumerator: baseline.medianNumerator,
      baselineMedianDenominator: baseline.medianDenominator,
      baselineUnit: current.usdMicros !== null ? 'usdMicros' : (current.rawNotional?.token ?? null),
      volumeMultiplier: baseline.multiplier,
    };
  }
}

function memoAggregate(
  selected: readonly MinuteMetric[],
  events: ReadonlyMap<number, readonly MetricEvent[]>,
  memo?: MetricMemo,
): AggregateMetric {
  const compute = () => aggregate(selected, events);
  if (!memo) return compute();
  // Exclude rolling baseline fields, which do not change this bucket's contribution.
  const input = selected.map((m) => ({
    minute: m.minuteStartSec,
    status: m.status,
    raw: m.rawNotional,
    events: events.get(m.minuteStartSec) ?? [],
  }));
  return memo(
    'aggregate:' + selected[0]!.minuteStartSec + ':' + selected.at(-1)!.minuteStartSec,
    selected[0]!.minuteStartSec,
    input,
    compute,
  );
}

function aggregate(
  selected: readonly MinuteMetric[],
  eventByMinute: ReadonlyMap<number, readonly MetricEvent[]>,
): AggregateMetric {
  const events = selected.flatMap((item) => [...(eventByMinute.get(item.minuteStartSec) ?? [])]);
  const swaps = events.filter((item) => item.event.kind === 'swap');
  const liquidity = events.filter((item) => item.event.kind === 'liquidity');
  return {
    startSec: selected[0]!.minuteStartSec,
    endSec: selected.at(-1)!.minuteStartSec + 60,
    status: 'closed',
    usdMicros: sumValued(swaps.map((item) => item.usdMicros)),
    usdgNotionalRaw: sumValued(swaps.map((item) => item.usdgNotionalRaw)),
    rawNotional: sumRaw(selected.map((item) => item.rawNotional)),
    swapCount: swaps.length,
    txCount: new Set(swaps.map((item) => item.event.ref.transactionHash.toLowerCase())).size,
    addCount: liquidity.filter((item) => item.event.kind === 'liquidity' && item.event.delta > 0n)
      .length,
    removeCount: liquidity.filter(
      (item) => item.event.kind === 'liquidity' && item.event.delta < 0n,
    ).length,
    zeroDeltaCount: liquidity.filter(
      (item) => item.event.kind === 'liquidity' && item.event.delta === 0n,
    ).length,
    activeMinutes: selected.filter((item) => (item.activeMinutes ?? 0) > 0).length,
    baselineSampleCount: 0,
    baselineMedian: null,
    baselineMedianNumerator: null,
    baselineMedianDenominator: null,
    baselineUnit: null,
    volumeMultiplier: null,
  };
}

function buildNaturalBuckets(
  minutes: readonly MinuteMetric[],
  events: ReadonlyMap<number, readonly MetricEvent[]>,
  minimum: number,
  limit: number,
  memo?: MetricMemo,
): AggregateMetric[] {
  const byStart = new Map(minutes.map((item) => [item.minuteStartSec, item]));
  const natural: AggregateMetric[] = [];
  const starts = [...byStart.keys()].filter((start) => start % 300 === 0).sort((a, b) => a - b);
  for (const start of starts) {
    const selected = Array.from({ length: 5 }, (_, i) => byStart.get(start + i * 60));
    if (selected.some((item) => item?.status !== 'closed')) continue;
    const selectedMinutes = selected as MinuteMetric[];
    let value = memoAggregate(selectedMinutes, events, memo);
    const prior = natural
      .filter((item) => sameAggregateScale(value, item))
      .slice(-limit)
      .map((item) => (value.usdMicros !== null ? item.usdMicros : (item.rawNotional?.raw ?? null)));
    const baseline = volumeBaseline(aggregateVolume(value), prior, minimum);
    value = {
      ...value,
      baselineSampleCount: baseline.sampleCount,
      baselineMedian: baseline.median,
      baselineMedianNumerator: baseline.medianNumerator,
      baselineMedianDenominator: baseline.medianDenominator,
      baselineUnit: value.usdMicros !== null ? 'usdMicros' : (value.rawNotional?.token ?? null),
      volumeMultiplier: baseline.multiplier,
    };
    natural.push(value);
  }
  return natural;
}
function aggregateVolume(item: AggregateMetric): bigint | null {
  return item.usdMicros ?? item.rawNotional?.raw ?? null;
}
function sameAggregateScale(a: AggregateMetric, b: AggregateMetric): boolean {
  if (a.usdMicros !== null) return b.usdMicros !== null;
  return (
    a.usdMicros === null &&
    a.rawNotional !== null &&
    a.rawNotional.token.toLowerCase() === b.rawNotional?.token.toLowerCase()
  );
}
function recentFive(
  minutes: readonly MinuteMetric[],
  events: ReadonlyMap<number, readonly MetricEvent[]>,
  currentMinute: number,
  minimum: number,
  limit: number,
  memo?: MetricMemo,
): AggregateMetric | null {
  const byStart = new Map(minutes.map((item) => [item.minuteStartSec, item]));
  const selected = Array.from({ length: 5 }, (_, i) => byStart.get(currentMinute - (5 - i) * 60));
  if (selected.some((item) => item?.status !== 'closed')) return null;
  const aggregateValue = memoAggregate(selected as MinuteMetric[], events, memo);
  const prior: AggregateMetric[] = [];
  for (let end = currentMinute - 300; end >= currentMinute - limit * 300; end -= 300) {
    const priorSelected = Array.from({ length: 5 }, (_, i) => byStart.get(end - 300 + i * 60));
    if (priorSelected.some((item) => item?.status !== 'closed')) continue;
    const priorAggregate = memoAggregate(priorSelected as MinuteMetric[], events, memo);
    if (sameAggregateScale(aggregateValue, priorAggregate)) prior.unshift(priorAggregate);
  }
  const baseline = volumeBaseline(
    aggregateVolume(aggregateValue),
    prior.map((item) =>
      aggregateValue.usdMicros !== null ? item.usdMicros : (item.rawNotional?.raw ?? null),
    ),
    minimum,
  );
  return {
    ...aggregateValue,
    baselineSampleCount: baseline.sampleCount,
    baselineMedian: baseline.median,
    baselineMedianNumerator: baseline.medianNumerator,
    baselineMedianDenominator: baseline.medianDenominator,
    baselineUnit:
      aggregateValue.usdMicros !== null ? 'usdMicros' : (aggregateValue.rawNotional?.token ?? null),
    volumeMultiplier: baseline.multiplier,
  };
}
function unknownBlockMetric(
  blockNumber: bigint,
  events: readonly MetricEvent[],
): UnknownTimeBlockCount {
  const swaps = events.filter((item) => item.event.kind === 'swap');
  const liquidity = events.filter((item) => item.event.kind === 'liquidity');
  return {
    blockNumber,
    eventCount: events.length,
    swapCount: swaps.length,
    txCount: new Set(swaps.map((item) => item.event.ref.transactionHash.toLowerCase())).size,
    addCount: liquidity.filter((item) => item.event.kind === 'liquidity' && item.event.delta > 0n)
      .length,
    removeCount: liquidity.filter(
      (item) => item.event.kind === 'liquidity' && item.event.delta < 0n,
    ).length,
    zeroDeltaCount: liquidity.filter(
      (item) => item.event.kind === 'liquidity' && item.event.delta === 0n,
    ).length,
  };
}
