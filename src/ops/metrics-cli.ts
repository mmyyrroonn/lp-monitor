import type { MetricsReport } from '../storage/metric-store.js';
import { poolRegistrationId } from '../registry/pools.js';
import { rawLogKey } from '../storage/manifest.js';
import { parseArgs } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from '../config/env.js';
import { loadChainConfig } from '../config/chain.js';
import { loadAssetVersion } from '../registry/assets.js';
import { computeWatchScopeId } from '../ingest/filter-plan.js';
import { loadMetricMetadata } from '../metrics/metadata.js';
import { rankPools, type PoolRankSort } from '../metrics/ranking.js';
import { openDatabase } from '../storage/database.js';
import {
  buildMetricsReport,
  SqliteMetricStore,
  StaleMetricProjectionError,
} from '../storage/metric-store.js';
import { encodeJson } from '../domain/json.js';
import { saveJson } from './files.js';

/** Offline commands; --save explicitly requests a derived cache update. */
export function runMetricsCli(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): number {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string' },
        db: { type: 'string' },
        watchlist: { type: 'string' },
        metadata: { type: 'string' },
        rwa: { type: 'string' },
        window: { type: 'string' },
        sort: { type: 'string' },
        out: { type: 'string' },
        save: { type: 'boolean' },
      },
    });
  } catch {
    throw new ConfigError('Invalid metrics option');
  }
  const command = parsed.positionals[0],
    values = parsed.values;
  if (parsed.positionals.length !== 1 || !['metrics', 'rank'].includes(command ?? ''))
    throw new ConfigError('Invalid metrics command');
  if (command === 'rank' && (values.rwa !== undefined || values.window !== undefined))
    throw new ConfigError('rwa/window require metrics');
  if (command === 'metrics' && values.sort !== undefined)
    throw new ConfigError('sort requires rank');
  if (values.window !== undefined && values.window !== '5m')
    throw new ConfigError('P3 supports --window 5m');
  const sort = String(values.sort ?? 'volume5mClosed');
  if (!['volume5mClosed', 'volumeMultiplier'].includes(sort))
    throw new ConfigError('Invalid rank sort');
  const config = loadChainConfig(String(values.config ?? 'config/robinhood.json'));
  const assets = loadAssetVersion(String(values.watchlist ?? 'config/watchlist.amc.json'));
  const selector = values.rwa === undefined ? null : String(values.rwa).toLowerCase();
  const selected =
    selector === null
      ? null
      : assets.assets.filter((a) => a.symbol.toLowerCase() === selector || a.address === selector);
  if (selected && selected.length !== 1)
    throw new ConfigError('RWA selector must identify one watched asset');
  const dbValue = String(values.db ?? (environment.LP_DATA_DIR ?? 'data') + '/recorder.sqlite');
  if (!dbValue.trim()) throw new ConfigError('Database path must not be blank');
  const path = resolve(dbValue);
  if (!existsSync(path) || !statSync(path).isFile())
    throw new ConfigError('Recorded database must exist');
  if (
    values.out !== undefined &&
    (!String(values.out).trim() || resolve(String(values.out)) === path)
  )
    throw new ConfigError('Invalid metrics output path');
  const metadata = loadMetricMetadata(String(values.metadata ?? 'config/metric-metadata.json'));
  const scopeId = computeWatchScopeId(assets, 'operations', config),
    registryScopeId = computeWatchScopeId(assets, 'discovery-only', config);
  const db = openDatabase(path, { readonly: values.save !== true });
  try {
    let report;
    try {
      report = buildMetricsReport(db, {
        scopeId,
        registryScopeId,
        configVersion: config.version,
        assets,
        usdg: config.tokens.USDG,
        metadata,
      });
    } catch (error) {
      if (!(error instanceof StaleMetricProjectionError)) throw error;
      console.log(
        encodeJson({
          status: 'projection-stale-or-missing',
          scopeId,
          next: 'Run project --rebuild against this database and config',
        }),
      );
      return 4;
    }
    if (values.save === true) new SqliteMetricStore(db).replace(report);
    const rwa = selected
      ? report.rwa.filter((r) => r.asset.address === selected[0]!.address)
      : report.rwa;
    const poolIds = new Set(rwa.flatMap((r) => r.poolIds));
    const windows = report.windows.filter((w) => poolIds.has(w.poolId));
    const current = Math.floor(report.at.timestampSec / 60) * 60;
    const lastFive = report.coverage.filter(
      (c) => c.minuteStartSec >= current - 300 && c.minuteStartSec < current,
    );
    const complete =
      lastFive.length === 5 &&
      lastFive.every((c) => c.complete) &&
      report.qualityErrors.length === 0;
    const result = {
      ...report,
      ...filterMetricEvidence(report, poolIds),
      status: complete ? 'observed' : 'incomplete',
      command,
      window: '5m',
      rwa,
      windows: windows.map(({ minutes, natural5mBuckets, ...summary }) => ({
        ...summary,
        minuteCount: minutes.length,
        natural5mBucketCount: natural5mBuckets.length,
      })),
      annotations: report.annotations.filter((a) => poolIds.has(a.poolId)),
      ...(command === 'rank'
        ? {
            sort,
            ranked: rankPools(windows, sort as PoolRankSort).map((w) =>
              summarizeRankedPool(
                w,
                sort as PoolRankSort,
                report.annotations.find((a) => a.poolId === w.poolId),
              ),
            ),
          }
        : {}),
    };
    if (values.out !== undefined) {
      saveJson(resolve(String(values.out)), result);
      console.log(
        encodeJson({
          status: result.status,
          out: String(values.out),
          scopeId,
          sourceHash: report.sourceHash,
          pools: windows.length,
          closedMinutes: report.coverage.filter((c) => c.complete).length,
          at: report.at,
        }),
      );
    } else console.log(encodeJson(result));
    return complete ? 0 : 4;
  } finally {
    db.close();
  }
}

export function filterMetricEvidence(
  report: Pick<MetricsReport, 'valuations' | 'quotes' | 'grossFees'>,
  poolIds: ReadonlySet<string>,
) {
  const valuations = report.valuations.filter((v) => poolIds.has(poolRegistrationId(v)));
  const eventIds = new Set(valuations.map((v) => v.eventId));
  const quoteIds = new Set(
    valuations.flatMap((v) => (v.quoteEvidence ? [rawLogKey(v.quoteEvidence.effectiveAt)] : [])),
  );
  return {
    valuations,
    quotes: report.quotes.filter((q) => quoteIds.has(rawLogKey(q.effectiveAt))),
    grossFees: report.grossFees.filter((f) => eventIds.has(f.eventId)),
  };
}

export function summarizeRankedPool(
  w: MetricsReport['windows'][number],
  sort: PoolRankSort,
  annotation: MetricsReport['annotations'][number] | undefined,
) {
  return {
    poolId: w.poolId,
    volume5mClosed: w.recentClosed5x1m?.usdMicros ?? null,
    volumeMultiplier: w.recentClosed1m?.volumeMultiplier ?? null,
    multiplierUnit: w.recentClosed1m?.baselineUnit ?? null,
    txCount: (sort === 'volume5mClosed' ? w.recentClosed5x1m : w.recentClosed1m)?.txCount ?? null,
    partialCurrent: w.partialCurrent,
    annotation,
  };
}
