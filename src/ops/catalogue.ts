import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BlockAnchor } from '../domain/types.js';
import { encodeJson } from '../domain/json.js';
import { ConfigError } from '../config/env.js';
import { loadAssetVersion } from '../registry/assets.js';
import { computeWatchScopeId } from '../ingest/filter-plan.js';
import { openDatabase } from '../storage/database.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { stockPoolAttributions } from '../registry/pools.js';
import { runRecorder, type RecorderOptions } from './recorder.js';
import { saveJson } from './files.js';

export const CATALOGUE_PROTOCOL_VERSION = 'uniswap-v3+uniswap-v4@1';
const EXCLUDED_PROTOCOLS = ['pons-v2-curves', 'other-dexes'] as const;
const PROVIDER_COMPLETENESS_ASSUMPTION =
  'Complete means all declared V3 Factory/V4 Manager discovery filters returned complete, hash-checked ranges through the fixed target anchor; the public RPC filter is not independently verified.';

export type CatalogueOptions = Pick<
  RecorderOptions,
  | 'config'
  | 'env'
  | 'watchlistPath'
  | 'databasePath'
  | 'outputDirectory'
  | 'maxCalls'
  | 'evidenceMode'
  | 'readerFactory'
  | 'shutdown'
> & {
  durationMs: number;
  targetBlock?: bigint;
};

export interface CatalogueReport {
  version: 1;
  scopeId: string;
  assetVersion: string;
  protocolVersion: string;
  targetAnchor: BlockAnchor | null;
  acceptedTip: BlockAnchor | null;
  status: 'complete' | 'incomplete' | 'failed' | 'stopped';
  missing: Array<{ fromBlock: bigint; toBlock: bigint; reason: string }>;
  poolCount: number;
  stockPoolAttributionCount: number;
  stockPoolAttributions: readonly { poolId: string; stockAddress: string }[];
  excluded: string[];
  sourceHash: string;
  providerCompletenessAssumption: string;
  runDirectory: string;
}

function revive<T>(text: string): T {
  return JSON.parse(text, (key, value: unknown) =>
    ['fromBlock', 'toBlock', 'blockNumber', 'number'].includes(key) &&
    typeof value === 'string' &&
    /^\d+$/.test(value)
      ? BigInt(value)
      : value,
  ) as T;
}

function sourceHash(assets: ReturnType<typeof loadAssetVersion>): string {
  return createHash('sha256')
    .update(encodeJson({ chainId: assets.chainId, version: assets.version, assets: assets.assets }))
    .digest('hex');
}

function runDirectory(outputDirectory: string, before: ReadonlySet<string>): string {
  if (!existsSync(outputDirectory)) throw new Error('Catalogue output directory was not created');
  const candidates = readdirSync(outputDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !before.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  const selected = candidates.at(-1);
  if (!selected) throw new Error('Catalogue run directory was not created');
  return join(outputDirectory, selected);
}

function validateOptions(options: CatalogueOptions): void {
  if (!Number.isSafeInteger(options.durationMs) || options.durationMs <= 0)
    throw new ConfigError('Catalogue duration must be a positive safe integer');
  if (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1)
    throw new ConfigError('Invalid RPC budget');
  if (
    options.targetBlock !== undefined &&
    (options.targetBlock < 0n || options.targetBlock > BigInt(Number.MAX_SAFE_INTEGER))
  )
    throw new ConfigError('Catalogue target must be a safe non-negative block height');
}

export async function runCatalogue(options: CatalogueOptions): Promise<CatalogueReport> {
  // Keep all validation before runRecorder opens its DB or creates evidence.
  validateOptions(options);
  const outputDirectory = resolve(options.outputDirectory);
  const before = new Set(
    existsSync(outputDirectory)
      ? readdirSync(outputDirectory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [],
  );
  await runRecorder({
    command: 'ingest',
    config: options.config,
    env: options.env,
    watchlistPath: options.watchlistPath,
    databasePath: options.databasePath,
    outputDirectory,
    durationMs: options.durationMs,
    maxCalls: options.maxCalls,
    evidenceMode: options.evidenceMode,
    ...(options.readerFactory ? { readerFactory: options.readerFactory } : {}),
    ...(options.shutdown ? { shutdown: options.shutdown } : {}),
    catalogueOnly: true,
    ...(options.targetBlock === undefined ? {} : { targetBlock: options.targetBlock }),
  });
  const runDir = runDirectory(outputDirectory, before);
  const summary = revive<{
    status: string;
    catalogue?: {
      targetAnchor: BlockAnchor | null;
      acceptedTip: BlockAnchor | null;
      missing: Array<{ fromBlock: bigint; toBlock: bigint; reason: string }>;
      sourceHash: string;
    } | null;
  }>(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
  const assets = loadAssetVersion(options.watchlistPath);
  const scopeId = computeWatchScopeId(assets, 'discovery-only', {
    v3Factory: options.config.v3Factory,
    v4Manager: options.config.v4Manager,
  });
  const db = openDatabase(options.databasePath, { readonly: true });
  let acceptedTip: BlockAnchor | null = null;
  let poolCount = 0;
  let stockPoolAttributionCount = 0;
  let attributions: readonly { poolId: string; stockAddress: string }[] = [];
  // A catalogue query must not attribute pools that were created after its fixed
  // target height, even when a later range is already accepted in the same scope.
  const targetNumber = summary.catalogue?.targetAnchor?.number ?? options.targetBlock ?? null;
  try {
    const store = new SqliteRangeStore(db);
    acceptedTip = store.acceptedTip(scopeId);
    const pools =
      targetNumber === null
        ? store.pools(scopeId)
        : store.pools(scopeId).filter((pool) => pool.discoveredAt.blockNumber <= targetNumber);
    poolCount = pools.length;
    attributions = stockPoolAttributions(pools, assets.addresses);
    stockPoolAttributionCount = attributions.length;
  } finally {
    db.close();
  }
  const rawStatus = summary.status;
  const status: CatalogueReport['status'] =
    rawStatus === 'complete' ||
    rawStatus === 'incomplete' ||
    rawStatus === 'failed' ||
    rawStatus === 'stopped'
      ? rawStatus
      : 'failed';
  const report: CatalogueReport = {
    version: 1,
    scopeId,
    assetVersion: assets.version,
    protocolVersion: CATALOGUE_PROTOCOL_VERSION,
    targetAnchor: summary.catalogue?.targetAnchor ?? null,
    acceptedTip: summary.catalogue?.acceptedTip ?? acceptedTip,
    status,
    missing: summary.catalogue?.missing ?? [],
    poolCount,
    stockPoolAttributionCount,
    stockPoolAttributions: attributions,
    excluded: [...EXCLUDED_PROTOCOLS],
    sourceHash: summary.catalogue?.sourceHash ?? sourceHash(assets),
    providerCompletenessAssumption: PROVIDER_COMPLETENESS_ASSUMPTION,
    runDirectory: runDir,
  };
  saveJson(join(runDir, 'catalogue-report.json'), report, runDir);
  return report;
}
