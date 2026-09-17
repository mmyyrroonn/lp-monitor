import { expect, test } from 'vitest';
import { buildRollingMetrics, prepareRollingCoverage } from '../../src/metrics/rolling.js';
import { buildReferenceRollingMetrics } from '../helpers/reference-rolling.js';
import { makeScaleData } from '../helpers/live-scale-fixture.js';
import { openWorkCounts } from '../../src/ops/work-counters.js';

const data = makeScaleData({
  poolCount: 20,
  activePoolCount: 20,
  assetCount: 4,
  historyMinutes: 181,
});
const pools = data.registrations.map((r) => ({
  pool: r.pool,
  discoveredAtBlock: r.discoveredAt.blockNumber,
  rawToken: r.token1,
}));

test('active pools share unchanged empty history and coverage without borrowing event results', () => {
  // This complexity bound compares pools with the same lifetime and raw-unit contract.
  // The separate oracle cases below retain the fixture's different birth cohorts.
  const sharedPools = pools.map((pool) => ({
    ...pool,
    discoveredAtBlock: 0n,
    rawToken: pools[1]!.rawToken,
  }));
  const work = openWorkCounts();
  let actual;
  try {
    actual = buildRollingMetrics(data.events, data.coverage, data.watermark, {
      pools: sharedPools,
    });
    expect(work.counts.rollingWindowsBuilt).toBeLessThan(1000);
    expect(work.counts.rollingCoverageVisits).toBeLessThan(4000);
  } finally {
    work.close();
  }
  expect(actual).toEqual(
    buildReferenceRollingMetrics(data.events, data.coverage, data.watermark, {
      pools: sharedPools,
    }),
  );
});

test.each([0, 1, 59, 60, 61, 300, -60])(
  'matches frozen rolling semantics at watermark offset %s with repaired and unknown evidence',
  (offset) => {
    const watermark = { ...data.watermark, timestampSec: data.watermark.timestampSec + offset };
    const variants = [
      data.events,
      data.events.slice(1),
      data.events.map((e, i) =>
        i === 0
          ? {
              ...e,
              usdMicros: null,
              event: {
                ...e.event,
                time: {
                  minuteStartSec: null,
                  exactTimestampSec: null,
                  source: 'unresolved' as const,
                },
              },
            }
          : e,
      ),
    ];
    for (const events of variants)
      for (const coverage of [data.coverage, data.coverage.filter((_, i) => i !== 20)])
        expect(buildRollingMetrics(events, coverage, watermark, { pools })).toEqual(
          buildReferenceRollingMetrics(events, coverage, watermark, { pools }),
        );
  },
);

test('callers cannot contaminate another window by appending a coverage reason', () => {
  const index = prepareRollingCoverage(data.coverage);
  const args = [
    data.watermark.timestampSec - 300,
    data.watermark.timestampSec,
    data.watermark.timestampSec,
    null,
  ] as const;
  const before = [...index.reasons(...args)];
  index.reasons(...args).push('boundary-time-unknown');
  expect(index.reasons(...args)).toEqual(before);
});

test('a report shares one coverage index across stock windows', async () => {
  const { openDashboardFixture, metricsReport } = await import('../helpers/dashboard-fixture.js');
  const f = openDashboardFixture();
  const work = openWorkCounts();
  try {
    const report = metricsReport(f);
    expect(report.windows).toHaveLength(12);
    expect(work.counts.coverageIndexBuilds).toBeLessThanOrEqual(3);
  } finally {
    work.close();
    f.close();
  }
});
