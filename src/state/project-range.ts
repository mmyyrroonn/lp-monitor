import type { LogTime, PoolEvent, PoolObservation, RangeBatch, RawLog } from '../domain/types.js';
import type { PoolRegistration } from '../registry/pools.js';
import { PoolRegistry, poolRegistrationId } from '../registry/pools.js';
import { decodeV3 } from '../protocols/uniswap-v3/decode.js';
import { decodeV4 } from '../protocols/uniswap-v4/decode.js';
import { PoolEventDecodeError } from '../domain/events.js';
import { CHAIN_ID } from '../domain/chain.js';
import { rawLogKey } from '../storage/manifest.js';
import type { RegistryView } from '../storage/registry-cache.js';
import { comparePosition, observePool } from './observations.js';

export const PROJECTION_VERSION = 'p2-v2';
export type ProjectionBatch = Pick<RangeBatch, 'id' | 'scopeId' | 'end' | 'completeness'>;
export interface ProjectionQualityError {
  code: string;
  raw: RawLog;
  time: LogTime;
  poolId: string | null;
}
export interface ProjectionResult {
  version: typeof PROJECTION_VERSION;
  scopeId: string;
  batchId: string;
  end: RangeBatch['end'];
  events: PoolEvent[];
  observations: PoolObservation[];
  qualityErrors: ProjectionQualityError[];
}
const unresolved: LogTime = { minuteStartSec: null, exactTimestampSec: null, source: 'unresolved' };

/** How one pass answers "which pool owns this log" and "is this log discovery evidence". */
interface RegistryLookup {
  /** The registration one pool id names, or undefined when this registry does not hold it. */
  byPoolId(poolId: string): PoolRegistration | undefined;
  /** Whether a raw log key is the discovery log of a registration rather than a pool operation. */
  isDiscovery(rawLogKey: string): boolean;
  /** Registrations that start with an empty observation, so a pool without a log is still reported. */
  preseed: Iterable<PoolRegistration>;
}

function emptyObservation(registration: PoolRegistration): PoolObservation {
  return { pool: registration.pool, lastSwap: null, lastLiquidityAction: null };
}

/** The one replay loop every projection path shares. Never reads `batch.logs`. */
function project(
  batch: ProjectionBatch,
  activeLogs: readonly RawLog[],
  logTimes: ReadonlyMap<string, LogTime>,
  registry: RegistryLookup,
): ProjectionResult {
  if (batch.completeness !== 'complete')
    throw new Error('Projection requires accepted complete input');
  const observations = new Map<string, PoolObservation>();
  for (const r of registry.preseed) observations.set(poolRegistrationId(r), emptyObservation(r));
  const result: ProjectionResult = {
    version: PROJECTION_VERSION,
    scopeId: batch.scopeId,
    batchId: batch.id,
    end: batch.end,
    events: [],
    observations: [],
    qualityErrors: [],
  };
  const seen = new Set<string>();
  for (const log of [...activeLogs].sort(comparePosition)) {
    const key = rawLogKey(log);
    if (seen.has(key)) continue;
    seen.add(key);
    const time = logTimes.get(key) ?? unresolved;
    const v3Id = poolRegistrationId({
      pool: { chainId: CHAIN_ID, protocol: 'v3', address: log.address },
    });
    const v4Id =
      log.topics[1] === undefined
        ? null
        : poolRegistrationId({
            pool: {
              chainId: CHAIN_ID,
              protocol: 'v4',
              manager: log.address,
              poolId: log.topics[1],
            },
          });
    const registration =
      registry.byPoolId(v3Id) ?? (v4Id === null ? undefined : registry.byPoolId(v4Id));
    if (!registration) {
      // Factory PoolCreated is discovery evidence, never a pool operation.
      if (!registry.isDiscovery(key))
        result.qualityErrors.push({ code: 'unregistered-pool', raw: log, time, poolId: null });
      continue;
    }
    const poolId = poolRegistrationId(registration);
    if (time.source === 'unresolved' || time.minuteStartSec === null)
      result.qualityErrors.push({ code: 'unresolved-time', raw: log, time, poolId });
    try {
      const event =
        registration.pool.protocol === 'v3'
          ? decodeV3(log, time, registration)
          : decodeV4(log, time, registration);
      result.events.push(event);
      if (event.pool)
        observations.set(
          poolId,
          observePool(observations.get(poolId) ?? emptyObservation(registration), event),
        );
    } catch (error) {
      if (!(error instanceof PoolEventDecodeError)) throw error;
      result.qualityErrors.push({ code: error.code, raw: log, time, poolId });
    }
  }
  result.observations = [...observations.values()];
  return result;
}

/** Full active-scope replay, including logs before this batch. Never reads batch.logs. */
export function projectRange(
  batch: ProjectionBatch,
  activeLogs: readonly RawLog[],
  logTimes: ReadonlyMap<string, LogTime>,
  registry: PoolRegistry,
): ProjectionResult {
  const registrations = registry.snapshot();
  const byId = new Map(registrations.map((r) => [poolRegistrationId(r), r]));
  const discovery = new Set(registrations.map((r) => rawLogKey(r.discoveredAt)));
  return project(batch, activeLogs, logTimes, {
    byPoolId: (poolId) => byId.get(poolId),
    // Discovery evidence is a registration's own discovery log, whatever protocol claims it.
    isDiscovery: (key) => discovery.has(key),
    preseed: registrations,
  });
}

/**
 * The same replay over a bounded registration set: only the pools the logs actually name, read
 * through the live registry view instead of a catalogue snapshot.
 *
 * The registry view answers by identity, so this pass never materialises the catalogue and never
 * seeds an empty observation for a pool that has no log in the window. It is the live projection's
 * entry point; the full `projectRange` stays the offline path, and both share one decode loop so a
 * log cannot be interpreted two ways.
 */
export function projectRangeSelected(
  batch: ProjectionBatch,
  activeLogs: readonly RawLog[],
  logTimes: ReadonlyMap<string, LogTime>,
  view: RegistryView,
): ProjectionResult {
  return project(batch, activeLogs, logTimes, {
    byPoolId: (poolId) => view.get(poolId),
    isDiscovery: (key) => view.isDiscoveryRef(key),
    preseed: [],
  });
}
