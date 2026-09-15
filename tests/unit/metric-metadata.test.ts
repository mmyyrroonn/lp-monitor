import { expect, test } from 'vitest';
import type { Address, Hex } from 'viem';
import type { BlockAnchor } from '../../src/domain/types.js';
import {
  decimalsAt,
  loadMetricMetadata,
  reconcileMetricMetadata,
  type MetricMetadata,
} from '../../src/metrics/metadata.js';

test('cached verified identities are historical and unknown addresses are not guessed', () => {
  const cache = loadMetricMetadata('config/metric-metadata.json');
  expect(decimalsAt(cache, '0x05a3d1cd21d0c88145e82600e62e7e496e0f222b', 57465417n)).toBe(18);
  expect(decimalsAt(cache, '0x5fc5360d0400a0fd4f2af552add042d716f1d168', 57465417n)).toBe(6);
  expect(decimalsAt(cache, '0x05a3d1cd21d0c88145e82600e62e7e496e0f222b', 57465416n)).toBeNull();
  expect(decimalsAt(cache, '0x0000000000000000000000000000000000000001', 99999999n)).toBeNull();
});

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const cache = (entries: MetricMetadata['entries']): MetricMetadata => ({
  version: 'test-v1',
  chainId: 4663,
  source: 'historical-identity-snapshot',
  entries,
});
const entry = (digit: string, blockHash = hash('a')) => ({
  address: address(digit),
  decimals: 18,
  observedAtBlock: '100',
  blockHash,
});
const anchor = (number: bigint, blockHash: Hex): BlockAnchor => ({
  number,
  hash: blockHash,
  timestampSec: 1,
});

test('excludes cache entries with a conflicting known hash at their observation height', () => {
  const first = entry('1');
  const input = cache([first]);
  const result = reconcileMetricMetadata(input, [anchor(100n, hash('b'))]);

  expect(result.metadata.entries).toEqual([]);
  // An exclusion is a real change to the cache, so this is the one path that must hand back a
  // different object: the entries array it drops from is not the caller's to edit.
  expect(result.metadata).not.toBe(input);
  expect(result.conflicts).toEqual([
    {
      address: first.address,
      observedAtBlock: '100',
      expectedHash: hash('a'),
      observedHashes: [hash('b')],
    },
  ]);
});

test('retains cache entries when all known hashes at the observation height match', () => {
  const first = entry('1');
  const result = reconcileMetricMetadata(cache([first]), [
    anchor(99n, hash('b')),
    anchor(100n, hash('a')),
    anchor(100n, hash('a')),
  ]);

  expect(result.metadata.entries).toEqual([first]);
  expect(result.conflicts).toEqual([]);
});

test('retains absent-height entries only as the existing historical carry-forward assumption', () => {
  const first = entry('1');
  const input = cache([first]);
  const result = reconcileMetricMetadata(input, [anchor(99n, hash('b')), anchor(101n, hash('c'))]);

  expect(result.metadata.entries).toEqual([first]);
  expect(result.metadata.source).toBe('historical-identity-snapshot');
  // Absence is not a conflict: nothing was dropped, so the cache passes through as itself.
  expect(result.metadata).toBe(input);
  expect(result.conflicts).toEqual([]);
});

test('reconciling the same cache twice hands the live path one object to index', () => {
  const input = cache([entry('1'), entry('2')]);
  const anchors = [anchor(100n, hash('a'))];
  // Every round reconciles the same seed against the same evidence. As long as no entry is excluded,
  // the round gets the very object `decimalsAt` already indexed, instead of a content-identical copy
  // that would rebuild the index — a digest per entry — once per report.
  const first = reconcileMetricMetadata(input, anchors).metadata;
  expect(reconcileMetricMetadata(input, anchors).metadata).toBe(first);
  expect(decimalsAt(reconcileMetricMetadata(input, anchors).metadata, address('2'), 100n)).toBe(18);
});

test('reports every distinct known hash and preserves stable cache order', () => {
  const first = entry('1');
  const second = { ...entry('2'), observedAtBlock: '101' };
  const result = reconcileMetricMetadata(cache([first, second]), [
    anchor(100n, hash('c')),
    anchor(100n, hash('b')),
    anchor(100n, hash('c')),
  ]);

  expect(result.metadata.entries).toEqual([second]);
  expect(result.conflicts[0]?.observedHashes).toEqual([hash('b'), hash('c')]);
});
