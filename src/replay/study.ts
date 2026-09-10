import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { ConfigError } from '../config/env.js';
import { initialSignalConfig } from '../signals/config.js';
import { encodeJson } from '../domain/json.js';
import { poolRegistrationId } from '../registry/pools.js';
import type { MinuteCoverage } from '../metrics/windows.js';
import { replay, type ReplayReport } from './runner.js';
import { buildCohort } from './cohort.js';
import { compareExperiments, gridSchema, type ExperimentDataset } from './experiments.js';
import { renderStudyReport } from './report.js';
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((x) => x.toLowerCase());
const interval = { startUtc: z.string().datetime(), endUtc: z.string().datetime() };
const casesSchema = z
  .object({
    version: z.string().min(1),
    chainId: z.literal(4663),
    quoteAddress: address,
    warmupMinutes: z.number().int().min(60).max(1440),
    resultMinutes: z.literal(180),
    manifests: z.array(z.string().min(1)).max(32),
    cohort: z
      .object({
        id: z.string().min(1),
        rwaAddress: address,
        ...interval,
        registryVersion: z.string().min(1),
        mode: z.literal('retrospective-cohort'),
      })
      .strict(),
    cases: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
            tokenAddress: address,
            rwaAddress: address,
            ...interval,
            creationTimestampSec: z.number().int().nonnegative().safe(),
            identitySource: z
              .object({
                path: z.string(),
                sha256: z.string().regex(/^[0-9a-f]{64}$/),
                kind: z.literal('saved-third-party-identity'),
                chainCreationVerified: z.literal(false),
              })
              .strict(),
            pool: z
              .object({
                protocol: z.literal('v4'),
                manager: address,
                poolId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
              })
              .strict(),
            use: z.literal('named-regression'),
          })
          .strict(),
      )
      .max(128),
    notes: z.array(z.string()),
  })
  .strict();
