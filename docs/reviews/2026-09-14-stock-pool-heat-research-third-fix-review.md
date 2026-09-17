# 股票池与热度研究：第三轮修复复核

审查日期：2026-09-14。基线 `865aef1`，目标 `main@d90206e`，范围 `865aef1..d90206e`。本轮检查 G01–G06 的修复，并验证新增基线、事件边界过滤和预算路径。

结论：上一轮 **5 项关闭、1 项部分修复**；本轮确认 **3 个 P2**，未发现新的 P1。显式 RPC 次数预算、共享截止时间、零后续成交判定、末分钟覆盖和活跃统计的原始反例均已通过。默认预算仍漏修；新的结果窗过滤和相对基线各有一处错误。

本轮仅审查及新增本报告。没有修改业务代码、Git 提交或生产数据库，没有连接真实 RPC 或运行采集。所有补充复现均使用模拟事件、临时配置及临时数据库。

## 待修问题

### J01 [P2] 完全在窗口之后的分钟精度事件会污染已完成窗口

位置：`src/replay/study-run.ts:227–231`。

`collectWindowEvidence` 修复右边界相交事件时，遗漏了对 `minuteStartSec >= toSec` 的完全窗外排除。现在右侧所有分钟精度事件都会命中 `minuteStartSec + 60 > toSec`，被标记为 `unresolved-event-time`。调用方的 `candidates` 包含池的全时段事件，因此无关的后续成交会让已有窗口和基线失效。

纯函数复现：触发 6050 秒，覆盖完整；精确 5200 秒成交 1,000 USD，精确 6110 秒成交 5,000 USD。原 15 分钟结果为：

```text
status=complete
usdMicros=5000000000
baselineUsdMicros=1000000000
relativeMultiple=5
```

额外加入一条 `minuteStartSec=18000 / exactTimestampSec=null` 的事件后，15/60/180 分钟窗口全部变为 `incomplete / unresolved-event-time`，金额和基线均为 null。该事件所在分钟完全在三个窗口之外。将其改为精确 18010 秒，原结果保持正确。

应先排除完全位于窗口两侧的事件，仅对确实与左右边界相交、无法确定归属的分钟精度事件保留未知。补充测试需覆盖：远端分钟事件不改变较早窗口；前向窗内的分钟事件也不能污染前置基线。

证据：`C:/Users/myron/AppData/Local/Temp/review-d90206e-h4-UNF4ph/boundary-evidence.json`，含有无远端事件、精确时间对照及 G02/G03/G06 原场景。

### J02 [P2] 相对倍率的基线随反应延迟偏移，混入触发后成交

位置：`src/replay/study-run.ts:299–301`，关联 `src/replay/study.ts:524`、`534–537`。

`baselineUsdMicros` 的定义是同长度的触发前窗口（`study-run.ts:179`），实际却以 `startSec = triggerSec + reactionDelayMinutes * 60` 作为基线终点。延迟为 1/5 分钟时，触发后的等待期成交被加入分母，同时较早的触发前成交可能被移出。

纯函数复现，触发 6050 秒、主窗口 15 分钟、覆盖完整：

| 时间    |    成交量 | 相对触发的位置           |
| ------- | --------: | ------------------------ |
| 5600 秒 | 1,000 USD | 触发前                   |
| 6070 秒 | 9,000 USD | 触发后，在等待期内       |
| 6500 秒 | 5,000 USD | 1/5 分钟延迟后的结果窗内 |

delay=1 和 delay=5 均输出：前向成交 5,000 USD，基线 10,000 USD，倍率 0.5。按照声明的触发前口径，基线应为 `[5150,6050)` 中的 1,000 USD，倍率应为 5。

新 `study.ts` 明确读取 delay=1 的结果，并应用 `minimumRelativeMultiple`。若最低倍率为 1，该结果窗会从满足条件变为不满足；这会影响启用了相对倍率条件的候选验证。默认 `minimumRelativeMultiple=null` 时，该错误不会影响未启用的倍率门槛。

应固定前置基线为 `[triggerSec - horizon, triggerSec)`，只有前向结果窗随反应延迟移动。如果产品想比较开始行动前后两个相邻窗口，应先明确另一个指标口径，不能沿用当前“触发前基线”的定义。

