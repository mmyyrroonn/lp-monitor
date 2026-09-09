function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    throw new RangeError('decimals must be an integer from 0 to 255');
}

/** Decimal rendering using string arithmetic only; bigint values never pass through Number. */
export function formatBigIntUnits(raw: bigint, decimals: number): string {
  assertDecimals(decimals);
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString();
  if (decimals === 0) return `${negative ? '-' : ''}${digits}`;

  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  const value = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  return `${negative ? '-' : ''}${value}`;
}

export function formatLabeledAmount(
  raw: bigint,
  decimals: number,
  label: string,
  unit: string,
): string {
  return `${label}: ${formatBigIntUnits(raw, decimals)} ${unit}`;
}
