import type { TokenMinute } from '../types.js';

export type HeatKind = 'warming' | 'new' | 'sustained' | 'cooling' | 'active' | 'quiet' | 'unknown';
export type SortMode = 'warming' | 'activity' | 'sustained' | 'cooling';
export interface HeatInput {
  current: number | null;
  previous: number | null;
  minutes: readonly { txCount: number | null; status: string }[];
}
export const heatLabels: Record<HeatKind, string> = {
  warming: '突然升温',
  new: '新增活跃',
  sustained: '持续热门',
  cooling: '正在降温',
  active: '活跃',
  quiet: '暂无交易',
  unknown: '数据不足',
};
/** Descriptive thresholds, not a signal or a profitability model. */
export function classifyHeat(input: HeatInput) {
  const { current, previous } = input;
  const delta = current === null || previous === null ? null : current - previous;
  const changePercent =
    delta === null || previous === null || previous === 0 ? null : (delta / previous) * 100;
  const tail = input.minutes.slice(-5);
  const sustained =
    tail.length === 5 &&
    tail.every((m) => m.status === 'closed' && m.txCount !== null) &&
    tail.filter((m) => m.txCount! > 0).length >= 4;
  let kind: HeatKind;
  if (current === null || previous === null) kind = 'unknown';
  else if (previous >= 10 && current <= previous * 0.5) kind = 'cooling';
  else if (current === 0) kind = 'quiet';
  else if (previous === 0) kind = 'new';
  else if (current >= 10 && delta! >= 5 && current >= previous * 2) kind = 'warming';
  else if (current >= 10 && sustained) kind = 'sustained';
  else kind = 'active';
  return { kind, label: heatLabels[kind], delta, changePercent };
}
export function compareHeat(a: HeatInput, b: HeatInput, mode: SortMode): number {
  if (a.current === null || b.current === null)
    return a.current === b.current ? 0 : a.current === null ? 1 : -1;
  if (mode === 'activity') return b.current - a.current;
  const aa = classifyHeat(a),
    bb = classifyHeat(b);
  const eligible = (i: HeatInput, h: ReturnType<typeof classifyHeat>) =>
    mode === 'warming'
      ? h.kind === 'warming' || (h.kind === 'new' && i.current! >= 10)
      : h.kind === mode;
  const priority = Number(eligible(b, bb)) - Number(eligible(a, aa));
  if (priority) return priority;
  if (a.previous === null || b.previous === null)
    return a.previous === b.previous ? b.current - a.current : a.previous === null ? 1 : -1;
  return (
    (mode === 'cooling' ? aa.delta! - bb.delta! : mode === 'warming' ? bb.delta! - aa.delta! : 0) ||
    b.current - a.current
  );
}
export type ColumnKey = 'name' | 'count' | 'amount' | 'pools';
export type SortDirection = 'asc' | 'desc';
/** One column and the way it is being read. A column and a view never order the ranking at once. */
export interface ColumnSort {
  key: ColumnKey;
  dir: SortDirection;
}
/** What one column of the ranking needs from a row: its value, and how to tell rows apart. */
export interface ColumnInput {
  symbol: string;
  address: string;
  poolCount: number;
  txCount: number | null;
  usdMicros: string | null;
}
/** A missing symbol still needs a label; the address is the only name such a row has. */
const columnName = (t: ColumnInput) => t.symbol || t.address;
/** Equal values read in the same order whichever way the column is read, so the list stays put. */
const byIdentity = (a: ColumnInput, b: ColumnInput) =>
  a.symbol.localeCompare(b.symbol) || a.address.localeCompare(b.address);
/**
 * Unknown is not zero: a row whose window is unknown sorts after every row that has a value,
 * ascending and descending alike. Only the known values turn around with the direction.
 */
const byNumber = (a: number | null, b: number | null, dir: SortDirection) =>
  a === null || b === null ? (a === b ? 0 : a === null ? 1 : -1) : dir === 'desc' ? b - a : a - b;
