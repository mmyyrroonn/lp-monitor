import type { Address, Hex } from 'viem';
import type { PoolRef } from '../domain/types.js';
import { poolRegistrationId } from '../registry/pools.js';
import type { SwapValuation } from './notional.js';

export type PoolActivityAggregate = {
  pool: PoolRef;
  swapCount: number;
  txCount: number;
  nativeTotals: readonly (readonly [Address, bigint])[];
  usdgNotionalRaw: bigint | null;
  usdMicros: bigint | null;
};
export type RwaActivityAggregate = {
  swapCount: number;
  txCount: number;
  poolActivityUsdgRaw: bigint | null;
  poolActivityUsdMicros: bigint | null;
  pools: readonly PoolActivityAggregate[];
  cooccurringTransactionHashes: readonly Hex[];
};

function sumNullable(values: readonly (bigint | null)[]): bigint | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
}

export function aggregateRwa(swaps: readonly SwapValuation[]): RwaActivityAggregate {
  const byPool = new Map<string, SwapValuation[]>();
  const txPools = new Map<Hex, Set<string>>();
  for (const swap of swaps) {
    const poolId = poolRegistrationId({ pool: swap.pool });
    const group = byPool.get(poolId) ?? [];
    group.push(swap);
    byPool.set(poolId, group);
    const tx = swap.transactionHash.toLowerCase() as Hex;
    const pools = txPools.get(tx) ?? new Set<string>();
    pools.add(poolId);
    txPools.set(tx, pools);
  }
  const pools = [...byPool.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => {
      const native = new Map<Address, bigint>();
      for (const swap of group) {
        const token = swap.nativeToken.toLowerCase() as Address;
        native.set(token, (native.get(token) ?? 0n) + swap.nativeAmountRaw);
      }
      return {
        pool: group[0]!.pool,
        swapCount: group.length,
        txCount: new Set(group.map((swap) => swap.transactionHash.toLowerCase())).size,
        nativeTotals: [...native.entries()].sort(([left], [right]) => left.localeCompare(right)),
        usdgNotionalRaw: sumNullable(group.map((swap) => swap.usdgNotionalRaw)),
        usdMicros: sumNullable(group.map((swap) => swap.usdMicros)),
      };
    });
  return {
    swapCount: swaps.length,
    txCount: new Set(swaps.map((swap) => swap.transactionHash.toLowerCase())).size,
    poolActivityUsdgRaw: sumNullable(swaps.map((swap) => swap.usdgNotionalRaw)),
    poolActivityUsdMicros: sumNullable(swaps.map((swap) => swap.usdMicros)),
    pools,
    cooccurringTransactionHashes: [...txPools.entries()]
      .filter(([, ids]) => ids.size > 1)
      .map(([tx]) => tx)
      .sort(),
  };
}
