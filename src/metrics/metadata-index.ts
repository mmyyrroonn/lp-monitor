import { createHash } from 'node:crypto';
import type { MetricMetadata } from './metadata.js';

type MetadataEntry = MetricMetadata['entries'][number];

/** One anchor, with the fields the index and its digest read already normalized. */
type Anchor = {
  /** `observedAtBlock` as supplied: the digest covers it verbatim, so a respelling is new content. */
  readonly observedAtBlock: string;
  readonly height: bigint;
  readonly decimals: number;
  readonly blockHash: string;
};

/** One address's anchors in lookup order, plus the digest of what they say. */
type AddressAnchors = {
  /** Anchor heights ascending. Ties keep the order the entries were supplied in. */
  readonly heights: readonly bigint[];
  readonly decimals: readonly number[];
  readonly revision: string;
};

export interface MetadataIndex {
  decimalsAt(address: string, block: bigint): number | null;
  revisionFor(address: string): string;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** What an address with no anchors reports. A digest of the empty anchor list, so it is a constant
 * that any process derives the same way, not a counter that only this process knows. */
const NO_ANCHORS_REVISION = digest([]);

/** Ascending by height, then by everything the digest covers, so anchors that tie on height have
 * one order regardless of the order they arrived in. */
function compareAnchors(left: Anchor, right: Anchor): number {
  if (left.height !== right.height) return left.height < right.height ? -1 : 1;
  if (left.observedAtBlock !== right.observedAtBlock)
    return left.observedAtBlock < right.observedAtBlock ? -1 : 1;
  if (left.decimals !== right.decimals) return left.decimals - right.decimals;
  return left.blockHash < right.blockHash ? -1 : left.blockHash > right.blockHash ? 1 : 0;
}

/** The digest of one address's anchors, in ascending height order. */
function revisionOf(anchors: readonly Anchor[]): string {
  return digest(
    [...anchors]
      .sort(compareAnchors)
      .map((anchor) => [anchor.observedAtBlock, anchor.decimals, anchor.blockHash]),
  );
}

/** The decimals of the last anchor at or below `block`, or null when the group starts after it. */
function decimalsAtOrBelow(anchors: AddressAnchors, block: bigint): number | null {
  let low = 0;
  let high = anchors.heights.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (anchors.heights[middle]! <= block) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found === -1 ? null : anchors.decimals[found]!;
}

/**
 * An address-keyed lookup over a `MetricMetadata` cache.
 *
 * `decimalsAt` runs once per swap event against a cache holding hundreds to thousands of anchors,
 * so the scan it replaces repeated the same work for every event of every round. Building costs one
 * O(n log n) sort of the whole cache; after that a lookup is a binary search inside the one group
 * for its address — O(log n) in that group's anchor count, never linear in the cache.
 *
 * Entries are grouped under `address.toLowerCase()` and a lookup lowers its own argument the same
 * way, so any spelling of an address reaches its anchors. The cache schema admits only lowercase
 * addresses, so the widening it buys is unreachable from a validated cache: an anchor whose address
 * were written in mixed case is found here by its lowercased spelling, where the scan this replaces
 * — comparing `entry.address` against the lowered argument — would not have matched it.
 *
 * `revisionFor` is a digest of the address's own anchors rather than a build counter or an object
 * identity. It is meant to key a cache: two processes that read the same anchors, on either side of
 * a restart, have to agree on it, and any change to what an address's anchors say has to produce a
 * new one. The address is not part of the digest, so two addresses holding identical anchors share
 * a revision — pair it with the address wherever it keys something.
 *
 * The index is a snapshot of the entries it was built from: it never reads them again, so mutating
 * an entry afterwards is not observed.
 */
export function buildMetadataIndex(entries: readonly MetadataEntry[]): MetadataIndex {
  const groups = new Map<string, Anchor[]>();
  for (const entry of entries) {
    const anchor: Anchor = {
      observedAtBlock: entry.observedAtBlock,
      height: BigInt(entry.observedAtBlock),
      decimals: entry.decimals,
      blockHash: entry.blockHash.toLowerCase(),
    };
    const address = entry.address.toLowerCase();
    const group = groups.get(address);
    if (group === undefined) groups.set(address, [anchor]);
    else group.push(anchor);
  }

  const built = new Map<string, AddressAnchors>();
  for (const [address, group] of groups) {
    // Ascending and stable, so the last anchor at or below a height is the one the scan landed on
    // when several anchors share that height: the last one supplied wins there too.
    group.sort((left, right) =>
      left.height < right.height ? -1 : left.height > right.height ? 1 : 0,
    );
    built.set(address, {
      heights: group.map((anchor) => anchor.height),
      decimals: group.map((anchor) => anchor.decimals),
      revision: revisionOf(group),
    });
  }

  return {
    decimalsAt(address, block) {
      const anchors = built.get(address.toLowerCase());
      return anchors === undefined ? null : decimalsAtOrBelow(anchors, block);
    },
    revisionFor(address) {
      return built.get(address.toLowerCase())?.revision ?? NO_ANCHORS_REVISION;
    },
  };
}
