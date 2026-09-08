import {
  BaseError,
  encodeAbiParameters,
  toEventSelector,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { CHAIN_ID } from '../domain/chain.js';
import { PoolEventDecodeError } from '../domain/events.js';
import type { AncillaryEvent, LogRef, RawLog } from '../domain/types.js';
import type { PoolRegistration } from '../registry/pools.js';

export class UniswapEventDecodeError extends Error {
  constructor(protocol: 'v3' | 'v4', cause: unknown) {
    super(`Could not strictly decode Uniswap ${protocol} event`, { cause });
    this.name = 'UniswapEventDecodeError';
  }
}
/** Expected malformed chain payload/ABI value; internal failures must propagate. */
export class CanonicalEventError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CanonicalEventError';
  }
}

export function eventRef(log: RawLog): LogRef {
  const { blockHash, blockNumber, transactionHash, transactionIndex, logIndex } = log;
  return { blockHash, blockNumber, transactionHash, transactionIndex, logIndex };
}

export function assertLogEncoding(log: { topics: readonly Hex[]; data: Hex }): void {
  if (
    typeof log.data !== 'string' ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(log.data) ||
    !Array.isArray(log.topics) ||
    log.topics.some((topic) => typeof topic !== 'string' || !/^0x[0-9a-f]{64}$/i.test(topic))
  ) {
    throw new CanonicalEventError('Malformed event hex data or topics');
  }
}

/** viem strict checks required fields; canonical re-encoding also rejects trailing
 * data/topics and out-of-width integers or invalid sign/address padding. The fixed
 * official pool event ABIs use only static, elementary types. */
export function assertCanonicalEvent(
  log: RawLog,
  abi: Abi,
  eventName: string,
  args: Readonly<Record<string, unknown>>,
): void {
  assertLogEncoding(log);
  const event = abi.find(
    (entry) =>
      entry.type === 'event' &&
      toEventSelector(entry).toLowerCase() === log.topics[0]?.toLowerCase(),
  );
  if (!event || event.type !== 'event' || event.name !== eventName)
    throw new TypeError('Decoded event does not match ABI selector');
  for (const input of event.inputs) {
    if (!input.name || args[input.name] === undefined)
      throw new TypeError('Decoded ABI field missing');
  }
  try {
    const dataInputs = event.inputs.filter((input) => !input.indexed);
    const expectedData = encodeAbiParameters(
      dataInputs,
      dataInputs.map((input) => args[input.name!]),
    );
    const indexedInputs = event.inputs.filter((input) => input.indexed);
    const expectedTopics = indexedInputs.map((input) =>
      encodeAbiParameters([input], [args[input.name!]]),
    );
    if (
      log.data.toLowerCase() !== expectedData.toLowerCase() ||
      log.topics.length !== expectedTopics.length + 1 ||
      expectedTopics.some(
        (topic, index) => topic.toLowerCase() !== log.topics[index + 1]?.toLowerCase(),
      )
    ) {
      throw new CanonicalEventError('Noncanonical event data or topics');
    }
  } catch (cause) {
    if (cause instanceof BaseError) throw new CanonicalEventError('Invalid ABI value', { cause });
    throw cause;
  }
}

export function decoderRegistration(
  log: RawLog,
  registration: PoolRegistration,
  protocol: 'v3' | 'v4',
): PoolRegistration {
  const address = (value: unknown): value is Address =>
    typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
  const pool = registration?.pool;
  if (
    !pool ||
    pool.protocol !== protocol ||
    pool.chainId !== CHAIN_ID ||
    !address(registration.token0) ||
    !address(registration.token1) ||
    !Number.isInteger(registration.feePips) ||
    registration.feePips < 0 ||
    registration.feePips > (protocol === 'v3' ? 1_000_000 : 0xffffff) ||
    !address(log.address) ||
    (pool.protocol === 'v3'
      ? !address(pool.address) || pool.address.toLowerCase() !== log.address.toLowerCase()
      : !address(pool.manager) ||
        pool.manager.toLowerCase() !== log.address.toLowerCase() ||
        typeof pool.poolId !== 'string' ||
        !/^0x[0-9a-f]{64}$/i.test(pool.poolId))
  ) {
    throw new PoolEventDecodeError(
      'registration-mismatch',
      protocol,
      log,
      new Error('Invalid or mismatched pool registration'),
    );
  }
  return {
    ...registration,
    token0: registration.token0.toLowerCase() as Address,
    token1: registration.token1.toLowerCase() as Address,
    pool:
      pool.protocol === 'v3'
        ? { ...pool, address: pool.address.toLowerCase() as Address }
        : {
            ...pool,
            manager: pool.manager.toLowerCase() as Address,
            poolId: pool.poolId.toLowerCase() as Hex,
          },
  };
}

export function assertLiquidityTicks(lower: number, upper: number): void {
  if (
    !Number.isInteger(lower) ||
    !Number.isInteger(upper) ||
    lower < -887272 ||
    upper > 887272 ||
    lower >= upper
  )
    throw new CanonicalEventError('Invalid liquidity tick range');
}

export function nontradeSwapFields(
  args: { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number },
  fee: number,
): AncillaryEvent['decoded'] {
  return {
    eventName: 'Swap',
    amount0: args.amount0.toString(),
    amount1: args.amount1.toString(),
    sqrtPriceX96: args.sqrtPriceX96.toString(),
    liquidity: args.liquidity.toString(),
    tick: args.tick.toString(),
    fee: fee.toString(),
  };
}

export function ancillaryFields(
  eventName: string,
  args: Readonly<Record<string, string | number | bigint | boolean>>,
): AncillaryEvent['decoded'] {
  return Object.fromEntries([
    ['eventName', eventName],
    ...Object.entries(args).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? value.toString() : value,
    ]),
  ]);
}