/** Case differences should not decide the list; the spelling only settles names that tie. */
const byName = (a: ColumnInput, b: ColumnInput, dir: SortDirection) => {
  const order =
    columnName(a).toLowerCase().localeCompare(columnName(b).toLowerCase()) ||
    columnName(a).localeCompare(columnName(b));
  return dir === 'desc' ? -order : order;
};
/** Amounts arrive as micro-unit decimal strings; anything else is unpriced, exactly as the page reads it. */
const microsOf = (value: string | null) =>
  value !== null && /^-?\d+$/.test(value) ? BigInt(value) : null;
const byAmount = (a: string | null, b: string | null, dir: SortDirection) => {
  const x = microsOf(a),
    y = microsOf(b);
  if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
  const order = x < y ? -1 : x > y ? 1 : 0;
  return dir === 'desc' ? -order : order;
};

/**
 * Orders the ranking by one column instead of by a heat view. The column decides which value is
 * compared and the direction only turns that value around; every tie falls back to the symbol and
 * then the address, so the same rows in the same order do not shuffle between two equal columns.
 */
export function compareColumn(
  a: ColumnInput,
  b: ColumnInput,
  key: ColumnKey,
  dir: SortDirection,
): number {
  const order =
    key === 'name'
      ? byName(a, b, dir)
      : key === 'count'
        ? byNumber(a.txCount, b.txCount, dir)
        : key === 'amount'
          ? byAmount(a.usdMicros, b.usdMicros, dir)
          : byNumber(a.poolCount, b.poolCount, dir);
  return order || byIdentity(a, b);
}

/**
 * What one click on a column header asks for. The column already in charge is read the other way;
 * any other column starts at the end its own values are wanted from — a name from A, a number from
 * the top — so the first click is the one the reader almost always meant.
 */
export function nextColumnSort(current: ColumnSort | null, key: ColumnKey): ColumnSort {
  return current?.key === key
    ? { key, dir: current.dir === 'desc' ? 'asc' : 'desc' }
    : { key, dir: key === 'name' ? 'asc' : 'desc' };
}

/**
 * The sentence above the ranking while a column, not a view, is what orders it: it names the column
 * in the words of the table and says where the rows it cannot compare went.
 */
export function columnSortExplanation(
  key: ColumnKey,
  dir: SortDirection,
  windowName: string,
): string {
  const column = {
    name: '代币名称',
    count: `${windowName} 交易数`,
    amount: 'USDG 等值量',
    pools: '池数量',
  }[key];
  const tail = {
    name: '名称相同时按合约地址排列。',
    count: '当前窗口数据不足的行排在末尾。',
    amount: '未计价数据排在末尾。',
    pools: '池数相同时按代币名称排列。',
  }[key];
  return `按「${column}」${dir === 'desc' ? '降序' : '升序'}；${tail}`;
}

export function heatIntensity(value: number | null, maximum: number): number | null {
  if (value === null) return null;
  if (value <= 0 || maximum <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(maximum));
}
/** Micro-unit amount read as a dollar number, for the log-scaled heat colouring only. */
export function microsToDollars(value: bigint): number {
  return Number(value) / 1_000_000;
}

export type HeatBlockStatus = 'closed' | 'partial' | 'gap';
/** One fixed-length time block of a token's heat trajectory, aggregated from minute evidence. */
export type HeatBlock = {
  startSec: number;
  status: HeatBlockStatus;
  /** How many of the block's minutes are closed and therefore counted into the value. */
  closedMinutes: number;
  txCount: number;
  /** Null-propagating sum of closed minutes: one unpriced minute keeps the whole block unpriced. */
  usdMicros: bigint | null;
  /** Deduplicated coverage reasons from the minutes the block touches. */
  reasons: string[];
};

/**
 * Aggregates a token's minute series into fixed-length blocks. Only closed minutes contribute a
 * value; a block that touches the still-running minute is `partial`, and one with no evidence is
 * `gap`. Minutes missing from the series count as no evidence, so a block that reaches past the
 * watermark simply ignores the minutes it has not seen yet.
 */
