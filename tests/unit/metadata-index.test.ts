import { expect, test } from 'vitest';
import { decimalsAt, loadMetricMetadata, type MetricMetadata } from '../../src/metrics/metadata.js';
import { buildMetadataIndex } from '../../src/metrics/metadata-index.js';

type Entry = MetricMetadata['entries'][number];

/**
 * The pre-index implementation of `decimalsAt`, kept verbatim as the equivalence witness: the index
 * is correct only if it answers what this scan answered, for every input.
 */
function legacyDecimalsAt(cache: MetricMetadata, address: string, block: bigint): number | null {
  const entry = cache.entries
    .filter((e) => e.address === address.toLowerCase() && BigInt(e.observedAtBlock) <= block)
    .reduce<MetricMetadata['entries'][number] | undefined>(
      (latest, e) =>
        !latest || BigInt(e.observedAtBlock) >= BigInt(latest.observedAtBlock) ? e : latest,
      undefined,
    );
  return entry && BigInt(entry.observedAtBlock) <= block ? entry.decimals : null;
}

/** Deterministic generator, so a failing corpus reproduces from its seed alone. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = (entries: Entry[]): MetricMetadata => ({
  version: 'test-v1',
  chainId: 4663,
  source: 'historical-identity-snapshot',
  entries,
});

/** The letter-rich tail keeps the case spellings below apart; the index prefix makes it unique. */
const ADDRESS_TAIL = 'abcdef0123456789'.repeat(2);
const address = (index: number): string =>
  `0x${index.toString(16).padStart(8, '0')}${ADDRESS_TAIL}`;
const HEX = '0123456789abcdef';
const hash = (digit: string): string => `0x${digit.repeat(64)}`;
const entry = (
  addr: string,
  observedAtBlock: string,
  decimals: number,
  blockHash = hash('a'),
): Entry => ({
  address: addr,
  decimals,
  observedAtBlock,
  blockHash,
});

/** The spellings a caller may pass for one address: lowercase, uppercase, and alternating case. */
const spellings = (value: string): string[] => [
  value,
  `0x${value.slice(2).toUpperCase()}`,
  `0x${[...value.slice(2)].map((char, i) => (i % 2 === 0 ? char.toUpperCase() : char)).join('')}`,
];

