import { expect, test, vi } from 'vitest';
vi.mock('../../src/domain/chain.js', () => ({ CHAIN_ID: 9999 }));
import { CHAIN_ID } from '../../src/domain/chain.js';
import { toHex, type Hex } from 'viem';
import { Interface } from 'ethers';
import {
  PoolRegistry,
  poolRegistrationId,
  type PoolRegistration,
} from '../../src/registry/pools.js';
import { projectRange } from '../../src/state/project-range.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import { v4ManagerAbi } from '../../src/protocols/uniswap-v4/abi.js';
import { rawLogKey } from '../../src/storage/manifest.js';
import type { RawLog } from '../../src/domain/types.js';
test.each(['v3', 'v4'] as const)(
  'projection %s keys follow configured chain identity and registry',
  (v) => {
    const address = toHex(1, { size: 20 }),
      id = toHex(1, { size: 32 }),
      hash = toHex(2, { size: 32 });
    const pool: PoolRegistration['pool'] =
      v === 'v3'
        ? { chainId: CHAIN_ID, protocol: v, address }
        : { chainId: CHAIN_ID, protocol: v, manager: address, poolId: id };
    const abi = new Interface(v === 'v3' ? v3PoolAbi : v4ManagerAbi);
    const encoded = abi.encodeEventLog(
      abi.getEvent('Swap')!,
      v === 'v3'
        ? [address, address, 100n, -90n, 2n ** 96n, 1000n, 0]
        : [id, address, -100n, 90n, 2n ** 96n, 1000n, 0, 3000],
    );
    const raw: RawLog = {
      address,
      blockNumber: 1n,
      blockHash: hash,
      transactionHash: hash,
      transactionIndex: 0,
      logIndex: 0,
      data: encoded.data as Hex,
      topics: encoded.topics as Hex[],
      rawBlockTimestamp: null,
    };
    const registration: PoolRegistration = {
      pool,
      token0: address,
      token1: toHex(2, { size: 20 }),
      feePips: 3000,
      tickSpacing: 60,
      hooks: toHex(0, { size: 20 }),
      discoveredAt: raw,
      source: 'synthetic',
      assetVersion: 'test',
    };
    const result = projectRange(
      {
        id: 'test',
        scopeId: 'test',
        completeness: 'complete',
        end: { number: 1n, hash, timestampSec: 120 },
      },
      [raw],
      new Map([
        [
          rawLogKey(raw),
          { minuteStartSec: 120, exactTimestampSec: null, source: 'minute-boundary' },
        ],
      ]),
      new PoolRegistry([registration]),
    );
    expect(result.qualityErrors).toEqual([]);
    expect(result.events).toHaveLength(1);
    expect(poolRegistrationId({ pool: result.events[0]!.pool! })).toBe(
      poolRegistrationId(registration),
    );
    expect(poolRegistrationId(registration)).toMatch(/^9999:/);
  },
);
