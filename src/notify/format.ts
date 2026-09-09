import type { AggregateMetric, MinuteMetric } from '../metrics/windows.js';
import type { AlertKind, AlertRecord } from '../signals/types.js';

const KIND_LABEL: Record<AlertKind | 'retracted', string> = {
  candidate: '候选观察',
  hot: '热度确认',
  reheat: '再次升温',
  cooling: '热度降温',
  'liquidity-watch': '流动性观察',
  retracted: '提醒撤回',
};

function grouped(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString();
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function usdg(value: bigint | null | undefined): string {
  if (value === null || value === undefined) return 'unknown';
  const whole = value / 1_000_000n,
    remainder = value % 1_000_000n;
  if (remainder === 0n) return `${grouped(whole)} USDG`;
  return `${grouped(whole)}.${remainder.toString().padStart(6, '0').replace(/0+$/, '')} USDG`;
}

function count(value: number | null | undefined, suffix: string): string {
  return value === null || value === undefined ? `unknown${suffix}` : `${value}${suffix}`;
}

function metricCounts(metric: MinuteMetric | AggregateMetric | null): string {
  return `Swap：${count(metric?.swapCount, '次')}；不同tx：${count(metric?.txCount, '笔')}；加池动作${count(metric?.addCount, '次')}、减池动作${count(metric?.removeCount, '次')}`;
}

function ratio(
  metric: MinuteMetric | AggregateMetric | null,
  baseline?: AlertRecord['baseline']['minute'],
): string {
  const median = baseline?.median ?? metric?.baselineMedian ?? null;
  const unit = baseline?.unit ?? metric?.baselineUnit ?? null;
  const multiplier = baseline?.multiplier ?? metric?.volumeMultiplier ?? null;
  const multiple = multiplier === null ? 'unknown' : `${multiplier}倍`;
  return `过去基线：${unit === 'usdMicros' ? usdg(median) : 'unknown'}；${multiple}`;
}

function poolLabel(alert: AlertRecord): string {
  return alert.presentation?.pairLabel ?? alert.presentation?.rwaSymbol ?? alert.poolId;
}

export function formatAlert(alert: AlertRecord): string {
  const recent = alert.metrics.recentClosed5x1m;
  const natural = alert.metrics.naturalClosed5m;
  const partial = alert.metrics.partialCurrent;
  const evidence = alert.presentation?.evidenceTxs?.length
    ? alert.presentation.evidenceTxs.join('、')
    : 'unknown';
  const tokens = alert.presentation?.associatedTokens?.length
    ? `${alert.presentation.associatedTokens.join('、')}（同交易共现，尚未证实完整路由）`
    : 'unknown';
  const lines = [
    `${poolLabel(alert)} — ${KIND_LABEL[alert.kind]}（暂未最终确认）`,
    `RWA：${alert.presentation?.rwaSymbol ?? 'unknown'}；pool：${alert.poolId}`,
    `最近5m：${usdg(recent?.usdMicros)}；${ratio(recent)}`,
    `自然完整5m：${usdg(natural?.usdMicros)}；${ratio(natural, alert.baseline?.fiveMinute)}`,
    `本分钟累计：${usdg(partial?.usdMicros)}${partial?.status === 'partial' ? '（仍在更新）' : ''}`,
    `最近5m次数：${metricCounts(recent)}`,
    `自然5m次数：${metricCounts(natural)}`,
    `本分钟次数：${metricCounts(partial)}`,
    `本分钟${ratio(partial, alert.baseline?.minute)}`,
    '时间：分钟归桶；本分钟累计可能仍在更新；数据可能修订',
    `归桶分钟：${new Date(alert.watermarkSec * 1_000).toISOString().slice(0, 16)}Z`,
    `关联代币：${tokens}`,
  ];
  if (alert.presentation?.liquidityNote)
    lines.push(`流动性附注：${alert.presentation.liquidityNote}`);
  lines.push(
    `到达时间：${new Date(alert.observedAtMs).toISOString()}；完整至区块${grouped(alert.endAnchor.number)}`,
    `证据：${evidence}；告警：${alert.id}/revision ${alert.revision}`,
    `命中原因：${alert.reasons.length ? alert.reasons.join('、') : 'unknown'}`,
  );
  if (alert.coverage !== 'complete')
    lines.push(`覆盖状态：${alert.coverage}；缺失数据按unknown展示`);
  return lines.join('\n');
}
