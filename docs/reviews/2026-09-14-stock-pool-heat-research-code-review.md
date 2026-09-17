# 最近实现代码审查：股票池目录、存储、历史与热度研究

日期：2026-09-14  
审查范围：`c30048f..e8464e6`，当前 `main@e8464e6`，67 个变更文件。  
方式：对照 H1–H4 计划审查，独立分模块复核，使用仓库合成夹具、mock RPC 和临时 SQLite 复现。未连接真实 RPC，未启动历史采集，未修改业务代码或生产数据库。

## 结论

确认 **16 项问题：6 个 P1、10 个 P2**。当前版本不能据此宣称完整池目录、固定分支历史与热度标准研究均已完成。建议先修复数据完整性和原生导出，再补齐研究执行路径，之后安排 H5 实链验收。

现有类型检查、构建和离线测试通过，不代表下述边界通过。2026-09-14 原验收报告中的“H1–H4 完成”与本轮复现不一致；修复后应重做相关验收并更新入口文档。

## P1：优先修复

### R01 历史续跑混合两个链分支，仍标记 complete

位置：`src/ops/history-job.ts:114`；补采集成在 347–360 行。

`targetAnchorMissing` 使用 `rows.some(...)`，只要任一 scope 的目标 hash 匹配，就忽略另一 scope 的冲突。补采前也没有核验固定目标及已接受覆盖所属分支。

复现：先录制操作 90–180，目录已到旧块 200；prepare 固定旧 200 hash 后模拟重组，再 run。结果为 `complete / missing=[]`，但目录 200 hash 为旧 `…00c8`，操作 200 hash 为新 `…27d8`；active logs 同时包含旧块 180 和新块 185 的同一交易 `…03ea / logIndex=2`。

后果：撤回事件和替代事件会一起进入统计。应拒绝目标冲突，核验所有相关 scope 与范围分支，失效受影响覆盖后再补缺口。

### R02 目录把最高游标当作完整历史覆盖

位置：`src/ops/recorder.ts:440–441`、571–572、656；错误 missing 报告在 1055–1068。

同一 discovery scope 的合法数据库若只包含已接受尾段 `[150,200]`，bootstrap 从 cursor 200 之后开始，不检查缺失前缀。catalogue target 200 返回 `complete / missing=[] / poolCount=0`，实际缺失 `[0,149]`，漏掉夹具中块 90 创建的池。

后果：漏池被当成“没有池”，直接破坏完整目录和冷池分母。应按实际 selector 验证 `floor..target` 的 accepted coverage，并从每个缺口恢复。

### R03 目录恢复后接受了新目标 hash，却仍对旧固定目标报完成

位置：`src/ops/recorder.ts:535–538`、656。

最终目标块 200 在扫描期间换链时，`refreshRetryAnchor` 改用新 hash 重新抓取，但 `catalogueTarget` 仍保存旧 hash。复现报告 `targetAnchor.hash=…00c8`、`acceptedTip.hash=…27d8`，仍是 `complete / missing=[]`。

应在完成前验证固定目标 hash；目标失效必须显式结束或记录目标修订，不能仅按高度判断。此项与 R01 分属 catalogue 和 history-job 两个独立路径。

### R04 原生导出没有装配数据库中已保存的时间索引

位置：`src/replay/export.ts:158–171`。相关写入顺序：`src/ops/recorder.ts:796`、834–853；`src/ops/history.ts:354–372`。

真实 recorder/history 路径先压缩保存原始 batch，随后解析时间，再通过 acceptRange 将时间写入 `log_times/minute_boundaries/anchors`。原 batch payload 不包含后加的时间信息。export 只读取 `readBatch`，没有读取这些派生表。

按真实顺序离线复现：源库有 **79 条时间记录、80 条分钟边界**；导出的 batch 两者都为 0，回放返回 `minute-boundary-missing / log-time-unresolved / no-evaluable-frames`。export 自己却返回 `complete=true`，同时在 timeQuality 中写 `unresolvedLogs=79`。

应在一致读快照中装配可用时间和登记证据；时间未知应进入完整性判定。chain-time 可使用已验证的派生证据；recorded-observed 还必须保留当时可用顺序，不能把今天补出的时间伪装成当时已知。

### R05 v2 reader 丢弃导出声明的范围缺口，使不完整数据变成 complete

位置：`src/replay/reader.ts:100–124`、244–250；被忽略的字段在 `src/replay/export.ts:255–269`。

reader 校验分片，但没有把 `export.excluded / coverage / fromBlock / toBlock` 纳入 replay 完整性。

复现：完整保存 `[60,4800]` 的批次和时间证据，要求导出到 6000。export 正确返回 `complete=false`、`coverage:4801-6000:accepted-coverage-missing`；reader 的 issues 却为空，随后 replay 返回 `complete`。

