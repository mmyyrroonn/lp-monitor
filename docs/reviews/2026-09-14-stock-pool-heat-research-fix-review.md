# DeepSeek 修复提交复核

日期：2026-09-14  
审查提交：`e8464e6..5a9abb8`，29 个文件。  
参考：上一轮 `2026-09-14-stock-pool-heat-research-code-review.md` 与本次 `2026-09-14-stock-pool-heat-research-code-review-resolution.md`。

## 结论

原 16 项中，**11 项在原复现场景下可关闭，5 项部分修复**。本轮确认 **6 个剩余问题：4 个 P1、2 个 P2**。不能接受“R01–R16 全部解决”的结论。

类型检查、构建、全量 **111 文件 / 891 测试**通过。以下问题由额外 mock RPC、临时 SQLite 和明确事件时间的离线复现发现；既有绿色测试未覆盖这些边界。未连接真实 RPC，未修改业务代码或生产库，未运行 H5。

## 剩余问题

### F01 [P1] 两个 scope 一起过期时，仍拼接旧前缀和新分支并报 complete

对应原 R01；位置：`src/ops/history-job.ts:186–187`，调用在 511–516 行。

新 reconciliation 只比较两个本地 scope；两者没有差异就直接返回，没有向本次 reader 证明已接受前缀属于固定目标分支。

复现：

1. 两个 scope 都录制旧分支至块 200。
2. mock 链从块 150 重组，推进至新块 220。
3. prepare 固定目标为新块 220 hash `…27ec`，范围 120–220。
4. run 仅补 201–220，返回 `complete / missing=[] / notes=[]`。

结果两个 scope 都同时保存旧块 200 `…00c8` 和新块 220 `…27ec`；active logs 保留撤回的旧块 180 交易，却漏掉替代分支块 185 的交易。

应在复用旧覆盖前，用共享 reader 校验已有 checkpoint 与固定目标，定位共同祖先并失效受影响范围。两个 scope 相互一致不能证明它们仍在有效链上。

补充同根因：固定旧目标已失效的场景，reconciliation 会在 RPC 验证前清空操作 scope；反复 resume 仍重抓 120–200、每次消耗 38 次请求，始终 waiting-retry。应先确认目标仍有效，再决定回退和补采。

### F02 [P1] 目录最终确认发现重组后，失效池仍可被 follow 复用

对应原 R03；位置：`src/ops/recorder.ts:661–664`；667–669 同类分支。

`confirmTarget` 发现目标或 tip 改变时，只将报告降为 incomplete，没有撤销已接受范围、登记和派生状态。

复现：冷池只存在于旧分支块 170；最终确认块 200 时换链，目录返回 incomplete，但 DB 保留旧 acceptedTip200 和该池。随后同 DB 默认 latest follow 从 220 开始，**返回 complete / exit 0，并向失效池实际发送两次 operation getLogs**。

应回退到匹配 checkpoint 或明确失效受影响目录，再保存 incomplete。错误报告必须同步反映在可复用的数据库状态中。

### F03 [P1] 全部后续结果都被截尾，仍宣称 candidate-supported

对应原 R06；位置：`src/replay/study.ts:513–525`。

新 `validated` 只要求：训练选中、验证覆盖完整、有一个验证 episode、测试覆盖完整。它不检查任何完整结果窗、不检查选定的验证效果标准。

离线复现使用 79 分钟的完整夹具：

- train：300–1200 秒；
- validation：2700–3600 秒；
- test：3900–4800 秒；
- cadence 60 秒，warmup/outcome 配置均为 0（当前 schema 允许）。

输出 `status=complete / conclusion=candidate-supported / issues=[]`。被冻结候选的 train、validation、test 中，**15/60/180 分钟完整结果窗数量全部为 0**，有结果的窗均为 right-censored。例如候选 `2fa79bc483f64ed0` 的三段截尾窗数分别为 9、18、9。

应把“触发过提醒”和“后续表现支持候选标准”分开。候选支持判定需使用训练前确定的验证标准、可评价结果及样本要求；全部结果被截尾时必须保持证据不足。原来的网格执行缺口已补上，但验证结论仍不成立。

