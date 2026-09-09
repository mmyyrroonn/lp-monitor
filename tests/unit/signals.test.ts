import { describe, expect, it } from 'vitest';
import { evaluateSignal, initialSignalSnapshot } from '../../src/signals/engine.js';
import { initialSignalConfig, parseSignalConfig } from '../../src/signals/config.js';
import type { SignalInput } from '../../src/signals/types.js';
import type { AggregateMetric, MinuteMetric } from '../../src/metrics/windows.js';
const pool = { chainId: 4663, protocol: 'v3', address: `0x${'1'.repeat(40)}` } as const;
const fields = {
  usdgNotionalRaw: null,
  rawNotional: null,
  swapCount: 10,
  txCount: 9,
  addCount: 0,
  removeCount: 0,
  zeroDeltaCount: 0,
  activeMinutes: 1,
  baselineSampleCount: 0,
  baselineMedian: null,
  baselineMedianNumerator: null,
  baselineMedianDenominator: null,
  baselineUnit: null,
  volumeMultiplier: null,
};
function bucket(startSec: number, usd: number): AggregateMetric {
  return {
    ...fields,
    startSec,
    endSec: startSec + 300,
    status: 'closed',
    usdMicros: BigInt(usd) * 1_000_000n,
  };
}
function input(now: number, five: AggregateMetric[], minuteUsd = 0): SignalInput {
  const partial: MinuteMetric = {
    ...fields,
    minuteStartSec: Math.floor(now / 60) * 60,
    status: 'partial',
    fromBlock: 1n,
    toBlock: 2n,
    reasons: [],
    usdMicros: BigInt(minuteUsd) * 1_000_000n,
  };
  return {
    pool,
    batchId: `b${now}`,
    observedAtMs: now * 1000,
    endAnchor: { number: BigInt(now), hash: `0x${'2'.repeat(64)}`, timestampSec: now },
    watermarkSec: now,
    coverage: 'complete',
    metrics: {
      pool,
      poolId: 'pool',
      minutes: [partial],
      partialCurrent: partial,
      natural5mBuckets: five,
      naturalClosed5m: five.at(-1) ?? null,
      recentClosed1m: null,
      recentClosed5x1m: null,
      unknownTimeBlockCounts: [],
    },
  };
}
const history = Array.from({ length: 12 }, (_, i) => bucket(i * 300, 10000));
describe('signals', () => {
  it('absolute warming candidate and deterministic draft', () => {
    const x = input(3601, [], 25000);
    const a = evaluateSignal(initialSignalSnapshot(), x, initialSignalConfig);
    expect(a.alertDraft?.kind).toBe('candidate');
    expect(a.alertDraft?.reasons).toContain('warming/absolute-only');
    expect(evaluateSignal(initialSignalSnapshot(), x, initialSignalConfig)).toEqual(a);
  });
  it('hot, suppress same bucket, upgrade, cooling and reheat sequence', () => {
    let x = input(3900, [...history, bucket(3600, 120000)]);
    let d = evaluateSignal(initialSignalSnapshot(), x, initialSignalConfig);
    expect(d.alertDraft?.kind).toBe('hot');
    d = evaluateSignal(d.nextSnapshot, { ...x, watermarkSec: 4020 }, initialSignalConfig);
    expect(d.alertDraft).toBeNull();
    x = input(4200, [...x.metrics.natural5mBuckets, bucket(3900, 300000)]);
    d = evaluateSignal(d.nextSnapshot, x, initialSignalConfig);
    expect(d.alertDraft?.reasons).toContain('upgrade');
    for (let s = 4200; s <= 4800; s += 300) {
      x = input(s + 300, [...x.metrics.natural5mBuckets, bucket(s, 10000)]);
      d = evaluateSignal(d.nextSnapshot, x, initialSignalConfig);
    }
    expect(d.alertDraft?.kind).toBe('cooling');
    x = input(5400, [...x.metrics.natural5mBuckets, bucket(5100, 120000)]);
    d = evaluateSignal(d.nextSnapshot, x, initialSignalConfig);
    expect(d.alertDraft?.kind).toBe('reheat');
  });
  it('records separate confirmation outcomes and requires consecutive natural buckets', () => {
    const d = evaluateSignal(
      initialSignalSnapshot(),
      input(4200, [bucket(3600, 50000), bucket(3900, 50000)]),
      initialSignalConfig,
    );
    expect(d.matches.find((m) => m.ruleId === 'confirmConsecutive')?.matched).toBe(true);
    expect(d.matches.find((m) => m.ruleId === 'confirmRelative')?.matched).toBe(false);
    expect(
      evaluateSignal(
        initialSignalSnapshot(),
        input(4500, [bucket(3600, 50000), bucket(4200, 50000)]),
        initialSignalConfig,
      ).alertDraft,
    ).toBeNull();
  });
  it('gaps never cool and gaps break consecutive low sequence', () => {
    const hot = evaluateSignal(
      initialSignalSnapshot(),
      input(3900, [...history, bucket(3600, 120000)]),
      initialSignalConfig,
    );
    const gap = evaluateSignal(
      hot.nextSnapshot,
      { ...input(4800, []), coverage: 'gap' },
      initialSignalConfig,
    );
    expect(gap.nextSnapshot.state).toBe('hot');
    expect(gap.alertDraft).toBeNull();
    const d = evaluateSignal(
      gap.nextSnapshot,
      input(5400, [bucket(4200, 1), bucket(4800, 1), bucket(5100, 1)]),
      initialSignalConfig,
    );
    expect(d.nextSnapshot.state).toBe('hot');
  });
  it('never applies dollar thresholds to raw units', () => {
    const x = input(3601, [], 25000);
    x.metrics.partialCurrent!.usdMicros;
    const m = {
      ...x.metrics.partialCurrent!,
      usdMicros: null,
      rawNotional: { token: 'MEME', raw: 10n ** 30n },
    };
    expect(
      evaluateSignal(
        initialSignalSnapshot(),
        { ...x, metrics: { ...x.metrics, partialCurrent: m, minutes: [m] } },
        initialSignalConfig,
      ).alertDraft,
    ).toBeNull();
  });
  it('rejects sinks and invalid thresholds', () => {
    expect(() =>
      parseSignalConfig({ ...initialSignalConfig, sink: 'https://example.com' }),
    ).toThrow();
    expect(() =>
      parseSignalConfig({
        ...initialSignalConfig,
        candidate: { ...initialSignalConfig.candidate, threshold: '-1' },
      }),
    ).toThrow();
  });
});
import { readFileSync } from 'node:fs';
it('keeps cooling episode through partial candidate until confirmed reheat', () => {
  let d = evaluateSignal(
    initialSignalSnapshot(),
    input(3900, [...history, bucket(3600, 120000)]),
    initialSignalConfig,
  );
  d = evaluateSignal(
    d.nextSnapshot,
    input(4800, [bucket(3900, 1), bucket(4200, 1), bucket(4500, 1)]),
    initialSignalConfig,
  );
  expect(d.nextSnapshot.state).toBe('cooling');
  d = evaluateSignal(d.nextSnapshot, input(4801, [], 25000), initialSignalConfig);
  expect(d.nextSnapshot.state).toBe('cooling');
  const hot = evaluateSignal(
    d.nextSnapshot,
    input(5400, [...history, bucket(5100, 120000)]),
    initialSignalConfig,
  );
  expect(hot.alertDraft?.kind).toBe('reheat');
});
it('does not emit a stale last closed bucket after an unresolved interval', () => {
  const d = evaluateSignal(
    initialSignalSnapshot(),
    input(5100, [...history, bucket(3600, 120000)]),
    initialSignalConfig,
  );
  expect(d.alertDraft).toBeNull();
});
it('stable hot identity across upgrade revisions and epoch resets separate IDs', () => {
  const a = input(3900, [...history, bucket(3600, 120000)]);
  const first = evaluateSignal(initialSignalSnapshot(), a, initialSignalConfig);
  const next = evaluateSignal(
    first.nextSnapshot,
    input(4200, [...a.metrics.natural5mBuckets, bucket(3900, 300000)]),
    initialSignalConfig,
  );
  expect(next.alertDraft?.id).toBe(first.alertDraft?.id);
  expect(
    evaluateSignal(initialSignalSnapshot(), { ...a, epoch: 'repaired' }, initialSignalConfig)
      .alertDraft?.id,
  ).not.toBe(first.alertDraft?.id);
});
it('ships matching strict initial JSON and config changes reset state', () => {
  expect(
    parseSignalConfig(JSON.parse(readFileSync('config/signals.initial.json', 'utf8'))),
  ).toEqual(initialSignalConfig);
  const x = input(3601, [], 25000);
  const first = evaluateSignal(initialSignalSnapshot(), x, initialSignalConfig);
  const changed = {
    ...initialSignalConfig,
    candidate: { ...initialSignalConfig.candidate, threshold: '30000000000' },
  };
  expect(evaluateSignal(first.nextSnapshot, x, changed).nextSnapshot.state).toBe('watch');
});
it('suppresses repeated candidate drafts while preserving cooling state', () => {
  const x = input(4801, [], 25000);
  const first = evaluateSignal(
    { ...initialSignalSnapshot(), state: 'cooling', episodeId: 'prior' },
    x,
    initialSignalConfig,
  );
  expect(first.alertDraft?.kind).toBe('candidate');
  expect(
    evaluateSignal(
      first.nextSnapshot,
      { ...x, batchId: 'again', watermarkSec: 4803 },
      initialSignalConfig,
    ).alertDraft,
  ).toBeNull();
});
it('compares candidate micro thresholds exactly and refuses insufficient relative strength', () => {
  const x = input(3601, [], 25000);
  const m = {
    ...x.metrics.partialCurrent!,
    usdMicros: BigInt(initialSignalConfig.candidate.threshold) - 1n,
  };
  expect(
    evaluateSignal(
      initialSignalSnapshot(),
      { ...x, metrics: { ...x.metrics, partialCurrent: m } },
      initialSignalConfig,
    ).alertDraft,
  ).toBeNull();
  const minutes = Array.from({ length: 60 }, (_, i) => ({
    ...m,
    minuteStartSec: i * 60,
    status: 'closed' as const,
    usdMicros: 10000n * 1_000_000n,
  }));
  expect(
    evaluateSignal(
      initialSignalSnapshot(),
      { ...x, metrics: { ...x.metrics, minutes } },
      initialSignalConfig,
    ).alertDraft,
  ).toBeNull();
});
it('disabled rules cannot trigger, same level can revise after cooldown', () => {
  const x = input(3601, [], 25000);
  expect(
    evaluateSignal(initialSignalSnapshot(), x, {
      ...initialSignalConfig,
      candidate: { ...initialSignalConfig.candidate, enabled: false },
    }).alertDraft,
  ).toBeNull();
  const a = input(3900, [...history, bucket(3600, 120000)]);
  const first = evaluateSignal(initialSignalSnapshot(), a, initialSignalConfig);
  const second = evaluateSignal(
    first.nextSnapshot,
    input(4200, [...a.metrics.natural5mBuckets, bucket(3900, 120000)]),
    initialSignalConfig,
  );
  expect(second.alertDraft?.id).toBe(first.alertDraft?.id);
  expect(second.alertDraft?.reasons).not.toContain('upgrade');
});
it('rejects hidden nested channel configuration and URL versions', () => {
  expect(() =>
    parseSignalConfig({
      ...initialSignalConfig,
      candidate: { ...initialSignalConfig.candidate, webhook: 'https://example.com' },
    }),
  ).toThrow();
  expect(() =>
    parseSignalConfig({ ...initialSignalConfig, version: 'https://example.com' }),
  ).toThrow();
});
it('keeps original episode entry threshold when another confirmation rule later matches', () => {
  let x = input(3900, [...history, bucket(3600, 120000)]);
  let d = evaluateSignal(initialSignalSnapshot(), x, initialSignalConfig);
  x = input(4200, [...x.metrics.natural5mBuckets, bucket(3900, 50000)]);
  d = evaluateSignal(d.nextSnapshot, x, initialSignalConfig);
  expect(d.nextSnapshot.entryThreshold).toBe(100000n * 1_000_000n);
});
it('upgrades an already-hot pool after one low bucket without confirmation', () => {
  const highHistory = Array.from({ length: 12 }, (_, i) => bucket(i * 300, 100000));
  const entered = [...highHistory, bucket(3600, 50000), bucket(3900, 50000)];
  const hot = evaluateSignal(initialSignalSnapshot(), input(4200, entered), initialSignalConfig);
  expect(hot.alertDraft?.reasons).toEqual(['confirmConsecutive']);
  const low = evaluateSignal(
    hot.nextSnapshot,
    input(4500, [...entered, bucket(4200, 1000)]),
    initialSignalConfig,
  );
  expect(low.alertDraft).toBeNull();
  expect(low.nextSnapshot.state).toBe('hot');
  expect(low.nextSnapshot.lowBuckets).toBe(1);
  const next = input(4800, [...entered, bucket(4200, 1000), bucket(4500, 100000)]);
  const upgraded = evaluateSignal(low.nextSnapshot, next, initialSignalConfig);
  expect(
    upgraded.matches.filter((m) => m.ruleId.startsWith('confirm')).map((m) => m.matched),
  ).toEqual([false, false]);
  expect(upgraded.alertDraft?.kind).toBe('hot');
  expect(upgraded.alertDraft?.reasons).toEqual(['upgrade']);
  expect(upgraded.alertDraft?.id).toBe(hot.alertDraft?.id);
  expect(upgraded.nextSnapshot.episodeId).toBe(hot.nextSnapshot.episodeId);
  expect(upgraded.nextSnapshot.entryThreshold).toBe(50000n * 1_000_000n);
  expect(upgraded.nextSnapshot.lastAlertVolume).toBe(100000n * 1_000_000n);
  expect(upgraded.nextSnapshot.lowBuckets).toBe(0);
  expect(evaluateSignal(upgraded.nextSnapshot, next, initialSignalConfig).alertDraft).toBeNull();
  for (const coverage of ['gap', 'rechecking'] as const) {
    expect(
      evaluateSignal(low.nextSnapshot, { ...next, coverage }, initialSignalConfig).alertDraft,
    ).toBeNull();
  }
  expect(
    evaluateSignal(low.nextSnapshot, { ...next, watermarkSec: 5100 }, initialSignalConfig)
      .alertDraft,
  ).toBeNull();
  expect(
    evaluateSignal({ ...low.nextSnapshot, lastAlertScale: '1m' }, next, initialSignalConfig)
      .alertDraft,
  ).toBeNull();
  const disabled = {
    ...initialSignalConfig,
    upgrade: { ...initialSignalConfig.upgrade, enabled: false },
  };
  expect(
    evaluateSignal({ ...low.nextSnapshot, configVersion: null }, next, disabled).alertDraft,
  ).toBeNull();
  const incomplete = input(4800, [
    ...entered,
    bucket(4200, 1000),
    { ...bucket(4500, 100000), endSec: 4790 },
  ]);
  expect(evaluateSignal(low.nextSnapshot, incomplete, initialSignalConfig).alertDraft).toBeNull();
  const unpriced = input(4800, [
    ...entered,
    bucket(4200, 1000),
    {
      ...bucket(4500, 100000),
      usdMicros: null,
      rawNotional: { token: 'MEME', raw: 10n ** 30n },
    },
  ]);
  expect(evaluateSignal(low.nextSnapshot, unpriced, initialSignalConfig).alertDraft).toBeNull();
});
it('upgrades after ten seconds while the same-level cooldown remains active', () => {
  const firstInput = input(4190, [...history, bucket(3600, 120000)]);
  const first = evaluateSignal(initialSignalSnapshot(), firstInput, initialSignalConfig);
  expect(first.alertDraft?.kind).toBe('hot');
  expect(first.nextSnapshot.lastAlertSec).toBe(4190);
  const normal = evaluateSignal(
    first.nextSnapshot,
    input(4200, [...firstInput.metrics.natural5mBuckets, bucket(3900, 120000)]),
    initialSignalConfig,
  );
  expect(normal.alertDraft).toBeNull();
  const upgraded = evaluateSignal(
    first.nextSnapshot,
    input(4200, [...firstInput.metrics.natural5mBuckets, bucket(3900, 240000)]),
    initialSignalConfig,
  );
  expect(upgraded.alertDraft?.kind).toBe('hot');
  expect(upgraded.alertDraft?.reasons).toContain('upgrade');
  expect(upgraded.alertDraft?.id).toBe(first.alertDraft?.id);
  expect(upgraded.nextSnapshot.lastAlertSec).toBe(4200);
});
