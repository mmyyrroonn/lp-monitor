import { RpcFailure } from '../rpc/errors.js';
/** Parse a JSON-RPC QUANTITY without leaking provider response text. */
export function parseRpcQuantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value))
    throw new RpcFailure('malformed-response');
  return BigInt(value);
}
