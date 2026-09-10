import { expect, it } from 'vitest';
import { buildCohort } from '../../src/replay/cohort.js';
import { registration, addr, swap } from '../helpers/alert-fixture.js';
const item = (n: number, minute: number | null) => ({
  registration: {
    ...registration,
    pool: { ...registration.pool, address: addr(n) } as typeof registration.pool,
    discoveredAt: swap(n),
  },
  creationMinuteStartSec: minute,
  historyComplete: true,
});
it('retains dead pools, old pools for reheats, unresolved births and right-censored births', () => {
  const result = buildCohort(
    {
      startSec: 0,
      endSec: 600,
      observedUntilSec: 600 + 179 * 60,
      rwaAddresses: [registration.token0],
      usdg: registration.token1,
      discoveryComplete: true,
      registrations: [
        { ...item(1, 0), hasObservedSwaps: false },
        item(2, 540),
        item(3, -60),
        item(4, null),
      ],
    },
    'registry-v1',
  );
  expect(result.births).toHaveLength(2);
  expect(result.births[0]).toMatchObject({ status: 'complete', hasObservedSwaps: false });
  expect(result.births[1]).toMatchObject({ censored: true, hasObservedSwaps: null });
  expect(result.preexisting).toHaveLength(1);
  expect(result.unresolved).toHaveLength(1);
  expect(result.observedBirthCount).toBe(2);
  expect(result.denominator).toBeNull();
  expect(result.status).toBe('incomplete');
  expect(result.cohortMode).toBe('retrospective-cohort');
});
it('never uses a seed observation as creation evidence and never claims complete discovery from seen pools', () => {
  const seed = { ...item(1, 0), registration: { ...registration, source: 'seed-config' } };
  const result = buildCohort(
    {
      startSec: 0,
      endSec: 600,
      observedUntilSec: 20000,
      rwaAddresses: [registration.token0],
      usdg: registration.token1,
      discoveryComplete: false,
      registrations: [seed, item(2, 60)],
    },
    'v',
  );
  expect(result.births).toHaveLength(1);
  expect(result.unresolved).toHaveLength(1);
  expect(result.denominator).toBeNull();
});
it('per-pool history gaps remain incomplete without dropping the verified birth denominator', () => {
  const r = buildCohort(
    {
      startSec: 0,
      endSec: 600,
      observedUntilSec: 11000,
      rwaAddresses: [registration.token0],
      usdg: registration.token1,
      discoveryComplete: true,
      cohortMode: 'as-of',
      registrations: [
        { ...item(1, 0), historyComplete: true, hasObservedSwaps: false },
        { ...item(2, 60), historyComplete: false },
        { ...item(3, 540), historyComplete: true },
      ],
    },
    'v',
  );
  expect(r.denominator).toBe(3);
  expect(r.births[0]).toMatchObject({
    status: 'complete',
    historyComplete: true,
    hasObservedSwaps: false,
  });
  expect(r.births[1]).toMatchObject({ status: 'incomplete', historyComplete: false });
  expect(r.births[2]!.censored).toBe(true);
  expect(r.status).toBe('incomplete');
  expect(r.cohortMode).toBe('as-of');
});
