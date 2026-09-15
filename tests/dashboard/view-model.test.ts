import { describe, expect, it } from 'vitest';
import {
  classifyHeat,
  compareHeat,
  heatIntensity,
  formatMicros,
  favoriteKey,
} from '../../src/dashboard/web/view-model.js';

const minute = (txCount: number | null) => ({
  txCount,
  status: txCount === null ? 'gap' : 'closed',
});
const input = (
  current: number | null,
  previous: number | null,
  minutes = [minute(2), minute(3), minute(2), minute(3), minute(2)],
) => ({ current, previous, minutes });
describe('dashboard heat interpretation', () => {
  it('preserves unknown comparisons and never makes gaps quiet', () => {
    expect(classifyHeat(input(null, 10)).kind).toBe('unknown');
    expect(classifyHeat(input(30, null)).changePercent).toBeNull();
    expect(classifyHeat(input(30, null)).kind).toBe('unknown');
    expect(heatIntensity(null, 10)).toBeNull();
    expect(heatIntensity(0, 10)).toBe(0);
  });
  it('labels zero baselines without infinite percentages or trivial spikes', () => {
    expect(classifyHeat(input(3, 0))).toMatchObject({ kind: 'new', changePercent: null, delta: 3 });
    expect(classifyHeat(input(3, 1)).kind).not.toBe('warming');
    expect(classifyHeat(input(30, 10))).toMatchObject({
      kind: 'warming',
      changePercent: 200,
      delta: 20,
    });
  });
  it('requires sufficient activity and complete consecutive minutes for sustained heat', () => {
    expect(classifyHeat(input(50, 45)).kind).toBe('sustained');
    expect(
      classifyHeat(input(50, 45, [minute(null), minute(3), minute(4), minute(5), minute(6)])).kind,
    ).toBe('active');
    expect(classifyHeat(input(3, 3)).kind).toBe('active');
    expect(classifyHeat(input(10, 50)).kind).toBe('cooling');
    expect(classifyHeat(input(0, 0)).kind).toBe('quiet');
  });
  it('ranks meaningful absolute growth before small percent changes and keeps unknown last', () => {
    const values = [input(null, null), input(20, 1), input(100, 50), input(0, 0)];
    values.sort((a, b) => compareHeat(a, b, 'warming'));
    expect(values.map((v) => v.current)).toEqual([100, 20, 0, null]);
  });
  it('formats large integer amounts without IEEE754 coercion', () => {
    expect(formatMicros(null)).toBe('—');
    expect(formatMicros('0')).toBe('0.00');
    expect(formatMicros('1234567')).toBe('1.23');
    expect(formatMicros('1234567890123456789012345')).toBe('1,234,567,890,123,456,789.01');
  });
  it('bounds heat intensity and namespaces browser favorites', () => {
    expect(heatIntensity(15, 10)).toBe(1);
    expect(heatIntensity(0, 0)).toBe(0);
    expect(favoriteKey(4663, 'scope-a')).not.toBe(favoriteKey(4663, 'scope-b'));
  });
});

it('includes the selected complete minute at xx:xx:59, while live partial minute is excluded', async () => {
  const { closedMinuteStarts } = await import('../../src/dashboard/web/view-model.js');
  expect(closedMinuteStarts(299, 3)).toEqual([120, 180, 240]);
  expect(closedMinuteStarts(298, 3)).toEqual([60, 120, 180]);
  expect(closedMinuteStarts(300, 3)).toEqual([120, 180, 240]);
});

it('only selects retained minute cutoffs and counts overlapping minute intervals', async () => {
  const { selectableCutoff, minuteOverlaps } =
    await import('../../src/dashboard/web/view-model.js');
  expect(selectableCutoff(119, 120, 350)).toBe(false);
  expect(selectableCutoff(179, 120, 350)).toBe(true);
  expect(selectableCutoff(359, 120, 350)).toBe(false);
  expect(selectableCutoff(179, null, null)).toBe(false);
  expect(minuteOverlaps(180, 239, 299)).toBe(false);
  expect(minuteOverlaps(240, 239, 299)).toBe(true);
});

describe('dashboard request bookkeeping', () => {
  it('asks for the drawn horizon plus the minute it compares against, inside the reader bound', async () => {
    const { overviewMinutes } = await import('../../src/dashboard/web/view-model.js');
    expect(overviewMinutes(15)).toBe(16);
    expect(overviewMinutes(30)).toBe(31);
    // The reader refuses more than an hour, so the overview never asks for one.
    expect(overviewMinutes(60)).toBe(60);
    expect(overviewMinutes(0)).toBe(1);
  });
  it('tells a viewer what can be done next, in the words of the page and not of the reader', async () => {
    const { requestNotice } = await import('../../src/dashboard/web/view-model.js');
    expect(requestNotice(503, 'SNAPSHOT_BUSY')).toBe('详情更新中，可重试。');
    expect(requestNotice(503, 'SNAPSHOT_UNAVAILABLE')).toContain('快照暂不可用');
    expect(requestNotice(409, 'SNAPSHOT_EXPIRED')).toContain('重新获取');
    for (const status of [400, 500]) {
      const notice = requestNotice(status, null);
      expect(notice).not.toMatch(/worker|SQL|sqlite|线程|数据库连接/i);
    }
  });
  it('separates a first snapshot, a delayed one and an unusable one', async () => {
    const { summaryNotice } = await import('../../src/dashboard/web/view-model.js');
    expect(summaryNotice('ok', null)).toBeNull();
    expect(summaryNotice('empty', '正在生成首个快照')).toBe('正在生成首个快照');
    expect(summaryNotice('empty', null)).toBe('首次快照生成中');
    expect(summaryNotice('stale', null)).toBe('数据更新延迟');
    expect(summaryNotice('error', null)).toBe('快照暂不可用');
    // A reader that can say why keeps the floor.
    expect(summaryNotice('error', '无法读取本地数据；请检查数据库与配置版本。')).toContain(
      '无法读取本地数据',
    );
  });
  it('drops an answer that belongs to a generation or a token the page has moved on from', async () => {
    const { stillCurrent } = await import('../../src/dashboard/web/view-model.js');
    const wanted = { generation: 'g2', address: '0xAA' };
    expect(stillCurrent(wanted, { generation: 'g2', tokenAddress: '0xaa' })).toBe(true);
    expect(stillCurrent(wanted, { generation: 'g1', tokenAddress: '0xaa' })).toBe(false);
    expect(stillCurrent(wanted, { generation: 'g2', tokenAddress: '0xbb' })).toBe(false);
    expect(
      stillCurrent(
        { generation: null, address: '0xaa' },
        {
          generation: 'g2',
          tokenAddress: '0xaa',
        },
      ),
    ).toBe(false);
    expect(
      stillCurrent(
        { generation: 'g2', address: null },
        {
          generation: 'g2',
          tokenAddress: '0xaa',
        },
      ),
    ).toBe(false);
  });
});
