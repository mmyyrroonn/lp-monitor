import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';

/**
 * The contract of `scripts/benchmark-live-performance.mjs`, exercised by running it.
 *
 * Every case here starts the real script through `tsx` and reads the report it wrote: the p95
 * definition, the deterministic sample allocation, which samples are excluded from the normal
 * batch, the fields every sample has to carry, and the all-active stress configuration. The script
 * is a program, not a library, so starting it is the only honest way to check what it promises.
 * The runs are small on purpose: nothing here measures performance, and the scale runs are E3.2's.
 */
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const script = join(root, 'scripts', 'benchmark-live-performance.mjs');
const workspaces: string[] = [];

type Sample = Record<string, any>;
type Report = Record<string, any>;

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'live-performance-contract-'));
  workspaces.push(path);
  return path;
}

/** Start the script the way an operator would, then read back the report it wrote. */
function benchmark(args: readonly string[], timeout = 300_000): Report {
  const out = join(workspace(), 'out');
  execFileSync(process.execPath, ['--import', 'tsx', script, ...args, '--out', out], {
    cwd: root,
    stdio: 'pipe',
    timeout,
  });
  return JSON.parse(readFileSync(join(out, 'benchmark.json'), 'utf8')) as Report;
}

/** The documented percentile: ascending values, index `ceil(fraction * n) - 1`. Never the best. */
function documentedPercentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const ascending = [...values].sort((left, right) => left - right);
  return ascending[Math.ceil(fraction * values.length) - 1]!;
}

afterAll(() => {
  for (const path of workspaces) rmSync(path, { recursive: true, force: true });
});

test('p95 is the documented order statistic over every raw sample, next to p50', () => {
  const report = benchmark(['--pools', '300', '--active', '80', '--iterations', '20']);
  const durations: number[] = report.normal.durationsMs;

  expect(durations).toHaveLength(20);
  expect(report.normal.samples.map((sample: Sample) => sample.totalMs)).toEqual(durations);
  // With twenty samples the documented index is the second largest, so a p95 read off the fastest
  // sample, off the mean or off the maximum cannot equal it.
  expect(report.normal.p95Ms).toBe(documentedPercentile(durations, 0.95));
  expect(report.normal.p50Ms).toBe(documentedPercentile(durations, 0.5));
  expect(report.normal.p95Ms).toBeGreaterThan(Math.min(...durations));
  expect(report.normal.p95Ms).toBeLessThanOrEqual(Math.max(...durations));
  expect(report.normal.percentileDefinition).toBe('ascending[Math.ceil(0.95 * n) - 1]');
}, 300_000);

test('--iterations allocates new/advance/repeat deterministically and sums to the request', () => {
  const args = ['--pools', '300', '--active', '80', '--iterations', '17'];
  const first = benchmark(args).allocation;
  const second = benchmark(args).allocation;

  expect(first).toEqual(second);
  expect(first).toMatchObject({
    iterations: 17,
    fresh: Math.ceil(17 * 0.7),
    advance: Math.floor((17 - Math.ceil(17 * 0.7)) / 2),
  });
  expect(first.fresh + first.advance + first.repeat).toBe(17);
  expect(first.normalTotal).toBe(17);
  expect(first.repairTotal).toBe(3);
}, 300_000);

test('the default allocation is the plan’s 14 new, 3 advance-only and 3 repeat rounds', () => {
  const report = benchmark(['--pools', '300', '--active', '80', '--iterations', '20']);
  expect(report.allocation).toMatchObject({ iterations: 20, fresh: 14, advance: 3, repeat: 3 });
  const kinds = report.normal.samples.map((sample: Sample) => sample.kind);
  expect(kinds.filter((kind: string) => kind === 'fresh')).toHaveLength(14);
  expect(kinds.filter((kind: string) => kind === 'advance')).toHaveLength(3);
  expect(kinds.filter((kind: string) => kind === 'repeat')).toHaveLength(3);
}, 300_000);

