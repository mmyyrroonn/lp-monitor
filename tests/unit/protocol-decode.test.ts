import { Interface } from 'ethers';
import { expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import { PoolEventDecodeError } from '../../src/domain/events.js';
import type { RawLog, LogTime } from '../../src/domain/types.js';
import type { PoolRegistration } from '../../src/registry/pools.js';
import { decodeV3 } from '../../src/protocols/uniswap-v3/decode.js';
import { decodeV4 } from '../../src/protocols/uniswap-v4/decode.js';
import { v3PoolAbi } from '../../src/protocols/uniswap-v3/abi.js';
import { v4ManagerAbi } from '../../src/protocols/uniswap-v4/abi.js';

const actor = '0x0000000000000000000000000000000000000009' as Address;
const token0 = '0x0000000000000000000000000000000000000001' as Address;
const token1 = '0x0000000000000000000000000000000000000002' as Address;
const zero = '0x0000000000000000000000000000000000000000' as Address;
const id = `0x${'11'.repeat(32)}` as Hex;
const ref = {
  blockHash: id,
  transactionHash: id,
  blockNumber: 5n,
  transactionIndex: 2,
  logIndex: 3,
};
const time: LogTime = { minuteStartSec: null, exactTimestampSec: null, source: 'unresolved' };
const interfaces = { v3: new Interface(v3PoolAbi), v4: new Interface(v4ManagerAbi) };
function registration(v: 'v3' | 'v4'): PoolRegistration {
  return {
    pool:
      v === 'v3'
        ? { chainId: 4663, protocol: v, address: actor }
        : { chainId: 4663, protocol: v, manager: actor, poolId: id },
    token0,
    token1,
    feePips: v === 'v3' ? 3000 : 0x800000,
    tickSpacing: 60,
    hooks: zero,
    discoveredAt: ref,
    source: 'synthetic-test',
    assetVersion: 'test',
  };
}
function log(v: 'v3' | 'v4', name: string, args: readonly unknown[]): RawLog {
  const iface = interfaces[v];
  const encoded = iface.encodeEventLog(iface.getEvent(name)!, args);
  return {
    ...ref,
    address: actor,
    rawBlockTimestamp: null,
    topics: encoded.topics as Hex[],
    data: encoded.data as Hex,
  };
}
const decoders = { v3: decodeV3, v4: decodeV4 };
function swapLog(v: 'v3' | 'v4', a = v === 'v3' ? 100n : -100n, b = v === 'v3' ? -90n : 90n) {
  return log(
    v,
    'Swap',
    v === 'v3'
      ? [actor, token1, a, b, 1n << 96n, 12345n, -80]
      : [id, actor, a, b, 1n << 96n, 12345n, -80, 700],
  );
}
for (const v of ['v3', 'v4'] as const) {
  test(`${v} maps swap raw signs, post-state and actual fee`, () => {
    const raw = swapLog(v);
    expect(decoders[v](raw, time, registration(v))).toEqual({
      kind: 'swap',
      ref,
      time,
      pool: registration(v).pool,
      rawAmount0: v === 'v3' ? 100n : -100n,
      rawAmount1: v === 'v3' ? -90n : 90n,
      tokenIn: token0,
      tokenOut: token1,
      amountIn: 100n,
      amountOut: 90n,
      sqrtPriceX96After: 1n << 96n,
      liquidityAfter: 12345n,
      tickAfter: -80,
      effectiveSwapFeePips: v === 'v3' ? 3000 : 700,
    });
  });
  test.each([
    [0n, 1n],
    [1n, 1n],
  ])(`${v} retains non-trade raw evidence %s %s`, (a, b) => {
    const raw = swapLog(v, a, b);
    try {
      decoders[v](raw, time, registration(v));
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(PoolEventDecodeError);
      expect(error).toMatchObject({ code: 'invalid-direction', protocol: v, raw });
    }
  });
  test.each(['unknown', 'truncated', 'extra-topic', 'extra-data'])(
    `${v} retains malformed event evidence %s`,
    (variant) => {
      const raw = swapLog(v);
      if (variant === 'unknown') raw.topics = [id];
      if (variant === 'truncated') raw.data = '0x';
      if (variant === 'extra-topic') raw.topics = [...raw.topics, id];
      if (variant === 'extra-data') raw.data = `${raw.data}${'00'.repeat(32)}`;
      try {
        decoders[v](raw, time, registration(v));
        throw new Error('Expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(PoolEventDecodeError);
        expect(error).toMatchObject({
          code: variant === 'unknown' ? 'unknown-topic' : 'invalid-data',
          raw,
        });
        expect((error as Error).cause).toBeDefined();
      }
    },
  );
  test(`${v} rejects wrong registration emitter`, () => {
    const raw = { ...swapLog(v), address: token0 };
    expect(() => decoders[v](raw, time, registration(v))).toThrow(
      expect.objectContaining({ code: 'registration-mismatch', raw }),
    );
  });
  test(`${v} retains maximum signed amounts exactly`, () => {
    const max = (1n << (v === 'v3' ? 255n : 127n)) - 1n;
    const decoded = decoders[v](swapLog(v, max, -max - 1n), time, registration(v));
    expect(decoded).toMatchObject({ rawAmount0: max, rawAmount1: -max - 1n });
    expect(decoded).toMatchObject(
      v === 'v3' ? { amountIn: max, amountOut: max + 1n } : { amountIn: max + 1n, amountOut: max },
    );
  });
}
test.each(['Mint', 'Burn'])('V3 %s uses liquidity units and owner as actor', (name) => {
  const args = [actor, -120, 120, 123n, 999n, 888n];
  const raw = log('v3', name, name === 'Mint' ? [token1, ...args] : args);
  expect(decodeV3(raw, time, registration('v3'))).toEqual({
    kind: 'liquidity',
    ref,
    time,
    pool: registration('v3').pool,
    tickLower: -120,
    tickUpper: 120,
    delta: name === 'Mint' ? 123n : -123n,
    actor,
    salt: null,
  });
});
test('zero V3 Burn remains zero liquidity change', () => {
  expect(
    decodeV3(log('v3', 'Burn', [actor, -120, 120, 0n, 0n, 0n]), time, registration('v3')),
  ).toMatchObject({ kind: 'liquidity', delta: 0n });
});
test.each([-123n, 0n, 123n])('V4 ModifyLiquidity retains signed delta %s and salt', (delta) => {
  expect(
    decodeV4(
      log('v4', 'ModifyLiquidity', [id, actor, -120, 120, delta, id]),
      time,
      registration('v4'),
    ),
  ).toEqual({
    kind: 'liquidity',
    ref,
    time,
    pool: registration('v4').pool,
    tickLower: -120,
    tickUpper: 120,
    delta,
    actor,
    salt: id,
  });
});
test('V3 Collect stays ancillary and preserves principal fields losslessly', () => {
  expect(
    decodeV3(
      log('v3', 'Collect', [actor, token1, -120, 120, 1n << 100n, 999n]),
      time,
      registration('v3'),
    ),
  ).toMatchObject({
    kind: 'collect',
    decoded: { eventName: 'Collect', amount0: (1n << 100n).toString(), amount1: '999' },
  });
});
test('V4 Donate is separate from liquidity and swap', () => {
  expect(
    decodeV4(log('v4', 'Donate', [id, actor, 1n << 200n, 9n]), time, registration('v4')),
  ).toMatchObject({ kind: 'donate', decoded: { amount0: (1n << 200n).toString(), amount1: '9' } });
});
test('V4 Initialize dynamic fee flag remains metadata', () => {
  const decoded = decodeV4(
    log('v4', 'Initialize', [id, token0, token1, 0x800000, 60, zero, 1n << 96n, 0]),
    time,
    registration('v4'),
  );
  expect(decoded).toMatchObject({ kind: 'initialize', decoded: { fee: 0x800000 } });
  expect(decoded).not.toHaveProperty('effectiveSwapFeePips');
});
test('V4 wrong pool id is rejected', () => {
  expect(() =>
    decodeV4(swapLog('v4'), time, {
      ...registration('v4'),
      pool: { chainId: 4663, protocol: 'v4', manager: actor, poolId: `0x${'22'.repeat(32)}` },
    }),
  ).toThrow(expect.objectContaining({ code: 'registration-mismatch' }));
});
test('manager-wide Transfer id is a currency id, not a pool id', () => {
  const decoded = decodeV4(
    log('v4', 'Transfer', [actor, token0, token1, 42n, 500n]),
    time,
    registration('v4'),
  );
  expect(decoded).toMatchObject({
    kind: 'other',
    pool: null,
    decoded: { eventName: 'Transfer', id: '42', amount: '500' },
  });
});
test('rejects noncanonical signed int128 word before it can become a swap', () => {
  const raw = swapLog('v4');
  raw.data = `0x${(1n << 128n).toString(16).padStart(64, '0')}${raw.data.slice(66)}`;
  expect(() => decodeV4(raw, time, registration('v4'))).toThrow(
    expect.objectContaining({ code: 'invalid-data', raw }),
  );
});

test('V4 ProtocolFeeUpdated preserves its pool identity without overriding Swap fee', () => {
  expect(
    decodeV4(log('v4', 'ProtocolFeeUpdated', [id, 4097]), time, registration('v4')),
  ).toMatchObject({
    kind: 'other',
    pool: registration('v4').pool,
    decoded: { eventName: 'ProtocolFeeUpdated', protocolFee: 4097 },
  });
});
test('V4 ProtocolFeeUpdated rejects mismatched pool identity', () => {
  const raw = log('v4', 'ProtocolFeeUpdated', [`0x${'22'.repeat(32)}`, 4097]);
  expect(() => decodeV4(raw, time, registration('v4'))).toThrow(
    expect.objectContaining({ code: 'registration-mismatch', raw }),
  );
});