export function aggregateHeatBlocks(
  minutes: readonly TokenMinute[],
  blockStarts: readonly number[],
  blockSeconds: number,
): HeatBlock[] {
  const perBlock = Math.round(blockSeconds / 60);
  const byStart = new Map(minutes.map((m) => [m.minuteStartSec, m]));
  return blockStarts.map((startSec) => {
    let status: HeatBlockStatus = 'gap';
    let closedMinutes = 0;
    let txCount = 0;
    let usdMicros: bigint | null = 0n;
    const reasons = new Set<string>();
    for (let i = 0; i < perBlock; i++) {
      const m = byStart.get(startSec + i * 60);
      if (m !== undefined) for (const reason of m.reasons) reasons.add(reason);
      if (m === undefined || m.status === 'gap' || m.status === 'warming') continue;
      if (m.status === 'partial') {
        status = 'partial';
        continue;
      }
      status = 'closed';
      closedMinutes += 1;
      if (m.txCount !== null) txCount += m.txCount;
      const usd = m.usdMicros;
      if (usd === null) usdMicros = null;
      else if (usdMicros !== null) usdMicros += BigInt(usd);
    }
    return { startSec, status, closedMinutes, txCount, usdMicros, reasons: [...reasons] };
  });
}
export function formatMicros(value: string | null): string {
  if (value === null || !/^-?\d+$/.test(value)) return '—';
  const n = BigInt(value),
    abs = n < 0n ? -n : n;
  return (
    (n < 0n ? '-' : '') +
    (abs / 1000000n).toLocaleString('en-US') +
    '.' +
    ((abs % 1000000n) / 10000n).toString().padStart(2, '0')
  );
}
export const favoriteKey = (chainId: number, scope: string) =>
  `lp-monitor:favorites:${chainId}:${scope}`;
export const escapeHtml = (text: unknown) =>
  String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function closedMinuteStarts(endSec: number, count: number): number[] {
  const exclusiveEnd = Math.floor((endSec + 1) / 60) * 60;
  return Array.from({ length: count }, (_, i) => exclusiveEnd - (count - i) * 60);
}

export function selectableCutoff(
  at: number,
  from: number | null,
  sourceEnd: number | null,
): boolean {
  return from !== null && sourceEnd !== null && at >= from && at <= sourceEnd && at % 60 === 59;
}
export function minuteOverlaps(minuteStart: number, start: number, end: number): boolean {
  return minuteStart + 59 > start && minuteStart <= end;
}

/**
 * How many minutes the overview asks the reader for: the heatmap horizon, plus the one extra minute
 * the change list compares its oldest drawn minute against. The reader keeps three hours of minutes,
 * so at the longest horizon the comparison minute is the one that has to go.
 */
export function overviewMinutes(horizon: number): number {
  return Math.min(180, Math.max(1, Math.trunc(horizon) + 1));
}

/**
 * The one sentence a viewer reads when a request failed. A failure is described by what the page can
 * still do — keep what it has, ask again, or wait — never by what the reader was doing.
 */
export function requestNotice(status: number, code: string | null): string {
  if (status === 409) return '数据已更新，正在重新获取最新快照。';
  if (status === 503 && code === 'SNAPSHOT_BUSY') return '详情更新中，可重试。';
  if (status === 503) return '快照暂不可用，稍后会自动重试。';
  if (status === 400) return '本地服务没有接受这次请求参数。';
  return '本地服务暂时无法响应；保留上次结果。';
}

/**
 * The three states a summary can be in, told apart on purpose: nothing published yet, published
 * data that stopped moving, and a reader that cannot produce anything. A first snapshot and a
 * delayed one are not the same problem, and neither is a database that will not open.
 */
export function summaryNotice(
  status: 'ok' | 'empty' | 'stale' | 'error',
  message: string | null,
): string | null {
  if (status === 'ok') return null;
  if (status === 'empty') return message ?? '首次快照生成中';
  if (status === 'stale') return message ?? '数据更新延迟';
  return message ?? '快照暂不可用';
}

/**
 * Whether an answer still belongs to what the page is showing. A page that switched token, window
 * or cutoff while a request was in flight must drop the answer rather than paint it over the new
 * selection.
 */
export function stillCurrent(
  wanted: { generation: string | null; address: string | null },
  answer: { generation: string; tokenAddress: string },
): boolean {
  return (
    wanted.generation !== null &&
    wanted.address !== null &&
    answer.generation === wanted.generation &&
    answer.tokenAddress.toLowerCase() === wanted.address.toLowerCase()
  );
}
