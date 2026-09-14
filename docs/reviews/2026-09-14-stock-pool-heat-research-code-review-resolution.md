# 股票池热度研究 Review 修复记录（2026-09-14）

审查输入：`docs/reviews/2026-09-14-stock-pool-heat-research-code-review.md`（R01–R16，6 P1 + 10 P2），对照 H1–H4 子计划与设计合同。本轮只改代码与离线测试，未连接真实 RPC、未启动采集、未改线上阈值、未提交、未执行第 14/28 天容量与实链验收。

## 处理结论

| ID  | 处理 | 实现与验证依据 |
| --- | --- | --- |
| R01 | 已修复 | `targetAnchorMissing` 改为逐 scope 校验固定目标 hash，任一 scope 冲突即拒绝完成；新增 `historyBranchDivergence` 跨 scope 同高冲突检测，run 前 `reconcileHistoryJobBranches` 按目标匹配选择保留分支、对另一 scope 失效到最后一个双方一致锚点（无一致点则整 scope 重建）后再补缺口，并写入 job `notes`。回归：`tests/integration/history-job-integrity.test.ts` 首例（伪造操作分支 200 锚点，运行后该锚点被清除、作业 complete、notes 记录 divergence）。 |
| R02 | 已修复 | bootstrap 不再把 accepted cursor 当作覆盖证明：新增 `verifiedCoverage`（复用 `acceptedCoverage` + 实际 discovery selector 计划）计算 `missingIntervals(floor..target)`，按缺口驱动循环（`gapIndex`，每段不超过缺口终点）；发现前缀/内部缺口低于已接受 tip 时撤回并重建该 scope 后从 floor 重采。回归：`catalogue-target-coverage.test.ts` 首例（只含已接受 `[150,200]` 的库最终补齐 floor..200，且 manifest 含从 90 开始的新批次）。 |
| R03 | 已修复 | 批次 end 落在固定目标高度但 hash 与声明目标不同时立即拒绝（`target-anchor-changed`）；`confirmTarget` 在完成前重新核对目标锚点、已接受 tip 锚点与 tip 高度一致性，仅按高度判断被移除。回归：同文件第二例（扫描期间换链后 targetAnchor 与 acceptedTip hash 不一致、状态 incomplete 且 missing 含 `target-anchor-changed`）。 |
| R04 | 已修复 | export 在单个 SQLite 读事务中装配派生时间证据：新增 `assembleBatchEvidence`，按 `log_times`/`minute_boundaries`/`anchors` 合并 batch 的 `logTimes/anchors/boundaries`；仍无分钟的事件计入 `timeQuality.unresolvedLogs` 并产生 `time-unresolved` issue 使导出不完整；recorded-observed 模式下由派生表补出的分钟被标记（`derivedTimes` + `recorded-observed:derived-time-not-recorded-at-capture`）。回归：`tests/integration/replay-export-evidence.test.ts`。 |
| R05 | 已修复 | v2 reader 传播 `export.excluded`（逐条转 issue，batch 内嵌条目保留 batchId）、`timeQuality.unresolvedLogs`、recorded-observed 派生时间标记，并独立用已接受批次重新推导 `fromBlock..toBlock` 覆盖，缺口产生 `declared-range-coverage-missing`；该 issue 进入 replay integrity，使 replay 返回 incomplete。回归：同文件第二例覆盖 export → reader → replay 全链路。 |
| R06 | 已修复 | 新研究入口接入有界网格与滚动信号状态机：`runStudyExperiments` 用 `gridSchema` 校验并展开参数，对同一 rolling 评价点调用 `evaluateSignal` 产生候选提醒，按配置分段统计提醒/独立 episode/每小时提醒率与 15/60/180 分钟结果窗（结果窗在分段边界右截尾），按训练段 episode 选参并冻结（保存 `frozenHash`），再在验证/测试段输出全部候选。无参数或超限网格直接判为 `study-grid-unavailable` 而非完成。回归：`tests/integration/study-execution.test.ts` 三例。 |
| R07 | 已修复 | 新增 `withRecovery` 统一分类恢复，批次 end anchor 读取与初次 checkpoint 重核都走同一可中断路径：临时失败记录 `discovery-retry`（phase=anchor）后退避重试，budget/deadline/停止返回可续跑，永久错误仍然抛出。回归：`catalogue-target-coverage.test.ts` 后两例（批次前 anchor timeout、checkpoint 重核 rate-limit 均恢复完成）。 |
| R08 | 已修复 | catalogue 报告按固定目标高度过滤池与归因，目标早于后采范围时不再包含未来创建的池。回归：同文件第四例（target 200 后查询 target 80，`poolCount`/归因均为 0）。 |
| R09 | 已修复 | 冻结输入校验只比较 config/watchlist 快照，不再重新 hash 运行中的 source 主文件；study DB 必须由 prepare 建立，缺失时拒绝并提示重新 prepare，`reviewHistory` 也不再从活跃源库静默重建 study DB。回归：`history-job-integrity.test.ts` 第二、三例（source 增表后仍可续跑；watchlist 变化仍拒绝）。 |
| R10 | 已修复 | `reviewHistory` 增加独立时间补证阶段 `repairLogTimes`：存在未归时日志时创建共享预算 reader，复用已接受原始日志与锚点/分钟边界证据，通过 `SqliteRangeStore.recordLogTimes` 合并写回，仅剩余未解析才记为 unavailable。回归：同文件第四例（清空 log_times 后单次 run 归时完成，RPC>0）。 |
| R11 | 已修复 | 新增 `analysisWindowMissing`：用固定区间内已验证锚点的时间上下界校验 `analysisStart-warmup .. analysisEnd+outcome` 是否被包含；run 阶段按要求补取端点锚点后复验，不满足保留待验证状态（`analysis-window-unproven`），并写入报告 `requiredContext/contextProven`。回归：同文件第五例。 |
| R12 | 已修复 | 新增 `cadenceWatermarks`：chain-time 只用分钟水位与事件精确时间构造评价点，按请求 cadence 分桶保留最早可证明点；无法达到请求 cadence 时输出 `evaluation-cadence-unprovable` 并报告 `effectiveCadenceSec`，不伪造中间锚点。回归：`tests/integration/rolling-replay.test.ts` 新增用例。 |
| R13 | 已修复 | 完成判定区分“源数据集完整”和“请求研究期完整”：三个分段任一没有评价点、warmup 前文或 outcome 后文超出可评价范围都会产生 issue 并把结论降为 `insufficient-data`/`insufficient-evidence`，状态 incomplete、CLI 退出 4。回归：`study-execution.test.ts` 第二例（分段移到数据之后，`splitCounts.outside=79`，三段均 0 且不全绿）。 |
| R14 | 已修复 | `compactStorage` 在发布前对目标执行 `VACUUM` 并再次 checkpoint，报告新增 `physical`（源/目标 DB+WAL 字节、节省字节与比例）。回归：`storage-compact.test.ts` 新增用例（源库含空闲页，目标 `freelist_count=0` 且 `savedBytes>0`）。 |
| R15 | 已修复 | 超过 64 MiB 的整批 payload 改为 `batch-ref-v2`：有序分片对象（每片 ≤64 MiB、内容寻址去重）+ 整批 hash 与长度，读取时重组并校验；对象缺失/长度或 hash 不匹配仍然失败，事务内写入保持原子性；旧 `batch-ref-v1` 与 legacy inline JSON 继续可读。回归：`tests/unit/payload-store.test.ts` 新增用例（约 72 MB、2 片，往返无损，删片后明确失败）。 |
| R16 | 已修复 | `pruneSignalDerivedHistory` 在同一事务内回收无引用 payload 对象：清点 ingest_batches / signal_evaluations 中 v1/v2 envelope 的 hash 引用集合，只删除无引用对象，返回 `payloadObjects` 计数；失败回滚会同时保留评估行与对象。回归：`tests/integration/payload-retention.test.ts` 三例（共享引用保留、失败回滚、批引用保活）。 |

