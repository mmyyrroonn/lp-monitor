export type Support = 'supported' | 'unsupported' | 'unknown';
export class RpcFailure extends Error {
  constructor(public readonly kind: string, public readonly status: Support = 'unknown', public readonly retryable = false) { super(`RPC ${kind}`); }
}
export function classifyRpcError(error: unknown): RpcFailure {
  if (error instanceof RpcFailure) return error;
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  let code: unknown; let status: unknown; let message = '';
  while (cursor && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor);
    const item = cursor as Record<string, unknown>;
    code ??= item.code; status ??= item.status;
    message += ` ${item.name ?? ''} ${item.message ?? ''}`;
    cursor = item.cause;
  }
  if (code === -32601 || /method (not found|does not exist|.*not available)/i.test(message)) return new RpcFailure('method-not-found', 'unsupported');
  if (status === 429 || /429|rate limit|too many requests/i.test(message)) return new RpcFailure('rate-limit', 'unknown', true);
  if (/timeout|timed out|aborterror|econnreset|fetch failed/i.test(message)) return new RpcFailure('timeout-or-network', 'unknown', true);
  if (/missing trie|historical state|state.*not available|pruned/i.test(message)) return new RpcFailure('historical-state-missing', 'unsupported');
  if (/too many (results|logs)|block range|response.*(large|limit)|query.*limit|limit exceeded/i.test(message)) return new RpcFailure('range-limit');
  return new RpcFailure('request-failed');
}