test('initialization is timed on its own and the three warm-up rounds stay out of the batch', () => {
  const report = benchmark(['--pools', '300', '--active', '80', '--iterations', '8']);

  expect(report.init.catalogueMs).toBeGreaterThan(0);
  expect(report.init.coverageMs).toBeGreaterThan(0);
  expect(report.init.registrations).toBe(300);
  expect(report.init.activePools).toBe(80);
  expect(report.init.coverageMinutes).toBe(181);
  expect(report.warmup.rounds).toBe(3);
  expect(report.warmup.samples).toHaveLength(3);
  // A warm-up round is work the run did and then refused to count, so it has to be reported next
  // to the batch rather than inside it — and never under a batch id the normal batch reports.
  expect(report.warmup.samples.every((sample: Sample) => sample.totalMs > 0)).toBe(true);
  const warmupIds = report.warmup.samples.map((sample: Sample) => sample.batchId);
  for (const sample of report.normal.samples as Sample[])
    expect(warmupIds).not.toContain(sample.batchId);
  expect(report.normal.samples).toHaveLength(report.allocation.normalTotal);
  expect(report.normal.durationsMs).toHaveLength(report.allocation.normalTotal);
}, 300_000);

test('the three repair samples are listed on their own and never enter the normal batch', () => {
  const report = benchmark(['--pools', '300', '--active', '80', '--iterations', '8']);
  const kinds = report.repairs.map((sample: Sample) => sample.kind);

  expect(kinds).toEqual(['new-registration-first-swap', 'metadata-backfill', 'history-revision']);
  // A batch id is the digest of the range it records, so it names one round exactly: a repair round
  // that had leaked into the normal batch would be the same round under the same id.
  const normalBatchIds = report.normal.samples.map((sample: Sample) => sample.batchId);
  for (const repair of report.repairs) {
    expect(repair.totalMs).toBeGreaterThan(0);
    expect(normalBatchIds).not.toContain(repair.batchId);
    expect(report.warmup.samples.map((sample: Sample) => sample.batchId)).not.toContain(
      repair.batchId,
    );
  }
  // The repair samples are extra rounds: they are never part of `--iterations`.
  expect(report.normal.samples).toHaveLength(report.allocation.normalTotal);
  expect(report.repairs).toHaveLength(3);
}, 300_000);

test('every sample carries the decomposition, and raw payload is kept apart from the manifest', () => {
  const report = benchmark(['--pools', '300', '--active', '80', '--iterations', '8']);
  const samples: Sample[] = [...report.normal.samples, ...report.warmup.samples, ...report.repairs];

  for (const sample of samples) {
    expect(sample.localProcessingMs).toBeGreaterThan(0);
    expect(sample.rpcAcquisitionMs).toBeGreaterThanOrEqual(0);
    expect(sample.networkWaitMsAfterFetch).toBeGreaterThanOrEqual(0);
    expect(sample.stageMs).toBeTypeOf('object');
    expect(Object.keys(sample.counts).length).toBeGreaterThanOrEqual(16);
    expect(sample.manifestBytes).toBeGreaterThan(0);
    expect(sample.rawBatchBytes).toBeGreaterThan(0);
    expect(sample.poolRegistrationsBytes).toBeGreaterThan(0);
    expect(sample.rssBytes).toBeGreaterThan(0);
    expect(sample.http).toMatchObject({ status: 200 });
    expect(sample.http.responseBytes).toBeGreaterThan(0);
    expect(sample.http.latencyMs).toBeGreaterThanOrEqual(0);
  }
  // A number that folded the raw payload into "other" could not answer for both, and the batch's
  // own registrations are the directory the batch carries rather than the one it was planned from.
  for (const sample of samples.filter((candidate) => candidate.logs > 0)) {
    expect(sample.rawBatchBytes).toBeGreaterThan(sample.manifestBytes);
    expect(sample.rawBatchBytes).toBeGreaterThan(sample.poolRegistrationsBytes);
  }
}, 300_000);

