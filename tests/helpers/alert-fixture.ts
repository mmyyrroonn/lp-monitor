import { encodeAbiParameters, encodeEventTopics, toHex, type Hex } from 'viem';
import { createAssetRegistry } from '../../src/registry/assets.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import {
  rawLogKey,
  type RecordedRangeBatch,
  type PersistedPoolRegistration,
} from '../../src/storage/manifest.js';
import type { RawLog } from '../../src/domain/types.js';
export const addr = (n: number) => toHex(n, { size: 20 }),
  hash = (n: number) => toHex(n, { size: 32 });
export const anchor = (n: number) => ({ number: BigInt(n), hash: hash(n), timestampSec: n + 60 });
export const pool = addr(1),
  rwa = addr(2),
  usdg = addr(3);
export const metricInput = {
  scopeId: 's',
  registryScopeId: 's',
  configVersion: 'c',
  assets: createAssetRegistry('test', [rwa]),
  usdg,
  metadata: {
    version: 'test',
    chainId: 4663 as const,
    source: 'synthetic',
    entries: [rwa, usdg].map((address) => ({
      address,
      decimals: 6,
      observedAtBlock: '0',
      blockHash: hash(0),
    })),
  },
};
export function swap(block: number, usdgUnits = 2000): RawLog {
  return {
    address: pool,
    blockNumber: BigInt(block),
    blockHash: hash(block),
    transactionHash: hash(block + 10000),
    transactionIndex: 0,
    logIndex: 0,
    rawBlockTimestamp: '0x0',
    topics: encodeEventTopics({
      abi: v3PoolAbi,
      eventName: 'Swap',
      args: { sender: pool, recipient: pool },
    }) as Hex[],
    data: encodeAbiParameters(
      [
        { type: 'int256' },
        { type: 'int256' },
        { type: 'uint160' },
        { type: 'uint128' },
        { type: 'int24' },
      ],
      [1000000n, -BigInt(usdgUnits) * 1000000n, 2n ** 96n, 1000n, 0],
    ),
  };
}
export const registration: PersistedPoolRegistration = {
  pool: { chainId: 4663, protocol: 'v3', address: pool },
  token0: rwa,
  token1: usdg,
  feePips: 3000,
  tickSpacing: 60,
  hooks: addr(0),
  discoveredAt: swap(60),
  assetVersion: 'test',
  source: 'synthetic',
};
export function hotLogs(): RawLog[] {
  return Array.from({ length: 79 }, (_, i) => swap(70 + i * 60, i >= 73 && i <= 77 ? 30000 : 2000));
}
export function batch(id: string, logs: RawLog[]): RecordedRangeBatch {
  return {
    id,
    scopeId: 's',
    fromBlock: 60n,
    toBlock: 4800n,
    end: anchor(4800),
    previous: anchor(4800),
    logs,
    observedAtMs: 100000,
    captureMode: 'synthetic',
    filterPlanHash: 'f',
    manifestHash: id,
    completeness: 'complete',
    manifest: {
      version: 1,
      filterVersion: 'f',
      expectedShardIds: ['one'],
      shards: [
        {
          shardId: 'one',
          filterId: 'operation-v3',
          request: { fromBlock: 60n, toBlock: 4800n, address: [pool], topics: [] },
          status: 'success',
          responseHash: 'h',
          error: null,
          logKeys: logs.map(rawLogKey),
          logCount: logs.length,
        },
      ],
    },
    poolRegistrations: [{ ...registration, discoveredAt: logs[0] ?? swap(70) }],
    logTimes: logs.map((ref) => ({
      ref,
      time: {
        minuteStartSec: Math.floor((Number(ref.blockNumber) + 60) / 60) * 60,
        exactTimestampSec: Number(ref.blockNumber) + 60,
        source: 'log-verified',
      },
    })),
    boundaries: Array.from({ length: 80 }, (_, i) => {
      const timestampSec = 120 + i * 60,
        n = timestampSec - 60;
      return { timestampSec, firstBlock: BigInt(n), before: anchor(n - 1), at: anchor(n) };
    }),
  };
}
