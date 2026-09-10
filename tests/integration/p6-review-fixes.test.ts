import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChainReader } from '../../src/rpc/client.js';
import { aggregateOpsReport } from '../../src/ops/report.js';
import { RuntimeTelemetry } from '../../src/ops/runtime-telemetry.js';
import { RequestMeter } from '../../src/rpc/request-meter.js';
import { openDatabase } from '../../src/storage/database.js';
import { inspectDatabaseStatus } from '../../src/ops/status.js';
afterEach(() => vi.useRealTimers());
test('actual concurrent backfill dispatch remains one second apart across global retry deferral; rate wait is queued', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const sends: number[] = [];
  let foreground = 0;
  const reader = createChainReader(
    { httpRpcUrl: 'https://fixture.invalid', providerAlias: 'fixture', dataDir: '.' },
    {
      maxCalls: 20,
      evidenceMode: 'off',
      perSecond: 5,
      maxBackfillRpcRps: 1,
      fetchFn: async (_url, init) => {
        const req = JSON.parse(String(init?.body));
        if (req.params[0] === 'foreground' && foreground++ === 0)
          throw new TypeError('fetch failed: ECONNRESET');
        if (req.params[0] !== 'foreground') sends.push(Date.now());
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: '0x1' }));
      },
    },
  );
  const fg = reader.request('eth_call', ['foreground']);
  await vi.advanceTimersByTimeAsync(1);
  const work = Promise.all([
    fg,
    ...[1, 2].map((n) =>
      reader.meter.withPurpose('backfill', () => reader.request('eth_call', [n])),
    ),
  ]);
  await vi.advanceTimersByTimeAsync(300);
  expect(reader.meter.summary().activeRpc).toBe(0);
  expect(reader.meter.summary().queueDepth).toBeGreaterThan(0);
  await vi.runAllTimersAsync();
  await work;
  expect(sends[1]! - sends[0]!).toBeGreaterThanOrEqual(1000);
  expect(reader.meter.summary().timings.queueWaitMs).toBeGreaterThanOrEqual(1000);
  await reader.close();
});
test('total delivery includes slow acquisition while no alert has no delivery sample', () => {
  const report = aggregateOpsReport({
    sourceAlias: 'fixture',
    startedAtMs: 0,
    finishedAtMs: 20000,
    batchTimings: [
      {
        phase: 'steady',
        acquisitionStartedAtMs: 0,
        rpcAcquisitionMs: 10000,
        completeEvidenceAtMs: 10000,
        outboxDurableAtMs: 10020,
        deliveredAtMs: 10030,
        notifyAttemptCompletedAtMs: 10030,
      },
      {
        phase: 'steady',
        acquisitionStartedAtMs: 11000,
        rpcAcquisitionMs: 1000,
        completeEvidenceAtMs: 12000,
        outboxDurableAtMs: 12020,
        deliveredAtMs: null,
        notifyAttemptCompletedAtMs: 12025,
      },
    ],
    healthSamples: [],
    meterCheckpoints: [],
    diskCheckpoints: [],
    verifiedRates: null,
  });
  expect(report.latency.localProcessingMs.p95).toBe(20);
  expect(report.latency.totalDeliveryMs).toEqual({ sampleSize: 1, p95: 10030 });
  expect(report.monetaryCost).toBeNull();
});
test('failure transition immediately persists unknown coverage and original head time through offline status', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const dir = mkdtempSync(join(tmpdir(), 'p6-health-'));
  const path = join(dir, 'db.sqlite');
  const db = openDatabase(path);
  try {
    const telemetry = new RuntimeTelemetry({
      db,
      databasePath: path,
      scopeId: 'fixture',
      sourceAlias: 'fixture',
      chainId: 1,
      meter: new RequestMeter(),
    });
    telemetry.observeHead({ number: 10n, hash: '0x1234', timestampSec: 9 });
    telemetry.transition('healthy');
    telemetry.sample(false);
    vi.setSystemTime(40000);
    telemetry.transition('degraded');
    const sidecar = JSON.parse(readFileSync(path + '.health.json', 'utf8'));
    expect(sidecar).toMatchObject({
      runtimeState: 'degraded',
      gap: null,
      lastHeadAtMs: 10000,
      sampledAtMs: 40000,
    });
    expect(inspectDatabaseStatus(path, { scopeId: 'fixture' })).toMatchObject({
      runtimeState: 'degraded',
      gap: null,
      headObservationAgeMs: 30000,
    });
    expect(telemetry.finish().healthSamples.at(-1)?.gap).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
