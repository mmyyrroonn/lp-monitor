import type { StudyConfigReport, StudyReport } from './study.js';
function issueSummary(issues: unknown): string {
  const counts = new Map<string, number>();
  for (const issue of Array.isArray(issues) ? issues : []) {
    const code = typeof issue === 'string' ? issue : String(issue.code ?? 'unknown');
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts].map(([code, n]) => code + ' (' + n + ')').join('; ');
}
const cell = (x: unknown) =>
  String(x ?? 'unknown')
    .replaceAll('|', '/')
    .replaceAll('\n', ' ');
export function renderStudyReport(report: StudyReport): string {
  return [
    '# P5 离线热度研究',
    '',
    '状态：**' + report.status + '**。' + report.conclusion,
    '',
    '数据覆盖、命名案例与完整出生队列分列；没有数据的结果保持 unknown。',
    '',
    '## 数据来源',
    '',
    '| 本机 manifest | 状态 | 问题 |',
    '|---|---|---|',
    ...report.sources.map(
      (s) => '| ' + cell(s.path) + ' | ' + s.status + ' | ' + cell(issueSummary(s.issues)) + ' |',
    ),
    '',
    '## 固定案例',
    '',
    '| 案例 | UTC 核心区间 | 状态 |',
    '|---|---|---|',
    ...report.cases.map(
      (c) => '| ' + c.id + ' | ' + c.startUtc + ' 至 ' + c.endUtc + ' | ' + c.status + ' |',
    ),
    '',
    '## 出生队列与再热样本',
    '',
    '各队列列出来源中的 cohortMode；使用当前登记表筛选历史时为 retrospective-cohort。池没有成交也保留。独立链上覆盖验证：false。',
    ...report.cohorts.map(
      (c) =>
        '- ' +
        cell(c.source) +
        '（' +
        c.cohortMode +
        '）' +
        '：观测出生池 ' +
        c.observedBirthCount +
        '，完整分母 ' +
        cell(c.denominator) +
        '，出生时间未知 ' +
        c.unresolved.length +
        '，既有池 ' +
        c.preexisting.length +
        '。',
    ),
    '',
    '## 全部参数组合',
    '',
    '金额门槛为美元估值，内部使用 USD micros。1m 候选沿用 P4 的绝对量与相对倍数规则；基线未就绪保留 absolute-only 标签。5m 使用 1/2 根绝对量确认，关闭并行的相对 5m 确认，避免绕过确认根数。默认实时配置未调整。',
    '',
    '| 组合 | 1m USD | 倍数 | 5m USD | 根数 | 同级冷却 | 状态 | 通知数 | 每小时通知 |',
    '|---|---:|---:|---:|---:|---:|---|---:|---:|',
    ...report.experiments.map(
      (e) =>
        '| ' +
        e.id +
        ' | ' +
        e.parameters.absolute1mUsd +
        ' | ' +
        e.parameters.multiple +
        ' | ' +
        e.parameters.confirm5mUsd +
        ' | ' +
        e.parameters.confirmationBars +
        ' | 300s | ' +
        e.status +
        ' | ' +
        cell(e.alarmCount) +
        ' | ' +
        cell(e.notificationsPerHour) +
        ' |',
    ),
    '',
    '## 解释范围',
    '',
    '- 09-03 至 09-05 为探索，09-06 至 09-07 为验证，结果窗在分割边界右截尾。同币跨期依赖和 leave-one-token-out 数量见 results.json。',
    '- 15/60/180 分钟结果比较额外 0/1/5 分钟延迟。delay=0 包含发报当分钟，可能计入发报前的秒数；以 delay≥1 为主要保守口径。Meme/RWA 与 RWA/USDG 各池分列，不相加冒充同一池费用。',
    '- 缺口与右截尾保留；覆盖不足的总量、交易次数、持续时间与每小时通知率保持 null。已观察前缀次数另列。',
    '- 后续成交区间、独立 episode、活跃分钟和最长连续活跃分钟见 results.json；样本量列出，不估计可靠胜率。',
    '- 毛费未估计，费用可信度为 not-estimated；没有仓位、完整交易成本与无常损失模型，不输出 LP 净收益。',
    '- GMGN 代币级成交与链上单池成交的统计范围、时间聚合和估值时点不同，不强行对齐研究数字。',
    '',
    '实验：' + report.studyRunId,
    '',
  ].join('\n');
}

export function renderStudyConfigReport(report: StudyConfigReport): string {
  const p = report.periods;
  return [
    '# P5 固定时间滚动研究',
    '',
    '状态：**' + report.status + '**；结论：**' + report.conclusion + '**。',
    '',
    '数据集：`' +
      report.datasetManifest +
      '`；模式：`' +
      report.mode +
      '`；评价 cadence：' +
      report.cadenceSec +
      ' 秒。',
    '',
    '| 分段 | startSec | endSec | 评价点 |',
    '|---|---:|---:|---:|',
    '| train | ' +
      p.train.startSec +
      ' | ' +
      p.train.endSec +
      ' | ' +
      report.splitCounts.train +
      ' |',
    '| validation | ' +
      p.validation.startSec +
      ' | ' +
      p.validation.endSec +
      ' | ' +
      report.splitCounts.validation +
      ' |',
    '| test | ' + p.test.startSec + ' | ' + p.test.endSec + ' | ' + report.splitCounts.test + ' |',
    '',
    '完整性问题：' + (report.issues.length ? report.issues.join('; ') : 'none') + '。',
    '',
    'onlineRuleChanged：false。缺失覆盖、未知边界和未验证收益不会被填成零。',
    '',
  ].join('\n');
}
