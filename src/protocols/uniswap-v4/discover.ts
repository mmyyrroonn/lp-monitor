import type { Address, Hex } from 'viem';
import { CHAIN_ID } from '../../domain/chain.js';
import type { RawLog } from '../../domain/types.js';
import type { PoolRegistration } from '../../registry/pools.js';
import { computeV4PoolId, decodeV4ManagerEvent } from './pool-key.js';

export class V4PoolIdMismatchError extends Error {
  constructor(
    readonly expected: Hex,
    readonly observed: Hex,
  ) {
    super(`V4 Initialize PoolId mismatch: expected ${expected}, observed ${observed}`);
    this.name = 'V4PoolIdMismatchError';
  }
}

export function discoverPools(
  logs: readonly RawLog[],
  assetVersion: string,
): readonly PoolRegistration[] {
  return logs.map((log) => {
    const decoded = decodeV4ManagerEvent(log);
    if (decoded.eventName !== 'Initialize') throw new Error('Expected V4 Initialize event');
    const key = {
      currency0: decoded.args.currency0.toLowerCase() as Address,
      currency1: decoded.args.currency1.toLowerCase() as Address,
      fee: decoded.args.fee,
      tickSpacing: decoded.args.tickSpacing,
      hooks: decoded.args.hooks.toLowerCase() as Address,
    };
    const expected = computeV4PoolId(key).toLowerCase() as Hex;
    const observed = decoded.args.id.toLowerCase() as Hex;
    if (expected !== observed) throw new V4PoolIdMismatchError(expected, observed);
    return {
      pool: {
        chainId: CHAIN_ID,
        protocol: 'v4' as const,
        manager: log.address.toLowerCase() as Address,
        poolId: observed,
      },
      token0: key.currency0,
      token1: key.currency1,
      feePips: key.fee,
      tickSpacing: key.tickSpacing,
      hooks: key.hooks,
      discoveredAt: log,
      assetVersion,
      source: 'uniswap-v4:Initialize',
    };
  });
}
