import { expect, test } from 'vitest';
import {
  aggregateOpsReport,
  healthSnapshot,
  type HealthSnapshotInput,
} from '../../src/ops/report.js';

const health = (overrides: Partial<HealthSnapshotInput> = {}) =>
  healthSnapshot({
    sampledAtMs: 10_000,
    sourceAlias: 'local-rpc',
    chainId: 4665,
    head: { blockNumber: 120n, blockHash: '0xhead', timestampSec: 9 },
    lastHeadAtMs: 9_500,
    scanned: { blockNumber: 118n, blockHash: '0xscan', timestampSec: 8 },
    rawSaved: { blockNumber: 119n, blockHash: '0xraw', timestampSec: 8 },
    projected: { blockNumber: 118n, blockHash: '0xscan', timestampSec: 8 },
    projectedSourceVerified: true,
    projectedCursorVerified: true,
    queueDepth: 2,
    inflight: 1,
    rpc: { eth_getLogs: 4 },
    writeLatencyMs: 3,
    processingLatencyMs: 7,
    dbBytes: 100,
    walBytes: 20,
    outboxPending: 1,
    gap: true,
    ...overrides,
  });

test('health keeps raw saved distinct from accepted scan and computes head gap', () => {
  expect(health()).toMatchObject({
    sourceAlias: 'local-rpc',
    head: { blockNumber: 120n },
    scanned: { blockNumber: 118n },
    rawSaved: { blockNumber: 119n },
    projected: { blockNumber: 118n },
    headGapBlocks: 2n,
    headGapSeconds: 1,
    gap: true,
    dbBytes: 100,
    walBytes: 20,
  });
});

test('projection and future-tip health remain unknown rather than complete', () => {
  expect(health({ gap: undefined }).gap).toBeNull();
  expect(health({ projectedSourceVerified: false }).projected).toBeNull();
  expect(health({ projectedCursorVerified: false }).projected).toBeNull();
  expect(health({ head: null })).toMatchObject({ head: null, headGapBlocks: null });
  expect(
    health({
      head: { blockNumber: 117n, blockHash: '0xold', timestampSec: 7 },
    }),
  ).toMatchObject({ headGapBlocks: null, headGapSeconds: null });
});

test('report uses full sample nearest-rank p95 and keeps latency meanings separate', () => {
  const report = aggregateOpsReport({
    sourceAlias: 'local-rpc',
    startedAtMs: 0,
    finishedAtMs: 3_600_000,
    batchTimings: Array.from({ length: 20 }, (_, i) => ({
      phase: i < 2 ? ('startup' as const) : ('steady' as const),
      acquisitionStartedAtMs: i * 100 - (i + 1),
      rpcAcquisitionMs: i + 1,
      completeEvidenceAtMs: i * 100,
      outboxDurableAtMs: i * 100 + i + 1,
      deliveredAtMs: i * 100 + i + 11,
    })),
    healthSamples: [health(), health({ sampledAtMs: 11_000 })],
    meterCheckpoints: [
      { phase: 'startup', atMs: 0, calls: 0, responseBytes: 0, methods: {} },
      {
        phase: 'startup',
        atMs: 600_000,
        calls: 10,
        responseBytes: 1_000,
        methods: { eth_getLogs: 8, eth_getBlockByNumber: 2 },
      },
      { phase: 'steady', atMs: 600_000, calls: 10, responseBytes: 1_000, methods: {} },
      {
        phase: 'steady',
        atMs: 3_600_000,
        calls: 40,
        responseBytes: 4_000,
        methods: { eth_getLogs: 30 },
      },
    ],
    diskCheckpoints: [
      { phase: 'startup', atMs: 0, dbBytes: 100, walBytes: 0 },
      { phase: 'startup', atMs: 600_000, dbBytes: 200, walBytes: 50 },
      { phase: 'steady', atMs: 600_000, dbBytes: 200, walBytes: 50 },
      { phase: 'steady', atMs: 3_600_000, dbBytes: 500, walBytes: 50 },
    ],
    verifiedRates: null,
  });
  expect(report.latency.localProcessingMs).toEqual({ sampleSize: 20, p95: 19 });
  expect(report.latency.rpcAcquisitionMs).toEqual({ sampleSize: 20, p95: 19 });
  expect(report.latency.totalDeliveryMs).toEqual({ sampleSize: 20, p95: 48 });
  expect(report.usage.steady).toMatchObject({ calls: 30, responseBytes: 3_000, callsPerHour: 36 });
  expect(report.disk.steady).toMatchObject({ growthBytes: 300, growthBytesPerHour: 360 });
  expect(report.monetaryCost).toBeNull();
});

