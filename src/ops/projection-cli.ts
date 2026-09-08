import { parseArgs } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from '../config/env.js';
import { loadChainConfig } from '../config/chain.js';
import { loadAssetVersion } from '../registry/assets.js';
import { computeWatchScopeId } from '../ingest/filter-plan.js';
import { PoolRegistry, poolRegistrationId } from '../registry/pools.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { encodeJson } from '../domain/json.js';
import { openDatabase } from '../storage/database.js';
import { NoAcceptedScopeError, SqliteProjectionStore } from '../storage/projection-store.js';
import { observationFreshness } from '../state/observations.js';

export function runProjectionCli(
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
        pool: { type: 'string' },
        rebuild: { type: 'boolean' },
      },
    });
  } catch {
    throw new ConfigError('Invalid projection option');
  }
  const command = parsed.positionals[0],
    values = parsed.values;
  if (parsed.positionals.length !== 1 || !['project', 'inspect-pool'].includes(command ?? ''))
    throw new ConfigError('Invalid projection command');
  if (command === 'inspect-pool' && (typeof values.pool !== 'string' || !values.pool))
    throw new ConfigError('inspect-pool requires pool');
  if (command === 'project' && values.pool !== undefined)
    throw new ConfigError('pool requires inspect-pool');
  if (command === 'inspect-pool' && values.rebuild !== undefined)
    throw new ConfigError('rebuild requires project');
  const config = loadChainConfig(String(values.config ?? 'config/robinhood.json'));
  const assets = loadAssetVersion(String(values.watchlist ?? 'config/watchlist.amc.json'));
  const scopeId = computeWatchScopeId(assets, 'operations', config);
  const registryScopeId = computeWatchScopeId(assets, 'discovery-only', config);
  const dbValue = String(values.db ?? (environment.LP_DATA_DIR ?? 'data') + '/recorder.sqlite');
  if (!dbValue.trim()) throw new ConfigError('Recorded database path must not be blank');
  const dbPath = resolve(dbValue);
  if (!existsSync(dbPath)) throw new ConfigError('Recorded database does not exist');
  if (!statSync(dbPath).isFile()) throw new ConfigError('Recorded database path must be a file');
  if (command === 'project' && values.rebuild !== true)
    throw new ConfigError('project requires --rebuild');
  const db = openDatabase(dbPath, { readonly: command === 'inspect-pool' });
  try {
    const store = new SqliteProjectionStore(db);
    if (command === 'project') {
      // P2 uses deterministic whole-scope replacement; --rebuild makes this explicit.
      let result;
      try {
        result = store.rebuild(scopeId, registryScopeId, config.version);
      } catch (error) {
        if (!(error instanceof NoAcceptedScopeError)) throw error;
        console.log(
          encodeJson({
            status: 'no-accepted-scope',
            scopeId: error.scopeId,
            next: 'Run ingest/follow with the same config first',
          }),
        );
        return 4;
      }
      console.log(
        encodeJson({
          status: result.qualityErrors.length ? 'quality-errors' : 'projected',
          version: result.version,
          scopeId,
          registryScopeId,
          configVersion: config.version,
          assetVersion: assets.version,
          sourceHash: result.sourceHash,
          at: result.end,
          events: result.events.length,
          pools: result.observations.length,
          qualityErrors: result.qualityErrors,
          finality: 'provisional',
        }),
      );
      return result.qualityErrors.length ? 4 : 0;
    }
    const result = store.read(scopeId, registryScopeId, config.version);
    if (!result) {
      console.log(
        encodeJson({
          status: 'projection-stale-or-missing',
          scopeId,
          next: 'Run project --rebuild against this database and config',
        }),
      );
      return 4;
    }
    let selector = String(values.pool).toLowerCase();
    if (selector === 'amc-usdg-v3') {
      const raw = new SqliteRangeStore(db);
      const registry = new PoolRegistry([...raw.pools(registryScopeId), ...raw.pools(scopeId)]);
      const candidates = registry
        .snapshot()
        .filter(
          (r) =>
            r.pool.protocol === 'v3' &&
            config.v3Pools.includes(r.pool.address) &&
            ((r.token0 === config.tokens.AMC && r.token1 === config.tokens.USDG) ||
              (r.token1 === config.tokens.AMC && r.token0 === config.tokens.USDG)),
        );
      if (candidates.length !== 1)
        throw new ConfigError(
          'AMC/USDG alias requires one matching registered configured V3 pool; use a pool address',
        );
      selector = poolRegistrationId(candidates[0]!);
    }
    const observation = result.observations.find(
      (o) =>
        poolRegistrationId(o) === selector ||
        (o.pool.protocol === 'v3' ? o.pool.address === selector : o.pool.poolId === selector),
    );
    if (!observation) throw new ConfigError('Pool is not registered in this projection');
    const id = poolRegistrationId(observation);
    const poolQualityErrors = result.qualityErrors.filter((e) => e.poolId === id);
    const scopeQualityErrors = result.qualityErrors.filter((e) => e.poolId === null);
    const hasErrors = poolQualityErrors.length + scopeQualityErrors.length > 0;
    const last = observation.lastSwap?.time;
    console.log(
      encodeJson({
        status: hasErrors ? 'quality-errors' : 'observed',
        version: result.version,
        scopeId,
        configVersion: config.version,
        assetVersion: assets.version,
        sourceHash: result.sourceHash,
        at: result.end,
        observation,
        timing:
          !last || last.source === 'unresolved'
            ? 'unresolved'
            : last.exactTimestampSec === null
              ? 'minute'
              : 'second',
        swapObservation: observationFreshness(observation),
        currentPoolStateKnown: false,
        finality: 'provisional',
        note: 'L, price and tick are values reported by the last Swap. Later liquidity actions do not infer current L. Actors are not user counts.',
        poolQualityErrors,
        scopeQualityErrors,
      }),
    );
    return hasErrors ? 4 : 0;
  } finally {
    db.close();
  }
}
