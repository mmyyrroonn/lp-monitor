import type { Outcome } from './outcomes.js';
import type { Cohort } from './cohort.js';
export function summarizeOutcomeQuality(outcomes: readonly Outcome[], cohort: Cohort | null) {
  return {
    countUnit: 'outcome-window-records',
    independentSamples: false,
    note: 'Diagnostic coverage counts include repeated alerts, delays and overlapping named cases; not a population denominator.',
    cohortStatus: cohort?.status ?? 'unavailable',
    cohortDenominator: cohort?.denominator ?? null,
    observedBirthCount: cohort?.observedBirthCount ?? null,
    horizons: ([15, 60, 180] as const).map((horizonMinutes) => {
      const windows = outcomes.flatMap((o) =>
        o.windows.filter((w) => w.horizonMinutes === horizonMinutes),
      );
      return {
        horizonMinutes,
        total: windows.length,
        complete: windows.filter((w) => w.status === 'complete').length,
        incomplete: windows.filter((w) => w.incomplete).length,
        censored: windows.filter((w) => w.censored).length,
        valued: windows.filter((w) => w.valuationComplete).length,
      };
    }),
    coverageVerified: false,
    conclusion:
      'Coverage describes available evidence; threshold effectiveness and LP returns are not established.',
  };
}