应传播导出缺口，并独立核验声明范围及 scope 的覆盖。验收需覆盖“export → reader → replay/study”整条链路，而不只检查文件 hash。

### R06 新研究入口没有执行参数比较和结果窗分析

位置：`src/replay/study.ts:418–421`、427–450、473–474。

`studyWithConfig` 对 grid 仅做 JSON.parse 和 hash，然后用 `initialSignalConfig` 跑一次旧 replay，再计算 rolling windows。没有将网格参数传给实验引擎，没有训练选参/冻结、验证/测试评估，也没有 15/60/180 分钟结果分析；`warmupMinutes/outcomeMinutes` 只被解析。结论在有帧时固定为 `insufficient-evidence`。

复现：grid 为无任何参数的 `{}`，仍返回 `status=complete`；结果没有 experiments、候选参数或后续结果。此项并非真实样本不足，而是新执行路径尚未实现计划中的研究逻辑。

应接入有界参数网格、滚动信号状态机、按分段裁剪的结果窗与冻结候选验证；缺少必要研究步骤时不能按已完成研究验收。

## P2：应修复

### R07 批次开始前的 anchor 故障仍绕过目录恢复

位置：`src/ops/recorder.ts:576–583`；初次 checkpoint 重核 562–570 有同类分支。

已接受 `[0,49]` 后，获取下一批次 end anchor 99 的 `timeout-or-network` 直接抛出，报告 `failed / exitCode=3`，没有 `discovery-retry`，仍有足够时间和请求预算。生产请求级重试耗尽后同样会走此路径。

应把 anchor 读取、checkpoint 重核接入同一可中断的外层分类恢复。当前“RPC 恢复完成”的覆盖范围不包括全部启动请求。

### R08 查询较早目录目标时包含未来才创建的池

位置：`src/ops/catalogue.ts:142–144`。

同 DB 先完成 target 200，再请求 target 80，报告读取整个 scope 的所有池，返回 `poolCount=1`，包含块 90 才创建的池，预期为 0。池数和股票归因都应按目标高度及有效分支过滤。

### R09 已冻结 study 仍依赖运行中的 source 文件保持不变

位置：`src/ops/history-job.ts:299–305`；源库 hash 纳入位置 `src/storage/history-jobs.ts:183`。

prepare 已完成一致 backup，run/resume 却每次重新 hash 原 source 主文件。源 recorder 正常写入并 checkpoint 后，作业就会永久变为 failed，虽然冻结的 study 未变。

复现：prepare 后只在临时 source 增加一个无关表，run 抛出 `History job input snapshot changed; prepare a new fixed job`。应验证被冻结的输入身份，不能要求实时源库永远不变。

### R10 仅有时间缺口时，history-job 永远不会补证

位置：`src/ops/history-job.ts:347–360`；实际阻断条件 `src/ops/history.ts:290–305`。

job 虽显示 `phase=time`，调用的 reviewHistory 只在操作/目录缺口存在时创建 reader；resolveLogTimes 仅用于新批次。

复现：本地 `[120,200]` 日志覆盖完整但块 120、180 缺时间，连续两次 run 都是 `waiting-retry / time`，缺口不变，**RPC 请求总数 0**。应有独立时间补证阶段，复用已接受日志，共享预算。

### R11 history-job 完成判断不验证研究日期及前后文

位置：`src/ops/history-job.ts:382–388`。

`analysisStartSec/analysisEndSec/warmupMinutes/outcomeMinutes` 未进入完成条件。复现中所有锚点时间仅 1000–1200 秒，研究却指定 5000–6000 秒、前后文各 180 分钟，仍返回 `complete / missing=[]`。

应验证固定区块范围包含分析期间、预热及结果上下文；无法证明时保留待验证状态。与 R13 不同，此处是采集作业层的完整性。

### R12 cadenceSec=10 实际仍每 60 秒评价

位置：`src/replay/study.ts:427–430`、443–448；`src/replay/rolling-replay.ts:89–93`、119–122。

chain-time 调用旧 minute-close，再使用旧 frames 的时间点。cadence 只写入报告及比较过密点，没有生成指定评价计划。

同一完整夹具分别配置 10 和 60 秒，两者都生成 **79 个评价点，间隔均为 60 秒**，无 issues。会漏掉分钟内部的突发和触发顺序。

应按可证明链上时间生成指定 cadence 的评价点，使用相同 rolling/live 引擎；时间证据不足应明示，不能假造锚点或声称已按 10 秒评估。

### R13 三个研究分段完全无数据仍报 complete

位置：`src/replay/study.ts:459–464`。

完成判定只看源 replay 状态和 issues，不检查配置期间的覆盖、评价点和预热/结果窗。将所有 periods 移至数据结束之后，报告仍为 `complete / insufficient-evidence / issues=[]`，train/validation/test 都是 0，outside 为 79。

