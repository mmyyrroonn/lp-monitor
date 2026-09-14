# 第二轮修复复核处理记录 G01–G06

输入：`docs/reviews/2026-09-14-stock-pool-heat-research-second-fix-review.md`（基线 `5a9abb8`，目标 `main@865aef1`，4 项关闭、2 项部分修复，新增 1 P1 / 4 P2 / 1 P3）。本轮只改代码与离线测试；未连接真实 RPC、未启动采集、未改线上阈值、未提交、未运行 H5。

## 本轮处理

| ID  | 处理 | 实现与验证依据 |
| --- | --- | --- |
| G01 | 已修复 | 把「可评价样本门槛」与「效果通过标准」拆开：`validation` 新增 `minimumForwardSwapCount`（默认 1）、`minimumForwardUsdMicros`（十进制字符串，默认 "0"）、`minimumRelativeMultiple`（默认 null=不启用）。结果窗新增同长度前置基线窗（`baselineUsdMicros`）与 `relativeMultiple`，分段汇总新增 `minimumSwapCount` / `minimumUsdMicros` / `minimumRelativeMultiple`（对完整窗取最弱值）。`candidate-supported` 需验证段满足样本门槛**且**全部效果标准，测试段有 episode 时同样要满足；否则输出 `validation-requirement-not-met`、`insufficient-evidence`。回归：`study-execution.test.ts` 新增用例（单笔 30,000 USD 触发、此后无成交 → 15 分钟/delay=1 完整窗 swapCount=0 → 不支持）；原「全截尾」与「有后续成交」两例仍保持通过。 |
| G02 | 已修复 | 结果窗右边界与分钟相交时不再直接计入：事件所在分钟若跨过窗口终点（`minuteStartSec + 60 > toSec`）保留 `unresolved-event-time`，不生成完整金额合计；精确时间事件仍按秒过滤。回归：`tests/unit/study-outcome-window.test.ts`（[6050,6950) 内 minuteStartSec=6900 的 5,000 USD 交易 → incomplete/null；6900 秒精确时间对照仍排除；6840 分钟仍计入）。 |
| G03 | 已修复 | 覆盖核验改为遍历每个与结果窗相交的分钟槽直到 `min(coverage.endSec, endSec)`，不再因 `minute + 60 > coverage.endSec` 直接跳过；完整性同时要求 `coveredMinutes === expectedMinutes`，缺少末分钟证据时保持 incomplete 且合计为空。回归：同文件用例（移除 6900 分钟 → incomplete、expected 16 / covered 15、swapCount 与 usdMicros 为 null）。 |
| G04 | 已修复 | 目标预检的 1 次请求计入本次 run 预算：剩余预算为 0 时直接置 `paused`（`lastError` 说明预算耗尽、notes 记录“rpc budget consumed by target verification”），不再用 `Math.max(1, …)` 追加请求。回归：`history-job-integrity.test.ts`（`maxRpcCalls=1` → `currentRunRpcCalls=1`、`cumulativeRpcCalls=1`、paused）。 |
| G05 | 已修复 | 作业开始即固定绝对截止时间 `runStartedAtMs + durationMs`，预检 reader 收到同一 `deadlineMs`，预检结束后若已过期则不再创建后续 reader；reviewHistory 也使用同一绝对截止时间而非重新计时。回归：同文件（慢预检 120ms、`durationMs=25` → 只创建 1 个 reader、该 reader 带 deadline、状态为 paused/waiting-retry 且原因含 deadline）。 |
| G06 | 已修复 | `longestActiveRunMinutes` / `activeMinutes` 改为与覆盖核验相同的整分钟槽遍历（从 `floor(startSec/60)*60` 到窗口有效终点），不再漏掉右端相交分钟。回归：同文件（[6050,6950) 内 6920 秒单笔交易 → activeMinutes=1 且 longestActiveRunMinutes=1）。 |

## 复核遗留

- 效果标准目前是**声明式**的三项（前向成交笔数、前向美元金额、相对自身基线倍数）；`minimumRelativeMultiple` 默认关闭，需要真实基线样本时才启用。未定义/未满足时保持 `insufficient-evidence`。
- 测试段没有 episode 时不参与效果判定（仍要求覆盖完整）；验证段的判定是结论的唯一依据，测试段有 episode 时按同一标准复核。
- `invalidateAfter` 的 accepted_ranges 仍为 batch 级（前一轮已记录），本轮未改数据模型。
- 72.9 MB 批次峰值内存、实链目录、一天级容量与 14–28 天研究验收仍未运行（H5）。

## 本轮验证

- `pnpm typecheck`：退出 0。
- `pnpm lint`：退出 0。
- `pnpm build`：退出 0。
- `pnpm test`：112 文件 / 908 测试全部通过（新增 G01–G06 回归 7 项）。
