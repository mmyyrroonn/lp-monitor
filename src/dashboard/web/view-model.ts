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
export function heatIntensity(value: number | null, maximum: number): number | null {
  if (value === null) return null;
  if (value <= 0 || maximum <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(maximum));
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
