# 修复复核（fix review）处理记录 R01–R16 / F01–F06

输入：`docs/reviews/2026-09-14-stock-pool-heat-research-fix-review.md`（对 `e8464e6..5a9abb8` 的复核，确认 11 项关闭、5 项部分修复，另列 F01–F06）。本轮只改代码与离线测试；未连接真实 RPC、未启动采集、未改线上阈值、未提交、未运行 H5。

## 本轮处理

| ID  | 处理 | 实现与验证依据 |
| --- | --- | --- |
| F01 | 已修复 | ① `runHistoryJob` 在复用本地覆盖前，用有界 reader 先核验固定目标仍等于该高度的链上块（`verifyFixedTarget`）；目标失效时不再回退/重抓，直接置 `failed` 并把 `target-anchor-mismatch` 写入 missing/notes，反复 resume 不再消耗 RPC。② `reviewHistory` 接受 `targetAnchor`，在 identity 之后逐 scope 校验已接受 tip：与链不一致时用「checkpoint ∪ anchors」候选集搜索共同祖先（`findMatchingCheckpoint`），`invalidateAfter` 回退受影响覆盖后重新计算缺口再补采；成功回退写入报告 `reconciled` 并进入 job `notes`。回归：`history-job-integrity.test.ts` 新增两例（旧分支双 scope + 新目标 → 旧块 180 事件被清除、新块 185 事件存在、声明范围覆盖完整；旧目标失效 → failed、前缀未被清空、二次 resume 不再重抓）。 |
| F02 | 已修复 | `confirmTarget` 的三种冲突（target 变更、tip 变更、目标高度被替换）现在都会失效被撤销的目录：目标块本身失效或目标高度被替换时整 scope 重建（避免祖先回退保留混合分支证据），仅 tip 失效时回退到匹配 checkpoint。回归：`catalogue-target-coverage.test.ts` 新增用例，断言 DB 中失效冷池被移除、acceptedTip 不再停在失效高度，且随后同一 DB 的 latest follow 的 operation getLogs 过滤器不含该池地址。 |
| F03 | 已修复 | 结论判定改为「触发过提醒 ≠ 支持候选」：新增可在研究配置中预先声明的 `validation`（`primaryHorizonMinutes`、`minimumCompleteOutcomeWindows`，默认 60 分钟 / 1 个），`candidate-supported` 需冻结候选的验证段存在 episode、验证/测试覆盖完整且满足该完整结果窗数量；全部结果被截尾时输出 `validation-requirement-not-met`、状态 incomplete、结论 `insufficient-evidence`。报告新增 `validationRequirement`/`validationSatisfied` 与模板字段。回归：`study-execution.test.ts` 新增双池数据集用例（60 分钟标准全部截尾 → 证据不足；15 分钟标准有完整窗 → candidate-supported）；顺带修正非整分钟分段下 exposure 分钟统计。 |
| F04 | 已修复 | 研究结果窗不再套用旧 minute-close 口径：新增 `evaluateStudyOutcomeWindows`，从 `触发秒 + 反应延迟` 起算；精确时间事件按秒过滤（触发前成交不再计入），只有分钟精度且跨触发边界的事件保留 `unresolved-event-time` 未知，覆盖分钟与右截尾判定同前。回归：`tests/unit/study-outcome-window.test.ts` 四例（含复核场景：触发 6050 秒、唯一 6020 秒 30,000 USD 成交 → 15 分钟窗 swapCount=0/USD=0；1/5 分钟延迟起点偏移；跨边界未知；截尾窗无合计）。 |
| F05 | 已修复 | cadence 判定改为逐段检查：新增 `cadenceGaps`，任意相邻可证明评价点间距超过请求 cadence 即报告未覆盖区间（`cadenceGapCount` / `cadenceGaps`，报告中最多列 32 段），issue 文案带首个缺口；最小间距保留为统计量不再作为唯一依据。回归：`rolling-replay.test.ts` 新增 [600,610,1200]/10 秒用例（1 段缺口 620–1200，issue 存在），既有“仅分钟点”与“精确时间点”用例保持通过。 |
| F06 | 已修复 | 最终 target/tip 确认整体接入 `withRecovery`：可中断退避重试、沿用同一预算与停止条件，仅语义性冲突（目标/tip 变更）直接结束；临时错误不再把 run 变成不可恢复的 incomplete。回归：`catalogue-target-coverage.test.ts` 新增用例（第二次确认读取一次 timeout → `discovery-retry` phase=anchor 后完成）。 |

## 复核遗留（未处理或仅记录）

- 72.9 MB 批次保存/读取/接受的峰值 RSS 约 1.56 GiB：分片消除了单对象上限，但处理仍整批序列化与重组；复核报告已接受其作为实测限制，本轮未做流式改造。
- 实链目录、一天级资源基准、14–28 天数据与阈值有效性仍未运行（H5）。
- `invalidateAfter` 的 `accepted_ranges` 粒度仍是 batch 级：回退到较早共同祖先会一并丢弃该批次靠前的已验证区间，因此补采会从 `fromBlock` 重新开始；本轮未改数据模型，改为在目标失效时直接重建 scope 以避免留下混合分支证据。

## 本轮验证

- `pnpm typecheck`：退出 0。
- `pnpm test`：112 文件 / 901 测试全部通过（新增 F01/F02/F03/F04/F05/F06 回归 10 项；首轮全量并行运行时 3 个计时敏感的既有用例失败，单独与再次全量运行均通过）。
- `pnpm lint`：退出 0。
- `pnpm build`：退出 0。