### F04 [P1] 滚动结果窗把触发前成交计入后续表现

对应原 R06；位置：`src/replay/study-run.ts:168–172`。

新入口把精确的 `logicalTimeSec` 先向下取整到分钟，再减 60 秒传给旧 minute-close outcome 函数。旧函数随后加回 60 秒，因此 delay=0 的结果从“发报所在分钟的开头”开始，早于实际触发。

复现：提醒在 **6050 秒**触发，唯一一笔 **30,000 USD** 成交发生在 **6020 秒**，触发后没有成交。研究却将其列为完整的 15 分钟后续结果：`swapCountTotal=1 / usdMicrosTotal=30000000000`，正确的触发后值应为 0。

应从实际触发秒数加反应延迟开始统计；有精确时间按秒过滤，只有分钟精度且跨边界无法判断的事件保留未知。不能直接套用旧 minute-close 的结果窗口径。1/5 分钟延迟同样存在不足整分钟的起点偏移。

### F05 [P2] cadence 只检查最小间距，漏掉长时间没有评价点

对应原 R12；位置：`src/replay/rolling-replay.ts:131–136`。

`unprovable` 由 `minimumSpacing(points) > cadenceSec` 决定。只要存在一对相邻点达到目标间距，其他大缺口就被忽略。

复现：请求每 10 秒评价，只有 **600、610、1200** 三个证明点。输出 `effectiveCadenceSec=10 / issues=[]`，中间 590 秒缺口没有报告。

应逐段检查请求评价计划的覆盖与间距，报告缺少的评价区间。可以保留最小间距作为统计量，但不能用它证明指定 cadence 得到满足。

### F06 [P2] 最终确认的临时 RPC 错误仍不进入恢复循环

对应原 R07；位置：`src/ops/recorder.ts:676–678`。

新增最终确认在将错误判为 `retry` 后直接返回 false。原批次 anchor 和初次 checkpoint 的恢复已修好，但这条新路径绕过 `withRecovery`。

复现：全部扫描已成功，最终 target recheck 出现一次逻辑请求的 `timeout-or-network`，报告 `incomplete / missing=[] / acceptedTip200`，没有 discovery-retry；运行和调用预算仍充足。生产请求级重试耗尽后同样会走此路径。

应将最终 target/tip 确认接入相同的有界、可中断恢复，沿用已有预算和停止条件。

## 原 R01–R16 关闭情况

“关闭”仅指原缺陷的复现场景与对应修复通过本轮复核，不代表整个模块获得实链或容量验收。

| 原项                          | 本次状态 | 复核结果                                                                                              |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| R01 分支混合却完成            | 部分修复 | 不同 scope 的目标冲突会阻止完成，但相同旧前缀仍可误过；见 F01                                         |
| R02 cursor 冒充完整覆盖       | 关闭     | 原 `[150,200]` 尾段补齐真实 `[0,200]`，DB missing=[]、poolCount=1                                     |
| R03 固定目标 hash 失配        | 部分修复 | 原场景不再 complete；最终冲突仍留下可复用失效池，见 F02                                               |
| R04 导出缺时间证据            | 关闭     | 按真实先 raw 后 timed 顺序录制的旧复现，现在导出及回放 complete、79 帧                                |
| R05 导出缺口在 reader 丢失    | 关闭     | 要求导出至 6000 时，export 与 replay 都保持 incomplete，含 declared-range-coverage-missing            |
| R06 未执行网格和结果分析      | 部分修复 | 已执行 36 组并冻结候选；结论及结果窗仍错误，见 F03/F04                                                |
| R07 anchor 错误绕过恢复       | 部分修复 | 原批次 anchor、初次 checkpoint 已恢复；最终确认仍绕过，见 F06                                         |
| R08 较早目标包含未来池        | 关闭     | target200 后查询 target80，poolCount=0、归因=[]                                                       |
| R09 source 更新阻断冻结 study | 关闭原项 | prepare 后 source 增表，合法上下文作业仍可 complete                                                   |
| R10 时间缺口永远不补证        | 关闭     | 18 次预算实际用 18 次后 paused；resume 再用 23 次完成，累计 41；没有重抓日志                          |
| R11 未验证研究上下文          | 关闭     | 原 5000–6000 秒与前后文 180 分钟场景保持 analysis-window-unproven                                     |
| R12 声明 10 秒实际 60 秒      | 部分修复 | 纯分钟点会明确报不足；稀疏点混有一次 10 秒间距仍漏报，见 F05                                          |
| R13 无研究分段数据也完成      | 关闭     | 三段无评价点被明确标记，结论 insufficient-data、状态 incomplete                                       |
| R14 compact 未回收空闲页      | 关闭     | 源 26,210,304 bytes → 目标 17,891,328 bytes；freelist=0，源 hash 不变                                 |
| R15 超过 64 MiB 批次无法保存  | 关闭     | 合法范围 72,881,087-byte 批次分成两片，save→read→accept 成功接受 1,200 条日志；反转片序 hash 校验失败 |
| R16 retention 遗留对象        | 关闭     | 共享引用、批次引用与回滚测试通过；v2 分片保活，GC 仅删除独立 orphan                                   |

