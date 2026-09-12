import type { BlockAnchor, LogTime } from '../domain/types.js';
import { poolRegistrationId } from '../registry/pools.js';
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
  if (m + 60 <= start || m > end) return false;
  if (m > start && (m + 59 <= end || atWatermark)) return true;
  return null;
}
export function rollingCoverage(
  coverage: readonly MinuteCoverage[],
  start: number,
  end: number,
  watermark: number,
  birth: bigint | null = null,
): string[] {
  const reasons = new Set<string>();
  if (start < 0) reasons.add('warming');
  const byMinute = new Map(coverage.map((c) => [c.minuteStartSec, c]));
  for (let m = Math.max(0, Math.floor(start / 60) * 60); m <= Math.floor(end / 60) * 60; m += 60) {
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
const sum = (xs: readonly (bigint | null)[]) =>
  xs.some((v) => v === null) ? null : xs.reduce<bigint>((a, b) => a + b!, 0n);
function window(
  events: readonly MetricEvent[],
  coverage: readonly MinuteCoverage[],
  start: number,
  end: number,
  watermark: BlockAnchor,
  rawToken: string | null,
  birth: bigint | null,
): RollingMetric {
  const reasons = rollingCoverage(coverage, start, end, watermark.timestampSec, birth);
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
    string,
    Pick<PoolMetricWindows, 'rolling' | 'rollingHistory1m' | 'rollingHistory5m'>
  >();
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
        ? coverage.filter((c) => scopes.has(c.scopeId))
        : new Set(coverage.map((c) => c.scopeId)).size <= 1
          ? coverage
          : [];
    const registration = registrations.get(w.poolId);
    const dormantKey = JSON.stringify([
      registration?.rawToken,
      registration?.discoveredAtBlock?.toString(),
    ]);
    const cached = es.length === 0 ? dormant.get(dormantKey) : undefined;
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

    const compute = (duration: number, end = watermark.timestampSec) =>
      window(
        [
          ...sorted.slice(
            lower(Math.floor((end - duration) / 60) * 60),
            lower(Math.floor(end / 60) * 60 + 60),
          ),
          ...unknown,
        ],
        cs,
        end - duration,
        end,
        watermark,
        registration?.rawToken ?? null,
        registration?.discoveredAtBlock ?? null,
      );
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
    if (es.length === 0) dormant.set(dormantKey, { rolling, rollingHistory1m, rollingHistory5m });
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
