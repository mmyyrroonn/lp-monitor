import { expect, test } from 'vitest';
import { buildMinuteMetrics } from '../../src/metrics/windows.js';
import { summarizeRankedPool } from '../../src/ops/metrics-cli.js';

test('rank serialization leaves the multiplier unit unknown without a closed minute', () => {
  const pool = {
    chainId: 4663 as const,
    protocol: 'v3' as const,
    address: '0x1111111111111111111111111111111111111111' as const,
  };
  const [window] = buildMinuteMetrics(
    [],
    [],
    { number: 0n, hash: `0x${'0'.repeat(64)}`, timestampSec: 0 },
    { pools: [{ pool, discoveredAtBlock: null, rawToken: null }] },
  );
  expect(window!.recentClosed1m).toBeNull();
  expect(summarizeRankedPool(window!, 'volume5mClosed', undefined)).toMatchObject({
    volumeMultiplier: null,
    multiplierUnit: null,
  });
});
