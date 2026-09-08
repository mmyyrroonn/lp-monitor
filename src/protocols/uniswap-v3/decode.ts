import { decodeEventLog, toEventSelector, type Hex } from 'viem';
import { v3PoolAbi } from './abi.js';

const v3PoolEventTopics = new Set(
  v3PoolAbi
    .filter((entry) => entry.type === 'event')
    .map((entry) => toEventSelector(entry)),
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
  return decodeEventLog({
    abi: v3PoolAbi,
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
    strict: true,
  });
}