应区分源数据集完整与请求研究期间完整，无样本和覆盖不足必须影响状态与 CLI 退出码。

### R14 compact 没有回收 SQLite 空闲页，物理文件反而变大

位置：`src/ops/storage-audit.ts:193–195`。

转换后只做 WAL checkpoint，没有压紧目标文件。10,000 日志合成源库 **26,210,304 bytes**，compact 后 **26,316,800 bytes**，空闲页 1,947；仅对临时目标执行 VACUUM 后才变为 **17,891,328 bytes**。

应在独立目标发布前回收空闲页，并按最终物理 DB/WAL 字节验收节省比例。源文件 hash 保持不变。此数据是合成负载，不外推真实日均容量。

### R15 超过 64 MiB 的合法聚合批次没有分片保存

位置：`src/storage/payload-store.ts:286–288`。

整个 batch 被交给单次 putPayload；单 RPC shard 的响应限制没有约束所有 shards 合并后的批次大小。90,000 日志、20 shards、**71,813,887 bytes** 的批次报 `Payload exceeds the 64 MiB uncompressed limit`，落库后 batches/rawLogs 都为 0。

可能在历史拉取已付出 RPC 成本后无法保存，也会让含大 inline batch 的旧库 compact 失败。应使用有序分片/对象引用或明确约束整个批次，同时保留无损重组、哈希和原子性。

### R16 retention 删除评估行后留下永久无引用对象

位置：`src/signals/project.ts:74–77`；清理函数 654–673。

新增评估内容写入 payload_objects，但 pruneSignalDerivedHistory 只删 signal_evaluations。

真实 alert 夹具复现：evaluations=1、objects=1、payload=376 bytes；清理为 evaluations=0 后，objects=1、376 bytes 仍存在。长期录制加定期维护会累积无法被现有清理释放的评估对象。

应安全回收已无任何引用的对象，保留 batch 与其他评估共享的内容；需测试共享引用和事务中断。

## 本轮验证

- `pnpm typecheck`：退出 0。
- `pnpm test`：首次 106 文件、869 测试，其中 848 通过；21 个 P6 测试因旧 dist 缺少新 payload-store 模块失败。
- `pnpm build`：退出 0。
- `pnpm exec vitest run tests/integration/p6-assessment.test.ts --reporter=dot`：21/21 通过。加上首次通过项，现有 869 项最终全部通过；没有将首次失败隐藏为一次全绿。
- 独立 H1 定向回归 9 文件 / 25 测试通过，H3 定向回归 3 文件 / 6 测试通过。
- 上述 16 个问题使用额外离线复现识别；已有测试未覆盖相应边界。
- 本轮未跑实链、14–28 天容量/性能验收、真实通知或阈值有效性验证。

## 复现证据

以下为本次本机临时证据，可能被系统清理；关键输入及结果已在上文保留。

- H1 脚本：`C:/Users/myron/AppData/Local/Temp/h1-review-nSlaHQ/reproduce.mjs`
- H1 输出：`C:/Users/myron/AppData/Local/Temp/h1-review-nSlaHQ/reproduce-output.jsonl`
- H1 DB/运行证据：`C:/Users/myron/AppData/Local/Temp/h1-review-repro-tJaARl`
- H3 脚本：`C:/Users/myron/AppData/Local/Temp/h3-review-verified-20260914.mts`
- H3 输出：`C:/Users/myron/AppData/Local/Temp/h3-verified-findings-YjzdIP/results.json`
- H4 参数/频率/空分段报告：`C:/Users/myron/AppData/Local/Temp/replay-78xQzh/out`
- H4 缺口丢失的两个 dataset：`C:/Users/myron/AppData/Local/Temp/review-export-full-t9lG3X`
- H4 真实写入顺序与时间丢失摘要：`C:/Users/myron/AppData/Local/Temp/review-native-times-avRBnk/review-evidence.json`
- H2 compact 临时库：`C:/Users/myron/AppData/Local/Temp/lp-h2-review-zqhIdO`；其中 compact 目标已为复现对照手动 VACUUM，不能用当前大小代替上文转换时测量。

可在仓库运行 H1/H3 的纯 mock 复现：

```powershell
Set-Location E:\lp-monitor
node --import tsx "$env:TEMP\h1-review-nSlaHQ\reproduce.mjs"
node --import tsx "$env:TEMP\h3-review-verified-20260914.mts"
```

建议修复顺序：R01–R05 数据正确性 → R07/R09/R10 恢复与续跑 → R06/R11–R13 研究执行 → R08/R14–R16 边界与存储。每项应增加能失败的回归用例，再修实现。修复后需重新核验固定目标、源库隔离、原生导出到 study 的完整链路及容量上限。
