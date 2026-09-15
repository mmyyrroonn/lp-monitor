import { CHAIN_ID } from '../domain/chain.js';
import { loadValidatedJson } from '../config/json-file.js';
import { z } from 'zod';
import { ConfigError } from '../config/env.js';
import { buildMetadataIndex, type MetadataIndex } from './metadata-index.js';
const schema = z.strictObject({
  version: z.string().min(1),
  chainId: z.literal(CHAIN_ID),
  source: z.string().min(1),
  entries: z.array(
    z.strictObject({
      address: z.string().regex(/^0x[0-9a-f]{40}$/),
      decimals: z.number().int().min(0).max(255),
      observedAtBlock: z.string().regex(/^(0|[1-9][0-9]*)$/),
      blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    }),
  ),
});
export type MetricMetadata = z.infer<typeof schema>;
export function loadMetricMetadata(path: string): MetricMetadata {
  const data = loadValidatedJson(path, 'metric metadata cache', (value) => schema.parse(value));
  if (new Set(data.entries.map((entry) => entry.address)).size !== data.entries.length)
    throw new ConfigError('Invalid metric metadata cache: duplicate entries.address');
  return data;
}
type MemoizedIndex = {
  entries: MetricMetadata['entries'];
  length: number;
  index: MetadataIndex;
};

/** One index per cache object, reused by every lookup against it. */
const indexes = new WeakMap<MetricMetadata, MemoizedIndex>();

/**
 * Cached decimals are a documented carry-forward assumption from this anchor.
 * A snapshot does not establish decimals for earlier blocks or unknown tokens.
 *
 * A `MetricMetadata` object is treated as immutable: its index is built on the first lookup and
 * every later lookup answers from it, which is what turns the per-swap scan on the live path into a
 * binary search. Every producer in this repo — `loadMetricMetadata`, `reconcileMetricMetadata` and
 * `readCachedMetricMetadata`, which returns a seed it has nothing to add to unchanged — hands back
 * an object it does not go on to mutate. The memo also re-checks the entries array identity and its
 * length, so a rebuilt cache is never answered by a stale index. Mutating a cache
 * in place is not part of that contract: replacing or editing an entry inside the same array at the
 * same length is not detected, and the next lookup keeps answering from the index built before it.
 */
export function decimalsAt(cache: MetricMetadata, address: string, block: bigint): number | null {
  const memo = indexes.get(cache);
  if (memo !== undefined && memo.entries === cache.entries && memo.length === cache.entries.length)
    return memo.index.decimalsAt(address, block);
  const index = buildMetadataIndex(cache.entries);
  indexes.set(cache, { entries: cache.entries, length: cache.entries.length, index });
  return index.decimalsAt(address, block);
}

export type MetricMetadataConflict = {
  address: MetricMetadata['entries'][number]['address'];
  observedAtBlock: string;
  expectedHash: MetricMetadata['entries'][number]['blockHash'];
  observedHashes: readonly string[];
};

/**
 * Reconciles historical metadata against chain evidence already present in storage.
 *
 * A known hash mismatch at the entry's observation height excludes that entry. If
 * no anchor exists at that exact height, the entry remains only as its documented
 * historical carry-forward assumption; absence is not current validation and this
 * pure helper performs no RPC reads or timestamp inference.
 */
export function reconcileMetricMetadata(
  cache: MetricMetadata,
  anchors: readonly Pick<import('../domain/types.js').BlockAnchor, 'number' | 'hash'>[],
): { metadata: MetricMetadata; conflicts: readonly MetricMetadataConflict[] } {
  const hashesByHeight = new Map<bigint, Set<string>>();
  for (const anchor of anchors) {
    const hashes = hashesByHeight.get(anchor.number) ?? new Set<string>();
    hashes.add(anchor.hash.toLowerCase());
    hashesByHeight.set(anchor.number, hashes);
  }

  const entries: MetricMetadata['entries'] = [];
  const conflicts: MetricMetadataConflict[] = [];
  for (const entry of cache.entries) {
    const observedHashes = [...(hashesByHeight.get(BigInt(entry.observedAtBlock)) ?? [])].sort();
    const expectedHash = entry.blockHash.toLowerCase();
    if (observedHashes.some((observed) => observed !== expectedHash)) {
      conflicts.push({
        address: entry.address,
        observedAtBlock: entry.observedAtBlock,
        expectedHash: entry.blockHash,
        observedHashes,
      });
      continue;
    }
    entries.push(entry);
  }

  // Nothing was excluded, so the result *is* the cache: the same entries, in the same order, under
  // the same version. Handing back a content-identical copy instead would be a different object, and
  // `decimalsAt` memoizes its index per object — the live path reconciles, then asks per swap, so a
  // fresh copy per report is a full index rebuild (one digest per entry) per report, which is the
  // per-round work bounded evaluation exists to stop paying. Callers treat the result as immutable.
  if (conflicts.length === 0) return { metadata: cache, conflicts };

  return {
    metadata: { ...cache, entries },
    conflicts,
  };
}
