export class DiscoveryRecoveryStop extends Error {
  constructor(readonly kind: 'budget' | 'deadline') {
    super('Discovery recovery stopped: ' + kind);
  }
}

const retryableKinds = new Set([
  'timeout-or-network',
  'rate-limit',
  'http-transient',
  'anchor-changed',
  'anchor-conflict',
]);

const stoppingKinds = new Set(['budget', 'deadline', 'user-stop', 'shutdown', 'sigint', 'sigterm']);

/** Decide whether an incomplete discovery batch is safe to retry. */
export function classifyDiscoveryFailures(kinds: readonly string[]): 'retry' | 'stop' | 'fatal' {
  if (kinds.length === 0) return 'fatal';
  const unique = new Set(kinds);
  if ([...unique].some((kind) => !retryableKinds.has(kind) && !stoppingKinds.has(kind)))
    return 'fatal';
  const hasRetry = [...unique].some((kind) => retryableKinds.has(kind));
  const hasStop = [...unique].some((kind) => stoppingKinds.has(kind));
  if (hasRetry && hasStop) return 'fatal';
  return hasRetry ? 'retry' : 'stop';
}

/** Deterministic, capped exponential backoff for one-based recovery attempts. */
export function discoveryRetryDelayMs(consecutiveFailures: number): number {
  if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures <= 0)
    throw new RangeError('consecutiveFailures must be a positive integer');
  return Math.min(30_000, 2_000 * 2 ** Math.min(consecutiveFailures - 1, 4));
}
