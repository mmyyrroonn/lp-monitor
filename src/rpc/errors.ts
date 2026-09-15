export type Support = 'supported' | 'unsupported' | 'unknown';
export class RpcFailure extends Error {
  evidenceFailure?: RpcFailure;
  constructor(
    public readonly kind: string,
    public readonly status: Support = 'unknown',
    public readonly retryable = false,
  ) {
    super(`RPC ${kind}`);
  }
}
export function classifyRpcError(error: unknown): RpcFailure {
  if (error instanceof RpcFailure) return error;
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  const codes: number[] = [],
    statuses: number[] = [],
    messages: string[] = [];
  while (cursor && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor);
    const item = cursor as Record<string, unknown>;
    if (typeof item.code === 'number') codes.push(item.code);
    if (typeof item.status === 'number') statuses.push(item.status);
    // viem's composed message embeds URLs and request bodies. Prefer provider details;
    // strip URLs even in fallback strings so credentials cannot influence classification.
    const detail = typeof item.details === 'string' ? item.details : item.message;
    if (typeof detail === 'string')
      messages.push(
        detail.replace(/https?:\/\/\S+/gi, '').replace(/(?:URL|Request body):[^\n]*/gi, ''),
      );
    if (typeof item.name === 'string') messages.push(item.name);
    cursor = item.cause;
  }
  if (statuses.includes(429)) return new RpcFailure('rate-limit', 'unknown', true);
  if (statuses.some((s) => s === 408 || (s >= 500 && s <= 599 && s !== 501)))
    return new RpcFailure('http-transient', 'unknown', true);
  if (codes.includes(-32601)) return new RpcFailure('method-not-found', 'unsupported');
  if (codes.includes(-32029)) return new RpcFailure('rate-limit', 'unknown', true);
  const message = messages.join(' ');
  if (
    codes.includes(-32602) &&
    /(?:exceed|max(?:imum)?|too many).*(?:topics?|addresses?|filter values?)/i.test(message)
  )
    return new RpcFailure('filter-limit');
  if (
    /rate[ -]?limit|too many requests|requests per second|(?:CU|compute units?)\s*(?:per second|\/sec)/i.test(
      message,
    )
  )
    return new RpcFailure('rate-limit', 'unknown', true);
  if (/too many (results|logs)|block range|response.*(large|limit)|query.*limit/i.test(message))
    return new RpcFailure('range-limit');
  if (codes.includes(-32005)) return new RpcFailure('unknown-limit');
  if (/method (not found|does not exist|.*not available)/i.test(message))
    return new RpcFailure('method-not-found', 'unsupported');
  if (/timeout|timed out|aborterror|econnreset|fetch failed/i.test(message))
    return new RpcFailure('timeout-or-network', 'unknown', true);
  // Two wordings for the same provider limitation: geth's pruned-trie message, and providers
  // that only index block metadata for a recent window ("metadata is not found, <block>").
  if (
    /missing trie|historical state|state.*not available|pruned|metadata is not found/i.test(message)
  )
    return new RpcFailure('historical-state-missing', 'unsupported');
  // Residual fallback for a provider message that matches no known shape. Still retryable:
  // a bounded retry (the caller's maxRetries) costs seconds, while treating it as terminal
  // let the first unfamiliar message end an hours-long scan.
  return new RpcFailure('request-failed', 'unknown', true);
}
