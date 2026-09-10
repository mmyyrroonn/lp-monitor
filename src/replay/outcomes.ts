import type { PoolRef } from '../domain/types.js';
import type { MetricEvent, MinuteCoverage } from '../metrics/windows.js';
import { poolRegistrationId } from '../registry/pools.js';
import { rawLogKey } from '../storage/manifest.js';
import { encodeJson } from '../domain/json.js';

export interface OutcomeCoverage {
  minutes: readonly MinuteCoverage[];
  endSec: number;
  scopeId: string;
  integrityComplete?: boolean;
}
export interface OutcomeTrigger {
  pool: PoolRef;
  triggerMinuteStartSec: number;
  reactionDelayMinutes?: 0 | 1 | 5;
}
export type OutcomeWindow = {
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
  usdgNotionalRaw: bigint | null;
  swapCount: number | null;
  txCount: number | null;
  activeMinutes: number | null;
  longestActiveRunMinutes: number | null;
  valuationComplete: boolean;
  observedSwapCount: number;
  observedTxCount: number;
};
export type Outcome = ReturnType<typeof evaluateOutcomes>;

/** Minute-close benchmark: all outcomes exclude the whole trigger minute.
 * Missing coverage never turns observed partial volume into a complete total. */
export function evaluateOutcomes(
  alert: OutcomeTrigger,
  futureEvents: readonly MetricEvent[],
  coverage: OutcomeCoverage,
) {
  if (
    !Number.isSafeInteger(alert.triggerMinuteStartSec) ||
    alert.triggerMinuteStartSec % 60 !== 0 ||
    !Number.isSafeInteger(coverage.endSec) ||
    ![0, 1, 5].includes(alert.reactionDelayMinutes ?? 0)
  )
    throw new RangeError('Invalid outcome interval');
  const poolId = poolRegistrationId({ pool: alert.pool });
  const startSec = alert.triggerMinuteStartSec + 60 + (alert.reactionDelayMinutes ?? 0) * 60;
  const candidates = futureEvents.filter(
    (e) =>
      e.event.kind === 'swap' &&
      e.event.pool !== null &&
      poolRegistrationId({ pool: e.event.pool }) === poolId &&
      (e.scopeId === undefined || e.scopeId === coverage.scopeId),
  );
  const windows: OutcomeWindow[] = ([15, 60, 180] as const).map((horizonMinutes) => {
    const endSec = startSec + horizonMinutes * 60;
    const censored = endSec > coverage.endSec;
    const reasons = new Set<string>();
    let coveredMinutes = 0;
    const relevantCoverage: MinuteCoverage[] = [];
    for (let sec = startSec; sec < Math.min(endSec, coverage.endSec); sec += 60) {
      const rows = coverage.minutes.filter(
        (m) => m.scopeId === coverage.scopeId && m.minuteStartSec === sec,
      );
      relevantCoverage.push(...rows);
      if (sec + 60 > coverage.endSec) continue;
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
    if (coverage.integrityComplete === false) reasons.add('input-integrity-incomplete');
    const bounds = relevantCoverage.flatMap((m) =>
      m.fromBlock !== null && m.toBlock !== null ? [m.fromBlock, m.toBlock] : [],
    );
    const lo = bounds.length ? bounds.reduce((a, b) => (a < b ? a : b)) : null;
    const hi = bounds.length ? bounds.reduce((a, b) => (a > b ? a : b)) : null;
    const unique = new Map<string, MetricEvent>();
    for (const e of candidates) {
      const minute = e.event.time.minuteStartSec;
      if (minute === null) {
        if (
          lo === null ||
          hi === null ||
          (e.event.ref.blockNumber >= lo && e.event.ref.blockNumber <= hi)
        )
          reasons.add('unresolved-event-time');
        continue;
      }
      if (minute < startSec || minute >= Math.min(endSec, coverage.endSec)) continue;
      if (minute % 60 !== 0) reasons.add('invalid-event-minute');
      const key = rawLogKey(e.event.ref),
        previous = unique.get(key);
      if (previous && encodeJson(previous) !== encodeJson(e)) reasons.add('conflicting-event');
      else unique.set(key, e);
    }
    const events = [...unique.values()];
    const txs = new Set(events.map((e) => e.event.ref.transactionHash.toLowerCase()));
    const active = new Set(events.map((e) => e.event.time.minuteStartSec!));
    let longest = 0,
      run = 0;
    for (let sec = startSec; sec < endSec; sec += 60) {
      run = active.has(sec) ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    const incomplete = reasons.size > 0;
    const complete = !incomplete && !censored;
    const priced = events.every((e) => e.usdMicros !== null);
    const usdgPriced = events.every((e) => e.usdgNotionalRaw !== null);
    return {
      horizonMinutes,
      startSec,
      endSec,
      status: incomplete ? 'incomplete' : censored ? 'censored' : 'complete',
      incomplete,
      censored,
      reasons: [...reasons, ...(censored ? ['right-censored'] : [])].sort(),
      coveredMinutes,
      expectedMinutes: horizonMinutes,
      usdMicros: complete && priced ? events.reduce((s, e) => s + e.usdMicros!, 0n) : null,
      usdgNotionalRaw:
        complete && usdgPriced ? events.reduce((s, e) => s + e.usdgNotionalRaw!, 0n) : null,
      swapCount: complete ? events.length : null,
      txCount: complete ? txs.size : null,
      activeMinutes: complete ? active.size : null,
      longestActiveRunMinutes: complete ? longest : null,
      valuationComplete: complete && priced,
      observedSwapCount: events.length,
      observedTxCount: txs.size,
    };
  });
  return {
    poolId,
    mode: 'minute-close' as const,
    windowSemantics: {
      delayZero: 'includes-emission-minute' as const,
      primaryReactionDelaysMinutes: [1, 5] as const,
    },
    triggerMinuteStartSec: alert.triggerMinuteStartSec,
    reactionDelayMinutes: alert.reactionDelayMinutes ?? 0,
    windows,
    feeEstimate: null,
    feeConfidence: 'not-estimated' as const,
  };
}
