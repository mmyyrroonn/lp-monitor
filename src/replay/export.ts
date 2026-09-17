import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CHAIN_ID } from '../domain/chain.js';
import { encodeJson } from '../domain/json.js';
import type { LogTime } from '../domain/types.js';
import { missingIntervals, type BlockInterval } from '../ops/history.js';
import { openDatabase } from '../storage/database.js';
import { readBatch } from '../storage/payload-store.js';
import { SqliteRangeStore } from '../storage/raw-store.js';
import { rawLogKey, type RecordedRangeBatch } from '../storage/manifest.js';
import { checkBatchIntegrity } from './integrity.js';
import type { ReplayCatalogueSnapshot, ReplayInputSnapshot, ReplayManifestV2 } from './reader.js';

const UNRESOLVED_TIME: LogTime = {
  minuteStartSec: null,
  exactTimestampSec: null,
  source: 'unresolved',
};

/** The stored transport payload is written before minute evidence is resolved.
 * Replay must assemble the accepted derived evidence, while recorded-observed
 * mode cannot pretend that a later backfill was available at capture time. */
function assembleBatchEvidence(
  store: SqliteRangeStore,
  scopeId: string,
  batch: RecordedRangeBatch,
  mode: 'chain-time' | 'recorded-observed',
): {
  batch: RecordedRangeBatch;
  derivedTimes: number;
  unresolved: number;
} {
  const payloadTimes = new Map(
    (batch.logTimes ?? []).map((item) => [rawLogKey(item.ref), item.time]),
  );
  const derived = store.logTimes(scopeId, { fromBlock: batch.fromBlock, toBlock: batch.toBlock });
  let derivedTimes = 0;
  let unresolved = 0;
  const logTimes = batch.logs.map((log) => {
    const key = rawLogKey(log);
    const stored = payloadTimes.get(key);
    const recorded = derived.get(key);
    const time = recorded ?? stored ?? UNRESOLVED_TIME;
    if (time.minuteStartSec === null) unresolved++;
    // The transport payload never carries resolved minutes; recording the count
    // keeps later backfilled evidence distinguishable from capture-time facts.
    else if (stored === undefined && recorded !== undefined) derivedTimes++;
    return { ref: log, time };
  });
  const anchors =
    mode === 'chain-time'
      ? store.anchors(scopeId, {
          fromBlock: batch.fromBlock,
          toBlock: batch.toBlock,
          includeBrackets: true,
        })
      : [];
  const boundaries =
    mode === 'chain-time'
      ? store.boundaries(scopeId, {
          sinceSec: 0,
          untilSec: batch.end.timestampSec,
          includeBrackets: true,
        })
      : [];
  return {
    batch: {
      ...batch,
      logTimes,
      anchors: mode === 'chain-time' ? anchors : (batch.anchors ?? []),
      boundaries: mode === 'chain-time' ? boundaries : (batch.boundaries ?? []),
    },
    derivedTimes,
    unresolved,
  };
}

export interface ExportReplayOptions {
  databasePath: string;
  outputDirectory: string;
  scopeId: string;
  fromBlock: bigint;
  toBlock: bigint;
  mode: 'chain-time' | 'recorded-observed';
  cohortMode: 'as-of' | 'retrospective-cohort';
  discoveryScopeId?: string;
  inputSnapshot?: ReplayInputSnapshot;
  codeHash?: string;
  abiHash?: string;
}

export interface ExportReplayResult {
  manifestPath: string;
  complete: boolean;
  issues: string[];
}

type Segment = NonNullable<ReplayManifestV2['segments']>[number];

