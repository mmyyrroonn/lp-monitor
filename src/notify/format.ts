import type { RollingMetric } from '../metrics/rolling.js';
import type { SwapLiquidityAnnotation } from '../metrics/liquidity.js';
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

function rationalUnits(numerator: bigint, denominator: bigint, decimals: number): string {
  if (denominator <= 0n) throw new RangeError('Invalid rational denominator');
  const negative = numerator < 0n;
  let remainder = negative ? -numerator : numerator;
  const divisor = denominator * 10n ** BigInt(decimals);
  const whole = remainder / divisor;
  remainder %= divisor;
  if (remainder === 0n) return `${negative ? '-' : ''}${grouped(whole)}`;
  let fraction = '';
  while (remainder !== 0n) {
    remainder *= 10n;
    fraction += (remainder / divisor).toString();
    remainder %= divisor;
  }
  return `${negative ? '-' : ''}${grouped(whole)}.${fraction}`;
}

function usdg(value: bigint | null | undefined): string {
  return value === null || value === undefined ? 'unknown' : `${rationalUnits(value, 1n, 6)} USDG`;
}

function rationalUsdg(numerator: bigint | null, denominator: bigint | null): string {
  return numerator === null || denominator === null
    ? 'unknown'
    : `${rationalUnits(numerator, denominator, 6)} USDG`;
}

function count(value: number | null | undefined, suffix: string): string {
  return value === null || value === undefined ? `unknown${suffix}` : `${value}${suffix}`;
}

function metricCounts(metric: MinuteMetric | AggregateMetric | RollingMetric | null): string {
  return `Swap：${count(metric?.swapCount, '次')}；不同tx：${count(metric?.txCount, '笔')}；加池动作${count(metric?.addCount, '次')}、减池动作${count(metric?.removeCount, '次')}`;
}

function ratio(
  metric: MinuteMetric | AggregateMetric | RollingMetric | null,
  baseline?: AlertRecord['baseline']['minute'],
): string {
  const median = baseline ? baseline.median : (metric?.baselineMedian ?? null);
  const numerator = baseline ? baseline.medianNumerator : (metric?.baselineMedianNumerator ?? null);
  const denominator = baseline
    ? baseline.medianDenominator
    : (metric?.baselineMedianDenominator ?? null);
  const unit = baseline ? baseline.unit : (metric?.baselineUnit ?? null);
  const multiplier = baseline ? baseline.multiplier : (metric?.volumeMultiplier ?? null);
  const multiple = multiplier === null ? 'unknown' : `${multiplier}倍`;
  const renderedBaseline =
    unit !== 'usdMicros'
      ? 'unknown'
      : median !== null
        ? usdg(median)
        : rationalUsdg(numerator, denominator);
  return `过去基线：${renderedBaseline}；${multiple}`;
}

export function formatObservedLiquidity(annotation: SwapLiquidityAnnotation | null): string {
  if (annotation === null) return '未观察到 Swap 流动性状态';
  const age =
    annotation.ageSecInterval === null
      ? '时距unknown'
      : annotation.ageSecInterval.min === annotation.ageSecInterval.max
        ? `距锚点${annotation.ageSecInterval.min}秒`
        : `距锚点${annotation.ageSecInterval.min}–${annotation.ageSecInterval.max}秒`;
  const freshness =
    annotation.freshness === 'before-last-liquidity-action'
      ? '之后发生过流动性动作'
      : '最近 Swap 时观察值';
  return `最近 Swap 观察到 L=${grouped(annotation.liquidityRaw)}，tick=${annotation.tick}，区块${grouped(annotation.observedAt.blockNumber)}，${age}；${freshness}；L 不是美元流动性，不代表当前 L，也不代表提款`;
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
    `自然完整5m：${usdg(natural?.usdMicros)}；${ratio(natural, alert.baseline.fiveMinute)}`,
    `本分钟累计：${usdg(partial?.usdMicros)}${partial?.status === 'partial' ? '（仍在更新）' : ''}`,
    `最近5m次数：${metricCounts(recent)}`,
    `自然5m次数：${metricCounts(natural)}`,
    `本分钟次数：${metricCounts(partial)}`,
    `本分钟${ratio(partial, alert.baseline.minute)}`,
    '时间：分钟归桶；本分钟累计可能仍在更新；数据可能修订',
    `归桶分钟：${new Date(alert.watermarkSec * 1_000).toISOString().slice(0, 16)}Z`,
    `关联代币：${tokens}`,
  ];
  if (alert.metrics.rolling) {
    lines.splice(
      2,
      9,
      ...Object.entries(alert.metrics.rolling).map(
        ([name, m]) =>
          `过去${name}：${usdg(m.usdMicros)}；Swap ${m.swapCount ?? 'unknown'}；交易 ${m.txCount ?? 'unknown'}；${m.status}；${name === '1m' ? ratio(m, alert.baseline.minute) : name === '5m' ? ratio(m, alert.baseline.fiveMinute) : ''}`,
      ),
      '时间：以已采集链上时间为终点的滚动窗口 (start, end]；边界不确定时不可用',
    );
  }
  if (alert.logicalTimeSec !== undefined)
    lines.push(
      `评估桶时间：${new Date(alert.logicalTimeSec * 1_000).toISOString().slice(0, 16)}Z${alert.historical ? '（历史补评）' : ''}`,
    );
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
