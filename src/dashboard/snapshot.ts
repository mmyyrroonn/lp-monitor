import { SqliteProjectionStore, type StoredProjection } from '../storage/projection-store.js';
import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { openDatabase } from '../storage/database.js';
import {
  buildMetricsReport,
  StaleMetricProjectionError,
  type MetricInput,
  type MetricsReport,
} from '../storage/metric-store.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { PoolRegistry, poolRegistrationId, type PoolRegistration } from '../registry/pools.js';
import { inRollingWindow, ROLLING_DURATIONS } from '../metrics/rolling.js';
import type { SwapValuation } from '../metrics/notional.js';
import { inspectDatabaseStatus } from '../ops/status.js';
import { aggregateWindow } from './read-model.js';
import type {
  DashboardSnapshot,
  DashboardToken,
  Metric,
  TokenMinute,
  WindowName,
  RuntimeHealth,
} from './types.js';
export const unavailableHealth = (): RuntimeHealth => ({
  status: 'unavailable',
  updatedAtMs: null,
  headLagBlocks: null,
  headLagSeconds: null,
  coverage: null,
});
/**
 * The three fixed footnotes every dashboard answer carries after the report's own notes.
 *
 * Shared rather than copied: the worker publishes the same summary the legacy path publishes, and
 * two spellings of "what this page does not cover" would drift the moment one of them is edited.
 */