## 计划合同对齐说明

- 目录 complete 仍限定 chainId/assetVersion/protocolVersion/固定 targetAnchor，并保留 providerCompletenessAssumption 与 excluded。
- 历史作业仍使用独立 study DB；成功 HTTP 不等于完整数据；预算、停止、失败状态语义不变，新增的 reconciliation 与时间补证都共享同一次 run 的预算。
- 研究路径只读固定数据集，`onlineRuleChanged: false` 保持不变；候选选择只写研究报告，不写回 `config/signals.initial.json`。
- 未新增自动重试上限、未提额、未接第三方数据源、未改动 default follow 的 latest 语义。

## 本轮验证

- `pnpm typecheck`：退出 0。
- `pnpm test`：111 文件 / 891 测试全部通过（新增 5 个测试文件；另在 6 个既有文件补充用例或同步断言：rolling-replay、payload-store、storage-compact、history-job、replay-export、alert-reorg）。
- `pnpm lint`：退出 0。
- `pnpm build`：退出 0。
- 新增/调整的测试均使用临时 SQLite、mock RPC 与合成夹具；未连接真实 RPC。

## 未运行 / 待办

- H5 实链目录、一天级资源基准、14–28 天数据、阈值有效性：未运行。
- 大库 catalogue 的覆盖复算成本（每个 run 至少一次全量 accepted 覆盖验证）未做容量实测，H5 应按目标范围记录耗时。
- R06 的候选结论在真实数据下仍需按 H5.3 重新验收；本轮只证明执行路径、分段裁剪与冻结候选可用。
- 复核建议顺序仍按原报告：数据正确性 → 恢复续跑 → 研究执行 → 边界与存储。
