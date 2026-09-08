import type { RawLog } from './types.js';

export class InvalidSwapDirectionError extends Error {
  constructor(
    readonly version: 'v3' | 'v4',
    readonly rawAmount0: bigint,
    readonly rawAmount1: bigint,
  ) {
    super(`Cannot normalize ${version} swap with zero or same-sign deltas`);
    this.name = 'InvalidSwapDirectionError';
  }
}

export type PoolEventDecodeErrorCode =
  'unknown-topic' | 'invalid-data' | 'invalid-direction' | 'registration-mismatch';
/** A rejected event is not a PoolEvent. Keep its complete raw evidence for replay/diagnostics. */
export class PoolEventDecodeError extends Error {
  constructor(
    readonly code: PoolEventDecodeErrorCode,
    readonly protocol: 'v3' | 'v4',
    readonly raw: RawLog,
    cause: unknown,
  ) {
    super(`Cannot decode ${protocol} pool event: ${code}`, { cause });
    this.name = 'PoolEventDecodeError';
  }
}

/** Normalized amounts are unsigned bigint magnitudes; negating the signed minimum
 * exceeds int256/int128 maximum. Do not encode them back into those signed types. */
export function normalizeCoreDeltas(
  version: 'v3' | 'v4',
  a: bigint,
  b: bigint,
): { inputIndex: 0 | 1; amountIn: bigint; outputIndex: 0 | 1; amountOut: bigint } {
  const delta0 = version === 'v3' ? a : -a;
  const delta1 = version === 'v3' ? b : -b;
  if (delta0 > 0n && delta1 < 0n)
    return { inputIndex: 0, amountIn: delta0, outputIndex: 1, amountOut: -delta1 };
  if (delta1 > 0n && delta0 < 0n)
    return { inputIndex: 1, amountIn: delta1, outputIndex: 0, amountOut: -delta0 };
  throw new InvalidSwapDirectionError(version, a, b);
}
