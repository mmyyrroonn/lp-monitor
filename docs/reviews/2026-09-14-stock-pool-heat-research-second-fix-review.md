# 股票池与热度研究：第二轮修复复核

审查日期：2026-09-14。基线 `5a9abb8`，目标 `main@865aef1`，范围 `5a9abb8..865aef1`。本次检查最新修复及其邻近边界，复用上一轮复现，并增加独立离线反例。

结论：上一轮 F01–F06 中 **4 项关闭、2 项部分修复**；本轮确认 **6 个待修问题：1 个 P1、4 个 P2、1 个 P3**。目录重组清理、最终 RPC 确认恢复和原 cadence 漏报已修复；研究支持结论与结果窗边界仍有错误，新目标预检引入两项预算回归。

本轮未修改业务代码、提交或合并，未连接真实 RPC、启动采集或运行 H5。仅新增本报告，复现使用临时目录和模拟数据。

## 待修问题

### G01 [P1] 完整结果窗数量仍被当作热度标准得到支持

位置：`src/replay/study.ts:520–526`，关联 `529–534`；上一轮 F03 部分修复。

`meetsRequirement` 仅检查结果窗的 `complete` 数量，没有检查任何预先声明的后续热度效果标准。完整覆盖只能证明结果可评价，不能证明候选标准有效。测试段也只要求覆盖完整。

端到端反例使用项目的 batch/交易夹具与原生 `studyWithConfig`：训练段 300–1200 秒包含热点；验证段 1300–2600 秒，第二个池在 1330 秒出现一次 30,000 USD 成交，此后无成交；测试段 3000–4000 秒没有 episode。配置主结果窗 15 分钟、至少 1 个完整窗。输出为：

```text
status=complete
conclusion=candidate-supported
validationSatisfied=true
issues=[]
冻结候选 1991fd98c810d819：
  validation episodes=1
  15m / delay=1m：complete=1，swapCountTotal=0，usdMicrosTotal="0"
  test episodes=0
```

应将“可评价样本门槛”和“效果通过标准”分开：使用训练前声明的成交量、相对基线、持续性等验证规则评估真实结果；尚未定义或未通过效果标准时保留 `insufficient-evidence`。本次修复确实使上一轮“全部右截尾”的原始反例返回证据不足，但没有补齐效果判定。

证据：`C:/Users/myron/AppData/Local/Temp/review-865aef1-h4-BsWz2c/zero-forward-evidence.json`。同目录保留 `zero-forward-study.json`、`manifest.json`、原始 batch 与完整研究输出，可直接再次运行。

### G02 [P2] 结果窗右边界的分钟精度事件被直接计入

位置：`src/replay/study-run.ts:232–238`；上一轮 F04 部分修复。

左边界已检查跨分钟的不确定性，但右边界只排除 `minuteStartSec >= boundEnd`。事件所在分钟与窗口终点相交时，不能据此确认事件发生在窗口内。

纯函数反例：触发 6050 秒，15 分钟结果窗为 `[6050,6950)`；一笔 5,000 USD 交易仅有 `minuteStartSec=6900`、`exactTimestampSec=null`。其实际时间可能是 6955 秒，已经在窗口之外，函数却返回 `complete / swapCount=1 / usdMicros=5000000000`。应对右边界相交分钟同样保留 `unresolved-event-time`，不能生成完整金额合计。

对照：时间精确为 6950 秒时，会被正确排除。原始 F04 的 6020 秒成交也已不会进入 6050 秒触发的后续结果窗。

### G03 [P2] 缺少末分钟覆盖仍生成完整的零成交结果

位置：`src/replay/study-run.ts:210–212`。

当 `minute + 60 > coverage.endSec` 时，循环直接跳过覆盖核验，没有添加缺口原因；最终完整性也没有要求 `coveredMinutes === expectedMinutes`。

纯函数反例：结果窗仍为 `[6050,6950)`，`coverage.endSec=6950`，明确移除 6900 分钟的覆盖记录，其他覆盖完整且没有事件。函数返回：

```text
status=complete
coveredMinutes=15
expectedMinutes=16
swapCount=0
usdMicros=0
```

最后 50 秒没有覆盖证据，却被表示为已验证的零成交。应核验每个与结果窗相交的分钟；缺少末分钟证据时保持不完整及空合计。若上界代表分段裁剪，也不能省略裁剪之前那部分的覆盖核验。

G02/G03 的证据：`C:/Users/myron/AppData/Local/Temp/review-865aef1-h4-BsWz2c/outcome-right-boundary-evidence.json`。

### G04 [P2] 目标预检耗尽次数预算后仍额外发起 RPC

位置：`src/ops/history-job.ts:616–619`。

新增 `verifyFixedTarget` 已消耗 1 次请求，之后 `Math.max(1, options.maxRpcCalls - targetRunCalls)` 会把剩余的 0 次强制增加为 1 次。

