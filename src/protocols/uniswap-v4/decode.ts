import {
  InvalidSwapDirectionError,
  normalizeCoreDeltas,
  PoolEventDecodeError,
} from '../../domain/events.js';
import type { RawLog, LogTime, PoolEvent } from '../../domain/types.js';
import type { PoolRegistration } from '../../registry/pools.js';
import {
  ancillaryFields,
  assertCanonicalEvent,
  eventRef,
  CanonicalEventError,
  decoderRegistration,
  assertLiquidityTicks,
  nontradeSwapFields,
  UniswapEventDecodeError,
} from '../event-log.js';
import { v4ManagerAbi } from './abi.js';
import { decodeV4ManagerEvent, UnknownUniswapEventTopicError } from './pool-key.js';

export function decodeV4(log: RawLog, time: LogTime, registration: PoolRegistration): PoolEvent {
  registration = decoderRegistration(log, registration, 'v4');
  const pool = registration.pool;
  if (pool.protocol !== 'v4') throw new TypeError('Expected validated V4 registration');
  try {
    const decoded = decodeV4ManagerEvent(log);
    assertCanonicalEvent(log, v4ManagerAbi, decoded.eventName, decoded.args);
    const base = { ref: eventRef(log), time, pool };
    // ERC-6909 Transfer/Approval ids identify currencies, not pools. Pool events
    // and ProtocolFeeUpdated instead carry a bytes32 PoolId.
    const poolScoped =
      decoded.eventName === 'Initialize' ||
      decoded.eventName === 'Swap' ||
      decoded.eventName === 'ModifyLiquidity' ||
      decoded.eventName === 'Donate' ||
      decoded.eventName === 'ProtocolFeeUpdated';
    if (poolScoped && decoded.args.id.toLowerCase() !== pool.poolId.toLowerCase()) {
      throw new PoolEventDecodeError(
        'registration-mismatch',
        'v4',
        log,
        new Error('V4 PoolId does not match registration'),
      );
    }
    if (decoded.eventName === 'Swap') {
      const args = decoded.args;
      if (args.fee < 0 || args.fee > 1_000_000)
        throw new CanonicalEventError('Invalid V4 Swap fee');
      if (args.amount0 === 0n || args.amount1 === 0n)
        return { ...base, kind: 'swap-nontrade', decoded: nontradeSwapFields(args, args.fee) };
      const direction = normalizeCoreDeltas('v4', args.amount0, args.amount1);
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
        effectiveSwapFeePips: args.fee,
      };
    }
    if (decoded.eventName === 'ModifyLiquidity') {
      const args = decoded.args;
      assertLiquidityTicks(args.tickLower, args.tickUpper);
      return {
        ...base,
        kind: 'liquidity',
        tickLower: args.tickLower,
        tickUpper: args.tickUpper,
        delta: args.liquidityDelta,
        actor: args.sender.toLowerCase() as `0x${string}`,
        salt: args.salt,
      };
    }
    return {
      ...base,
      pool: poolScoped ? pool : null,
      kind:
        decoded.eventName === 'Initialize'
          ? 'initialize'
          : decoded.eventName === 'Donate'
            ? 'donate'
            : 'other',
      decoded: ancillaryFields(decoded.eventName, decoded.args),
    };
  } catch (cause) {
    if (cause instanceof PoolEventDecodeError) throw cause;
    const code =
      cause instanceof UnknownUniswapEventTopicError
        ? 'unknown-topic'
        : cause instanceof InvalidSwapDirectionError
          ? 'invalid-direction'
          : cause instanceof UniswapEventDecodeError || cause instanceof CanonicalEventError
            ? 'invalid-data'
            : null;
    if (code === null) throw cause;
    throw new PoolEventDecodeError(code, 'v4', log, cause);
  }
}
