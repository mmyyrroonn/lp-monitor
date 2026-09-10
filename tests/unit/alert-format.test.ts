import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { createConsoleSink } from '../../src/notify/console.js';
import { formatAlert, formatObservedLiquidity } from '../../src/notify/format.js';
import { createJsonlSink } from '../../src/notify/jsonl.js';
import type { AggregateMetric, MinuteMetric } from '../../src/metrics/windows.js';
import type { AlertRecord } from '../../src/signals/types.js';

const HASH = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const ADDRESS = '0x0000000000000000000000000000000000000010' as Address;

function metric(usdMicros: bigint | null, status: 'closed' | 'partial' = 'closed'): MinuteMetric {
  return {
    minuteStartSec: 1_788_839_040,
    status,
    fromBlock: 120n,
    toBlock: 130n,
    reasons: [],
    usdMicros,
    usdgNotionalRaw: usdMicros,
    rawNotional: null,
    swapCount: usdMicros === null ? null : 200,
    txCount: usdMicros === null ? null : 180,
    addCount: usdMicros === null ? null : 5,
    removeCount: usdMicros === null ? null : 2,
    zeroDeltaCount: 0,
    activeMinutes: 1,
    baselineSampleCount: 60,
    baselineMedian: usdMicros === null ? null : 10_000_000_000n,
    baselineMedianNumerator: usdMicros === null ? null : 10_000_000_000n,
    baselineMedianDenominator: usdMicros === null ? null : 1n,
    baselineUnit: usdMicros === null ? null : 'usdMicros',
    volumeMultiplier: usdMicros === null ? null : 12,
  };
}

function aggregateMetric(
  usdMicros: bigint,
  startSec = 1_788_838_740,
  endSec = 1_788_839_040,
): AggregateMetric {
  return {
    ...metric(usdMicros),
    startSec,
    endSec,
    status: 'closed',
    swapCount: 200,
    txCount: 180,
    addCount: 5,
    removeCount: 2,
    zeroDeltaCount: 0,
    activeMinutes: 5,
  };
}
function alert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  const partial = metric(25_000_000_000n, 'partial');
  const recent5m = aggregateMetric(120_000_000_000n);
  const natural5m = aggregateMetric(120_000_000_000n, 1_788_838_800, 1_788_839_100);
  return {
    id: 'alert-1',
    revision: 2,
    status: 'provisional',
    kind: 'hot',
    pool: { chainId: 4663, protocol: 'v3', address: ADDRESS },
    poolId: '4663:v3:0x10',
    ruleVersion: 'p4-v1',
    episodeId: 'episode-1',
    atBatchId: 'batch-1',
    observedAtMs: 1_788_839_058_000,
    endAnchor: { number: 9_876_543n, hash: HASH('a'), timestampSec: 1_788_839_058 },
    watermarkSec: 1_788_839_040,
    reasons: ['closed-5m-threshold'],
    metrics: {
      pool: { chainId: 4663, protocol: 'v3', address: ADDRESS },
      poolId: '4663:v3:0x10',
      minutes: [partial],
      natural5mBuckets: [natural5m],
      partialCurrent: partial,
      recentClosed1m: metric(20_000_000_000n),
      recentClosed5x1m: recent5m,
      naturalClosed5m: natural5m,
      unknownTimeBlockCounts: [],
    },
    coverage: 'complete',
    baseline: {
      minute: {
        sampleCount: 60,
        median: 10_000_000_000n,
        medianNumerator: 10_000_000_000n,
        medianDenominator: 1n,
        multiplier: 12,
        status: 'ready',
        unit: 'usdMicros',
      },
      fiveMinute: {
        sampleCount: 12,
        median: 10_000_000_000n,
        medianNumerator: 10_000_000_000n,
        medianDenominator: 1n,
        multiplier: 12,
        status: 'ready',
        unit: 'usdMicros',
      },
    },
    presentation: {
      rwaSymbol: 'AMC',
      pairLabel: 'AMC / USDG',
      associatedTokens: ['MEME'],
      evidenceTxs: [HASH('b')],
      liquidityNote: '观察到加减流动性动作；L变化不代表已提款',
    },
    ...overrides,
  };
}

test('formats a real hot alert with minute precision, evidence, and provisional caveats', () => {
  const text = formatAlert(alert());

  expect(text).toContain('AMC / USDG — 热度确认（暂未最终确认）');
  expect(text).toContain('最近5m：120,000 USDG');
  expect(text).toContain('过去基线：10,000 USDG；12倍');
  expect(text).toContain('本分钟累计：25,000 USDG（仍在更新）');
  expect(text).toContain('Swap：200次；不同tx：180笔；加池动作5次、减池动作2次');
  expect(text).toContain('时间：分钟归桶');
  expect(text).toContain('关联代币：MEME（同交易共现，尚未证实完整路由）');
  expect(text).toContain('完整至区块9,876,543');
  expect(text).toContain(HASH('b'));
  expect(text).toContain('告警：alert-1/revision 2');
  expect(text).toContain('L变化不代表已提款');
});

test.each([
  ['candidate', '候选观察'],
  ['hot', '热度确认'],
  ['reheat', '再次升温'],
  ['cooling', '热度降温'],
  ['liquidity-watch', '流动性观察'],
  ['retracted', '提醒撤回'],
] as const)('formats %s records as %s while retaining provisional wording', (kind, label) => {
  const record = alert(kind === 'retracted' ? { kind, status: 'retracted' } : { kind });
  const text = formatAlert(record);
  expect(text).toContain(label);
  expect(text).toContain('暂未最终确认');
});
test('renders unavailable metrics as unknown and never invents zero', () => {
  const unknown = metric(null, 'partial');
  const text = formatAlert(
    alert({
      coverage: 'gap',
      metrics: {
        ...alert().metrics,
        partialCurrent: unknown,
        recentClosed5x1m: null,
        naturalClosed5m: null,
      },
      presentation: { rwaSymbol: 'AMC' },
    }),
  );

  expect(text).toContain('unknown');
  expect(text).not.toContain('最近5m：0');
  expect(text).not.toContain('Swap：0');
});

