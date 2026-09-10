import type { PersistedPoolRegistration } from '../storage/manifest.js';
import { poolRegistrationId } from '../registry/pools.js';
export interface CohortRegistration {
  registration: PersistedPoolRegistration;
  creationMinuteStartSec: number | null;
  hasObservedSwaps?: boolean;
  historyComplete?: boolean;
}
export interface DiscoveryRange {
  startSec: number;
  endSec: number;
  observedUntilSec: number;
  rwaAddresses: readonly string[];
  usdg: string;
  registrations: readonly CohortRegistration[];
  discoveryComplete: boolean;
  cohortMode?: 'as-of' | 'retrospective-cohort';
}
export type Cohort = ReturnType<typeof buildCohort>;
/** The observed births remain visible even if discovery cannot prove the denominator. */
export function buildCohort(range: DiscoveryRange, registryVersion: string) {
  if (
    !registryVersion ||
    ![range.startSec, range.endSec, range.observedUntilSec].every(Number.isSafeInteger) ||
    range.startSec % 60 !== 0 ||
    range.endSec % 60 !== 0 ||
    range.endSec <= range.startSec
  )
    throw new RangeError('Invalid cohort range');
  const rwa = new Set(range.rwaAddresses.map((a) => a.toLowerCase()));
  const seen = new Set<string>();
  const entries = range.registrations
    .filter(
      ({ registration: r }) => rwa.has(r.token0.toLowerCase()) || rwa.has(r.token1.toLowerCase()),
    )
    .map(
      ({
        registration: r,
        creationMinuteStartSec: creation,
        hasObservedSwaps = null,
        historyComplete = null,
      }) => {
        const poolId = poolRegistrationId(r);
        if (seen.has(poolId)) throw new RangeError('Duplicate cohort pool');
        seen.add(poolId);
        if (r.source === 'seed-config') creation = null;
        if (creation !== null && (!Number.isSafeInteger(creation) || creation % 60 !== 0))
          throw new RangeError('Invalid creation minute');
        const birth = creation !== null && creation >= range.startSec && creation < range.endSec;
        const censored = birth && creation! + 60 + 180 * 60 > range.observedUntilSec;
        const incomplete =
          !range.discoveryComplete || creation === null || historyComplete !== true;
        return {
          poolId,
          pool: r.pool,
          token0: r.token0,
          token1: r.token1,
          role:
            r.token0.toLowerCase() === range.usdg.toLowerCase() ||
            r.token1.toLowerCase() === range.usdg.toLowerCase()
              ? ('rwa-usdg' as const)
              : ('meme-rwa' as const),
          creationMinuteStartSec: creation,
          creationEvidence: r.source,
          creationRef: r.discoveredAt,
          hasObservedSwaps,
          historyComplete,
          birth,
          censored,
          incomplete,
          status: incomplete
            ? ('incomplete' as const)
            : censored
              ? ('censored' as const)
              : ('complete' as const),
        };
      },
    )
    .sort((a, b) => a.poolId.localeCompare(b.poolId));
  const births = entries.filter((e) => e.birth);
  const unresolved = entries.filter((e) => e.creationMinuteStartSec === null);
  const complete = range.discoveryComplete && unresolved.length === 0;
  return {
    registryVersion,
    cohortMode: range.cohortMode ?? ('retrospective-cohort' as const),
    startSec: range.startSec,
    endSec: range.endSec,
    status:
      complete &&
      [
        ...births,
        ...entries.filter(
          (e) => e.creationMinuteStartSec !== null && e.creationMinuteStartSec < range.startSec,
        ),
      ].every((e) => !e.incomplete)
        ? ('complete' as const)
        : ('incomplete' as const),
    discoveryComplete: range.discoveryComplete,
    observedBirthCount: births.length,
    denominator: complete ? births.length : null,
    births,
    preexisting: entries.filter(
      (e) => e.creationMinuteStartSec !== null && e.creationMinuteStartSec < range.startSec,
    ),
    unresolved,
    excludedAfterRange: entries.filter(
      (e) => e.creationMinuteStartSec !== null && e.creationMinuteStartSec >= range.endSec,
    ),
  };
}
