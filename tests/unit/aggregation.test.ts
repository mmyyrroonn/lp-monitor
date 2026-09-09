import { expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import type { SwapValuation } from '../../src/metrics/notional.js';
import { aggregateRwa } from '../../src/metrics/rwa-aggregate.js';

const HASH = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const POOL_A = {
  chainId: 4663 as const,
  protocol: 'v3' as const,
  address: '0x0000000000000000000000000000000000000010' as Address,
};
const POOL_B = {
  chainId: 4663 as const,
  protocol: 'v4' as const,
  manager: '0x0000000000000000000000000000000000000020' as Address,
  poolId: HASH('c'),
};

function valued(pool: typeof POOL_A | typeof POOL_B, tx: Hex, amount: bigint): SwapValuation {
  return {
    ref: {
      blockHash: HASH('a'),
      blockNumber: 1n,
      transactionHash: tx,
      transactionIndex: 0,
      logIndex: 0,
    },
    eventId: `4663:${HASH('a').toLowerCase()}:${tx.toLowerCase()}:0`,
    time: { minuteStartSec: 0, exactTimestampSec: 1, source: 'log-verified' },
    pool,
    transactionHash: tx,
    nativeToken: '0x0000000000000000000000000000000000000002',
    nativeAmountRaw: amount,
    nativeDecimals: 6,
    nativeSide: 'token1',
    usdgNotionalRaw: amount,
    usdMicros: amount,
    pricingSide: 'usdg',
    quoteEvidence: null,
    quality: 'usdg-only',
  };
}

test('deduplicates RWA transactions while preserving each pool swap and pool activity', () => {
  const shared = HASH('1');
  const aggregate = aggregateRwa([
    valued(POOL_A, shared, 2_000_000n),
    valued(POOL_B, shared, 3_000_000n),
  ]);
  expect(aggregate.swapCount).toBe(2);
  expect(aggregate.txCount).toBe(1);
  expect(aggregate.poolActivityUsdgRaw).toBe(5_000_000n);
  expect(aggregate.poolActivityUsdMicros).toBe(5_000_000n);
  expect(aggregate.pools).toHaveLength(2);
  expect(aggregate.pools.map((pool) => [pool.swapCount, pool.txCount])).toEqual([
    [1, 1],
    [1, 1],
  ]);
  expect(aggregate.cooccurringTransactionHashes).toEqual([shared]);
});

test('keeps null valuation gaps instead of filling zero', () => {
  const unpriced = {
    ...valued(POOL_A, HASH('2'), 7n),
    usdgNotionalRaw: null,
    usdMicros: null,
    quality: 'unpriced' as const,
  };
  const aggregate = aggregateRwa([unpriced]);
  expect(aggregate.poolActivityUsdgRaw).toBeNull();
  expect(aggregate.poolActivityUsdMicros).toBeNull();
  expect(aggregate.pools[0]?.usdgNotionalRaw).toBeNull();
  expect(aggregate.pools[0]?.nativeTotals).toEqual([[unpriced.nativeToken, 7n]]);
});

test('does not add unlike native RWA units into one total', () => {
  const first = {
    ...valued(POOL_A, HASH('3'), 1n),
    nativeToken: '0x0000000000000000000000000000000000000001' as Address,
  };
  const second = {
    ...valued(POOL_A, HASH('4'), 2n),
    nativeToken: '0x0000000000000000000000000000000000000004' as Address,
  };
  const aggregate = aggregateRwa([first, second]);
  expect(aggregate.pools[0]?.nativeTotals).toEqual([
    [first.nativeToken, 1n],
    [second.nativeToken, 2n],
  ]);
});
