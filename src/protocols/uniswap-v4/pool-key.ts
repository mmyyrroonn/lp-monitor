import {
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  keccak256,
  toEventSelector,
  type Address,
  type Hex,
} from 'viem';
import type { PoolKey } from '../../domain/types.js';
import { v4ManagerAbi } from './abi.js';

const poolKeyParameters = [
  { type: 'address' },
  { type: 'address' },
  { type: 'uint24' },
  { type: 'int24' },
  { type: 'address' },
] as const;

const v4EventTopics = new Set(
  v4ManagerAbi
    .filter((entry) => entry.type === 'event')
    .map((entry) => toEventSelector(entry)),
);

export class UnknownUniswapEventTopicError extends Error {
  constructor(protocol: 'v4', topic: Hex | undefined) {
    super(`Unknown Uniswap ${protocol} event topic: ${topic ?? 'missing'}`);
    this.name = 'UnknownUniswapEventTopicError';
  }
}

export class UniswapEventDecodeError extends Error {
  constructor(protocol: 'v4', cause: unknown) {
    super(`Could not strictly decode Uniswap ${protocol} event`, { cause });
    this.name = 'UniswapEventDecodeError';
  }
}

export function computeV4PoolId(key: PoolKey): Hex {
  const currency0 = getAddress(key.currency0);
  const currency1 = getAddress(key.currency1);
  const hooks = getAddress(key.hooks);

  if (currency0.toLowerCase() >= currency1.toLowerCase()) {
    throw new RangeError('V4 PoolKey currencies must be strictly sorted');
  }
  if (!Number.isInteger(key.fee) || key.fee < 0 || key.fee > 0xffffff) {
    throw new RangeError('V4 PoolKey fee must fit uint24');
  }
  if (!Number.isInteger(key.tickSpacing) || key.tickSpacing < -8_388_608 || key.tickSpacing > 8_388_607) {
    throw new RangeError('V4 PoolKey tickSpacing must fit int24');
  }

  return keccak256(encodeAbiParameters(poolKeyParameters, [currency0, currency1, key.fee, key.tickSpacing, hooks]));
}

export function decodeV4ManagerEvent(log: { topics: readonly Hex[]; data: Hex }) {
  const topic = log.topics[0];
  if (topic === undefined || !v4EventTopics.has(topic)) {
    throw new UnknownUniswapEventTopicError('v4', topic);
  }
  try {
    return decodeEventLog({
      abi: v4ManagerAbi,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
  } catch (error) {
    throw new UniswapEventDecodeError('v4', error);
  }
}

export type { PoolKey, Address };
