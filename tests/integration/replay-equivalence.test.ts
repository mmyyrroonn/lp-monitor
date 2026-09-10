import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { encodeJson } from '../../src/domain/json.js';
import { batch, hotLogs, metricInput, swap, anchor } from '../helpers/alert-fixture.js';
import { initialSignalConfig } from '../../src/signals/config.js';
import { openDatabase } from '../../src/storage/database.js';
import { commitAcceptedSignalBatch } from '../../src/signals/project.js';
import { buildMetricsReport } from '../../src/storage/metric-store.js';
import { rawLogKey } from '../../src/storage/manifest.js';
import { replay } from '../../src/replay/runner.js';
import {
  replayFixture as fixture,
  replayFixtureDirs as dirs,
  refreshFixtureManifest,
} from '../helpers/replay-fixture.js';
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
test('recorded replay retains batch semantics and live business results without network', async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network forbidden');
  });
  const f = fixture();
  const db = openDatabase(':memory:');
  const alerts = commitAcceptedSignalBatch(db, metricInput, initialSignalConfig, f.raw).alerts;
  const metrics = buildMetricsReport(db, metricInput);
  db.close();
  const one = await replay(
    refreshFixtureManifest(f.path),
    initialSignalConfig,
    'recorded-observed',
  );
  expect(one.frames[0]?.metrics).toEqual(metrics);
  expect(one.frames[0]?.alerts).toEqual(alerts);
  expect(one.frames[0]?.observedAtMs).toBe(100000);
  expect(one.integrity.complete).toBe(true);
});
test('minute-close never exposes a later minute and retains minute candidates', async () => {
  const f = fixture();
  const r = await replay(refreshFixtureManifest(f.path), initialSignalConfig, 'minute-close');
  expect(r.frames.length).toBeGreaterThan(60);
  for (const frame of r.frames)
    for (const v of frame.metrics.valuations)
      expect(v.time.minuteStartSec!).toBeLessThan(frame.evaluatedAtSec);
  expect(r.alerts.some((a) => a.kind === 'candidate')).toBe(true);
  expect(r.alerts.every((a) => a.observedAtMs >= a.watermarkSec * 1000)).toBe(true);
});
test('changed rules create immutable distinct experiment directories', async () => {
  const f = fixture();
  const out = join(f.dir, 'out');
  const first = await replay(
    refreshFixtureManifest(f.path),
    initialSignalConfig,
    'recorded-observed',
    {
      outDirectory: out,
    },
  );
  const second = await replay(
    f.path,
    { ...initialSignalConfig, version: 'changed' },
    'recorded-observed',
    { outDirectory: out },
  );
  expect(second.replayRunId).not.toBe(first.replayRunId);
  expect(second.outputDirectory).not.toBe(first.outputDirectory);
});
test('minute-close replays separate discovery evidence only up to each frame anchor', async () => {
  const f = fixture();
  const discovery = { ...f.raw, id: 'discovery', scopeId: 'd', captureMode: 'backfill' };
  const operations = { ...f.raw, poolRegistrations: [] };
  f.manifest.discoveryScope = 'd';
  f.manifest.batches = [
    { id: 'discovery', scopeId: 'd', accepted: true },
    { id: 'one', scopeId: 's', accepted: true },
  ];
  writeFileSync(join(f.dir, 'discovery-discovery.json'), encodeJson(discovery));
  writeFileSync(join(f.dir, 'range-one.json'), encodeJson(operations));
  writeFileSync(f.path, JSON.stringify(f.manifest));
  const r = await replay(refreshFixtureManifest(f.path), initialSignalConfig, 'minute-close');
  expect(r.frames[0]?.metrics.windows.length).toBe(1);
  expect(r.alerts.some((a) => a.kind === 'candidate')).toBe(true);
});
test('saved replay manifest is portable and reproduces business content', async () => {
  const f = fixture();
  const r = await replay(refreshFixtureManifest(f.path), initialSignalConfig, 'recorded-observed', {
    outDirectory: join(f.dir, 'out'),
  });
  const copied = await replay(
    join(r.outputDirectory!, 'manifest.json'),
    initialSignalConfig,
    'recorded-observed',
  );
  expect(copied.businessHash).toBe(r.businessHash);
});
test('multiple recorded polls preserve corrections and original observedAt order', async () => {
  const f = fixture();
  const second = { ...f.raw, id: 'second', previous: f.raw.end, observedAtMs: 100100 };
  f.manifest.batches.push({ id: 'second', scopeId: 's', accepted: true });
  writeFileSync(join(f.dir, 'range-second.json'), encodeJson(second));
  writeFileSync(f.path, JSON.stringify(f.manifest));
  const r = await replay(refreshFixtureManifest(f.path), initialSignalConfig, 'recorded-observed');
  expect(r.frames.map((f) => f.observedAtMs)).toEqual([100000, 100100]);
  expect(r.frames[1]!.alerts).toEqual([]);
});
test('evaluation time retains the real boundary witness second instead of rounding backward', async () => {
  const f = fixture();
  delete f.manifest.batches[0]!.sha256;
  writeFileSync(f.path, JSON.stringify(f.manifest));
  writeFileSync(
    join(f.dir, 'range-one.json'),
    encodeJson({
      ...f.raw,
      boundaries: f.raw.boundaries!.map((b) =>
        b.timestampSec === 180 ? { ...b, at: { ...b.at, timestampSec: 181 } } : b,
      ),
    }),
  );
  const r = await replay(refreshFixtureManifest(f.path), initialSignalConfig, 'minute-close');
  expect(r.frames[0]!.evaluatedAtSec).toBe(181);
});
test('historical overlapping polls cannot silently move evaluation clock backward', async () => {
  const f = fixture();
  const second = { ...f.raw, id: 'second', previous: f.raw.end, observedAtMs: 100100 };
  f.manifest.batches.push({ id: 'second', scopeId: 's', accepted: true });
  writeFileSync(join(f.dir, 'range-second.json'), encodeJson(second));
  writeFileSync(f.path, JSON.stringify(f.manifest));
  const r = await replay(refreshFixtureManifest(f.path), initialSignalConfig, 'minute-close');
  expect(r.integrity.issues.map((i) => i.code)).toContain('historical-overlap');
  expect(
    r.frames.every((f, i) => i === 0 || f.evaluatedAtSec > r.frames[i - 1]!.evaluatedAtSec),
  ).toBe(true);
});
test.each([2410, 2400, 85])(
  'contiguous raw ranges split at block %s retain pending minutes and boundary swaps',
  async (split) => {
    const f = fixture();
    const extra = swap(2400);
    const all = {
      ...f.raw,
      logs: [...f.raw.logs, extra],
      logTimes: [
        ...f.raw.logTimes!,
        {
          ref: extra,
          time: {
            minuteStartSec: 2460,
            exactTimestampSec: null,
            source: 'minute-boundary' as const,
          },
        },
      ],
    };
    const parts = [
      { from: 60, to: split, id: 'one' },
      { from: split + 1, to: 4800, id: 'two' },
    ].map((part, index) => {
      const logs = all.logs.filter(
        (l) => l.blockNumber >= BigInt(part.from) && l.blockNumber <= BigInt(part.to),
      );
      return {
        ...all,
        id: part.id,
        fromBlock: BigInt(part.from),
        toBlock: BigInt(part.to),
        end: anchor(part.to),
        previous: index ? anchor(split) : null,
        logs,
        logTimes: all.logTimes.filter(
          (t) => t.ref.blockNumber >= BigInt(part.from) && t.ref.blockNumber <= BigInt(part.to),
        ),
        boundaries: all.boundaries!.filter(
          (b) => b.at.number <= BigInt(part.to) && b.at.number >= BigInt(part.from) - 60n,
        ),
        poolRegistrations: index ? [] : all.poolRegistrations,
        manifest: {
          ...all.manifest,
          shards: all.manifest.shards.map((s) => ({
            ...s,
            request: { ...s.request, fromBlock: BigInt(part.from), toBlock: BigInt(part.to) },
            logKeys: logs.map(rawLogKey),
            logCount: logs.length,
          })),
        },
      };
    });
    f.manifest.batches = parts.map((p) => ({ id: p.id, scopeId: 's', accepted: true }));
    for (const p of parts) writeFileSync(join(f.dir, 'range-' + p.id + '.json'), encodeJson(p));
    writeFileSync(f.path, JSON.stringify(f.manifest));
    const r = await replay(refreshFixtureManifest(f.path), initialSignalConfig, 'minute-close');
    expect(r.status).toBe('complete');
    expect(r.frames.at(-1)!.evaluatedAtSec).toBe(4860);
    expect(r.finalMetrics!.valuations.some((v) => v.eventId === rawLogKey(extra))).toBe(true);
  },
);
test('discovery final boundary registration becomes available after its minute closes', async () => {
  const f = fixture();
  const creation = swap(2400);
  const discovery = {
    ...f.raw,
    id: 'birth',
    scopeId: 'd',
    toBlock: 2400n,
    end: anchor(2400),
    logs: [creation],
    logTimes: [
      {
        ref: creation,
        time: { minuteStartSec: 2460, exactTimestampSec: null, source: 'minute-boundary' },
      },
    ],
    poolRegistrations: [{ ...f.raw.poolRegistrations![0]!, discoveredAt: creation }],
    boundaries: f.raw.boundaries!.filter((b) => b.at.number <= 2400n),
    manifest: {
      ...f.raw.manifest,
      shards: f.raw.manifest.shards.map((s) => ({
        ...s,
        request: { ...s.request, toBlock: 2400n },
        logKeys: [rawLogKey(creation)],
        logCount: 1,
      })),
    },
  };
  const operations = {
    ...f.raw,
    logs: [],
    logTimes: [],
    poolRegistrations: [],
    manifest: {
      ...f.raw.manifest,
      shards: f.raw.manifest.shards.map((s) => ({ ...s, logKeys: [], logCount: 0 })),
    },
  };
  f.manifest.discoveryScope = 'd';
  f.manifest.batches = [
    { id: 'birth', scopeId: 'd', accepted: true },
    { id: 'one', scopeId: 's', accepted: true },
  ];
  writeFileSync(join(f.dir, 'discovery-birth.json'), encodeJson(discovery));
  writeFileSync(join(f.dir, 'range-one.json'), encodeJson(operations));
  writeFileSync(f.path, JSON.stringify(f.manifest));
  const r = await replay(refreshFixtureManifest(f.path), initialSignalConfig, 'minute-close');
  expect(r.status).toBe('complete');
  expect(r.registrations).toHaveLength(1);
  expect(r.frames.find((f) => f.evaluatedAtSec === 2460)!.metrics.windows).toHaveLength(0);
  expect(r.frames.find((f) => f.evaluatedAtSec === 2520)!.metrics.windows).toHaveLength(1);
});
test('final report retains operation and discovery coverage beyond the rolling 180-minute frame', async () => {
  const f = fixture();
  const boundaries = Array.from({ length: 400 }, (_, i) => {
    const timestampSec = 120 + i * 60;
    return {
      timestampSec,
      firstBlock: BigInt(timestampSec - 60),
      before: anchor(timestampSec - 61),
      at: anchor(timestampSec - 60),
    };
  });
  const raw = {
    ...f.raw,
    toBlock: 24000n,
    end: anchor(24000),
    logs: [],
    logTimes: [],
    poolRegistrations: [],
    boundaries,
    manifest: {
      ...f.raw.manifest,
      shards: f.raw.manifest.shards.map((s) => ({
        ...s,
        request: { ...s.request, toBlock: 24000n },
        logKeys: [],
        logCount: 0,
      })),
    },
  };
  f.manifest.discoveryScope = 'd';
  f.manifest.batches = [
    { id: 'discovery', scopeId: 'd', accepted: true },
    { id: 'one', scopeId: 's', accepted: true },
  ];
  writeFileSync(
    join(f.dir, 'discovery-discovery.json'),
    encodeJson({ ...raw, id: 'discovery', scopeId: 'd' }),
  );
  writeFileSync(join(f.dir, 'range-one.json'), encodeJson(raw));
  writeFileSync(f.path, JSON.stringify(f.manifest));
  const r = await replay(refreshFixtureManifest(f.path), initialSignalConfig, 'recorded-observed');
  expect(r.coverage[0]!.minuteStartSec).toBe(120);
  expect(r.discoveryMinutes[0]!.minuteStartSec).toBe(120);
  expect(r.coverage.filter((c) => c.complete)).toHaveLength(399);
  expect(r.frames[0]!.metrics.coverage.length).toBeLessThan(r.coverage.length);
});
