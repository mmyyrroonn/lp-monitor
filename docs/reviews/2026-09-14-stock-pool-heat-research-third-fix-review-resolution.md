# 第三轮修复复核处理记录 J01–J03

输入：`docs/reviews/2026-09-14-stock-pool-heat-research-third-fix-review.md`（基线 `865aef1`，目标 `main@d90206e`，G01–G06 中 5 项关闭、1 项部分修复，新增 3 个 P2）。本轮只改代码与离线测试；未连接真实 RPC、未启动采集、未改线上阈值、未提交、未运行 H5。

## 本轮处理

| ID  | 处理 | 实现与验证依据 |
| --- | --- | --- |
| J01 | 已修复 | `collectWindowEvidence` 恢复“完全位于窗口之外即排除”的判定：先排除 `minuteStartSec + 60 <= fromSec`（全在左侧）与 `minuteStartSec >= toSec`（全在右侧），只有确实跨过左右边界的分钟精度事件才保留 `unresolved-event-time`。回归：`tests/unit/study-outcome-window.test.ts` 新增用例（远端 `minuteStartSec=18000` 事件不再让 15/60/180 全部 incomplete，金额与基线保持 5,000/1,000、倍率 5；前向窗内的分钟事件不污染前置基线：前向 7,000、基线仍 1,000）。 |
| J02 | 已修复 | 前置基线固定为 `[triggerSec - horizon, triggerSec)`，不再使用 `startSec`（含反应延迟）作为终点；只有前向结果窗随反应延迟移动。回归：同文件用例（触发 6050 秒、5,600/6,070/6,500 三笔；delay=1 与 delay=5 均得到前向 5,000 USD、基线 1,000 USD、倍率 5，等待期成交不再进分母）。 |
| J03 | 已修复 | 有效预算改为 `options.maxRpcCalls ?? input.config.recorderMaxRpcCalls` 后再扣预检消耗；余量为 0 即暂停，不再让默认配置路径额外发起一次请求。回归：`history-job-integrity.test.ts` 新增用例（临时配置 `recorderMaxRpcCalls=1`、省略 `maxRpcCalls` → 实际仅 1 次请求、`cumulativeRpcCalls=1`、paused 且原因为预算）。 |

## 复核遗留

- `minimumRelativeMultiple` 默认仍为 null（未启用）；启用后使用固定触发前基线口径，若要比较“开始行动前后两个相邻窗口”需要另行定义指标名与口径，本轮未新增该口径。
- 显式预算路径与默认预算路径现在都扣除预检；预检与 reviewHistory 仍各建一个 reader，但合计请求数受同一有效预算约束。
- 72.9 MB 批次峰值内存、实链目录、一天级容量与 14–28 天研究验收仍未运行（H5）。

## 本轮验证

- `pnpm typecheck`：退出 0。
- `pnpm lint`：退出 0。
- `pnpm build`：退出 0。
- `pnpm test`：112 文件 / 911 测试全部通过（新增 J01/J02/J03 回归 3 项，合计 10 项新增断言用例）。
