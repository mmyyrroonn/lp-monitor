import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import type { Address } from 'viem';
import { CHAIN_ID } from '../domain/chain.js';
import { encodeJson } from '../domain/json.js';
import type { AssetRegistration, AssetRegistry } from '../registry/assets.js';
import type { MetricMetadata } from '../metrics/metadata.js';
import type { RecordedRangeBatch } from '../storage/manifest.js';
import type { ReplayIssue } from './integrity.js';
export const contentHash = (value: unknown) =>
  createHash('sha256').update(encodeJson(value)).digest('hex');
const normalise = (value: string) => value.replace(/\\/g, '/');
export interface ReplayInputSnapshot {
  configVersion: string;
  usdg: Address;
  assets: { version: string; rwa: AssetRegistration[] };
  metadata: MetricMetadata;
  availableAtSec: number;
  cohortMode: 'as-of' | 'retrospective-cohort';
}
export interface ReplayBatchReference {
  id: string;
  scopeId: string;
  accepted: boolean;
  path?: string;
  sha256?: string;
  compressedSha256?: string;
  manifestHash?: string;
  logs?: number;
  fromBlock?: string | bigint;
  toBlock?: string | bigint;
  completeness?: string;
}
export interface ReplayManifestV1 {
  version: 1;
  chainId: number;
  scopeId: string;
  discoveryScope: string;
  configVersion?: string;
  assetVersion?: string;
  batches: ReplayBatchReference[];
  revisions?: unknown[];
  replay?: { version: 1; input: ReplayInputSnapshot; abiHash?: string; codeHash?: string };
}
export interface ReplayManifestV2 {
  version: 2;
  chainId: number;
  scopeId: string;
  discoveryScope: string;
  configVersion?: string;
  assetVersion?: string;
  batches: ReplayBatchReference[];
  segments: {
    path: string;
    compressedSha256: string;
    logicalSha256: string;
    bytes: { logical: number; compressed: number };
    batchIds: string[];
  }[];
  revisions?: unknown[];
  replay?: { version: 1; input: ReplayInputSnapshot; abiHash?: string; codeHash?: string };
  export: {
    version: 2;
    mode: 'chain-time' | 'recorded-observed';
    cohortMode: 'as-of' | 'retrospective-cohort';
    fromBlock: string;
    toBlock: string;
    inputSnapshot: unknown;
    sourceHash: string;
    coverage: unknown;
    timeQuality: unknown;
    provenance: string;
    excluded: string[];
  };
}
export type ReplayManifest = ReplayManifestV1 | ReplayManifestV2;
export function assetRegistry(snapshot: ReplayInputSnapshot): AssetRegistry {
  const assets = snapshot.assets.rwa;
  return {
    chainId: CHAIN_ID,
    version: snapshot.assets.version,
    assets,
    addresses: assets.map((a) => a.address),
    has: (a) => assets.some((x) => x.address.toLowerCase() === a.toLowerCase()),
  };
}
export function readReplayManifest(path: string) {
  const directory = realpathSync(dirname(resolve(path)));
  const manifestText = readFileSync(path, 'utf8');
  const manifest = JSON.parse(manifestText) as ReplayManifest;
  if (
    (manifest.version !== 1 && manifest.version !== 2) ||
    manifest.chainId !== CHAIN_ID ||
    !Array.isArray(manifest.batches) ||
    (manifest.version === 2 && !Array.isArray(manifest.segments))
  )
    throw new Error('Invalid replay manifest');
  const issues: ReplayIssue[] = [];
  const batches: RecordedRangeBatch[] = [];
  const files: { path: string; sha256: string; compressedSha256?: string }[] = [];
  const artifacts: { id: string; text: string; sha256: string }[] = [];
  const ids = new Set<string>();
  const segments =
    manifest.version === 2
      ? (() => {
          const found = new Map<string, ReplayManifestV2['segments'][number]>();
          for (const segment of manifest.segments) {
            const segmentPath = resolve(directory, segment.path);
            const localSegment = relative(directory, segmentPath);
            if (
              isAbsolute(localSegment) ||
              localSegment === '..' ||
              localSegment.startsWith('..\\') ||
              localSegment.startsWith('../')
            )
              throw new Error('Replay segment escapes manifest directory');
            if (found.has(normalise(segment.path))) throw new Error('Duplicate replay segment');
            found.set(normalise(segment.path), segment);
          }
          return found;
        })()
      : new Map<string, ReplayManifestV2['segments'][number]>();
  for (const ref of manifest.batches) {
    if (ids.has(ref.id)) {
      issues.push({ code: 'duplicate-batch', batchId: ref.id, detail: 'Batch ID is repeated' });
      continue;
    }
    ids.add(ref.id);
    const name =
      ref.path ??
      `${ref.scopeId === manifest.discoveryScope && manifest.discoveryScope !== manifest.scopeId ? 'discovery' : 'range'}-${ref.id}.json`;
    const file = resolve(directory, name);
    const local = relative(directory, file);
    if (isAbsolute(local) || local === '..' || local.startsWith('..\\') || local.startsWith('../'))
      throw new Error('Replay artifact escapes manifest directory');
    try {
      const actual = realpathSync(file);
      const rel = relative(directory, actual);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../'))
        throw new Error('Artifact symlink escapes manifest directory');
      const compressed = readFileSync(file);
      const compressedSha256 = createHash('sha256').update(compressed).digest('hex');
      const segment = segments.get(normalise(name));
      if (segment && segment.compressedSha256 !== compressedSha256)
        issues.push({
          code: 'compressed-artifact-hash-mismatch',
          batchId: ref.id,
          detail: 'Saved compressed hash differs from segment bytes',
        });
      if (ref.compressedSha256 && ref.compressedSha256 !== compressedSha256)
        issues.push({
          code: 'compressed-artifact-hash-mismatch',
          batchId: ref.id,
          detail: 'Saved compressed hash differs from artifact bytes',
        });
      const text =
        manifest.version === 2 || name.toLowerCase().endsWith('.gz')
          ? gunzipSync(compressed).toString('utf8')
          : compressed.toString('utf8');
      const sha256 = createHash('sha256').update(text).digest('hex');
      if (segment && segment.logicalSha256 !== sha256)
        issues.push({
          code: 'logical-artifact-hash-mismatch',
          batchId: ref.id,
          detail: 'Saved logical hash differs from decompressed content',
        });
      if (segment && segment.bytes.logical !== Buffer.byteLength(text, 'utf8'))
        issues.push({
          code: 'logical-artifact-size-mismatch',
          batchId: ref.id,
          detail: 'Saved logical byte count differs from decompressed content',
        });
      files.push(
        manifest.version === 2 ? { path: name, sha256, compressedSha256 } : { path: name, sha256 },
      );
      artifacts.push({ id: ref.id, text, sha256 });
      if (!ref.sha256)
        issues.push({
          code: 'artifact-hash-unavailable',
          batchId: ref.id,
          detail:
            'Original artifact SHA256 was not saved; a new digest does not authenticate original capture',
        });
      if (ref.sha256 && ref.sha256 !== sha256) {
        issues.push({
          code: 'artifact-hash-mismatch',
          batchId: ref.id,
          detail: 'Saved hash differs from raw artifact',
        });
        continue;
      }
      const parsed = JSON.parse(text, (key, value: unknown) =>
        typeof value === 'string' &&
        ['fromBlock', 'toBlock', 'blockNumber', 'firstBlock', 'number'].includes(key) &&
        /^\d+$/.test(value)
          ? BigInt(value)
          : value,
      ) as RecordedRangeBatch;
      if (parsed.id !== ref.id || parsed.scopeId !== ref.scopeId)
        throw new Error('Batch identity mismatch');
      const mismatch = ['manifestHash', 'logs', 'fromBlock', 'toBlock', 'completeness'].filter(
        (key) => {
          const saved = ref[key as keyof typeof ref];
          const actual =
            key === 'logs'
              ? parsed.logs.length
              : parsed[key as 'manifestHash' | 'fromBlock' | 'toBlock' | 'completeness'];
          return saved !== undefined && String(saved) !== String(actual);
        },
      );
      if (mismatch.length) {
        issues.push({
          code: 'artifact-reference-mismatch',
          batchId: ref.id,
          detail: 'Native manifest fields differ from raw artifact: ' + mismatch.join(','),
        });
        continue;
      }
      if (ref.accepted) batches.push(parsed);
      else
        issues.push({
          code: 'unaccepted-batch',
          batchId: ref.id,
          detail: 'Recorder did not accept this evidence',
        });
    } catch (error) {
      issues.push({
        code: 'artifact-unavailable',
        batchId: ref.id,
        detail:
          error instanceof Error && error.message === 'Batch identity mismatch'
            ? error.message
            : 'Raw artifact missing or invalid',
      });
    }
  }
  if (manifest.revisions?.length)
    issues.push({
      code: 'revision-history-unavailable',
      detail: 'P1 revision summaries lack exact replay ordering/rollback anchors',
    });
  return {
    manifest,
    batches,
    files,
    artifacts,
    issues,
    manifestHash: createHash('sha256').update(manifestText).digest('hex'),
  };
}
