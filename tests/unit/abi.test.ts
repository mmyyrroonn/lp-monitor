import { decodeV3PoolEvent } from '../../src/protocols/uniswap-v3/decode.js';
import { Pool } from '@uniswap/v4-sdk';
import { Token } from '@uniswap/sdk-core';
import { encodeAbiParameters, toEventSelector, type Address, type Hex } from 'viem';
import { describe, expect, test } from 'vitest';
import { type PoolKey } from '../../src/domain/types.js';
import {
  computeV4PoolId,
  decodeV4ManagerEvent,
  UniswapEventDecodeError,
  UnknownUniswapEventTopicError,
} from '../../src/protocols/uniswap-v4/pool-key.js';
import { v3FactoryAbi, v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import { v4ManagerAbi } from '../../src/protocols/uniswap-v4/abi.js';

const currency0 = '0x0000000000000000000000000000000000000001' as Address;
const currency1 = '0x0000000000000000000000000000000000000002' as Address;
const hooks = '0x0000000000000000000000000000000000000000' as Address;
const key: PoolKey = { currency0, currency1, fee: 3_000, tickSpacing: 60, hooks };

describe('official Uniswap ABI boundary', () => {
  test('computes the V4 PoolId with the official ABI encoding and SDK cross-check', () => {
    const expectedEncoding = encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    );
    const token0 = new Token(4663, key.currency0, 18, 'ONE', 'One');
    const token1 = new Token(4663, key.currency1, 18, 'TWO', 'Two');

    expect(expectedEncoding).toHaveLength(2 + 32 * 5 * 2);
    expect(computeV4PoolId(key)).toBe(
      Pool.getPoolId(token0, token1, key.fee, key.tickSpacing, key.hooks),
    );
  });

  test('rejects a V4 PoolKey whose currencies are not strictly sorted', () => {
    expect(() => computeV4PoolId({ ...key, currency0: currency1, currency1: currency0 })).toThrow(
      /sorted/i,
    );
    expect(() => computeV4PoolId({ ...key, currency1: currency0 })).toThrow(/sorted/i);
  });

  test('matches official V3 event signatures', () => {
    const poolCreated = v3FactoryAbi.find(
      (item) => item.type === 'event' && item.name === 'PoolCreated',
    );
    const swap = v3PoolAbi.find((item) => item.type === 'event' && item.name === 'Swap');

    expect(poolCreated).toBeDefined();
    expect(swap).toBeDefined();
    expect(toEventSelector(poolCreated!)).toBe(
      '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
    );
    expect(toEventSelector(swap!)).toBe(
      '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
    );
  });

  test('returns an explicit error for unknown V4 topics', () => {
    expect(() =>
      decodeV4ManagerEvent({
        topics: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex],
        data: '0x' as Hex,
      }),
    ).toThrow(UnknownUniswapEventTopicError);
  });

  test('does not accept malformed data for a recognized V4 topic', () => {
    const initialize = v4ManagerAbi.find(
      (item) => item.type === 'event' && item.name === 'Initialize',
    );
    expect(initialize).toBeDefined();

    expect(() =>
      decodeV4ManagerEvent({
        topics: [toEventSelector(initialize!)],
        data: '0x' as Hex,
      }),
    ).toThrow(UniswapEventDecodeError);
  });

  test('contains the official V4 Initialize, Swap, and ModifyLiquidity events', () => {
    for (const name of ['Initialize', 'Swap', 'ModifyLiquidity'] as const) {
      expect(v4ManagerAbi.some((item) => item.type === 'event' && item.name === name)).toBe(true);
    }
  });
});

test.each([0, -60, 32768])('rejects unusable tick spacing %s', (tickSpacing) => {
  expect(() => computeV4PoolId({ ...key, tickSpacing })).toThrow(RangeError);
});
test('wraps malformed V3 event data consistently', () => {
  const swap = v3PoolAbi.find((item) => item.type === 'event' && item.name === 'Swap')!;
  expect(() => decodeV3PoolEvent({ topics: [toEventSelector(swap)], data: '0x' })).toThrow(
    UniswapEventDecodeError,
  );
});

test('cross-checks nonzero hooks and dynamic fees with official SDK', () => {
  const dynamicKey = {
    ...key,
    fee: 0x800000,
    hooks: '0x0000000000000000000000000000000000000080' as Address,
  };
  const token0 = new Token(4663, dynamicKey.currency0, 18);
  const token1 = new Token(4663, dynamicKey.currency1, 18);
  expect(computeV4PoolId(dynamicKey)).toBe(
    Pool.getPoolId(token0, token1, dynamicKey.fee, dynamicKey.tickSpacing, dynamicKey.hooks),
  );
});
