export class DiscoveryRecoveryStop extends Error {
  constructor(readonly kind: 'budget' | 'deadline') {
    super('Discovery recovery stopped: ' + kind);
  }
}

/**
 * Failure kinds an incomplete discovery batch may retry. Shared with the recorder's
 * cooperative-stop test so the two cannot drift apart.
 *
 * `request-failed` is the classifier's residual fallback, so it covers every provider message
 * with no known shape. Retrying it a bounded number of times is what keeps one unfamiliar
 * error from ending a multi-hour scan; exhaustion is reported, not fatal.
 *
 * `historical-state-missing` is a provider limitation rather than a permanent property of the
 * range: this provider answers old-block reads with it intermittently while serving the same
 * blocks a moment later.
 */
export const retryableDiscoveryKinds = new Set([
  'timeout-or-network',
  'rate-limit',
  'http-transient',
  'anchor-changed',
  'anchor-conflict',
  'request-failed',
  'historical-state-missing',
]);

export const stoppingDiscoveryKinds = new Set([
  'budget',
  'deadline',
  'user-stop',
  'shutdown',
  'sigint',
  'sigterm',
]);

/** Decide whether an incomplete discovery batch is safe to retry. */
export function classifyDiscoveryFailures(kinds: readonly string[]): 'retry' | 'stop' | 'fatal' {
  if (kinds.length === 0) return 'fatal';
  const unique = new Set(kinds);
  if (
    [...unique].some(
      (kind) => !retryableDiscoveryKinds.has(kind) && !stoppingDiscoveryKinds.has(kind),
    )
  )
    return 'fatal';
  const hasRetry = [...unique].some((kind) => retryableDiscoveryKinds.has(kind));
  const hasStop = [...unique].some((kind) => stoppingDiscoveryKinds.has(kind));
  if (hasRetry && hasStop) return 'fatal';
  return hasRetry ? 'retry' : 'stop';
}

/**
 * A cooperative cutoff can accompany a transient leaf without becoming a fatal provider error:
 * the batch is abandoned for this run, not thrown out of the discovery phase.
 */
export function isCooperativeDiscoveryStop(failureKinds: readonly string[]): boolean {
  return (
    failureKinds.some((kind) => stoppingDiscoveryKinds.has(kind)) &&
    failureKinds.every(
      (kind) => retryableDiscoveryKinds.has(kind) || stoppingDiscoveryKinds.has(kind),
    )
  );
}

/** Deterministic, capped exponential backoff for one-based recovery attempts. */
export function discoveryRetryDelayMs(consecutiveFailures: number): number {
  if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures <= 0)
    throw new RangeError('consecutiveFailures must be a positive integer');
  return Math.min(30_000, 2_000 * 2 ** Math.min(consecutiveFailures - 1, 4));
}
