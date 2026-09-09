import type { PoolMetricWindows } from './windows.js';

export type PoolRankSort = 'volume5mClosed' | 'volumeMultiplier';

export function rankPools(
  windows: readonly PoolMetricWindows[],
  sortBy: PoolRankSort,
): readonly PoolMetricWindows[] {
  const included = windows.filter((window) =>
    sortBy === 'volume5mClosed'
      ? window.recentClosed5x1m?.usdMicros !== null &&
        window.recentClosed5x1m?.usdMicros !== undefined &&
        window.recentClosed5x1m.swapCount > 0
      : window.recentClosed1m?.minuteStartSec ===
          (window.partialCurrent?.minuteStartSec ?? -Infinity) - 60 &&
        window.recentClosed1m?.volumeMultiplier !== null &&
        window.recentClosed1m?.volumeMultiplier !== undefined,
  );
  return [...included].sort((a, b) => {
    const av =
      sortBy === 'volume5mClosed'
        ? a.recentClosed5x1m!.usdMicros!
        : a.recentClosed1m!.volumeMultiplier!;
    const bv =
      sortBy === 'volume5mClosed'
        ? b.recentClosed5x1m!.usdMicros!
        : b.recentClosed1m!.volumeMultiplier!;
    if (av < bv) return 1;
    if (av > bv) return -1;
    const at =
      sortBy === 'volume5mClosed' ? a.recentClosed5x1m!.txCount : a.recentClosed1m!.txCount!;
    const bt =
      sortBy === 'volume5mClosed' ? b.recentClosed5x1m!.txCount : b.recentClosed1m!.txCount!;
    return bt - at || a.poolId.localeCompare(b.poolId);
  });
}
