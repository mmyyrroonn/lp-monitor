import type { Address, Hex } from 'viem';
import type { BlockAnchor, LogRef, PoolRef } from '../domain/types.js';
import { countWork } from '../ops/work-counters.js';
import type {
  PersistedPoolRegistration as StoredPoolRegistration,
  RecordedRangeBatch,
} from '../storage/manifest.js';

export type PoolRegistration = StoredPoolRegistration;
const lowerAddress = (value: Address): Address => value.toLowerCase() as Address;
const lowerHex = (value: Hex): Hex => value.toLowerCase() as Hex;

export function poolRegistrationId(registration: Pick<PoolRegistration, 'pool'>): string {
  const pool = registration.pool;
  return pool.protocol === 'v3'
    ? `${pool.chainId}:v3:${pool.address.toLowerCase()}`
    : `${pool.chainId}:v4:${pool.manager.toLowerCase()}:${pool.poolId.toLowerCase()}`;
}

/** One pool can be attributed to each stock token it contains; the pool itself remains unique. */
export function stockPoolAttributions(
  registrations: readonly PoolRegistration[],
  stockAddresses: readonly Address[],
): readonly { poolId: string; stockAddress: Address }[] {
  const stocks = new Set(stockAddresses.map((address) => address.toLowerCase()));
  return registrations
    .flatMap((registration) =>
      [registration.token0, registration.token1]
        .filter((address, index, values) => values.indexOf(address) === index)
        .filter((address) => stocks.has(address.toLowerCase()))
        .map((stockAddress) => ({
          poolId: poolRegistrationId(registration),
          stockAddress,
        })),
    )
    .sort((left, right) =>
      `${left.poolId}:${left.stockAddress}`.localeCompare(`${right.poolId}:${right.stockAddress}`),
    );
}

function normalizeRef(pool: PoolRef): PoolRef {
  return pool.protocol === 'v3'
    ? { ...pool, address: lowerAddress(pool.address) }
    : { ...pool, manager: lowerAddress(pool.manager), poolId: lowerHex(pool.poolId) };
}
function normalizeLogRef(ref: LogRef): LogRef {
  return {
    ...ref,
    blockHash: lowerHex(ref.blockHash),
    transactionHash: lowerHex(ref.transactionHash),
  };
}
export function normalizePoolRegistration(registration: PoolRegistration): PoolRegistration {
  return {
    ...registration,
    pool: normalizeRef(registration.pool),
    token0: lowerAddress(registration.token0),
    token1: lowerAddress(registration.token1),
    hooks: lowerAddress(registration.hooks),
    discoveredAt: normalizeLogRef(registration.discoveredAt),
  };
}
function equivalent(left: PoolRegistration, right: PoolRegistration): boolean {
  const encode = (value: PoolRegistration) =>
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    );
  // Both sides are serialized; neither the merge nor the counters may assume equality.
  countWork('registryRowsSerialized', 2);
  return encode(left) === encode(right);
}

/** Whether two records are the same stored bytes, so a caller can skip a write it already holds. */
export function registrationsEqual(left: PoolRegistration, right: PoolRegistration): boolean {
  return equivalent(left, right);
}

/**
 * The one merge rule for a pool identity, shared by the batch preview and every live registry:
 * a stored record stands unless the candidate is a different record with the same identity, in
 * which case a seed record yields to a chain record and a chain record is kept as written.
 *
 * `changed` reports whether the stored record really moved. An equivalent rewrite keeps the record
 * already held, so a caller caching by object identity is not invalidated by a re-encode.
 */
export function mergeRegistration(
  existing: PoolRegistration | undefined,
  candidate: PoolRegistration,
): { changed: boolean; record: PoolRegistration } {
  if (existing === undefined) return { changed: true, record: candidate };
  if (equivalent(existing, candidate)) return { changed: false, record: existing };
  const sameMetadata =
    existing.token0 === candidate.token0 &&
    existing.token1 === candidate.token1 &&
    existing.feePips === candidate.feePips &&
    existing.tickSpacing === candidate.tickSpacing &&
    existing.hooks === candidate.hooks &&
    existing.assetVersion === candidate.assetVersion;
  if (!sameMetadata)
    throw new Error(`Conflicting pool registration ${poolRegistrationId(candidate)}`);
  if (existing.source !== 'seed-config' || candidate.source === 'seed-config')
    return { changed: false, record: existing };
  return { changed: true, record: candidate };
}

export class PoolRegistry {
  readonly #registrations = new Map<string, PoolRegistration>();
  constructor(seeds: readonly PoolRegistration[] = []) {
    this.registerAll(seeds);
  }
  snapshot(assetVersion?: string): readonly PoolRegistration[] {
    return [...this.#registrations.values()]
      .filter(
        (registration) => assetVersion === undefined || registration.assetVersion === assetVersion,
      )
      .sort((left, right) => poolRegistrationId(left).localeCompare(poolRegistrationId(right)));
  }
  preview(staged: readonly PoolRegistration[], assetVersion?: string): readonly PoolRegistration[] {
    const merged = new Map(
      this.snapshot(assetVersion).map((entry) => [poolRegistrationId(entry), entry]),
    );
    for (const candidate of staged.map(normalizePoolRegistration)) {
      if (assetVersion !== undefined && candidate.assetVersion !== assetVersion) continue;
      const id = poolRegistrationId(candidate);
      const existing = merged.get(id);
      const decision = mergeRegistration(existing, candidate);
      if (decision.record !== existing) merged.set(id, decision.record);
    }
    return [...merged.values()].sort((left, right) =>
      poolRegistrationId(left).localeCompare(poolRegistrationId(right)),
    );
  }
  /** O(1) lookup by `poolRegistrationId`. */
  get(poolId: string): PoolRegistration | undefined {
    return this.#registrations.get(poolId);
  }
  /** Merge one stored record in place under the shared rule; returns whether it moved. */
  apply(candidate: PoolRegistration): boolean {
    const normalized = normalizePoolRegistration(candidate);
    const id = poolRegistrationId(normalized);
    const decision = mergeRegistration(this.#registrations.get(id), normalized);
    if (!decision.changed) return false;
    this.#registrations.set(id, decision.record);
    return true;
  }
  remove(poolId: string): boolean {
    return this.#registrations.delete(poolId);
  }
  registerAll(registrations: readonly PoolRegistration[]): void {
    // A union, not a replacement, and no full sort: the map carries no order, so the ordering
    // preview applies to its returned array is only needed by callers that ask for an array.
    for (const registration of registrations) this.apply(registration);
  }
  registerAccepted(batch: RecordedRangeBatch): void {
    if (batch.completeness !== 'complete') {
      throw new Error('Cannot register pools from an incomplete range');
    }
    this.registerAll(batch.poolRegistrations ?? []);
  }
  invalidateAfter(anchor: BlockAnchor): void {
    for (const [id, registration] of this.#registrations) {
      const discovery = registration.discoveredAt;
      if (
        discovery.blockNumber > anchor.number ||
        (discovery.blockNumber === anchor.number &&
          discovery.blockHash.toLowerCase() !== anchor.hash.toLowerCase())
      ) {
        this.remove(id);
      }
    }
  }
}