证据：`C:/Users/myron/AppData/Local/Temp/review-d90206e-h4-UNF4ph/baseline-and-g01-evidence.json`，包含 delay=0/1/5 对照。本项确认的是基线及倍率偏移，不是收益或线上信号计算的验证结论。

### J03 [P2] 配置默认 RPC 预算仍未扣除目标预检

位置：`src/ops/history-job.ts:598–599`，关联 `src/ops/history.ts:367`；上一轮 G04 部分修复。

显式传入 `maxRpcCalls` 时会正确扣除预检，但省略该选项时 `remainingCalls` 保持 undefined。随后主 reader 使用完整的 `config.recorderMaxRpcCalls`，预检的一次请求仍在默认预算之外。

在临时配置中设置 `recorderMaxRpcCalls=1`，省略 `maxRpcCalls`，复现结果：

```text
configuredBudget=1
maxRpcCallsOption=omitted
两个 reader：maxCalls 分别为 1、1
actualCalls=2
currentRunRpcCalls=2
status=paused
```

应先取得有效预算 `options.maxRpcCalls ?? input.config.recorderMaxRpcCalls`，再扣预检消耗，并在余量为零时暂停。

复现脚本：`C:/Users/myron/AppData/Local/Temp/h3-limits-default-review-20260914.mts`。结果：`C:/Users/myron/AppData/Local/Temp/h3-limits-default-L12Apq/results.json`。原项目配置没有被修改。

## G01–G06 关闭情况

| 上轮 ID                | 本轮结论 | 本轮实测                                                                                                                                                                                                     |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G01 零成交仍支持候选   | 关闭     | 上轮原始数据和配置经 studyWithConfig 重跑，完整验证窗的 minimumSwapCount=0、minimumUsdMicros="0"，现在输出 incomplete / insufficient-evidence / validation-requirement-not-met。新增相对基线的问题另列 J02。 |
| G02 右边界分钟事件误计 | 关闭     | `[6050,6950)` 中 minuteStartSec=6900 的不确定事件现在输出 incomplete/null。完全位于窗外的事件出现另一项回归，见 J01。                                                                                        |
| G03 缺末分钟仍报零     | 关闭     | 移除 6900 分钟覆盖后，covered=15、expected=16，状态 incomplete，金额和笔数均为 null。                                                                                                                        |
| G04 次数超预算         | 部分修复 | 显式 maxRpcCalls=1：仅一个 reader、实际 1 次后 paused；配置默认值路径仍实际 2 次，见 J03。                                                                                                                   |
| G05 预检与后续重新计时 | 关闭     | 慢预检收到原绝对 deadline，结束后不创建第二 reader；正常续跑的两个 reader 截止时间完全相同。                                                                                                                 |
| G06 最长活跃遗漏末分钟 | 关闭     | 6920 秒的唯一成交现在 activeMinutes=1、longestActiveRunMinutes=1。                                                                                                                                           |

额外恢复检查：先以显式预算 1 暂停，再续跑 22 次请求后 complete，累计 23 次；旧固定目标失效仍只请求 1 次即 failed，并保留原 active 数据。

预算及时间的原复现输出：`C:/Users/myron/AppData/Local/Temp/h3-target-limits-YTw2cY/results.json`。模拟慢调用自身的等待没有被取消，但过期后没有新启动后续采集；本次关闭证据针对共享 deadline 与不续期开工的行为。

## 验证及边界

- `pnpm build`：通过，先构建后测试。
- `pnpm typecheck`：通过。
- `pnpm test`：112 个文件、908 个测试全部通过；本轮全量一次通过，用时 50.96 秒。
- `pnpm lint`：通过。
- `git diff --check 865aef1..d90206e`：通过。
- 额外使用独立端到端研究数据、纯函数边界反例、带计量器的模拟 RPC 验证；上述 3 个缺陷未被现有测试覆盖。

测试日志：`C:/Users/myron/AppData/Local/Temp/lp-review-d90206e-tests.log`。

本轮没有扩展复核未修改的完整目录与存储模块，也未运行实链目录、容量基准或历史热度有效性验收。通过离线测试不等于 H5 已完成。