test('verified rates price only stated units and never infer fees from calls', () => {
  const report = aggregateOpsReport({
    sourceAlias: 'priced-rpc',
    startedAtMs: 0,
    finishedAtMs: 1_000,
    batchTimings: [],
    healthSamples: [],
    meterCheckpoints: [
      { phase: 'steady', atMs: 0, calls: 0, responseBytes: 0, billingUnits: 0, methods: {} },
      { phase: 'steady', atMs: 1_000, calls: 2, responseBytes: 10, billingUnits: 4, methods: {} },
    ],
    diskCheckpoints: [],
    verifiedRates: { currency: 'USD', costPerBillingUnit: 0.25, verifiedAtMs: 1 },
  });
  expect(report.monetaryCost).toEqual({ currency: 'USD', amount: 1, verifiedAtMs: 1 });
});

test('phase totals sum adjacent intervals across repeated phase transitions', () => {
  const report = aggregateOpsReport({
    sourceAlias: 'rpc',
    startedAtMs: 0,
    finishedAtMs: 4000,
    batchTimings: [],
    healthSamples: [],
    verifiedRates: null,
    diskCheckpoints: [
      { phase: 'steady', atMs: 0, dbBytes: 0, walBytes: 0 },
      { phase: 'steady', atMs: 1000, dbBytes: 100, walBytes: 0 },
      { phase: 'backfill', atMs: 1000, dbBytes: 100, walBytes: 0 },
      { phase: 'backfill', atMs: 2000, dbBytes: 300, walBytes: 0 },
      { phase: 'steady', atMs: 2000, dbBytes: 300, walBytes: 0 },
      { phase: 'steady', atMs: 3000, dbBytes: 600, walBytes: 0 },
    ],
    meterCheckpoints: [
      { phase: 'steady', atMs: 0, calls: 0, responseBytes: 0, methods: {} },
      { phase: 'steady', atMs: 1000, calls: 1, responseBytes: 10, methods: { log: 1 } },
      { phase: 'backfill', atMs: 1000, calls: 1, responseBytes: 10, methods: { log: 1 } },
      { phase: 'backfill', atMs: 2000, calls: 3, responseBytes: 30, methods: { log: 3 } },
      { phase: 'steady', atMs: 2000, calls: 3, responseBytes: 30, methods: { log: 3 } },
      { phase: 'steady', atMs: 3000, calls: 6, responseBytes: 60, methods: { log: 6 } },
    ],
  });
  expect(report.usage.steady).toMatchObject({
    durationMs: 2000,
    calls: 4,
    responseBytes: 40,
    methods: { log: 4 },
  });
  expect(report.disk.steady).toMatchObject({ durationMs: 2000, growthBytes: 400 });
});

test('disk usage reports signed net change separately from gross positive growth', () => {
  const result = aggregateOpsReport({
    sourceAlias: 'rpc',
    startedAtMs: 0,
    finishedAtMs: 3000,
    batchTimings: [],
    healthSamples: [],
    meterCheckpoints: [],
    diskCheckpoints: [
      { phase: 'steady', atMs: 0, dbBytes: 100, walBytes: 100 },
      { phase: 'steady', atMs: 1000, dbBytes: 300, walBytes: 100 },
      { phase: 'steady', atMs: 2000, dbBytes: 250, walBytes: 0 },
      { phase: 'steady', atMs: 3000, dbBytes: 200, walBytes: 0 },
    ],
    verifiedRates: null,
  });
  expect(result.disk.steady).toEqual({
    durationMs: 3000,
    growthBytes: 0,
    growthBytesPerHour: 0,
    positiveGrowthBytes: 200,
    positiveGrowthBytesPerHour: 240_000,
  });
});