type AcceptedBatchRow = {
  id: string;
  scope_id: string;
  from_block: number;
  to_block: number;
  manifest_hash: string;
  completeness: string;
  accepted_at_ms: number;
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertBounds(options: ExportReplayOptions): void {
  if (options.fromBlock < 0n || options.toBlock < options.fromBlock)
    throw new Error('Replay export requires ordered non-negative block bounds');
  if (options.toBlock > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Replay export block bounds exceed safe range');
  if (!options.scopeId.trim()) throw new Error('Replay export scopeId is required');
  if (!['chain-time', 'recorded-observed'].includes(options.mode))
    throw new Error('Replay export mode is invalid');
  if (!['as-of', 'retrospective-cohort'].includes(options.cohortMode))
    throw new Error('Replay export cohort mode is invalid');
  if (options.inputSnapshot) {
    if (options.inputSnapshot.cohortMode !== options.cohortMode)
      throw new Error('Replay export snapshot cohort mode does not match export');
    if (!Number.isSafeInteger(options.inputSnapshot.availableAtSec))
      throw new Error('Replay export snapshot availability is invalid');
  }
}

function coverageFromRows(rows: readonly AcceptedBatchRow[], fromBlock: bigint, toBlock: bigint) {
  const covered = rows
    .filter((row) => row.scope_id === rows[0]?.scope_id)
    .map((row) => [BigInt(row.from_block), BigInt(row.to_block)] as BlockInterval);
  return {
    ranges: covered.map(([from, to]) => ({ fromBlock: from.toString(), toBlock: to.toString() })),
    missing: missingIntervals(fromBlock, toBlock, covered).map(([from, to]) => ({
      fromBlock: from.toString(),
      toBlock: to.toString(),
      reason: 'accepted-coverage-missing',
    })),
  };
}

function batchRows(
  db: ReturnType<typeof openDatabase>,
  options: ExportReplayOptions,
): AcceptedBatchRow[] {
  const scopes = [...new Set([options.scopeId, options.discoveryScopeId ?? options.scopeId])];
  const placeholders = scopes.map(() => '?').join(',');
  return db
    .prepare(
      `select b.id,b.scope_id,b.from_block,b.to_block,b.manifest_hash,b.completeness,
              min(a.accepted_at_ms) as accepted_at_ms
       from ingest_batches b join accepted_ranges a on a.batch_id=b.id
       where a.scope_id in (${placeholders}) and b.to_block>=? and b.from_block<=?
       group by b.id,b.scope_id,b.from_block,b.to_block,b.manifest_hash,b.completeness
       order by accepted_at_ms,b.scope_id,b.from_block,b.id`,
    )
    .all(...scopes, Number(options.fromBlock), Number(options.toBlock)) as AcceptedBatchRow[];
}

function relativeArtifact(output: string, path: string): void {
  const value = relative(output, path);
  if (
    value === '..' ||
    value.startsWith('../') ||
    value.startsWith('..\\') ||
    /^[A-Za-z]:[\\/]/.test(value)
  )
    throw new Error('Replay export artifact escapes output directory');
}

function inputSnapshotMeta(snapshot: ReplayInputSnapshot | undefined) {
  if (!snapshot) return null;
  const catalogue = snapshot.catalogue;
  return {
    configVersion: snapshot.configVersion,
    assetVersion: snapshot.assets.version,
    metadataVersion: snapshot.metadata.version,
    availableAtSec: snapshot.availableAtSec,
    cohortMode: snapshot.cohortMode,
    // The register is stated once for the dataset and summarized here, so a reader can see its
    // scope, cutoff, size and provenance without walking the pools.
    ...(catalogue === undefined
      ? {}
      : {
          catalogue: {
            registryScopeId: catalogue.registryScopeId,
            assetVersion: catalogue.assetVersion,
            asOfBlock: catalogue.asOfBlock,
            pools: catalogue.pools.length,
            source: catalogue.source,
          },
        }),
    hash: sha256(Buffer.from(encodeJson(snapshot), 'utf8')),
  };
}

/** The complete register travels once, instead of being repeated in every batch that touches a
 *  pool. It is bounded by the export's own upper bound: a pool discovered later was not knowable
 *  inside this range, so reading the catalogue whole would claim history the dataset cannot show. */
function catalogueSnapshot(
  store: SqliteRangeStore,
  registryScopeId: string,
  snapshot: ReplayInputSnapshot,
  cutoffBlock: bigint,
): ReplayCatalogueSnapshot {
  return {
    version: 1,
    registryScopeId,
    assetVersion: snapshot.assets.version,
    asOfBlock: cutoffBlock.toString(),
    // The read happens while the export runs, after the recording database has been accepting
    // batches for however long it has. Nothing here proves the register was closed at the study
    // point, so it is retrospective and must not be read as evidence of what was known then.
    source: { reader: 'local-pools', availability: 'retrospective' },
    pools: store
      .pools(registryScopeId)
      .filter((pool) => pool.discoveredAt.blockNumber <= cutoffBlock),
  };
}

export async function exportReplayDataset(
  options: ExportReplayOptions,
): Promise<ExportReplayResult> {
  assertBounds(options);
  const source = resolve(options.databasePath);
  const output = resolve(options.outputDirectory);
  if (!existsSync(source) || !statSync(source).isFile())
    throw new Error('Replay export source DB does not exist');
  if (existsSync(output)) throw new Error('Replay export output already exists');
  mkdirSync(dirname(output), { recursive: true });
  const temporary = output + '.tmp-' + process.pid + '-' + Date.now();
  if (existsSync(temporary)) throw new Error('Replay export temporary output already exists');
  mkdirSync(join(temporary, 'segments'), { recursive: true });
  const issues: string[] = [];
  const segments: Segment[] = [];
  const batches: ReplayManifestV2['batches'] = [];
  const logicalSource = createHash('sha256');
  const operationRows: AcceptedBatchRow[] = [];
  let unresolvedTimes = 0;
  let derivedTimes = 0;
  let observedOrderComplete = true;
  let sourceDb: ReturnType<typeof openDatabase> | null = null;
  try {
    sourceDb = openDatabase(source, { readonly: true });
    // One read snapshot covers batches, times and anchors so the export cannot
    // mix evidence from different writer commits.
    sourceDb.exec('begin');
    const rows = batchRows(sourceDb, options);
    const store = new SqliteRangeStore(sourceDb);
    const discoveryScope = options.discoveryScopeId ?? options.scopeId;
    // A caller-supplied register is theirs and is carried verbatim; one the export fills in is
    // read from this database here, once, rather than from the batches it is about to write.
    const inputSnapshot =
      options.inputSnapshot === undefined || options.inputSnapshot.catalogue !== undefined
        ? options.inputSnapshot
        : {
            ...options.inputSnapshot,
            catalogue: catalogueSnapshot(
              store,
              discoveryScope,
              options.inputSnapshot,
              options.toBlock,
            ),
          };
    operationRows.push(...rows.filter((row) => row.scope_id === options.scopeId));
    const coverage = coverageFromRows(operationRows, options.fromBlock, options.toBlock);
    issues.push(
      ...coverage.missing.map(
        (item) => `coverage:${item.fromBlock}-${item.toBlock}:${item.reason}`,
      ),
    );
    for (const [index, row] of rows.entries()) {
      let batch: RecordedRangeBatch;
      let logical: Buffer;
      try {
        const stored = readBatch(sourceDb, row.id);
        const integrity = checkBatchIntegrity(stored, false);
        for (const issue of integrity) issues.push(`batch:${row.id}:${issue.code}:${issue.detail}`);
        const evidence = assembleBatchEvidence(store, row.scope_id, stored, options.mode);
        batch = evidence.batch;
        logical = Buffer.from(encodeJson(batch), 'utf8');
        logicalSource.update(logical);
        derivedTimes += evidence.derivedTimes;
        unresolvedTimes += evidence.unresolved;
        if (evidence.unresolved > 0)
          issues.push(`batch:${row.id}:time-unresolved:${evidence.unresolved}`);
        if (!Number.isSafeInteger(batch.observedAtMs) || batch.observedAtMs < 0)
          observedOrderComplete = false;
        const path = `segments/${String(index).padStart(6, '0')}.json.gz`;
        const absolute = join(temporary, path.replaceAll('/', '\\'));
        relativeArtifact(temporary, absolute);
        const compressed = gzipSync(logical, { level: 9 });
        writeFileSync(absolute, compressed, { flag: 'wx' });
        const logicalSha256 = sha256(logical);
        const compressedSha256 = sha256(compressed);
        segments.push({
          path,
          compressedSha256,
          logicalSha256,
          bytes: { logical: logical.byteLength, compressed: compressed.byteLength },
          batchIds: [batch.id],
        });
        batches.push({
          id: batch.id,
          scopeId: batch.scopeId,
          accepted: true,
          path,
          sha256: logicalSha256,
          compressedSha256,
          manifestHash: batch.manifestHash,
          logs: batch.logs.length,
          fromBlock: batch.fromBlock.toString(),
          toBlock: batch.toBlock.toString(),
          completeness: batch.completeness,
        });
      } catch (error) {
        issues.push(
          `batch:${row.id}:unavailable:${error instanceof Error ? error.message : 'read failed'}`,
        );
        batches.push({
          id: row.id,
          scopeId: row.scope_id,
          accepted: true,
          path: `segments/${String(index).padStart(6, '0')}.json.gz`,
          sha256: undefined,
          manifestHash: row.manifest_hash,
          completeness: row.completeness,
        });
      }
    }
    if (options.mode === 'recorded-observed' && !observedOrderComplete)
      issues.push('recorded-observed:observedAt-missing');
    if (options.mode === 'recorded-observed' && derivedTimes > 0)
      issues.push('recorded-observed:derived-time-not-recorded-at-capture');
    if (unresolvedTimes > 0) issues.push(`time-unresolved:${unresolvedTimes}`);
    if (!options.inputSnapshot) issues.push('input-snapshot-missing');
    if (
      options.mode === 'recorded-observed' &&
      rows.some((row) => row.scope_id === options.scopeId)
    ) {
      const observed = rows
        .filter((row) => row.scope_id === options.scopeId)
        .map((row) => {
          try {
            return readBatch(sourceDb!, row.id).observedAtMs;
          } catch {
            return null;
          }
        });
      if (
        observed.some((value, index) => value !== null && index > 0 && value < observed[index - 1]!)
      )
        issues.push('recorded-observed:observedAt-order-invalid');
    }
    const manifest: ReplayManifestV2 = {
      version: 2,
      chainId: CHAIN_ID,
      scopeId: options.scopeId,
      discoveryScope,
      configVersion: inputSnapshot?.configVersion,
      assetVersion: inputSnapshot?.assets.version,
      batches,
      segments,
      replay: inputSnapshot
        ? {
            version: 1,
            input: inputSnapshot,
            ...(options.codeHash ? { codeHash: options.codeHash } : {}),
            ...(options.abiHash ? { abiHash: options.abiHash } : {}),
          }
        : undefined,
      export: {
        version: 2,
        mode: options.mode,
        cohortMode: options.cohortMode,
        fromBlock: options.fromBlock.toString(),
        toBlock: options.toBlock.toString(),
        inputSnapshot: inputSnapshotMeta(inputSnapshot),
        sourceHash: logicalSource.digest('hex'),
        coverage,
        timeQuality: {
          unresolvedLogs: unresolvedTimes,
          derivedTimes,
          observedOrderComplete,
        },
        provenance: 'native sqlite accepted batches; simulated acquisition is not recorded latency',
        excluded: issues,
      },
    };
    const manifestPath = join(temporary, 'manifest.json');
    writeFileSync(manifestPath, encodeJson(manifest), { flag: 'wx' });
    sourceDb.exec('commit');
    sourceDb.close();
    sourceDb = null;
    renameSync(temporary, output);
    return {
      manifestPath: join(output, 'manifest.json'),
      complete: issues.length === 0,
      issues,
    };
  } catch (error) {
    sourceDb?.close();
    throw error;
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  }
}
