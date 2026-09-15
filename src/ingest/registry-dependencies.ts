import type { Hex } from 'viem';
import type { RawLog } from '../domain/types.js';
import {
  normalizePoolRegistration,
  poolRegistrationId,
  type PoolRegistration,
} from '../registry/pools.js';
import type { RegistryView } from '../storage/registry-cache.js';
import { rawLogKey } from '../storage/manifest.js';
import { isV4OperationTopic, lower, type ProtocolDeployments } from './filter-plan.js';

/** A V4 pool id is one 32-byte word; no other shape is read as a pool identity. */
const POOL_ID = /^0x[0-9a-f]{64}$/;

/**
 * The registrations one batch's own logs depend on, and nothing else.
 *
 * A batch that records only the pools it touched can be replayed and persisted from its own
 * evidence; an array that pretends to be the whole catalogue cannot, because a reader would take
 * an unlisted pool for a withdrawn one. Every record here is resolved — a log that names a pool
 * this caller does not know contributes no record rather than a fabricated one, and the raw log
 * stays in the batch either way.
 *
 * A pool is referenced by exactly one of four things: the discovery log it was found in (a V3
 * `PoolCreated` comes from the factory, so only its own registration identifies the pool), a V3
 * log from a pool address, a V4 log from the deployed manager whose event topic is one this
 * protocol is known to emit and whose second topic is the pool id, or a pool staged by the same
 * batch. Any other log is left alone: an unknown topic[1] is a value, not a pool identity.
 */
export function referencedRegistrations(
  logs: readonly RawLog[],
  staged: readonly PoolRegistration[],
  view: RegistryView,
  deployments: ProtocolDeployments,
): readonly PoolRegistration[] {
  const discoveredAt = new Map<string, PoolRegistration>();
  const carriedV3 = new Map<string, PoolRegistration>();
  const carriedV4 = new Map<string, PoolRegistration>();
  for (const record of staged) {
    const registration = normalizePoolRegistration(record);
    discoveredAt.set(rawLogKey(registration.discoveredAt), registration);
    if (registration.pool.protocol === 'v3')
      carriedV3.set(lower(registration.pool.address), registration);
    else carriedV4.set(lower(registration.pool.poolId), registration);
  }
  const manager = lower(deployments.v4Manager);
  const referenced = new Map<string, PoolRegistration>();
  for (const log of logs) {
    const discovered = discoveredAt.get(rawLogKey(log));
    if (discovered !== undefined) {
      referenced.set(poolRegistrationId(discovered), discovered);
      continue;
    }
    const address = lower(log.address);
    const carried = carriedV3.get(address);
    if (carried !== undefined) {
      referenced.set(poolRegistrationId(carried), carried);
      continue;
    }
    const known = view.getByV3Address(address);
    if (known !== undefined) {
      referenced.set(poolRegistrationId(known), known);
      continue;
    }
    if (address !== manager) continue;
    const topic = log.topics[0];
    const poolId = log.topics[1];
    if (
      topic === undefined ||
      poolId === undefined ||
      !isV4OperationTopic(topic) ||
      !POOL_ID.test(lower(poolId))
    )
      continue;
    const pool = carriedV4.get(lower(poolId)) ?? view.getByV4Id(manager, poolId);
    if (pool !== undefined) referenced.set(poolRegistrationId(pool), pool);
  }
  return [...referenced.values()].sort((left, right) => {
    const before = poolRegistrationId(left);
    const after = poolRegistrationId(right);
    return before < after ? -1 : before > after ? 1 : 0;
  });
}
