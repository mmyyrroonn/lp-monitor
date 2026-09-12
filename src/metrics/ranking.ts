import type { PoolMetricWindows } from './windows.js';

export type PoolRankSort = 'volume5m' | 'volume5mClosed' | 'volumeMultiplier';

export function rankPools(
  windows: readonly PoolMetricWindows[],
  sortBy: PoolRankSort,
): readonly PoolMetricWindows[] {
  if (windows.some((w) => w.rolling)) {
    const key = sortBy !== 'volumeMultiplier' ? '5m' : '1m';
    const value = (w: PoolMetricWindows) =>
      sortBy !== 'volumeMultiplier'
        ? w.rolling?.[key].usdMicros
        : w.rolling?.[key].volumeMultiplier;
    return windows
      .filter(
        (w) =>
          w.rolling?.[key].status === 'closed' &&
          value(w) !== null &&
          value(w) !== undefined &&
          (w.rolling[key].swapCount ?? 0) > 0,
      )
      .sort((a, b) =>
        value(a)! > value(b)!
          ? -1
          : value(a)! < value(b)!
            ? 1
            : (b.rolling![key].txCount ?? 0) - (a.rolling![key].txCount ?? 0) ||
              a.poolId.localeCompare(b.poolId),
      );
  }
  const included = windows.filter((window) =>
    sortBy !== 'volumeMultiplier'
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
      sortBy !== 'volumeMultiplier'
        ? a.recentClosed5x1m!.usdMicros!
        : a.recentClosed1m!.volumeMultiplier!;
    const bv =
      sortBy !== 'volumeMultiplier'
        ? b.recentClosed5x1m!.usdMicros!
        : b.recentClosed1m!.volumeMultiplier!;
    if (av < bv) return 1;
    if (av > bv) return -1;
    const at =
      sortBy !== 'volumeMultiplier' ? a.recentClosed5x1m!.txCount : a.recentClosed1m!.txCount!;
    const bt =
      sortBy !== 'volumeMultiplier' ? b.recentClosed5x1m!.txCount : b.recentClosed1m!.txCount!;
    return bt - at || a.poolId.localeCompare(b.poolId);
  });
}
