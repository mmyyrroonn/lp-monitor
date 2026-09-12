import { CHAIN_ID } from '../domain/chain.js';
import { loadValidatedJson } from '../config/json-file.js';
import { z } from 'zod';
import { ConfigError } from '../config/env.js';
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
/** Cached decimals are a documented carry-forward assumption from this anchor.
 * A snapshot does not establish decimals for earlier blocks or unknown tokens. */
export function decimalsAt(cache: MetricMetadata, address: string, block: bigint): number | null {
  const entry = cache.entries
    .filter((e) => e.address === address.toLowerCase() && BigInt(e.observedAtBlock) <= block)
    .reduce<MetricMetadata['entries'][number] | undefined>(
      (latest, e) =>
        !latest || BigInt(e.observedAtBlock) >= BigInt(latest.observedAtBlock) ? e : latest,
      undefined,
    );
  return entry && BigInt(entry.observedAtBlock) <= block ? entry.decimals : null;
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

  return {
    metadata: { ...cache, entries },
    conflicts,
  };
}
