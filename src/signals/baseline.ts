import { volumeBaseline, type BaselineResult } from '../metrics/baseline.js';
export type BaselineSample = {
  startSec: number;
  endSec: number;
  status: string;
  value: bigint | null;
  unit: string | null;
};
export type SignalBaseline = BaselineResult & {
  status: 'ready' | 'warming' | 'zero-baseline' | 'unpriced';
  unit: string | null;
};
export function signalBaseline(
  current: BaselineSample,
  history: readonly BaselineSample[],
  count: number,
): SignalBaseline {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('Invalid baseline count');
  if (current.value !== null && current.value < 0n) throw new RangeError('Negative volume');
  const duration = current.endSec - current.startSec;
  const seen = new Set<number>();
  const prior = history
    .filter(
      (s) =>
        s.status === 'closed' &&
        s.endSec <= current.startSec &&
        s.endSec - s.startSec === duration &&
        s.unit === current.unit &&
        s.value !== null,
    )
    .sort((a, b) => b.startSec - a.startSec)
    .filter((s) => {
      if (seen.has(s.startSec)) return false;
      seen.add(s.startSec);
      return true;
    })
    .slice(0, count);
  const result = volumeBaseline(
    current.value,
    prior.map((s) => s.value),
    count,
  );
  const status =
    current.value === null || current.unit === null
      ? 'unpriced'
      : result.sampleCount < count
        ? 'warming'
        : result.medianNumerator === 0n
          ? 'zero-baseline'
          : 'ready';
  return {
    ...result,
    multiplier: status === 'ready' ? result.multiplier : null,
    status,
    unit: current.unit,
  };
}
export function meetsMultiple(
  value: bigint | null,
  baseline: SignalBaseline,
  multiple: number,
): boolean {
  return (
    value !== null &&
    baseline.status === 'ready' &&
    baseline.medianNumerator !== null &&
    baseline.medianDenominator !== null &&
    value * baseline.medianDenominator >= baseline.medianNumerator * BigInt(multiple)
  );
}
