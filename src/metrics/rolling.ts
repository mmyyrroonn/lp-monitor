import type { BlockAnchor, LogTime } from '../domain/types.js';
import { poolRegistrationId } from '../registry/pools.js';
import { countWork } from '../ops/work-counters.js';
import { volumeBaseline } from './baseline.js';
import {
  buildMinuteMetrics,
  type AggregateMetric,
  type BuildMinuteMetricOptions,
  type MetricEvent,
  type MinuteCoverage,
  type PoolMetricWindows,
} from './windows.js';
export const ROLLING_DURATIONS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 } as const;
export type RollingWindowName = keyof typeof ROLLING_DURATIONS;
type Counts =
  'swapCount' | 'txCount' | 'addCount' | 'removeCount' | 'zeroDeltaCount' | 'activeMinutes';
export type RollingMetric = Omit<AggregateMetric, 'status' | Counts> & {
  status: 'closed' | 'gap' | 'warming';
  reasons: readonly string[];
} & { readonly [K in Counts]: number | null };
export type RollingWindows = Record<RollingWindowName, RollingMetric>;
/** (start, end], measured against accepted chain time, never wall clock. */
export function inRollingWindow(
  time: LogTime,
  start: number,
  end: number,
  atWatermark = false,
): boolean | null {
  if (time.exactTimestampSec !== null)
    return time.exactTimestampSec > start && time.exactTimestampSec <= end;
  const m = time.minuteStartSec;
  if (m === null) return null;
  if (m + 59 <= start || m > end) return false;
  if (m > start && (m + 59 <= end || atWatermark)) return true;
  return null;
}
/** A minute index over one coverage set, built once and reused by every query in a build. */
export interface RollingCoverageIndex {
  reasons(start: number, end: number, watermark: number, birth: bigint | null): string[];
}
function coverageReasons(
  byMinute: Map<number, MinuteCoverage>,
  start: number,
  end: number,
  watermark: number,
  birth: bigint | null,
): string[] {
  const reasons = new Set<string>();
  if (start < 0) reasons.add('warming');
  for (let m = Math.max(0, Math.floor(start / 60) * 60); m <= Math.floor(end / 60) * 60; m += 60) {
    countWork('rollingCoverageVisits');
    const c = byMinute.get(m);
    if (!c || c.fromBlock === null || c.toBlock === null) reasons.add('coverage-missing');
    else {
      const prefix =
        end === watermark &&
        m === Math.floor(watermark / 60) * 60 &&
        c.reasons.every((r) => r === 'watermark-partial');
      if (!c.complete && !prefix) reasons.add('coverage-gap');
      if (birth !== null && c.fromBlock < birth) reasons.add('pool-lifetime-incomplete');
    }
  }
  return [...reasons];
}
export function prepareRollingCoverage(coverage: readonly MinuteCoverage[]): RollingCoverageIndex {
  countWork('coverageIndexBuilds');
  const byMinute = new Map(coverage.map((c) => [c.minuteStartSec, c]));
  const earliest = coverage.reduce<bigint | null>(
    (min, c) => (c.fromBlock !== null && (min === null || c.fromBlock < min) ? c.fromBlock : min),
    null,
  );
  const memo = new Map<string, readonly string[]>();
  return {
    reasons: (start, end, watermark, birth) => {
      const effectiveBirth =
        birth !== null && earliest !== null && birth <= earliest ? null : birth;
      const key = `${start}:${end}:${watermark}:${effectiveBirth ?? ''}`;
      const cached = memo.get(key);
      if (cached) return [...cached];
      const reasons = coverageReasons(byMinute, start, end, watermark, effectiveBirth);
      // A coverage index belongs to one build. Keep pathological horizons/birth cohorts bounded.
      if (memo.size < 4096) memo.set(key, [...reasons]);
      return reasons;
    },
  };
}
export function rollingCoverage(
  coverage: readonly MinuteCoverage[],
  start: number,
  end: number,
  watermark: number,
  birth: bigint | null = null,
): string[] {
  return prepareRollingCoverage(coverage).reasons(start, end, watermark, birth);
}
const sum = (xs: readonly (bigint | null)[]) =>
  xs.some((v) => v === null) ? null : xs.reduce<bigint>((a, b) => a + b!, 0n);
