export type BaselineResult = {
  readonly sampleCount: number;
  readonly median: bigint | null;
  readonly medianNumerator: bigint | null;
  readonly medianDenominator: bigint | null;
  readonly multiplier: number | null;
};
function medianRatio(values: readonly bigint[]): { numerator: bigint; denominator: bigint } | null {
  if (!values.length) return null;
  if (values.some((v) => v < 0n)) throw new RangeError('Negative volume');
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? { numerator: sorted[middle]!, denominator: 1n }
    : { numerator: sorted[middle - 1]! + sorted[middle]!, denominator: 2n };
}
export function medianBigInt(values: readonly bigint[]): bigint | null {
  const ratio = medianRatio(values);
  return ratio && ratio.numerator % ratio.denominator === 0n
    ? ratio.numerator / ratio.denominator
    : null;
}
export function volumeBaseline(
  current: bigint | null,
  preceding: readonly (bigint | null)[],
  minimumSamples: number,
): BaselineResult {
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1)
    throw new RangeError('Invalid sample minimum');
  const samples = preceding.filter((v): v is bigint => v !== null),
    ratio = medianRatio(samples);
  const result = {
    sampleCount: samples.length,
    median: medianBigInt(samples),
    medianNumerator: ratio?.numerator ?? null,
    medianDenominator: ratio?.denominator ?? null,
    multiplier: null as number | null,
  };
  if (
    current === null ||
    samples.length < minimumSamples ||
    ratio === null ||
    ratio.numerator === 0n
  )
    return result;
  if (current < 0n) throw new RangeError('Negative volume');
  const value = Number((current * ratio.denominator * 1_000_000n) / ratio.numerator) / 1_000_000;
  return { ...result, multiplier: Number.isFinite(value) ? value : null };
}

export type RollingBaselinePoint = {
  readonly eligible: boolean;
  readonly unit: string | null;
  readonly current: bigint | null;
  readonly history?: readonly { readonly unit: string; readonly value: bigint | null }[];
};

/** Equivalent to filtering the complete eligible prefix for every point, while
 * retaining only the bounded history that can affect the next baseline. */
type RollingHistory = { queue: (bigint | null)[]; sorted: bigint[] };

function baselineFromSorted(
  current: bigint | null,
  sorted: readonly bigint[],
  minimumSamples: number,
): BaselineResult {
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1)
    throw new RangeError('Invalid sample minimum');
  if (sorted[0] !== undefined && sorted[0] < 0n) throw new RangeError('Negative volume');
  const middle = Math.floor(sorted.length / 2);
  const numerator =
    sorted.length === 0
      ? null
      : sorted.length % 2
        ? sorted[middle]!
        : sorted[middle - 1]! + sorted[middle]!;
  const denominator = sorted.length % 2 ? 1n : 2n;
  const result = {
    sampleCount: sorted.length,
    median: numerator !== null && numerator % denominator === 0n ? numerator / denominator : null,
    medianNumerator: numerator,
    medianDenominator: numerator === null ? null : denominator,
    multiplier: null as number | null,
  };
  if (current === null || sorted.length < minimumSamples || numerator === null || numerator === 0n)
    return result;
  if (current < 0n) throw new RangeError('Negative volume');
  const value = Number((current * denominator * 1_000_000n) / numerator) / 1_000_000;
  return { ...result, multiplier: Number.isFinite(value) ? value : null };
}

function sortedInsert(values: bigint[], value: bigint): void {
  let low = 0,
    high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < value) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

export class RollingVolumeBaseline {
  private readonly histories = new Map<string, RollingHistory>();
  constructor(
    private readonly minimumSamples: number,
    private readonly limit: number,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid baseline limit');
  }
  next(point: RollingBaselinePoint): BaselineResult | null {
    if (!point.eligible) return null;
    const prior = point.unit === null ? undefined : this.histories.get(point.unit);
    const result = baselineFromSorted(point.current, prior?.sorted ?? [], this.minimumSamples);
    for (const item of point.history ??
      (point.unit === null ? [] : [{ unit: point.unit, value: point.current }])) {
      const history = this.histories.get(item.unit) ?? { queue: [], sorted: [] };
      if (this.limit > 0 && history.queue.length === this.limit) {
        const removed = history.queue.shift();
        if (removed !== null && removed !== undefined)
          history.sorted.splice(history.sorted.indexOf(removed), 1);
      }
      history.queue.push(item.value);
      if (item.value !== null) sortedInsert(history.sorted, item.value);
      this.histories.set(item.unit, history);
    }
    return result;
  }
}

export function rollingVolumeBaselines(
  points: readonly RollingBaselinePoint[],
  minimumSamples: number,
  limit: number,
): readonly (BaselineResult | null)[] {
  const rolling = new RollingVolumeBaseline(minimumSamples, limit);
  return points.map((point) => rolling.next(point));
}
