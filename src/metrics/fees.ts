export type GrossSwapFeeEstimate = {
  amountRaw: bigint;
  token: string;
  unit: string;
  label: 'estimated gross swap fee (not LP net fee)';
};

const FEE_DENOMINATOR = 1_000_000n;

/** Optional gross trade-fee annotation. It does not estimate the amount retained by LPs. */
export function estimateGrossSwapFee(
  amountIn: bigint,
  effectiveSwapFeePips: number | null,
  token: string,
  unit: string,
): GrossSwapFeeEstimate | null {
  if (amountIn < 0n) throw new RangeError('amountIn must be non-negative');
  if (effectiveSwapFeePips === null) return null;
  if (
    !Number.isInteger(effectiveSwapFeePips) ||
    effectiveSwapFeePips < 0 ||
    effectiveSwapFeePips > Number(FEE_DENOMINATOR)
  )
    throw new RangeError('effective swap fee must be an integer from 0 to 1,000,000 pips');

  return {
    amountRaw: (amountIn * BigInt(effectiveSwapFeePips)) / FEE_DENOMINATOR,
    token,
    unit,
    label: 'estimated gross swap fee (not LP net fee)',
  };
}
