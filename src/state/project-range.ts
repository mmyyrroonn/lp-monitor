import type { LogTime, PoolEvent, PoolObservation, RangeBatch, RawLog } from '../domain/types.js';
import { PoolRegistry, poolRegistrationId } from '../registry/pools.js';
import { decodeV3 } from '../protocols/uniswap-v3/decode.js';
import { decodeV4 } from '../protocols/uniswap-v4/decode.js';
import { PoolEventDecodeError } from '../domain/events.js';
import { CHAIN_ID } from '../domain/chain.js';
import { rawLogKey } from '../storage/manifest.js';
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

/** Full active-scope replay, including logs before this batch. Never reads batch.logs. */
export function projectRange(
  batch: ProjectionBatch,
  activeLogs: readonly RawLog[],
  logTimes: ReadonlyMap<string, LogTime>,
  registry: PoolRegistry,
): ProjectionResult {
  if (batch.completeness !== 'complete')
    throw new Error('Projection requires accepted complete input');
  const registrations = registry.snapshot();
  const byId = new Map(registrations.map((r) => [poolRegistrationId(r), r]));
  const observations = new Map<string, PoolObservation>();
  for (const r of registrations)
    observations.set(poolRegistrationId(r), {
      pool: r.pool,
      lastSwap: null,
      lastLiquidityAction: null,
    });
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
    const registration = byId.get(v3Id) ?? (v4Id === null ? undefined : byId.get(v4Id));
    if (!registration) {
      // Factory PoolCreated is discovery evidence, never a pool operation.
      const discovery = registrations.some(
        (r) => r.pool.protocol === 'v3' && rawLogKey(r.discoveredAt) === key,
      );
      if (!discovery)
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
      if (event.pool) observations.set(poolId, observePool(observations.get(poolId)!, event));
    } catch (error) {
      if (!(error instanceof PoolEventDecodeError)) throw error;
      result.qualityErrors.push({ code: error.code, raw: log, time, poolId });
    }
  }
  result.observations = [...observations.values()];
  return result;
}