export const SNAPSHOT_NOTES: readonly string[] = [
  '仅分类登记的 RWA；Meme 分类不可用。',
  '统计范围仅包含本地已登记池；默认实时采集不补历史，未登记老池的覆盖未知。',
  '链上最终性为 provisional。窗口采用 (start, end]；历史分钟截止于该分钟最后一秒。',
];
/** The one freshness rule: a watermark more than a minute behind the wall clock is stale. */
export function snapshotFreshness(
  watermarkSec: number,
  nowMs: number,
): { status: 'ok' | 'stale'; message: string | null } {
  const stale = nowMs - watermarkSec * 1000 > 60000;
  return {
    status: stale ? 'stale' : 'ok',
    message: stale ? '链上数据已超过 60 秒未更新；当前显示保留的观测数据。' : null,
  };
}
export function emptySnapshot(
  input: Pick<MetricInput, 'scopeId' | 'assets'>,
  status: DashboardSnapshot['status'],
  message: string,
  nowMs = Date.now(),
): DashboardSnapshot {
  return {
    status,
    generatedAtMs: nowMs,
    sourceChainTimeSec: null,
    selectedEndSec: null,
    availableFromSec: null,
    sourceHash: null,
    scopeId: input.scopeId,
    assetVersion: input.assets.version,
    tokens: [],
    coverage: [],
    health: unavailableHealth(),
    message,
    notes: [],
  };
}
/** The legacy window rule, now shared with the read model so both cannot drift apart. */
function aggregate(
  swaps: readonly SwapValuation[],
  report: MetricsReport,
  startSec: number,
  endSec: number,
  pools: readonly PoolRegistration[],
): Metric {
  return aggregateWindow(swaps, report.coverage, report.at.timestampSec, startSec, endSec, pools);
}
/** Only accepts read-only handles: buildMetricsReport's live mode must never sync caches here. */
export function buildDashboardSnapshot(
  db: Database.Database,
  input: MetricInput,
  options: { at?: number; nowMs?: number; projection?: StoredProjection } = {},
): DashboardSnapshot {
  if (!db.readonly) throw new Error('Dashboard requires a read-only database');
  if (
    options.at !== undefined &&
    (!Number.isSafeInteger(options.at) || options.at < 0 || options.at % 60 !== 59)
  )
    throw new RangeError('Cutoff must be the integer final second of a minute');
  const nowMs = options.nowMs ?? Date.now();
  return db.transaction((): DashboardSnapshot => {
    const raw = new SqliteRangeStore(db),
      tip = raw.acceptedTip(input.scopeId);
    if (!tip) return emptySnapshot(input, 'empty', '当前范围没有已接受的链上数据。', nowMs);
    let report: MetricsReport;
    try {
      report = buildMetricsReport(db, input, {
        live: { historyMinutes: 180 },
        includeAssetValuations: true,
        projection: options.projection,
      });
    } catch (error) {
      if (!(error instanceof StaleMetricProjectionError)) throw error;
      const value = emptySnapshot(
        input,
        'stale',
        '投影缺失或已过期。请通过已有 follow 流程更新增量投影。',
        nowMs,
      );
      value.sourceChainTimeSec = tip.timestampSec;
      return value;
    }
    const end = options.at ?? report.at.timestampSec;
    const from = Math.max(
      0,
      Math.floor(report.at.timestampSec / 60) * 60 - 180 * 60,
      report.coverage.find((c) => c.fromBlock !== null)?.minuteStartSec ?? report.at.timestampSec,
    );
    if (end > report.at.timestampSec || end < from)
      throw new RangeError('Cutoff is outside retained chain-time evidence');
    const registrations = new PoolRegistry([
      ...raw.pools(input.registryScopeId),
      ...raw.pools(input.scopeId),
    ]).snapshot();
    const names = Object.keys(ROLLING_DURATIONS) as WindowName[];
    const tokens: DashboardToken[] = report.rwa.map((r) => {
      const pools = registrations.filter((p) => r.poolIds.includes(poolRegistrationId(p))),
        swaps = r.valuations ?? [];
      const metric = (start: number, finish: number) =>
        aggregate(swaps, report, start, finish, pools);
      const minutes: TokenMinute[] = [];
      for (
        let minuteStartSec = from;
        minuteStartSec <= Math.floor(report.at.timestampSec / 60) * 60;
        minuteStartSec += 60
      ) {
        const value = metric(
          minuteStartSec - 1,
          Math.min(minuteStartSec + 59, report.at.timestampSec),
        );
        minutes.push({
          minuteStartSec,
          status: !value.available
            ? value.reasons.includes('pool-lifetime-incomplete')
              ? ('warming' as const)
              : ('gap' as const)
            : minuteStartSec + 59 > report.at.timestampSec
              ? ('partial' as const)
              : ('closed' as const),
          txCount: value.txCount,
          swapCount: value.swapCount,
          usdMicros: value.usdMicros,
          reasons: value.reasons,
        });
      }
      return {
        address: r.asset.address,
        symbol: r.asset.symbol,
        category: 'rwa',
        poolIds: r.poolIds,
        minutes,
        windows: Object.fromEntries(
          names.map((name) => {
            const duration = ROLLING_DURATIONS[name];
            return [
              name,
              {
                current: metric(end - duration, end),
                previous: metric(end - duration * 2, end - duration),
              },
            ];
          }),
        ) as DashboardToken['windows'],
        pools: pools.map((pool) => {
          const poolId = poolRegistrationId(pool),
            es = swaps.filter((s) => poolRegistrationId(s) === poolId);
          const latest = es
            .filter(
              (s) => inRollingWindow(s.time, -1, end, end === report.at.timestampSec) !== false,
            )
            .at(-1);
          return {
            poolId,
            protocol: pool.pool.protocol,
            token0: pool.token0,
            token1: pool.token1,
            windows: Object.fromEntries(
              names.map((name) => [
                name,
                aggregate(es, report, end - ROLLING_DURATIONS[name], end, [pool]),
              ]),
            ) as Record<WindowName, Metric>,
            lastSwapTimeSec: latest?.time.exactTimestampSec ?? null,
          };
        }),
      };
    });
    const freshness = snapshotFreshness(report.at.timestampSec, nowMs);
    return {
      status: freshness.status,
      generatedAtMs: nowMs,
      sourceChainTimeSec: report.at.timestampSec,
      selectedEndSec: end,
      availableFromSec: from,
      sourceHash: report.sourceHash,
      scopeId: report.scopeId,
      assetVersion: report.assetVersion,
      tokens,
      coverage: report.coverage
        .filter((c) => c.minuteStartSec >= from && c.minuteStartSec <= end)
        .map((c) => ({
          minuteStartSec: c.minuteStartSec,
          complete: c.complete,
          reasons: [...c.reasons],
        })),
      health: unavailableHealth(),
      message: freshness.message,
      notes: [...report.notes, ...SNAPSHOT_NOTES],
    };
  })();
}
export function readDashboardSnapshot(
  path: string,
  input: MetricInput,
  at?: number,
): DashboardSnapshot {
  if (!existsSync(path))
    return emptySnapshot(input, 'empty', '尚无本地数据库；请先运行已有的有界采集流程。');
  let db: Database.Database | undefined;
  try {
    db = openDatabase(path, { readonly: true });
    const snapshot = buildDashboardSnapshot(db, input, { at });
    snapshot.health = runtimeHealth(path, input.scopeId);
    return snapshot;
  } catch (error) {
    if (error instanceof RangeError) throw error;
    return emptySnapshot(input, 'error', '无法读取本地数据；请检查数据库与配置版本。');
  } finally {
    db?.close();
  }
}

/**
 * The runtime health a dashboard answer reports, read from the persisted sidecar facts.
 *
 * A caller that cannot read them gets the honest "unavailable" value rather than an invented one,
 * and never an error: health is optional and must not expose filesystem or provider details.
 */
export function runtimeHealth(path: string, scopeId: string): RuntimeHealth {
  try {
    return mapDatabaseHealth(inspectDatabaseStatus(path, { scopeId }));
  } catch {
    return unavailableHealth();
  }
}

