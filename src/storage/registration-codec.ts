import type { LogRef } from '../domain/types.js';
import type { PersistedPoolRegistration } from './manifest.js';

function normalizeHex<T extends string>(value: T): T {
  return value.toLowerCase() as T;
}

function losslessJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString(10) : item,
  );
}

/** The identity `pools.pool_key` is keyed on: a pool, not a discovery of it. */
export function storedPoolKey(registration: PersistedPoolRegistration): string {
  return losslessJson(
    registration.pool.protocol === 'v3'
      ? {
          chainId: registration.pool.chainId,
          protocol: registration.pool.protocol,
          address: normalizeHex(registration.pool.address),
        }
      : {
          chainId: registration.pool.chainId,
          protocol: registration.pool.protocol,
          manager: normalizeHex(registration.pool.manager),
          poolId: normalizeHex(registration.pool.poolId),
        },
  );
}

/** The normalized object written to `pools.payload_json`. */
export function normalizeStoredRegistration(
  registration: PersistedPoolRegistration,
): Record<string, unknown> {
  const pool =
    registration.pool.protocol === 'v3'
      ? { ...registration.pool, address: normalizeHex(registration.pool.address) }
      : {
          ...registration.pool,
          manager: normalizeHex(registration.pool.manager),
          poolId: normalizeHex(registration.pool.poolId),
        };
  return {
    ...registration,
    pool,
    token0: normalizeHex(registration.token0),
    token1: normalizeHex(registration.token1),
    hooks: normalizeHex(registration.hooks),
    discoveredAt: {
      ...registration.discoveredAt,
      blockHash: normalizeHex(registration.discoveredAt.blockHash),
      transactionHash: normalizeHex(registration.discoveredAt.transactionHash),
    },
  };
}

/** The exact bytes stored in a `pools` row or a registry journal entry. */
export function storedRegistrationJson(registration: PersistedPoolRegistration): string {
  return losslessJson(normalizeStoredRegistration(registration));
}

/** Revive a stored registration, restoring the bigint discovery height. */
export function decodeStoredRegistration(payloadJson: string): PersistedPoolRegistration {
  const value = JSON.parse(payloadJson) as Record<string, unknown>;
  const discoveredAt = value.discoveredAt as Record<string, unknown>;
  return {
    ...(value as Omit<PersistedPoolRegistration, 'discoveredAt'>),
    discoveredAt: {
      ...(discoveredAt as Omit<LogRef, 'blockNumber'>),
      blockNumber: BigInt(discoveredAt.blockNumber as string),
    },
  };
}