模拟实际 reader meter 的复现：`maxRpcCalls=1`，创建两个 reader，各自额度为 1；实际请求 2 次，`currentRunRpcCalls=2`，最终 `paused`。应在剩余预算为 0 时暂停，或者让预检与后续流程共用同一个预算计量器。

### G05 [P2] 目标预检在时间预算之外执行，随后重新计时

位置：`src/ops/history-job.ts:467–472`，关联 `620`。

预检 reader 没有收到 `deadlineMs`；预检完成后，主流程才计算 `Date.now() + durationMs`。慢预检会占用额外时间，并在作业原本应结束后继续启动采集。

复现：`durationMs=25`，模拟目标读取延迟 150ms。第一个 reader 无 deadline；第二个 reader 在作业开始后 177ms 才创建，并得到开始后 195ms 的新截止时间；整个 run 为 220ms。此处问题不仅是一个已经在途的请求晚返回，而是超时后仍新建了后续流程。

应在作业开始时固定一个绝对截止时间，并贯穿预检、等待与后续采集。

G04/G05 的复现脚本：`C:/Users/myron/AppData/Local/Temp/h3-target-limits-review-20260914.mts`；结果：`C:/Users/myron/AppData/Local/Temp/h3-target-limits-j9GnF6/results.json`。

### G06 [P3] 最长连续活跃分钟漏掉最后一个相交分钟

位置：`src/replay/study-run.ts:255–257`。

遍历从非整分钟的 `startSec` 每次加 60，然后向下取整，会漏掉结果窗右端的相交分钟。相同 `[6050,6950)` 窗口，覆盖完整，唯一交易精确发生在 6920 秒，返回 `activeMinutes=1`，但 `longestActiveRunMinutes=0`。

应按与覆盖检查相同的整分钟槽遍历。目前这两个字段未进入 `StudyOutcomeSummary` 的汇总输出，所以此项列为 P3；若直接使用新导出的结果窗函数，已会取得错误的持续性统计。复现包含在上述 `outcome-right-boundary-evidence.json`。

## 上一轮问题关闭情况

| 上轮 ID                       | 本轮结论 | 复核证据                                                                                                                                                                          |
| ----------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 两 scope 共用旧分支前缀   | 关闭     | 原复现回退/重建，移除旧块 180 事件、保留新块 185，200/220 锚点属于新分支，最终 complete；旧固定目标仅 1 RPC 即 failed，保留旧证据且再次 resume 被拒绝。新增预算回归另列 G04/G05。 |
| F02 最终确认重组后遗留旧池    | 关闭     | 最终确认在块 200 换链后 acceptedTip=null、retainedPools=[]；随后 latest follow@220 complete/exit0，没有查询被撤销的冷池。                                                         |
| F03 无完整结果仍声明支持      | 部分修复 | 原始全部右截尾反例现在 incomplete/insufficient-evidence；完整但零成交结果仍 candidate-supported，见 G01。                                                                         |
| F04 触发前成交进入后续结果    | 部分修复 | 触发 6050 秒、唯一 6020 秒成交的原反例现在返回 0；新增函数的右边界、覆盖及持续性统计见 G02/G03/G06。                                                                              |
| F05 最小间距掩盖 cadence 缺口 | 关闭     | `[600,610,1200]` / 10 秒请求现在输出 1 个缺口 620–1200，并报告 evaluation-cadence-unprovable。                                                                                    |
| F06 最终确认瞬时错误不恢复    | 关闭     | 最终 anchor 一次 timeout 后记录 discovery-retry/phase=anchor，最终 complete/missing=[]。                                                                                          |

F01 最新复现结果：`C:/Users/myron/AppData/Local/Temp/h3-fix-branch-fzHKxL/result.json`。F02/F06：`C:/Users/myron/AppData/Local/Temp/h1-fix-boundary-UnFOQ5/reproduce-after-865aef1.jsonl`。F04/F05：`C:/Users/myron/AppData/Local/Temp/review-865aef1-h4-BsWz2c/old-f04-f05-evidence.json`。

## 验证

- `pnpm build`：通过；先构建，以确保依赖 dist 的测试使用本次代码。
- `pnpm typecheck`：通过。
- `pnpm test`：112 个文件、901 个测试全部通过；本轮全量一次通过，用时 51.01 秒。
- `pnpm lint`：通过。
- `git diff --check 5a9abb8..865aef1`：通过。
- 补充原始场景、合成研究数据与纯函数边界反例；上述缺陷未被现有 901 个测试覆盖。

测试日志：`C:/Users/myron/AppData/Local/Temp/lp-review-865aef1-tests.log`。

本轮未重新审查无改动的全部 H2 存储实现，也未扩大到生产规模历史性能或阈值有效性验收。上一轮记录的内存峰值与 H5 未运行状态仍是交接限制，本轮没有产生新的实链或容量验证结论。