test('console sink writes the human-readable revision', async () => {
  const log = vi.fn();
  await createConsoleSink(log)(alert());
  expect(log).toHaveBeenCalledOnce();
  expect(log.mock.calls[0]?.[0]).toContain('alert-1/revision 2');
});

test('JSONL sink appends one lossless line per delivery for consumer id/revision dedupe', async () => {
  const path = join(tmpdir(), `lp-monitor-alert-${process.pid}-${Date.now()}.jsonl`);
  try {
    const sink = createJsonlSink(path);
    await sink(alert());
    await sink(alert({ revision: 3, endAnchor: { ...alert().endAnchor, number: 9_876_544n } }));

    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 'alert-1', revision: 2 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 'alert-1', revision: 3 });
    expect(JSON.parse(lines[0]!).endAnchor.number).toBe('9876543');
    expect(lines[0]).not.toMatch(/\d+n/);
  } finally {
    await rm(path, { force: true });
  }
});

test('recent rolling and natural confirmation baselines are not mixed', () => {
  const base = alert();
  const recent = {
    ...base.metrics.recentClosed5x1m!,
    usdMicros: 300_000_000_000n,
    baselineMedian: 100_000_000_000n,
    baselineUnit: 'usdMicros',
    volumeMultiplier: 3,
  };
  const natural = { ...base.metrics.naturalClosed5m!, usdMicros: 100_000_000_000n };
  const text = formatAlert({
    ...base,
    metrics: { ...base.metrics, recentClosed5x1m: recent, naturalClosed5m: natural },
    baseline: {
      ...base.baseline,
      fiveMinute: {
        ...base.baseline.fiveMinute,
        median: 10_000_000_000n,
        unit: 'usdMicros',
        multiplier: 10,
      },
      minute: {
        ...base.baseline.minute,
        median: null,
        medianNumerator: null,
        medianDenominator: null,
        unit: null,
        multiplier: null,
        status: 'unpriced',
      },
    },
  });
  expect(text).toContain('最近5m：300,000 USDG；过去基线：100,000 USDG；3倍');
  expect(text).toContain('自然完整5m：100,000 USDG；过去基线：10,000 USDG；10倍');
});
test('candidate without closed history still prints known current-minute counts', () => {
  const base = alert();
  const text = formatAlert({
    ...base,
    kind: 'candidate',
    metrics: { ...base.metrics, recentClosed5x1m: null, naturalClosed5m: null },
  });
  expect(text).toContain('本分钟次数：Swap：200次；不同tx：180笔');
});

test('natural confirmation counts are labeled separately from recent rolling counts', () => {
  const base = alert();
  const natural = { ...base.metrics.naturalClosed5m!, swapCount: 50, txCount: 45 };
  expect(
    formatAlert({ ...base, metrics: { ...base.metrics, naturalClosed5m: natural } }),
  ).toContain('自然5m次数：Swap：50次；不同tx：45笔');
});

test('renders exact half-micro rational baselines instead of unknown', () => {
  const base = alert();
  const text = formatAlert({
    ...base,
    baseline: {
      ...base.baseline,
      fiveMinute: {
        sampleCount: 12,
        median: null,
        medianNumerator: 20_000_000_013n,
        medianDenominator: 2n,
        unit: 'usdMicros',
        multiplier: 29.999999,
        status: 'ready',
      },
    },
  });
  expect(text).toContain('过去基线：10,000.0000065 USDG；29.999999倍');
});

test.each([
  [-500_000n, '-0.5 USDG'],
  [-1_500_000n, '-1.5 USDG'],
] as const)('formats signed USDG micros %s as %s', (value, expected) => {
  const base = alert();
  const text = formatAlert({
    ...base,
    metrics: {
      ...base.metrics,
      partialCurrent: { ...metric(value, 'partial'), usdMicros: value },
    },
  });
  expect(text).toContain(`本分钟累计：${expected}`);
});

test('formats observed Swap liquidity as a readable caution rather than JSON', () => {
  const note = formatObservedLiquidity({
    liquidityRaw: 987_654_321n,
    tick: 42,
    observedAt: {
      blockNumber: 120n,
      blockHash: HASH('c'),
      transactionHash: HASH('d'),
      transactionIndex: 1,
      logIndex: 2,
    },
    anchor: { number: 130n, hash: HASH('e'), timestampSec: 1_788_839_058 },
    ageSecInterval: { min: 15, max: 74 },
    freshness: 'before-last-liquidity-action',
    interpretation:
      'L is from the last Swap before a later liquidity action; it is not proof of a withdrawal or current L.',
  });
  expect(note).toContain('L=987,654,321');
  expect(note).toContain('tick=42');
  expect(note).toContain('区块120');
  expect(note).toContain('15–74秒');
  expect(note).toContain('不代表提款');
  expect(note).not.toContain('{');
});

test('labels delayed historical alerts with their logical evaluated bucket time and keeps gaps', () => {
  const text = formatAlert(
    alert({
      historical: true,
      logicalTimeSec: 1_788_838_800,
      coverage: 'gap',
    }),
  );
  expect(text).toContain('评估桶时间：2026-09-08T03:40Z（历史补评）');
  expect(text).toContain('到达时间：2026-09-08T03:44:18.000Z');
  expect(text).toContain('覆盖状态：gap；缺失数据按unknown展示');
});