## 验证及容量边界

- `pnpm build`：退出 0；先构建再测试，避免上一轮 dist 缺失导致的环境误报。
- `pnpm typecheck`：退出 0。
- `pnpm test`：**111 文件 / 891 测试全部通过**，本次用时 51.01 秒。
- 独立定向复测：H1 4 文件 / 10 测试；H3 5 文件 / 18 测试；H2 5 文件 / 37 测试通过。
- 旧 DB 无 payload_objects 时 readonly 读取 79 条日志正常，bigint 还原正常，没有补建表或迁移。
- 72.9 MB 批次连续保存、读取、接受、GC 后再读取的测量峰值 RSS 约 **1.56 GiB**。分片消除了单对象上限，但处理仍整批序列化、重组、比较，不能据此宣称固定内存或流式完成。此为实测限制，不另计一个 P2。
- 未进行生产规模长历史性能验证、真实 RPC 或阈值有效性验证。

## 本机复现证据

临时目录可能被系统清理，关键触发条件与测量结果已写入上文。

- F01 脚本：`C:/Users/myron/AppData/Local/Temp/h3-fix-review-branch-20260914.mts`
- F01 输出：`C:/Users/myron/AppData/Local/Temp/h3-fix-branch-JXxZlR/result.json`
- F01 旧目标反复重抓：`C:/Users/myron/AppData/Local/Temp/h3-fix-stale-target-f0X67V/results.json`
- F02/F06 脚本：`C:/Users/myron/AppData/Local/Temp/h1-fix-boundary-UnFOQ5/reproduce-fix-boundaries.mjs`
- F02/F06 输出：`C:/Users/myron/AppData/Local/Temp/h1-fix-boundary-UnFOQ5/reproduce-output.jsonl`
- F03 配置及结果：`C:/Users/myron/AppData/Local/Temp/review-fix-h4-Ys2SSt/supported-study.json`、`supported-evidence.json`、`supported-out`
- F04 输出：`C:/Users/myron/AppData/Local/Temp/review-fix-h4-Ys2SSt/outcome-before-trigger.json`
- R04/R05 复测导出：`C:/Users/myron/AppData/Local/Temp/review-fixed-export-YC8lMi`
- H2 compact 复测：`C:/Users/myron/AppData/Local/Temp/lp-h2-fixreview-muoNlL/compact.sqlite`
- H3 时间预算与 source 更新：`C:/Users/myron/AppData/Local/Temp/h3-fix-budget-YLzBC7/results.json`

建议下一轮先修 F01/F02 的分支复用，再修 F03/F04 的研究正确性，最后收口 F05/F06。修复用例应断言数据库中有效数据、后续 follow 行为和实际统计值，不能只断言报告状态、存在结果字段或测试退出码。
