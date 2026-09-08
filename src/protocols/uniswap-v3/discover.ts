import { decodeEventLog, type Address, type Hex } from 'viem';
import { CHAIN_ID } from '../../domain/chain.js';
import type { RawLog } from '../../domain/types.js';
import type { PoolRegistration } from '../../registry/pools.js';
import { v3FactoryAbi } from './abi.js';

const zeroAddress = '0x0000000000000000000000000000000000000000' as Address;

export function discoverPools(
  logs: readonly RawLog[],
  assetVersion: string,
): readonly PoolRegistration[] {
  return logs.map((log) => {
    const decoded = decodeEventLog({
      abi: v3FactoryAbi,
      eventName: 'PoolCreated',
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
      strict: true,
    });
    return {
      pool: {
        chainId: CHAIN_ID,
        protocol: 'v3' as const,
        address: decoded.args.pool.toLowerCase() as Address,
      },
      token0: decoded.args.token0.toLowerCase() as Address,
      token1: decoded.args.token1.toLowerCase() as Address,
      feePips: decoded.args.fee,
      tickSpacing: decoded.args.tickSpacing,
      hooks: zeroAddress,
      discoveredAt: log,
      assetVersion,
      source: 'uniswap-v3:PoolCreated',
    };
  });
}
