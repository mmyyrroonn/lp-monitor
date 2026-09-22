import { describe, expect, it } from 'vitest';
import { aggregateHeatBlocks } from '../../src/dashboard/web/view-model.js';
import type { TokenMinute } from '../../src/dashboard/types.js';

const minutes = (): TokenMinute[] =>
  Array.from({ length: 10 }, (_, i) => ({
    minuteStartSec: i * 60,
    status: 'closed',
    txCount: 1,
    swapCount: 1,
    usdMicros: '1000000',
    reasons: [],
  }));

describe('heat block coverage', () => {
  it.each([1, 9])('keeps %i/10 observed minutes incomplete with a missing reason', (count) => {
    const series = minutes().slice(0, count);
    const block = aggregateHeatBlocks(series, [0], 600)[0];
    expect(block).toMatchObject({
      status: 'partial',
      closedMinutes: count,
      expectedMinutes: 10,
      missingMinutes: 10 - count,
      txCount: count,
      inProgress: false,
    });
    expect(block?.reasons).toContain('missing-minute');
  });
  it('does not let later closed minutes overwrite a middle gap or partial', () => {
    for (const status of ['gap', 'warming', 'partial'] as const) {
      const series = minutes();
      series[4] = { ...series[4]!, status, txCount: null, usdMicros: null };
      const block = aggregateHeatBlocks(series, [0], 600)[0];
      expect(block).toMatchObject({ status: 'partial', closedMinutes: 9, txCount: 9 });
      expect(block?.reasons.length).toBeGreaterThan(0);
      expect(aggregateHeatBlocks([...series].reverse(), [0], 600)[0]).toEqual(block);
    }
  });
  it('only closes all ten complete minutes including a quiet complete block', () => {
    expect(aggregateHeatBlocks(minutes(), [0], 600)[0]).toMatchObject({
      status: 'closed',
      closedMinutes: 10,
      missingMinutes: 0,
    });
    expect(
      aggregateHeatBlocks(
        minutes().map((m) => ({ ...m, txCount: 0, usdMicros: '0' })),
        [0],
        600,
      )[0],
    ).toMatchObject({ status: 'closed', txCount: 0, usdMicros: 0n });
  });
  it('does not report an entirely unavailable block as a priced zero', () => {
    expect(aggregateHeatBlocks([], [0], 600)[0]).toMatchObject({
      status: 'gap',
      usdMicros: null,
      missingMinutes: 10,
    });
  });
  it('separates elapsed gaps from the running minute and future minutes', () => {
    const series = minutes().slice(0, 3);
    const current = aggregateHeatBlocks(series, [0], 600, 200)[0];
    expect(current).toMatchObject({
      status: 'partial',
      closedMinutes: 3,
      partialMinutes: 1,
      futureMinutes: 6,
      missingMinutes: 0,
      inProgress: true,
    });
    expect(current?.reasons).toContain('watermark-partial');
    expect(aggregateHeatBlocks(series.slice(1), [0], 600, 200)[0]).toMatchObject({
      closedMinutes: 2,
      partialMinutes: 1,
      futureMinutes: 6,
      missingMinutes: 1,
      inProgress: true,
    });
    expect(aggregateHeatBlocks(series, [0], 600, 900)[0]).toMatchObject({
      status: 'partial',
      missingMinutes: 7,
      inProgress: false,
    });
  });
  it('excludes partial observations from comparable heat and labels their coverage', async () => {
    const { comparableHeatValue, heatCoverageLabel, heatBlockClass } =
      await import('../../src/dashboard/web/view-model.js');
    const complete = aggregateHeatBlocks(minutes(), [0], 600)[0]!;
    const missing = aggregateHeatBlocks(minutes().slice(0, 9), [0], 600)[0]!;
    const running = aggregateHeatBlocks(minutes().slice(0, 3), [0], 600, 200)[0]!;
    expect(comparableHeatValue(complete, 'count')).toBe(10);
    expect(comparableHeatValue(complete, 'amount')).toBe(10);
    expect(comparableHeatValue(missing, 'count')).toBeNull();
    expect(comparableHeatValue(missing, 'amount')).toBeNull();
    expect(heatBlockClass(missing, 'count', 10)).toBe('gap');
    expect(heatBlockClass(running, 'count', 10)).toBe('partial');
    expect(heatBlockClass(complete, 'count', 10)).toBe('h4');
    expect(heatCoverageLabel(missing)).toContain('历史数据不完整');
    expect(heatCoverageLabel(missing)).toContain('已观测 9 笔');
    expect(heatCoverageLabel(running)).toContain('进行中');
    expect(heatCoverageLabel(running)).not.toContain('历史');
    const mixed = aggregateHeatBlocks(minutes().slice(1, 3), [0], 600, 200)[0]!;
    expect(heatCoverageLabel(mixed)).toContain('已有缺口');
    expect(heatBlockClass(mixed, 'count', 10)).toBe('gap');
    expect(heatBlockClass({ ...complete, usdMicros: null }, 'amount', 10)).toBe('unpriced');
  });
});
