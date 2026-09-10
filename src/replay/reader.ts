import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
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
export interface ReplayInputSnapshot {
  configVersion: string;
  usdg: Address;
  assets: { version: string; rwa: AssetRegistration[] };
  metadata: MetricMetadata;
  availableAtSec: number;
  cohortMode: 'as-of' | 'retrospective-cohort';
}
export interface ReplayManifest {
  version: 1;
  chainId: number;
  scopeId: string;
  discoveryScope: string;
  configVersion?: string;
  assetVersion?: string;
  batches: {
    id: string;
    scopeId: string;
    accepted: boolean;
    path?: string;
    sha256?: string;
    manifestHash?: string;
    logs?: number;
    fromBlock?: string | bigint;
    toBlock?: string | bigint;
    completeness?: string;
  }[];
  revisions?: unknown[];
  replay?: { version: 1; input: ReplayInputSnapshot; abiHash?: string; codeHash?: string };
}
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
  if (manifest.version !== 1 || manifest.chainId !== CHAIN_ID || !Array.isArray(manifest.batches))
    throw new Error('Invalid replay manifest');
  const issues: ReplayIssue[] = [];
  const batches: RecordedRangeBatch[] = [];
  const files: { path: string; sha256: string }[] = [];
  const artifacts: { id: string; text: string; sha256: string }[] = [];
  const ids = new Set<string>();
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
      const text = readFileSync(file, 'utf8');
      const sha256 = createHash('sha256').update(text).digest('hex');
      files.push({ path: name, sha256 });
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
