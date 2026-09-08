import { encodeAbiParameters, type Abi } from 'viem';
import type { AncillaryEvent, LogRef, RawLog } from '../domain/types.js';

export function eventRef(log: RawLog): LogRef {
  const { blockHash, blockNumber, transactionHash, transactionIndex, logIndex } = log;
  return { blockHash, blockNumber, transactionHash, transactionIndex, logIndex };
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
  const event = abi.find((entry) => entry.type === 'event' && entry.name === eventName);
  if (!event || event.type !== 'event') throw new Error('Unknown ABI event');
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
    throw new Error('Noncanonical event data or topics');
  }
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