function mapDatabaseHealth(health: ReturnType<typeof inspectDatabaseStatus>): RuntimeHealth {
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const rpc = Object.values(health.rpc);
  return {
    status: health.sidecarFreshness === 'fresh' ? 'available' : 'unavailable',
    updatedAtMs: health.sidecarSampledAtMs,
    headLagBlocks:
      health.headGapBlocks !== null && health.headGapBlocks <= BigInt(Number.MAX_SAFE_INTEGER)
        ? number(Number(health.headGapBlocks))
        : null,
    headLagSeconds: number(health.headGapSeconds),
    coverage: health.gap === null ? null : health.gap ? 'gap' : 'complete',
    runtimeState: health.runtimeState ?? null,
    sidecarFreshness: health.sidecarFreshness,
    scannedBlock: health.scanned?.blockNumber.toString() ?? null,
    projectedBlock: health.projected?.blockNumber.toString() ?? null,
    outboxPending: number(health.outboxPending),
    dbBytes: number(health.dbBytes),
    walBytes: number(health.walBytes),
    processingLatencyMs: number(health.processingLatencyMs),
    rpcCalls:
      rpc.length > 0 && rpc.every((v) => number(v) !== null)
        ? number(rpc.reduce((a, b) => a + b, 0))
        : null,
  };
}

const LEGACY_NOTE = '旧库只读快照 · 不自动跟随写入；重启重新核验';
/** Explicit legacy compatibility: one full freshness check per reader lifetime,
 * then bounded evidence guarded by data_version on the SAME readonly connection. */
export function createDashboardReader(
  path: string,
  input: MetricInput,
  options: { legacySnapshot?: boolean } = {},
) {
  let db: Database.Database | undefined;
  let closed = false,
    attempted = false,
    invalidated = false;
  let version: number | null = null;
  let projection: StoredProjection | null = null;
  const stale = () => {
    const result = emptySnapshot(
      input,
      'stale',
      `${LEGACY_NOTE}。源数据库已更改，或旧投影未通过核验。`,
    );
    result.sourceChainTimeSec = projection?.end.timestampSec ?? null;
    result.notes = [LEGACY_NOTE];
    return result;
  };
  return {
    read(at?: number): DashboardSnapshot {
      if (closed) return emptySnapshot(input, 'error', '数据读取器已关闭。');
      if (!options.legacySnapshot) return readDashboardSnapshot(path, input, at);
      if (at !== undefined && (!Number.isSafeInteger(at) || at < 0 || at % 60 !== 59))
        throw new RangeError('Invalid cutoff');
      if (!existsSync(path))
        return emptySnapshot(input, 'empty', '尚无本地数据库；请先运行已有的有界采集流程。');
      try {
        db ??= openDatabase(path, { readonly: true });
        const connection = db;
        const snapshot = connection.transaction((): DashboardSnapshot => {
          // This query also establishes the SQLite read snapshot before data_version.
          const hasTable = connection
            .prepare(
              "select 1 from sqlite_master where type='table' and name='live_projection_cursors'",
            )
            .get();
          if (
            hasTable &&
            connection
              .prepare('select 1 from live_projection_cursors where scope_id=?')
              .get(input.scopeId)
          )
            return buildDashboardSnapshot(connection, input, { at });
          if (invalidated) return stale();
          const currentVersion = connection.pragma('data_version', { simple: true }) as number;
          if (attempted && currentVersion !== version) {
            invalidated = true;
            return stale();
          }
          if (!attempted) {
            attempted = true;
            version = currentVersion;
            const verified = new SqliteProjectionStore(connection).read(
              input.scopeId,
              input.registryScopeId,
              input.configVersion,
            );
            if (!verified) {
              invalidated = true;
              return stale();
            }
            const since = Math.floor(verified.end.timestampSec / 60) * 60 - 180 * 60 - 120;
            projection = {
              ...verified,
              events: verified.events.filter(
                (e) => e.time.minuteStartSec === null || e.time.minuteStartSec >= since,
              ),
              qualityErrors: verified.qualityErrors.filter(
                (e) => e.time.minuteStartSec === null || e.time.minuteStartSec >= since,
              ),
            };
          }
          if (!projection) return stale();
          const result = buildDashboardSnapshot(connection, input, { at, projection });
          result.notes = [...result.notes, LEGACY_NOTE];
          result.message = [result.message, LEGACY_NOTE].filter(Boolean).join(' ');
          return result;
        })();
        snapshot.health = runtimeHealth(path, input.scopeId);
        return snapshot;
      } catch (error) {
        if (error instanceof RangeError) throw error;
        return emptySnapshot(input, 'error', '无法读取本地数据；请检查数据库与配置版本。');
      }
    },
    close() {
      closed = true;
      db?.close();
      db = undefined;
      projection = null;
    },
  };
}