/** The distinct heights of one address, ascending. */
function ascendingHeights(observed: readonly string[]): bigint[] {
  return [...new Set(observed)]
    .map(BigInt)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** How many anchors share their address and height with another anchor. */
function tiedAnchors(anchors: readonly Entry[]): number {
  const places = new Set(anchors.map((a) => `${a.address}:${a.observedAtBlock}`));
  return anchors.length - places.size;
}

test('answers exactly what the pre-index scan answered over a generated corpus', () => {
  const random = mulberry32(0x5eed);
  // Repeated heights in the pool are deliberate: anchors that tie on height are where the two
  // implementations have to agree on which anchor wins.
  const heights = ['90', '100', '100', '250', '251', '4000', '100000'];
  const entries: Entry[] = [];
  const observedByAddress = new Map<string, string[]>();
  for (let i = 0; i < 60; i += 1) {
    const addr = address(i);
    const own: string[] = [];
    for (let n = 0, count = 1 + Math.floor(random() * 6); n < count; n += 1) {
      const observedAtBlock = heights[Math.floor(random() * heights.length)]!;
      own.push(observedAtBlock);
      entries.push(
        entry(
          addr,
          observedAtBlock,
          Math.floor(random() * 256),
          hash(HEX[Math.floor(random() * 16)]!),
        ),
      );
    }
    observedByAddress.set(addr, own);
  }

  const source = cache(entries);
  const index = buildMetadataIndex(source.entries);
  const probes: [string, bigint][] = [];
  for (const [addr, observed] of observedByAddress) {
    const ascending = ascendingHeights(observed);
    const blocks = new Set<bigint>([
      0n,
      ascending[ascending.length - 1]! + 1n,
      ...ascending,
      ...ascending.map((height) => height - 1n),
    ]);
    for (let n = 0; n + 1 < ascending.length; n += 1)
      blocks.add((ascending[n]! + ascending[n + 1]!) / 2n);
    for (const block of blocks)
      for (const spelling of spellings(addr)) probes.push([spelling, block]);
  }
  for (const absent of [address(1000), address(1001)])
    probes.push([absent, 0n], [absent, 50000n], [absent, 10n ** 12n]);

  let hits = 0;
  let misses = 0;
  for (const [probe, block] of probes) {
    const expected = legacyDecimalsAt(source, probe, block);
    expect(index.decimalsAt(probe, block)).toBe(expected);
    if (expected === null) misses += 1;
    else hits += 1;
  }
  expect(hits).toBeGreaterThan(0);
  expect(misses).toBeGreaterThan(0);
  // The corpus has to keep holding anchors that tie on height: that is where "the last anchor
  // supplied wins" is decided, and a corpus without them would let the tie-break rot unnoticed.
  expect(tiedAnchors(entries)).toBeGreaterThan(0);
});

test('agrees with the pre-index scan and the exported lookup on the real cache', () => {
  const source = loadMetricMetadata('config/metric-metadata.json');
  const index = buildMetadataIndex(source.entries);
  expect(source.entries.length).toBeGreaterThan(0);

  let observed = 0;
  for (const anchor of source.entries) {
    const height = BigInt(anchor.observedAtBlock);
    for (const block of [height, height - 1n]) {
      const expected = legacyDecimalsAt(source, anchor.address, block);
      expect(index.decimalsAt(anchor.address, block)).toBe(expected);
      expect(decimalsAt(source, anchor.address, block)).toBe(expected);
      expect(index.decimalsAt(anchor.address.toUpperCase(), block)).toBe(expected);
    }
    if (index.decimalsAt(anchor.address, height) !== null) observed += 1;
  }
  expect(observed).toBe(source.entries.length);
});

test('revision digests an anchor set, so equal anchors share it and any change breaks it', () => {
  const addr = address(0);
  const other = address(1);
  const anchors = [entry(addr, '300', 18, hash('a')), entry(addr, '100', 6, hash('b'))];
  const clone = () => anchors.map((value) => ({ ...value }));
  const first = buildMetadataIndex(clone());
  const second = buildMetadataIndex(clone());
  const revision = first.revisionFor(addr);

  expect(revision).toMatch(/^[0-9a-f]{64}$/);
  expect(second.revisionFor(addr)).toBe(revision);
  expect(buildMetadataIndex([...clone()].reverse()).revisionFor(addr)).toBe(revision);
  // The digest covers `blockHash.toLowerCase()`, so the same hash respelled is the same content.
  expect(
    buildMetadataIndex([
      entry(addr, '300', 18, hash('A')),
      entry(addr, '100', 6, hash('B')),
    ]).revisionFor(addr),
  ).toBe(revision);

  expect(
    buildMetadataIndex([
      entry(addr, '300', 19, hash('a')),
      entry(addr, '100', 6, hash('b')),
    ]).revisionFor(addr),
  ).not.toBe(revision);
  expect(
    buildMetadataIndex([
      entry(addr, '301', 18, hash('a')),
      entry(addr, '100', 6, hash('b')),
    ]).revisionFor(addr),
  ).not.toBe(revision);
  expect(
    buildMetadataIndex([
      entry(addr, '300', 18, hash('c')),
      entry(addr, '100', 6, hash('b')),
    ]).revisionFor(addr),
  ).not.toBe(revision);

  // Anchors that tie on height digest in one canonical order, not in the order they were supplied,
  // and the tie is still content: it differs from holding only one of the two.
  const tied = [entry(addr, '100', 6, hash('b')), entry(addr, '100', 18, hash('a'))];
  const tiedRevision = buildMetadataIndex(tied).revisionFor(addr);
  expect(tiedRevision).toBe(buildMetadataIndex([...tied].reverse()).revisionFor(addr));
  expect(tiedRevision).not.toBe(buildMetadataIndex([tied[0]!]).revisionFor(addr));

  // An address with no anchors still reports a stable, non-empty revision.
  const absent = first.revisionFor(other);
  expect(absent).toMatch(/^[0-9a-f]{64}$/);
  expect(second.revisionFor(other)).toBe(absent);
  expect(first.revisionFor(address(9999))).toBe(absent);
});

test('memoizes one index per cache object and rebuilds when the entries change', () => {
  let reads = 0;
  const watched = (value: Entry): Entry =>
    new Proxy(value, {
      get: (target, property, receiver) => {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

  const addr = address(0);
  const source = cache([watched(entry(addr, '100', 6)), watched(entry(addr, '300', 18))]);

  expect(decimalsAt(source, addr, 300n)).toBe(18);
  const afterBuild = reads;
  expect(afterBuild).toBeGreaterThan(0);

  expect(decimalsAt(source, addr, 300n)).toBe(18);
  expect(decimalsAt(source, addr, 50n)).toBeNull();
  expect(decimalsAt(source, addr, 10n ** 9n)).toBe(18);
  // Serving the same answers without reading an entry again is the memo doing its job.
  expect(reads).toBe(afterBuild);

  // A separate object with different anchors gets its own index; the first keeps its own answer.
  const rebuilt = cache([entry(addr, '100', 6), entry(addr, '300', 8)]);
  expect(decimalsAt(rebuilt, addr, 300n)).toBe(8);
  expect(decimalsAt(source, addr, 300n)).toBe(18);

  // The length guard, exercised against the contract rather than through it (a cache is immutable,
  // see `decimalsAt`): appending in place is seen, so no stale index survives it.
  source.entries.push(entry(addr, '500', 2));
  expect(decimalsAt(source, addr, 600n)).toBe(2);
  expect(decimalsAt(source, addr, 300n)).toBe(18);
});

test('answers 4,000 lookups over 20,000 entries with the pre-index scan answers', () => {
  const random = mulberry32(0xca11e);
  const addressCount = 4000;
  const perAddress = 5;
  const heights = Array.from({ length: 40 }, (_, i) => String(60_000_000 + i * 1000));
  const entries: Entry[] = [];
  const observedByAddress = new Map<string, string[]>();
  for (let i = 0; i < addressCount; i += 1) {
    const addr = address(i);
    const own: string[] = [];
    for (let n = 0; n < perAddress; n += 1) {
      const observedAtBlock = heights[Math.floor(random() * heights.length)]!;
      own.push(observedAtBlock);
      entries.push(
        entry(
          addr,
          observedAtBlock,
          Math.floor(random() * 256),
          hash(HEX[Math.floor(random() * 16)]!),
        ),
      );
    }
    observedByAddress.set(addr, own);
  }

  const source = cache(entries);
  const index = buildMetadataIndex(source.entries);
  expect(source.entries).toHaveLength(addressCount * perAddress);
  expect(observedByAddress.size).toBe(addressCount);
  expect(tiedAnchors(entries)).toBeGreaterThan(0);

  let hits = 0;
  let misses = 0;
  for (let i = 0; i < addressCount; i += 1) {
    const addr = address(i);
    const ascending = ascendingHeights(observedByAddress.get(addr)!);
    const block =
      i % 3 === 0
        ? ascending[0]! - 1n
        : i % 3 === 1
          ? ascending[Math.floor(ascending.length / 2)]!
          : ascending[ascending.length - 1]! + 1n;
    const expected = legacyDecimalsAt(source, addr, block);
    expect(index.decimalsAt(addr, block)).toBe(expected);
    if (expected === null) misses += 1;
    else hits += 1;
  }
  expect(hits).toBeGreaterThan(0);
  expect(misses).toBeGreaterThan(0);
}, 120_000);
