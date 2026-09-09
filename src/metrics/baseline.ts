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
