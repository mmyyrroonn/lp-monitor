import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import * as rpc from '../../src/rpc/client.js';
import { loadChainConfig } from '../../src/config/chain.js';
import { loadEnv } from '../../src/config/env.js';
import { loadMetricMetadata } from '../../src/metrics/metadata.js';
import { parseSignalConfig } from '../../src/signals/config.js';
import { runRecorder, type RecorderOptions } from '../../src/ops/recorder.js';
import * as localConsole from '../../src/notify/console.js';
import type { AlertRecord } from '../../src/signals/types.js';
import { AlertOutbox } from '../../src/notify/outbox.js';
import { recorderFixture } from '../helpers/recorder-fixture.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup(dir: string): RecorderOptions {
  return {
    command: 'follow',
    notify: 'local',
    signalConfig: parseSignalConfig(
      JSON.parse(readFileSync('config/signals.initial.json', 'utf8')),
    ),
    metricMetadata: loadMetricMetadata('config/metric-metadata.json'),
    config: loadChainConfig('config/robinhood.json'),
    env: loadEnv({ RH_RPC_HTTP: 'https://fixture.invalid', RH_PROVIDER_ALIAS: 'fixture' }),
    watchlistPath: 'config/watchlist.amc.json',
    databasePath: join(dir, 'db.sqlite'),
    outputDirectory: join(dir, 'runs'),
    fromBlock: 100n,
    durationMs: 1000,
    maxCalls: 10000,
    evidenceMode: 'off',
    readerFactory: recorderFixture().factory,
  };
}
const manifest = (options: RecorderOptions) =>
  JSON.parse(
    readFileSync(
      join(options.outputDirectory, readdirSync(options.outputDirectory)[0]!, 'manifest.json'),
      'utf8',
    ),
  );
test('real zero timestamp recorder minute and initial warmup calls retain categories and historical dispatch spacing', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const dir = mkdtempSync(join(tmpdir(), 'p6-historical-'));
  const opts = setup(dir);
  opts.command = 'ingest';
  delete opts.notify;
  delete opts.fromBlock;
  opts.durationMs = 120000;
  const original = rpc.createChainReader;
  const calls: { at: number; purpose: string | undefined }[] = [];
  vi.spyOn(rpc, 'createChainReader').mockImplementation((env, options) => {
    const transport = options!.fetchFn!;
    let reader: rpc.EvidenceReader;
    reader = original(env, {
      ...options,
      perSecond: 5,
      maxBackfillRpcRps: 1,
      fetchFn: async (input, init) => {
        if (reader.meter.isBackfill)
          calls.push({ at: Date.now(), purpose: reader.meter.currentPurpose });
        return transport(input, init);
      },
    });
    return reader as ReturnType<typeof rpc.createChainReader>;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const work = runRecorder(opts);
    await vi.runAllTimersAsync();
    expect(await work).toBe(0);
    expect(calls.some((x) => x.purpose === 'minute-boundary')).toBe(true);
    expect(calls.some((x) => x.purpose === 'warmup-anchor')).toBe(true);
    for (let i = 1; i < calls.length; i++)
      expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('a no-alert round measures computation without fabricating an outbox or delivery timestamp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-empty-delivery-'));
  const opts = setup(dir);
  vi.spyOn(AlertOutbox.prototype, 'deliverPending').mockResolvedValue({ sent: 0, failed: 0 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await runRecorder(opts)).toBe(0);
    const result = manifest(opts);
    expect(result.telemetry.batchTimings[0].deliveredAtMs).toBeNull();
    expect(result.telemetry.report.latency.totalDeliveryMs.sampleSize).toBe(0);
    // Delivery is asynchronous now: the batch reports when its computation landed, never a sink
    // completion it did not wait for.
    expect(result.telemetry.batchTimings[0].computationMs).toBeGreaterThanOrEqual(0);
    expect(result.telemetry.report.latency.localProcessingMs.sampleSize).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('delivery failures recover after subsequent real successful sink delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-delivery-recovery-'));
  const opts = setup(dir);
  const original = AlertOutbox.prototype.deliverPending;
  let inserted = false;
  const sink = vi
    .fn()
    .mockRejectedValueOnce(new Error('fixture sink unavailable'))
    .mockResolvedValue(undefined);
  vi.spyOn(localConsole, 'createConsoleSink').mockReturnValue(sink);
  vi.spyOn(AlertOutbox.prototype, 'deliverPending').mockImplementation(function (
    this: AlertOutbox,
    target,
    scope,
    kind,
  ) {
    if (!inserted) {
      inserted = true;
      this.enqueue(
        scope!,
        { id: 'recovery-fixture', revision: 1, kind: 'retracted' } as AlertRecord,
        'live',
      );
    }
    return original.call(this, target, scope, kind);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await runRecorder(opts)).toBe(0);
    const result = manifest(opts);
    expect(result.alertDelivery).toMatchObject({ failed: 1, status: 'ok' });
    expect(result.alertDelivery.sent).toBeGreaterThan(0);
    // Delivery is decoupled from the batch: the batch's own timing carries no sink timestamp, and
    // the delivery health that recovered is the run-level summary.
    expect(result.telemetry.batchTimings[0].deliveredAtMs).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('natural duration stops new batches while an in-progress acquisition drains within bounded grace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-duration-drain-'));
  const opts = setup(dir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await runRecorder(opts)).toBe(0);
    opts.outputDirectory = join(dir, 'drain-runs');
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const original = rpc.createChainReader;
    vi.spyOn(rpc, 'createChainReader').mockImplementation((env, options) => {
      const transport = options!.fetchFn!;
      return original(env, {
        ...options,
        fetchFn: async (input, init) => {
          if (JSON.parse(String(init?.body)).method === 'eth_getLogs')
            await new Promise((resolve) => setTimeout(resolve, 1100));
          return transport(input, init);
        },
      });
    });
    const work = runRecorder(opts);
    await vi.runAllTimersAsync();
    expect(await work).toBe(0);
    const result = manifest(opts);
    expect(result.counts.operationBatches).toBe(1);
    expect(result.finishedAtMs).toBeGreaterThan(result.startedAtMs + 1000);
    expect(result.stopReason).toBe('duration');
    expect(result.rpcDrainDeadlineMs - result.stopAtMs).toBe(30000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