const seconds = (utc: string) => Date.parse(utc) / 1000;
export function intervalCovered(
  minutes: readonly MinuteCoverage[],
  startSec: number,
  endSec: number,
) {
  const found = new Map<number, MinuteCoverage[]>();
  for (const m of minutes) {
    const items = found.get(m.minuteStartSec) ?? [];
    items.push(m);
    found.set(m.minuteStartSec, items);
  }
  for (let sec = startSec; sec < endSec; sec += 60) {
    const rows = found.get(sec);
    if (rows?.length !== 1 || !rows[0]!.complete) return false;
  }
  return true;
}
export function cohortHistoryComplete(
  report: Pick<ReplayReport, 'coverage' | 'finalMetrics'>,
  creation: number | null,
  start: number,
  end: number,
): boolean {
  if (creation === null) return false;
  const from = Math.max(start, creation >= start ? creation + 60 : start);
  const until = Math.min(
    end + 180 * 60,
    Math.floor((report.finalMetrics?.at.timestampSec ?? 0) / 60) * 60,
  );
  return (
    from < end &&
    from < until &&
    intervalCovered(
      report.coverage.filter((m) => m.scopeId === report.finalMetrics?.scopeId),
      from,
      until,
    )
  );
}
function roleTargets(report: ReplayReport, token: string, rwa: string, usdg: string) {
  const targets: {
    pool: ReplayReport['registrations'][number]['pool'];
    role: 'meme-rwa' | 'rwa-usdg';
  }[] = [];
  for (const r of report.registrations) {
    const pair = [r.token0.toLowerCase(), r.token1.toLowerCase()];
    if (pair.includes(rwa) && pair.includes(usdg)) targets.push({ pool: r.pool, role: 'rwa-usdg' });
    else if (pair.includes(rwa) && pair.includes(token))
      targets.push({ pool: r.pool, role: 'meme-rwa' });
  }
  return targets;
}
export async function study(casesPath: string, gridPath: string, outDirectory: string) {
  const casesText = readFileSync(casesPath, 'utf8'),
    gridText = readFileSync(gridPath, 'utf8');
  const cases = casesSchema.parse(JSON.parse(casesText)),
    grid = gridSchema.parse(JSON.parse(gridText));
  if (new Set(cases.cases.map((c) => c.id)).size !== cases.cases.length)
    throw new ConfigError('Duplicate history case');
  for (const item of [cases.cohort, ...cases.cases]) {
    const start = seconds(item.startUtc),
      end = seconds(item.endUtc);
    if (start % 60 !== 0 || end % 60 !== 0 || end <= start || end - start > 31 * 86400)
      throw new ConfigError('Invalid history interval');
  }
  if (
    new Set(cases.manifests.map((p) => resolve(dirname(casesPath), p))).size !==
    cases.manifests.length
  )
    throw new ConfigError('Duplicate historical manifest');
  const reports: { path: string; report: ReplayReport }[] = [];
  const sources: { path: string; status: string; issues: unknown; provenance: unknown }[] = [];
  for (const path of cases.manifests) {
    if (/^[a-z]+:\/\//i.test(path)) throw new ConfigError('Study requires local manifests');
    try {
      const result = await replay(
        resolve(dirname(casesPath), path),
        initialSignalConfig,
        'minute-close',
      );
      reports.push({ path, report: result });
      sources.push({
        path,
        status: result.status,
        issues: result.integrity.issues,
        provenance: result.provenance,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      sources.push({
        path,
        status: 'unavailable',
        issues: ['manifest-not-found'],
        provenance: null,
      });
    }
  }
  const datasets: ExperimentDataset[] = [];
  const caseResults = cases.cases.map((c) => {
    const startSec = seconds(c.startUtc),
      endSec = seconds(c.endUtc);
    const matches = reports.filter((r) =>
      r.report.frames.some(
        (f) =>
          f.evaluatedAtSec >= startSec - cases.warmupMinutes * 60 &&
          f.evaluatedAtSec < endSec + cases.resultMinutes * 60,
      ),
    );
    const idList: string[] = [];
    for (const { path, report } of matches) {
      const targets = roleTargets(report, c.tokenAddress, c.rwaAddress, cases.quoteAddress);
      const id = c.id + ':' + path;
      idList.push(id);
      datasets.push({
        id,
        group: 'named-regression',
        token: c.tokenAddress,
        startSec,
        endSec,
        frames: report.frames,
        events: report.metricEvents,
        coverage: {
          minutes: report.coverage,
          scopeId: report.finalMetrics?.scopeId ?? '',
          endSec: report.finalMetrics?.at.timestampSec ?? 0,
          integrityComplete: report.integrity.complete,
        },
        selectedPoolIds: targets.map((t) => poolRegistrationId(t)),
        targets,
        complete:
          matches.length === 1 &&
          report.status === 'complete' &&
          targets.some((t) => t.role === 'meme-rwa') &&
          targets.some((t) => t.role === 'rwa-usdg') &&
          intervalCovered(
            report.coverage,
            startSec - cases.warmupMinutes * 60,
            endSec + cases.resultMinutes * 60,
          ),
      });
    }
    if (!matches.length) {
      idList.push(c.id + ':unavailable');
      datasets.push({
        id: idList[0]!,
        group: 'named-regression',
        token: c.tokenAddress,
        startSec,
        endSec,
        frames: [],
        events: [],
        coverage: { minutes: [], scopeId: 'unavailable', endSec: 0, integrityComplete: false },
        selectedPoolIds: [],
        targets: [],
        complete: false,
      });
    }
    return {
      ...c,
      datasetIds: idList,
      status: datasets.filter((d) => idList.includes(d.id)).every((d) => d.complete)
        ? 'complete'
        : 'incomplete',
      reasons:
        matches.length > 1
          ? ['multiple-source-runs-kept-separate-no-independent-denominator']
          : matches.length
            ? ['see-source-and-window-coverage']
            : ['no-raw-history-in-required-window'],
    };
  });
  const cohortStart = seconds(cases.cohort.startUtc),
    cohortEnd = seconds(cases.cohort.endUtc);
  const cohorts = reports.map(({ path, report }) => {
    const times = new Map(
      report.registrationTimes.map((t) => [t.poolId, t.creationMinuteStartSec]),
    );
    const active = new Set(
      report.metricEvents
        .filter((e) => e.event.kind === 'swap' && e.event.pool !== null)
        .map((e) => poolRegistrationId({ pool: e.event.pool! })),
    );
    const discoveryComplete =
      report.discoveryCoverage.integrityComplete &&
      intervalCovered(report.discoveryMinutes, cohortStart, cohortEnd);
    const cohortMode =
      report.provenance.cohortMode === 'as-of' &&
      report.provenance.availableAtSec !== null &&
      report.provenance.availableAtSec <= cohortStart &&
      report.finalMetrics?.rwa.some(
        (r) => r.asset.address.toLowerCase() === cases.cohort.rwaAddress,
      )
        ? 'as-of'
        : 'retrospective-cohort';
    const cohort = buildCohort(
      {
        startSec: cohortStart,
        endSec: cohortEnd,
        observedUntilSec: report.finalMetrics?.at.timestampSec ?? 0,
        rwaAddresses: [cases.cohort.rwaAddress],
        usdg: cases.quoteAddress,
        discoveryComplete,
        cohortMode,
        registrations: report.registrations.map((registration) => ({
          registration,
          creationMinuteStartSec: times.get(poolRegistrationId(registration)) ?? null,
          hasObservedSwaps: active.has(poolRegistrationId(registration)),
          historyComplete: cohortHistoryComplete(
            report,
            times.get(poolRegistrationId(registration)) ?? null,
            cohortStart,
            cohortEnd,
          ),
        })),
      },
      cohortMode === 'as-of' ? report.finalMetrics!.assetVersion : cases.cohort.registryVersion,
    );
    for (const [group, members] of [
      ['birth-cohort', cohort.births],
      ['preexisting-reheat', cohort.preexisting],
    ] as const) {
      for (const member of members) {
        const token =
          [member.token0, member.token1].find((t) => t.toLowerCase() !== cases.cohort.rwaAddress) ??
          cases.cohort.rwaAddress;
        const targets = roleTargets(report, token, cases.cohort.rwaAddress, cases.quoteAddress);
        const exposureStart =
          group === 'birth-cohort'
            ? Math.max(cohortStart, member.creationMinuteStartSec! + 60)
            : cohortStart;
        datasets.push({
          id: cases.cohort.id + ':' + group + ':' + path + ':' + member.poolId,
          group,
          token,
          startSec: exposureStart,
          endSec: cohortEnd,
          frames: report.frames,
          events: report.metricEvents,
          selectedPoolIds: [member.poolId],
          targets,
          coverage: {
            minutes: report.coverage,
            scopeId: report.finalMetrics?.scopeId ?? '',
            endSec: report.finalMetrics?.at.timestampSec ?? 0,
            integrityComplete: report.integrity.complete,
          },
          complete:
            exposureStart < cohortEnd &&
            cohort.status === 'complete' &&
            intervalCovered(report.coverage, exposureStart, cohortEnd + 180 * 60),
        });
      }
    }
    return { source: path, ...cohort };
  });
  const experiments = compareExperiments(datasets, grid);
  const studyRunId = 'study-' + randomUUID(),
    outputDirectory = resolve(outDirectory, studyRunId);
  const status =
    caseResults.length > 0 &&
    caseResults.every((c) => c.status === 'complete') &&
    cohorts.length === 1 &&
    cohorts[0]!.status === 'complete' &&
    experiments.every((e) => e.status === 'complete')
      ? ('complete' as const)
      : ('incomplete' as const);
  const result = {
    version: 'p5-study-v1',
    studyRunId,
    chainId: 4663,
    mode: 'minute-close',
    status,
    outputDirectory,
    provenance: {
      casesHash: createHash('sha256').update(casesText).digest('hex'),
      gridHash: createHash('sha256').update(gridText).digest('hex'),
    },
    sources,
    cases: caseResults,
    cohorts,
    experiments,
    coverageVerified: false,
    split: {
      exploration: '[2026-09-03,2026-09-06)',
      validation: '[2026-09-06,2026-09-08)',
      outcomeBoundary: 'right-censored at each split end',
    },
    method: {
      warmupMinutes: cases.warmupMinutes,
      resultMinutes: cases.resultMinutes,
      ruleUnit: 'USD estimate micros',
      gridRule:
        '1m absolute + relative (warming fallback per P4); 1 or 2 absolute natural 5m confirmations; confirmRelative disabled to preserve bar axis',
      fees: 'not estimated; no positions, execution costs, impermanent loss, or LP net return',
      discovery:
        'RPC coverage evidence only; each cohort carries its saved input mode; current-registry selection is retrospective-cohort',
      reactionDelaySemantics:
        'delay=0 includes the emission minute, potentially preceding the actual emission second; delay>=1 is the primary conservative comparison',
      primaryReactionDelaysMinutes: [1, 5],
      externalComparison:
        'GMGN token-level USD estimates and chain pool-specific activity differ in scope, aggregation and valuation time; no forced matching',
      namedCases: 'regression selection only; never a population denominator',
    },
    conclusion: '现有阈值尚无足够独立验证证据；报告不证明 LP 净收益。',
  };
  mkdirSync(outputDirectory, { recursive: true });
  const json = encodeJson(result),
    markdown = renderStudyReport(result);
  writeFileSync(join(outputDirectory, 'results.json'), json, { flag: 'wx' });
  writeFileSync(join(outputDirectory, 'report.md'), markdown, { flag: 'wx' });
  writeFileSync(join(outputDirectory, 'history.cases.json'), casesText, { flag: 'wx' });
  writeFileSync(join(outputDirectory, 'signals.grid.json'), gridText, { flag: 'wx' });
  writeFileSync(join(outDirectory, 'results.json'), json);
  writeFileSync(join(outDirectory, 'report.md'), markdown);
  return result;
}
export type StudyReport = Awaited<ReturnType<typeof study>>;