test('stage timings are mutually exclusive, and local processing is not their sum', () => {
  const report = benchmark(['--pools', '300', '--active', '80', '--iterations', '8']);
  const exclusive: string[] = report.stageAccounting.exclusive;
  const inside: string[] = report.stageAccounting.insideLocalProcessing;

  // The contract the report states about itself: the fetch and the notification stand outside the
  // local-processing window, and every stream stage is measured exactly once.
  expect(exclusive).toContain('rpcAcquisition');
  expect(exclusive).toContain('notify');
  expect(inside).toContain('projection');
  expect(inside).toContain('valuation');
  expect(exclusive.filter((stage) => inside.includes(stage))).toEqual([]);
  expect([...exclusive, ...inside].length).toBe(new Set([...exclusive, ...inside]).size);

  for (const sample of report.normal.samples as Sample[]) {
    const nested = inside.reduce((total, stage) => total + (sample.stageMs[stage] ?? 0), 0);
    // Nested stages break the local window down, so they add up to at most it; the fetch and the
    // notification are outside it and may never be added into it.
    expect(nested).toBeLessThanOrEqual(sample.localProcessingMs + 1);
    expect(sample.localProcessingMs).toBeLessThan(sample.totalMs + 1);
  }
}, 300_000);

test('the report states the machine, the load and the revision it ran at', () => {
  const report = benchmark(['--pools', '300', '--active', '80', '--iterations', '8']);

  expect(report.environment.node).toBe(process.version);
  expect(report.environment.cpuModel.length).toBeGreaterThan(0);
  expect(report.environment.cpuCount).toBeGreaterThan(0);
  expect(report.environment.parallelLoad.length).toBeGreaterThan(0);
  expect(report.environment.gitHead).toMatch(/^[0-9a-f]{7,40}$/);
  expect(report.environment.platform).toBe(`${process.platform} ${process.arch}`);
}, 300_000);

test('the default pool-ids filter cost and the manifest size are reported, not hidden', () => {
  const report = benchmark(['--pools', '2000', '--active', '2000', '--iterations', '5'], 600_000);

  // R05 is still the live strategy: one V4 request per `maxFilterValues` pool ids, and that count
  // has to be stated at the scale it was run at instead of being folded into a total.
  expect(report.filterPlan.maxFilterValues).toBe(1000);
  expect(report.filterPlan.v4PoolIdValues).toBeGreaterThan(1500);
  expect(report.filterPlan.v4ShardCount).toBe(
    Math.ceil(report.filterPlan.v4PoolIdValues / report.filterPlan.maxFilterValues),
  );
  expect(report.filterPlan.v3ShardCount).toBeGreaterThan(0);
  expect(report.filterPlan.operationFilterValuesScanned).toBeGreaterThanOrEqual(
    report.filterPlan.v4PoolIdValues,
  );
  expect(report.filterPlan.perShardRequestBytes.p95Bytes).toBeGreaterThan(0);
  expect(report.filterPlan.manifestBytesPerRound.p95Bytes).toBeGreaterThan(0);
  expect(report.filterPlan.rawBatchBytesPerRound.p95Bytes).toBeGreaterThan(0);
  // The all-active stress configuration is the same script, not a special case.
  expect(report.init.registrations).toBe(2000);
  expect(report.init.activePools).toBe(2000);
  expect(report.normal.samples.length).toBe(report.allocation.normalTotal);
}, 600_000);

test('an existing output directory is refused instead of overwritten', () => {
  const out = join(workspace(), 'taken');
  const args = ['--pools', '300', '--active', '80', '--iterations', '5', '--out', out];
  execFileSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: root,
    stdio: 'pipe',
    timeout: 300_000,
  });
  expect(existsSync(join(out, 'benchmark.json'))).toBe(true);
  expect(() =>
    execFileSync(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: root,
      stdio: 'pipe',
      timeout: 300_000,
    }),
  ).toThrow();
}, 300_000);
