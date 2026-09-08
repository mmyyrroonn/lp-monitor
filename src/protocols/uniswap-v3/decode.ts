import {
  InvalidSwapDirectionError,
  normalizeCoreDeltas,
  PoolEventDecodeError,
} from '../../domain/events.js';
import type { RawLog, LogTime, PoolEvent } from '../../domain/types.js';
import type { PoolRegistration } from '../../registry/pools.js';
import { ancillaryFields, assertCanonicalEvent, eventRef } from '../event-log.js';

import { UniswapEventDecodeError } from '../uniswap-v4/pool-key.js';
import { decodeEventLog, toEventSelector, type Hex } from 'viem';
import { v3PoolAbi } from './abi.js';

const v3PoolEventTopics = new Set(
  v3PoolAbi.filter((entry) => entry.type === 'event').map((entry) => toEventSelector(entry)),
);

export class UnknownUniswapV3EventTopicError extends Error {
  constructor(topic: Hex | undefined) {
    super(`Unknown Uniswap v3 pool event topic: ${topic ?? 'missing'}`);
    this.name = 'UnknownUniswapV3EventTopicError';
  }
}

export function decodeV3PoolEvent(log: { topics: readonly Hex[]; data: Hex }) {
  const topic = log.topics[0];
  if (topic === undefined || !v3PoolEventTopics.has(topic)) {
    throw new UnknownUniswapV3EventTopicError(topic);
  }
  try {
    return decodeEventLog({
      abi: v3PoolAbi,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
  } catch (error) {
    throw new UniswapEventDecodeError('v3', error);
  }
}

export function decodeV3(log: RawLog, time: LogTime, registration: PoolRegistration): PoolEvent {
  const pool = registration.pool;
  if (pool.protocol !== 'v3' || pool.address.toLowerCase() !== log.address.toLowerCase()) {
    throw new PoolEventDecodeError(
      'registration-mismatch',
      'v3',
      log,
      new Error('V3 emitter does not match registration'),
    );
  }
  try {
    const decoded = decodeV3PoolEvent(log);
    assertCanonicalEvent(log, v3PoolAbi, decoded.eventName, decoded.args);
    const base = { ref: eventRef(log), time, pool };
    if (decoded.eventName === 'Swap') {
      const args = decoded.args;
      const direction = normalizeCoreDeltas('v3', args.amount0, args.amount1);
      const tokens = [registration.token0, registration.token1] as const;
      return {
        ...base,
        kind: 'swap',
        rawAmount0: args.amount0,
        rawAmount1: args.amount1,
        tokenIn: tokens[direction.inputIndex],
        amountIn: direction.amountIn,
        tokenOut: tokens[direction.outputIndex],
        amountOut: direction.amountOut,
        sqrtPriceX96After: args.sqrtPriceX96,
        liquidityAfter: args.liquidity,
        tickAfter: args.tick,
        effectiveSwapFeePips: registration.feePips,
      };
    }
    if (decoded.eventName === 'Mint' || decoded.eventName === 'Burn') {
      const args = decoded.args;
      return {
        ...base,
        kind: 'liquidity',
        tickLower: args.tickLower,
        tickUpper: args.tickUpper,
        delta: decoded.eventName === 'Mint' ? args.amount : -args.amount,
        actor: args.owner.toLowerCase() as `0x${string}`,
        salt: null,
      };
    }
    return {
      ...base,
      kind:
        decoded.eventName === 'Initialize'
          ? 'initialize'
          : decoded.eventName === 'Collect' || decoded.eventName === 'CollectProtocol'
            ? 'collect'
            : 'other',
      decoded: ancillaryFields(decoded.eventName, decoded.args),
    };
  } catch (cause) {
    const code =
      cause instanceof UnknownUniswapV3EventTopicError
        ? 'unknown-topic'
        : cause instanceof InvalidSwapDirectionError
          ? 'invalid-direction'
          : 'invalid-data';
    throw new PoolEventDecodeError(code, 'v3', log, cause);
  }
}