function window(
  events: readonly MetricEvent[],
  index: RollingCoverageIndex,
  start: number,
  end: number,
  watermark: BlockAnchor,
  rawToken: string | null,
  birth: bigint | null,
): RollingMetric {
  countWork('rollingWindowsBuilt');
  const reasons = index.reasons(start, end, watermark.timestampSec, birth);
  const selected: MetricEvent[] = [];
  for (const e of events) {
    if (e.event.ref.blockNumber > watermark.number) continue;
    const inside = inRollingWindow(e.event.time, start, end, end === watermark.timestampSec);
    if (inside === null) reasons.push('boundary-time-unknown');
    else if (inside) selected.push(e);
  }
  const swaps = selected.filter((e) => e.event.kind === 'swap');
  const liquidity = selected.filter((e) => e.event.kind === 'liquidity');
  const available = reasons.length === 0;
  const raw = swaps.map((e) => e.rawNotional ?? null);
  const token = raw[0]?.token ?? rawToken;
  const rawValue =
    token !== null && raw.every((r) => r !== null && r.token.toLowerCase() === token.toLowerCase())
      ? { token, raw: sum(raw.map((r) => r!.raw))! }
      : null;
  return {
    startSec: start,
    endSec: end,
    status: available
      ? 'closed'
      : reasons.includes('pool-lifetime-incomplete') || start < 0
        ? 'warming'
        : 'gap',
    reasons: [...new Set(reasons)],
    usdMicros: available ? sum(swaps.map((e) => e.usdMicros)) : null,
    usdgNotionalRaw: available ? sum(swaps.map((e) => e.usdgNotionalRaw)) : null,
    rawNotional: available ? rawValue : null,
    swapCount: available ? swaps.length : null,
    txCount: available
      ? new Set(swaps.map((e) => e.event.ref.transactionHash.toLowerCase())).size
      : null,
    addCount: available
      ? liquidity.filter((e) => e.event.kind === 'liquidity' && e.event.delta > 0n).length
      : null,
    removeCount: available
      ? liquidity.filter((e) => e.event.kind === 'liquidity' && e.event.delta < 0n).length
      : null,
    zeroDeltaCount: available
      ? liquidity.filter((e) => e.event.kind === 'liquidity' && e.event.delta === 0n).length
      : null,
    activeMinutes:
      available &&
      (swaps.every((e) => e.event.time.exactTimestampSec !== null) ||
        ((start % 60) + 60) % 60 === 59)
        ? new Set(
            swaps.map((e) =>
              Math.max(
                0,
                Math.floor(
                  ((e.event.time.exactTimestampSec ?? e.event.time.minuteStartSec!) - start - 1) /
                    60,
                ),
              ),
            ),
          ).size
        : null,
    baselineSampleCount: 0,
    baselineMedian: null,
    baselineMedianNumerator: null,
    baselineMedianDenominator: null,
    baselineUnit: null,
    volumeMultiplier: null,
  };
}
function baseline(
  current: RollingMetric,
  history: readonly RollingMetric[],
  minimum: number,
): RollingMetric {
  const prior = history.filter(
    (h) =>
      h.status === 'closed' &&
      h.endSec <= current.startSec &&
      (current.usdMicros !== null
        ? h.usdMicros !== null
        : current.rawNotional !== null && h.rawNotional?.token === current.rawNotional.token),
  );
  const b = volumeBaseline(
    current.usdMicros ?? current.rawNotional?.raw ?? null,
    prior
      .slice(-minimum)
      .map((h) => (current.usdMicros !== null ? h.usdMicros : h.rawNotional!.raw)),
    minimum,
  );
  return {
    ...current,
    baselineSampleCount: b.sampleCount,
    baselineMedian: b.median,
    baselineMedianNumerator: b.medianNumerator,
    baselineMedianDenominator: b.medianDenominator,
    baselineUnit: current.usdMicros !== null ? 'usdMicros' : (current.rawNotional?.token ?? null),
    volumeMultiplier: b.multiplier,
  };
}
export function buildRollingMetrics(
  events: readonly MetricEvent[],
  coverage: readonly MinuteCoverage[],
  watermark: BlockAnchor,
  options: BuildMinuteMetricOptions = {},
): PoolMetricWindows[] {
  const groups = new Map<string, MetricEvent[]>();
  const registrations = new Map(options.pools?.map((p) => [poolRegistrationId(p), p]));
  const dormant = new Map<
    RollingCoverageIndex,
    Map<string, Pick<PoolMetricWindows, 'rolling' | 'rollingHistory1m' | 'rollingHistory5m'>>
  >();
  // One minute index per coverage set for the whole build. Windows ask this map instead of
  // rebuilding the index for every query, and it dies with the build: nothing is reused across
  // batches, where a watermark move would invalidate every entry.
  const indexes = new Map<readonly MinuteCoverage[], RollingCoverageIndex>();
  const scoped = new Map<string, MinuteCoverage[]>();
  const emptyWindows = new Map<RollingCoverageIndex, Map<string, RollingMetric>>();
  let emptyWindowCount = 0;
  const indexFor = (cs: readonly MinuteCoverage[]) => {
    const existing = indexes.get(cs);
    if (existing) return existing;
    const prepared = prepareRollingCoverage(cs);
    indexes.set(cs, prepared);
    return prepared;
  };
  for (const e of events)
    if (e.event.pool) {
      const id = poolRegistrationId({ pool: e.event.pool });
      const group = groups.get(id) ?? [];
      group.push(e);
      groups.set(id, group);
    }
  return buildMinuteMetrics(events, coverage, watermark, {
    ...options,
    internalMinutesOnly: true,
  }).map((w) => {
    const es = groups.get(w.poolId) ?? [];
    const scopes = new Set(es.map((e) => e.scopeId).filter((s) => s !== undefined));
    const cs =
      scopes.size === 1
        ? (() => {
            const only = [...scopes][0]!;
            const memo = scoped.get(only);
            if (memo) return memo;
            const filtered = coverage.filter((c) => c.scopeId === only);
            scoped.set(only, filtered);
            return filtered;
          })()
        : new Set(coverage.map((c) => c.scopeId)).size <= 1
          ? coverage
          : [];
    const index = indexFor(cs);
    const registration = registrations.get(w.poolId);
    // A pool born at or before the earliest verifiable boundary of the coverage it is measured
    // against cannot have any window shortened by its birth, so its result never depends on the
    // exact birth block. Dropping it from the key lets those pools share one computation instead
    // of repeating it once per discovery height. Without a verifiable boundary the birth stays.
    const starts = cs.flatMap((c) => (c.fromBlock === null ? [] : [c.fromBlock]));
    const earliest = starts.reduce<bigint | null>((a, b) => (a === null || b < a ? b : a), null);
    const birth = registration?.discoveredAtBlock ?? null;
    const birthKey =
      birth !== null && earliest !== null && birth <= earliest ? null : (birth?.toString() ?? null);
    const byKey = dormant.get(index) ?? new Map();
    dormant.set(index, byKey);
    const dormantKey = JSON.stringify([registration?.rawToken ?? null, birthKey]);
    const cached = es.length === 0 ? byKey.get(dormantKey) : undefined;
    if (cached)
      return {
        ...w,
        partialCurrent: null,
        recentClosed1m: null,
        recentClosed5x1m: null,
        naturalClosed5m: null,
        ...cached,
      };
    const unknown = es.filter((e) => e.event.time.minuteStartSec === null);
    const sorted = es
      .filter((e) => e.event.time.minuteStartSec !== null)
      .sort((a, b) => a.event.time.minuteStartSec! - b.event.time.minuteStartSec!);
    const lower = (sec: number) => {
      let lo = 0,
        hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid]!.event.time.minuteStartSec! < sec) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const historyMinutes = Math.min(
      10080,
      Math.max(
        0,
        Math.ceil((watermark.timestampSec - Math.min(...cs.map((c) => c.minuteStartSec))) / 60),
      ),
    );

    const compute = (duration: number, end = watermark.timestampSec) => {
      const from = lower(Math.floor((end - duration) / 60) * 60);
      const to = lower(Math.floor(end / 60) * 60 + 60);
      const empty = from === to && unknown.length === 0;
      const key = empty ? `${dormantKey}:${duration}:${end}` : '';
      const byWindow = emptyWindows.get(index);
      const prior = empty ? byWindow?.get(key) : undefined;
      if (prior) return prior;
      const result = window(
        empty ? [] : [...sorted.slice(from, to), ...unknown],
        index,
        end - duration,
        end,
        watermark,
        registration?.rawToken ?? null,
        registration?.discoveredAtBlock ?? null,
      );
      // Only event-free windows can share across pools. Coverage, lifetime and raw-unit
      // identity are part of the key, and this memo ends with the current build.
      if (empty && emptyWindowCount < 4096) {
        const memo = byWindow ?? new Map<string, RollingMetric>();
        memo.set(key, result);
        emptyWindows.set(index, memo);
        emptyWindowCount++;
      }
      return result;
    };
    const histories = (duration: number, count: number) =>
      Array.from({ length: count + 1 }, (_, i) =>
        compute(duration, watermark.timestampSec - (count - i) * duration),
      );
    const rollingHistory1m = histories(
      60,
      Math.max(options.oneMinuteBaselineLimit ?? 60, historyMinutes),
    );
    const rollingHistory5m = histories(
      300,
      Math.max(options.fiveMinuteBaselineLimit ?? 12, Math.ceil(historyMinutes / 5)),
    );
    const rolling: RollingWindows = {
      '1m': baseline(
        rollingHistory1m.at(-1)!,
        rollingHistory1m,
        options.minimumOneMinuteSamples ?? 60,
      ),
      '5m': baseline(
        rollingHistory5m.at(-1)!,
        rollingHistory5m,
        options.minimumFiveMinuteSamples ?? 12,
      ),
      '15m': compute(900),
      '1h': compute(3600),
    };
    if (es.length === 0) byKey.set(dormantKey, { rolling, rollingHistory1m, rollingHistory5m });
    return {
      ...w,
      partialCurrent: null,
      recentClosed1m: null,
      recentClosed5x1m: null,
      naturalClosed5m: null,
      rolling,
      rollingHistory1m,
      rollingHistory5m,
    };
  });
}
