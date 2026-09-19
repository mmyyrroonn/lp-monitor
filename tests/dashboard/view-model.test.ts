import { describe, expect, it } from 'vitest';
import {
  classifyHeat,
  columnSortExplanation,
  compareColumn,
  compareHeat,
  heatIntensity,
  formatMicros,
  favoriteKey,
  nextColumnSort,
  type ColumnInput,
  type ColumnKey,
  type SortDirection,
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

describe('dashboard ranking column order', () => {
  const row = (over: Partial<ColumnInput> & { symbol: string }): ColumnInput => ({
    address: `0xaddr-${over.symbol}`,
    poolCount: 1,
    txCount: 0,
    usdMicros: null,
    ...over,
  });
  const sorted = (rows: ColumnInput[], key: ColumnKey, dir: SortDirection) =>
    [...rows].sort((a, b) => compareColumn(a, b, key, dir));

  it('reads the transaction-count column both ways', () => {
    const rows = [
      row({ symbol: 'A', txCount: 5 }),
      row({ symbol: 'B', txCount: 40 }),
      row({ symbol: 'C', txCount: 12 }),
    ];
    expect(sorted(rows, 'count', 'desc').map((r) => r.symbol)).toEqual(['B', 'C', 'A']);
    expect(sorted(rows, 'count', 'asc').map((r) => r.symbol)).toEqual(['A', 'C', 'B']);
  });
  it('reads the pool column and settles equal counts by name', () => {
    const rows = [
      row({ symbol: 'A', poolCount: 2 }),
      row({ symbol: 'C', poolCount: 7 }),
      row({ symbol: 'B', poolCount: 7 }),
    ];
    expect(sorted(rows, 'pools', 'desc').map((r) => r.symbol)).toEqual(['B', 'C', 'A']);
    expect(sorted(rows, 'pools', 'asc').map((r) => r.symbol)).toEqual(['A', 'B', 'C']);
  });
  it('keeps tokens whose window is unknown at the end, whichever way the column reads', () => {
    const rows = [
      row({ symbol: 'GAP', txCount: null }),
      row({ symbol: 'LOW', txCount: 3 }),
      row({ symbol: 'MISSING', txCount: null }),
      row({ symbol: 'HIGH', txCount: 9 }),
      row({ symbol: 'ZERO', txCount: 0 }),
    ];
    // Ascending has the quietest row first and the unknown rows last, so unknown is not zero.
    expect(sorted(rows, 'count', 'asc').map((r) => r.symbol)).toEqual([
      'ZERO',
      'LOW',
      'HIGH',
      'GAP',
      'MISSING',
    ]);
    expect(sorted(rows, 'count', 'desc').map((r) => r.symbol)).toEqual([
      'HIGH',
      'LOW',
      'ZERO',
      'GAP',
      'MISSING',
    ]);
  });
  it('compares USDG amounts as integers and leaves unpriced rows at the end', () => {
    const rows = [
      row({ symbol: 'BIG', usdMicros: '123456789012345678901233' }),
      row({ symbol: 'HUGE', usdMicros: '123456789012345678901234' }),
      row({ symbol: 'UNPRICED', usdMicros: null }),
      row({ symbol: 'BLANK', usdMicros: '' }),
    ];
    // These two amounts are the same double, so only an integer comparison can tell them apart.
    // The two unpriced rows tie with each other and keep their name order in both directions.
    expect(sorted(rows, 'amount', 'desc').map((r) => r.symbol)).toEqual([
      'HUGE',
      'BIG',
      'BLANK',
      'UNPRICED',
    ]);
    expect(sorted(rows, 'amount', 'asc').map((r) => r.symbol)).toEqual([
      'BIG',
      'HUGE',
      'BLANK',
      'UNPRICED',
    ]);
    // Everything drawn as — is unknown rather than zero.
    expect(formatMicros('')).toBe('—');
  });
  it('orders names without letting case or the runtime collation move a row around', () => {
    const rows = [row({ symbol: 'apple' }), row({ symbol: 'Banana' }), row({ symbol: 'APPLE' })];
    const ascending = sorted(rows, 'name', 'asc').map((r) => r.symbol);
    expect(ascending[2]).toBe('Banana');
    expect([ascending[0], ascending[1]].map((s) => s?.toLowerCase())).toEqual(['apple', 'apple']);

    const chinese = [
      row({ symbol: '茅台' }),
      row({ symbol: '平安银行' }),
      row({ symbol: '宁德时代' }),
    ];
    const byName = sorted(chinese, 'name', 'asc').map((r) => r.symbol);
    const reversed = sorted(chinese, 'name', 'desc').map((r) => r.symbol);
    expect(reversed).toEqual([...byName].reverse());
  });
  it('settles equal values by name and address so a refresh cannot reshuffle the table', () => {
    const rows = [
      row({ symbol: 'B', address: '0x2', txCount: 4 }),
      row({ symbol: 'A', address: '0x9', txCount: 4 }),
      row({ symbol: 'A', address: '0x1', txCount: 4 }),
    ];
    // Rows that tie on the column keep the same order in both directions; only the column flips.
    expect(sorted(rows, 'count', 'desc').map((r) => r.address)).toEqual(['0x1', '0x9', '0x2']);
    expect(sorted(rows, 'count', 'asc').map((r) => r.address)).toEqual(['0x1', '0x9', '0x2']);
    for (const a of rows)
      for (const b of rows) if (a !== b) expect(compareColumn(a, b, 'count', 'desc')).not.toBe(0);
  });
  it('lets the clicked column, not the heat view, decide the order', () => {
    const spike = row({ symbol: 'SPIKE', txCount: 30, poolCount: 1 });
    const quiet = row({ symbol: 'QUIET', txCount: 4, poolCount: 9 });
    const heat = (r: ColumnInput) => ({ current: r.txCount, previous: 1, minutes: [] });
    expect(compareHeat(heat(spike), heat(quiet), 'warming')).toBeLessThan(0);
    expect(compareColumn(spike, quiet, 'pools', 'desc')).toBeGreaterThan(0);
  });
  it('flips the column already in charge and starts a new one at its own end', () => {
    expect(nextColumnSort(null, 'count')).toEqual({ key: 'count', dir: 'desc' });
    expect(nextColumnSort(null, 'name')).toEqual({ key: 'name', dir: 'asc' });
    expect(nextColumnSort({ key: 'pools', dir: 'desc' }, 'name')).toEqual({
      key: 'name',
      dir: 'asc',
    });
    expect(nextColumnSort({ key: 'amount', dir: 'desc' }, 'pools')).toEqual({
      key: 'pools',
      dir: 'desc',
    });
    expect(nextColumnSort({ key: 'count', dir: 'desc' }, 'count')).toEqual({
      key: 'count',
      dir: 'asc',
    });
    expect(nextColumnSort({ key: 'count', dir: 'asc' }, 'count')).toEqual({
      key: 'count',
      dir: 'desc',
    });
  });
  it('names the column ordering the ranking and where the rows it cannot compare went', () => {
    expect(columnSortExplanation('amount', 'desc', '5m')).toBe(
      '按「USDG 等值量」降序；未计价数据排在末尾。',
    );
    expect(columnSortExplanation('count', 'asc', '1m')).toBe(
      '按「1m 交易数」升序；当前窗口数据不足的行排在末尾。',
    );
    expect(columnSortExplanation('name', 'asc', '5m')).toContain('代币名称');
    expect(columnSortExplanation('pools', 'desc', '5m')).toContain('池数量');
  });
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
