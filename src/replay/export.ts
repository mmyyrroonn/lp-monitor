import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CHAIN_ID } from '../domain/chain.js';
import { encodeJson } from '../domain/json.js';
import { missingIntervals, type BlockInterval } from '../ops/history.js';
import { openDatabase } from '../storage/database.js';
import { readBatch } from '../storage/payload-store.js';
import type { RecordedRangeBatch } from '../storage/manifest.js';
import { checkBatchIntegrity } from './integrity.js';
import type { ReplayInputSnapshot, ReplayManifestV2 } from './reader.js';

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
  return {
    configVersion: snapshot.configVersion,
    assetVersion: snapshot.assets.version,
    metadataVersion: snapshot.metadata.version,
    availableAtSec: snapshot.availableAtSec,
    cohortMode: snapshot.cohortMode,
    hash: sha256(Buffer.from(encodeJson(snapshot), 'utf8')),
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
  let observedOrderComplete = true;
  let sourceDb: ReturnType<typeof openDatabase> | null = null;
  try {
    sourceDb = openDatabase(source, { readonly: true });
    const rows = batchRows(sourceDb, options);
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
        batch = readBatch(sourceDb, row.id);
        const integrity = checkBatchIntegrity(batch, false);
        for (const issue of integrity) issues.push(`batch:${row.id}:${issue.code}:${issue.detail}`);
        logical = Buffer.from(encodeJson(batch), 'utf8');
        logicalSource.update(logical);
        unresolvedTimes += (batch.logs ?? []).filter((log) => {
          const time = batch.logTimes?.find(
            (item) =>
              item.ref.blockHash.toLowerCase() === log.blockHash.toLowerCase() &&
              item.ref.transactionHash.toLowerCase() === log.transactionHash.toLowerCase() &&
              item.ref.logIndex === log.logIndex,
          )?.time;
          return !time || time.minuteStartSec === null;
        }).length;
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
    const discoveryScope = options.discoveryScopeId ?? options.scopeId;
    const manifest: ReplayManifestV2 = {
      version: 2,
      chainId: CHAIN_ID,
      scopeId: options.scopeId,
      discoveryScope,
      configVersion: options.inputSnapshot?.configVersion,
      assetVersion: options.inputSnapshot?.assets.version,
      batches,
      segments,
      replay: options.inputSnapshot
        ? {
            version: 1,
            input: options.inputSnapshot,
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
        inputSnapshot: inputSnapshotMeta(options.inputSnapshot),
        sourceHash: logicalSource.digest('hex'),
        coverage,
        timeQuality: {
          unresolvedLogs: unresolvedTimes,
          observedOrderComplete,
        },
        provenance: 'native sqlite accepted batches; simulated acquisition is not recorded latency',
        excluded: issues,
      },
    };
    const manifestPath = join(temporary, 'manifest.json');
    writeFileSync(manifestPath, encodeJson(manifest), { flag: 'wx' });
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
