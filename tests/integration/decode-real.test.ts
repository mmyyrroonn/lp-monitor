import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';
import { expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import { decodeV3 } from '../../src/protocols/uniswap-v3/decode.js';
import { decodeV4 } from '../../src/protocols/uniswap-v4/decode.js';
import { discoverPools } from '../../src/protocols/uniswap-v4/discover.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import { v4ManagerAbi } from '../../src/protocols/uniswap-v4/abi.js';
import type { RawLog, LogTime, Swap } from '../../src/domain/types.js';
import type { PoolRegistration } from '../../src/registry/pools.js';
import { sha256 } from '../../src/ops/files.js';
import { PoolEventDecodeError } from '../../src/domain/events.js';

const root = 'artifacts/p0/raw/2026-09-08T06-10-51-129Z';
const bytes = readFileSync(`${root}/logs.json`);
const logs = (
  JSON.parse(bytes.toString('utf8')) as (Omit<RawLog, 'blockNumber'> & { blockNumber: string })[]
).map((raw): RawLog => ({ ...raw, blockNumber: BigInt(raw.blockNumber) }));
const v3 = new Interface(v3PoolAbi);
const v4 = new Interface(v4ManagerAbi);
const initializeTopic = v4.getEvent('Initialize')!.topicHash;
const registrations = discoverPools(
  logs.filter((raw) => raw.topics[0] === initializeTopic),
  'archived-p0',
);
const time: LogTime = { minuteStartSec: null, exactTimestampSec: null, source: 'unresolved' };

test('archived real events match independent ethers signed values and normalization', () => {
  expect(sha256(bytes)).toBe('13d388eaf6702cf28025e064f0f3fdab2c93ecd50cc5069e36e7a45489223126');
  let v3Swaps = 0;
  let v4Swaps = 0;
  let rejectedSwaps = 0;
  let v4Liquidity = 0;
  let dynamicFlagRegistrationSwaps = 0;
  for (const raw of logs) {
    const isV3 = raw.topics[0] === v3.getEvent('Swap')!.topicHash;
    const parsed = (isV3 ? v3 : v4).parseLog({ topics: [...raw.topics], data: raw.data })!;
    const registration = isV3
      ? // The fixture has no V3 creation event: this tests the supplied registration contract,
        // not verification of historical pool metadata or its fee.
        ({
          pool: { chainId: 4663, protocol: 'v3', address: raw.address },
          token0: '0x0000000000000000000000000000000000000001',
          token1: '0x0000000000000000000000000000000000000002',
          feePips: 3000,
          tickSpacing: 60,
          hooks: '0x0000000000000000000000000000000000000000',
          discoveredAt: raw,
          assetVersion: 'test-registration',
          source: 'synthetic-metadata',
        } satisfies PoolRegistration)
      : registrations.find(
          (entry) =>
            entry.pool.protocol === 'v4' &&
            entry.pool.poolId.toLowerCase() === raw.topics[1]?.toLowerCase(),
        );
    // Most manager-wide fixture swaps have no archived Initialize. Synthetic token/fee
    // metadata below tests the registration input contract only; no metadata is asserted as historical truth.
    const suppliedRegistration: PoolRegistration = registration ?? {
      pool: { chainId: 4663, protocol: 'v4', manager: raw.address, poolId: raw.topics[1] as Hex },
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      feePips: 0x800000,
      tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000',
      discoveredAt: raw,
      assetVersion: 'test-registration',
      source: 'synthetic-metadata',
    };
    if (
      parsed.name === 'Swap' &&
      !(
        (parsed.args.amount0 > 0n && parsed.args.amount1 < 0n) ||
        (parsed.args.amount0 < 0n && parsed.args.amount1 > 0n)
      )
    ) {
      rejectedSwaps++;
      try {
        (isV3 ? decodeV3 : decodeV4)(raw, time, suppliedRegistration);
        throw new Error('Expected invalid direction');
      } catch (error) {
        expect(error).toBeInstanceOf(PoolEventDecodeError);
        expect(error).toMatchObject({
          code: 'invalid-direction',
          raw,
          cause: { rawAmount0: parsed.args.amount0, rawAmount1: parsed.args.amount1 },
        });
      }
      continue;
    }
    const event = (isV3 ? decodeV3 : decodeV4)(raw, time, suppliedRegistration);
    expect(event.ref).toMatchObject({
      blockHash: raw.blockHash,
      transactionHash: raw.transactionHash,
      blockNumber: raw.blockNumber,
      logIndex: raw.logIndex,
    });
    expect(event.time).toEqual(time);
    if (parsed.name === 'Swap') {
      expect(event.kind).toBe('swap');
      const swap = event as Swap;
      expect(swap.rawAmount0).toBe(parsed.args.amount0);
      expect(swap.rawAmount1).toBe(parsed.args.amount1);
      expect(swap.sqrtPriceX96After).toBe(parsed.args.sqrtPriceX96);
      expect(swap.liquidityAfter).toBe(parsed.args.liquidity);
      expect(BigInt(swap.tickAfter)).toBe(parsed.args.tick);
      const pool0 = isV3 ? (parsed.args.amount0 as bigint) : -(parsed.args.amount0 as bigint);
      const pool1 = isV3 ? (parsed.args.amount1 as bigint) : -(parsed.args.amount1 as bigint);
      expect(swap.amountIn).toBe(pool0 > 0n ? pool0 : pool1);
      expect(swap.amountOut).toBe(pool0 < 0n ? -pool0 : -pool1);
      expect(swap.tokenIn.toLowerCase()).toBe(
        (pool0 > 0n ? suppliedRegistration.token0 : suppliedRegistration.token1).toLowerCase(),
      );
      expect(swap.effectiveSwapFeePips).toBe(
        isV3 ? suppliedRegistration.feePips : Number(parsed.args.fee),
      );
      if (isV3) {
        v3Swaps++;
        expect(swap.rawAmount0).toBe(-186644829477990813964n);
      } else {
        v4Swaps++;
        if (suppliedRegistration.feePips === 0x800000) {
          dynamicFlagRegistrationSwaps++;
          expect(swap.effectiveSwapFeePips).not.toBe(0x800000);
        }
      }
    } else if (parsed.name === 'ModifyLiquidity') {
      v4Liquidity++;
      expect(event).toMatchObject({
        kind: 'liquidity',
        delta: parsed.args.liquidityDelta,
        actor: (parsed.args.sender as Address).toLowerCase(),
        salt: parsed.args.salt,
      });
    } else if (parsed.name === 'Initialize') expect(event.kind).toBe('initialize');
  }
  expect(v3Swaps).toBe(1);
  expect(v4Swaps).toBe(530);
  expect(rejectedSwaps).toBe(1);
  expect(v4Swaps + rejectedSwaps).toBe(531);
  expect(v4Liquidity).toBe(27);
  expect(dynamicFlagRegistrationSwaps).toBeGreaterThan(0);
});
