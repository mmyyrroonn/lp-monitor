# P5 独立复审与修复清单 — 2026-09-10

复审对象：分支 `codex/p5-history` 上未提交的 P5 实现（`src/replay/`、`src/signals/` 改动、`config/history.cases.json`、`config/signals.grid.json`、`artifacts/p5/`）。复审不采信 [实现者自审](2026-09-10-p5-review.md) 与 [验收文档](2026-09-10-p5-acceptance.md) 的结论，独立读码并实测。

结论：**代码验收层面 typecheck / lint / 623 测试全部通过，但存在 1 个 Critical 与 4 个 Important，修复前不能视为 P5 通过。** 历史研究结论 incomplete 属于真实数据限制：四份本机 P1 manifest 全是 2026-09-08 的 5 分钟短录制，与七个案例的 09-03 至 09-07 区间完全不重叠，不是代码问题。

## 复审者独立核实

| 项目 | 结果 |
|---|---|
| `pnpm typecheck` | 退出 0 |
| `pnpm lint` | 退出 0 |
| `pnpm exec vitest run` | 61 文件，623/623 通过 |
| 默认实时配置 `config/signals.initial.json` 的 configVersion hash | `p4-v2:3e1fe9c3…` 与改动前逐字节一致 |
| 实时路径（`evaluationMode` 未传）与 HEAD 版引擎差分 | 12,000 组随机输入、4 种配置、4,449 次告警，0 处不一致 |
| `artifacts/p5/study-exit.json` | exitCode 4，networkCalls 0 |
| `artifacts/p5/results.json` | 36 组唯一、无冠军、cooldown 全 300、confirmRelative 全关；告警 / 结局窗口 / 首告警对比记录数均为 0 |

## 修复清单

每条按「位置 / 问题 / 触发 / 要求」给出。修复后需补回归测试并把真实命令输出贴回。

### C1（Critical）minute-close 下真实历史缺口导致回放崩溃，而非标 incomplete

- 位置：`src/replay/runner.ts:275-282`（catch 白名单）、`src/replay/runner.ts:238`（`store.acceptRange(b)`）、`src/ingest/completeness.ts:97-104`。
- 问题：catch 用**消息文本**正则 `/^(Stale range|Range gap|Incomplete|Missing|No accepted|Cannot project)/` 判断可恢复错误，但 `IncompleteRangeError` 的大多数消息不以这些词开头（`Filter … has a coverage gap`、`… does not cover the complete batch range`、`Not every batch log is covered by a successful shard`、`Range is not complete`、`Fetch shard X is not complete`）。第 288 行 detail 用了 `error.name`，说明原意是按类型捕获，实际按消息判断。
- 触发：minute-close 每帧对 `mergeHistoricalBatches` 的前缀调用 `acceptRange`；只要中间有一个批次被 reader 丢弃（`accepted:false` → `unaccepted-batch`）或产物缺失，合并范围出现 shard 缺口 → 抛错逃出 `replay()` → `src/cli.ts:271-273` 打印 `Internal error`，退出 1，报告与 issues 全部丢失。验收文档已承认真实录制含未接纳批次，这是真实数据的必经路径。
- 实测：三个连续批次、中间一个 `accepted:false`。minute-close：`THREW IncompleteRangeError: Filter operation-v3 has a coverage gap`；recorded-observed：`status=incomplete issues=["unaccepted-batch","minute-boundary-missing","projection-input-incomplete"]`（正确）。构造区块缺口的变体同样崩溃，栈顶 `runner.ts:238`。
- 要求：改为 `error instanceof IncompleteRangeError || error instanceof NoAcceptedScopeError || /^(Stale range|Range gap)/.test(message)`；命中后仍走 `projection-input-incomplete`；为「合并历史出现 shard 缺口」单列 issue code。补回归：中间批次未接纳 + 区块缺口两种输入，minute-close 必须返回 `status: 'incomplete'` 且不抛错。

### I1（Important）minute-close 告警绕过 live 的去重 / 修订，同一 alert id 重复计数

- 位置：`src/replay/runner.ts:246-267`（直接 `evaluateSignal` 后 `alerts.push`）；对照 `src/signals/project.ts:83-92`（`commitSignalDecision`：payload 相同返回 null，不同则 revision+1）。
- 问题：`AlertRecord.id = hash([chainId, poolId, version, episodeId, kind])`（`src/signals/engine.ts:268-274`），同一 episode 内第二次 candidate 与第一次 id 相同。live / recorded-observed 走 `commitSignalDecision`，得到一条告警的 revision 2；minute-close 直接 push，得到两条 `revision: 1` 的独立元素。
- 实测：两次相隔 10 分钟的 1m 尖峰、未升 hot，`alerts=2 distinctIds=1 revisions 1,1`。
- 影响：36 组网格的报警数、每小时通知数系统性高于实时语义；`report.alerts` 的 id 不是唯一键，下游按 id 建 Map 会静默丢样本。
- 要求：minute-close 侧复用 `commitSignalDecision` 的等价判定（按 id 折叠、payload 相同丢弃、不同记 revision）；或在 `ReplayReport` 同时给出去重后的 `alertIdentities` 与原始 `alertDrafts`，并让 `experiments.ts` 明确使用去重后的集合计算 alarmCount / notificationsPerHour。补回归：同 episode 两次 candidate 在 minute-close 下只计 1 条身份。

### I2（Important）原生 P1 manifest 无法回放，且真实 manifest 上产物哈希校验不执行

- 位置：`src/replay/reader.ts:28`（只认 `path/sha256`）、`src/replay/reader.ts:77`（仅 `ref.sha256` 存在时比对）、`src/replay/runner.ts:134-139`（无 `replay.input` 快照则整段跳过）；对照 `src/ops/recorder.ts:291-300, 431-439`（真实 batch 记录字段为 `id, scopeId, fromBlock, toBlock, manifestHash, completeness, logs, accepted`）。
- 问题 1：真实 manifest 没有 `replay.input` → `input-snapshot-missing` → 0 帧。仓库内 `artifacts/p5/replay-native-check/*/report.json` 即证据（`status incomplete, frames 0`）。仓库中没有任何从 P1 运行导出可移植 replay manifest 的实现（全库 `availableAtSec` 只出现在 `src/replay/` 与测试）。计划 Task 5.1 的验收命令 `pnpm lp replay --manifest artifacts/p1/manifest.json` 在真实数据上评估不了任何东西，只有验收脚本手工造的合成 manifest 能跑。
- 问题 2：真实 manifest 没有 `sha256` → 哈希校验永不执行；manifest 里现成的 `manifestHash`、`logs` 条数、`completeness`、`fromBlock/toBlock` 均未用于交叉校验。实测：把产物截断到 40 条日志并同步改 shard 的 logKeys/logCount 后，回放报告 `status=complete issues=[]`。
- 要求：(a) reader 至少校验 `ref.manifestHash === parsed.manifestHash`、`ref.logs === parsed.logs.length`、`fromBlock/toBlock` 一致；缺 `sha256` 时显式记 `artifact-hash-unavailable` issue，不得静默通过。(b) 提供从 P1 运行（库 + 运行摘要）生成 `replay.input` 的导出入口，或在计划与验收文档中明确写出「原生 P1 manifest 当前不可回放，需要导出步骤」并把 Task 5.1 对应复选框改回未完成。(a) 必做，(b) 二选一由用户决定。

### I3（Important）minute-close 复杂度 O(n²)，计划中的完整队列窗口不可行

- 位置：`src/replay/runner.ts:186`（每个批次重算 `mergeHistoricalBatches(historical)` 全部前缀）、`src/replay/runner.ts:238-245`（每分钟 `acceptRange` 整段前缀 + `SqliteProjectionStore.rebuild` 全量 + `buildMetricsReport` 对全历史重估值）。
- 实测（合成、每分钟 1 条日志）：

  | minutes | elapsedMs | msPerFrame |
  |---:|---:|---:|
  | 60 | 732 | 12.2 |
  | 120 | 2860 | 23.8 |
  | 240 | 14294 | 59.6 |
  | 480 | 74832 | 155.9 |

  每翻倍约 ×5。外推 1 天（1440 分钟）约 15–20 分钟，Task 5.2 的 09-03→09-07（5760 分钟）以小时计；`coverageHistory` 上限 10080 分钟说明设计允许 7 天。
- 要求：增量化——store 只接纳新增区间、projection 增量 rebuild、metrics 只在滚动窗口内重算；至少缓存 `mergeHistoricalBatches` 结果并只对新分钟生成前缀。若本轮不修，在验收文档中记为已知限制并给出实测数字，不得宣称可跑完整队列。

### I4（Important）`buckets: 1` 时未命中的 reason 标签描述了并未生效的规则

- 位置：`src/signals/engine.ts:162-168`。
- 问题：正向分支按 `buckets` 分流成 `one-complete-natural5m` / `two-consecutive-natural5m`，反向分支固定 `no-two-adjacent-above-threshold`。`buckets === 1` 时不要求两根相邻，唯一失败原因是「唯一那根 5m 未达绝对量」。
- 实测：最新一根不达标、前一根达标时，`buckets:1` 得 `kind:'hot'（来自前一根）/ reason:'no-two-adjacent-above-threshold'`。
- 影响：`matches` 整条落盘 `signal_evaluations`（`src/signals/project.ts:449`）。与 [P4 审查](2026-09-09-p4-review-findings.md) 已要求修掉的「reason 与实际命中路径无关」同类。实时路径不设 `buckets`，不影响生产。
- 要求：`buckets === 1 ? 'no-complete-above-threshold' : 'no-two-adjacent-above-threshold'`；在 `tests/unit/signals-confirmation.test.ts` 补断言。

### Minor

- **M1 验收文档措辞**：`2026-09-10-p5-acceptance.md`「交付」第 3 条描述的是代码路径，交付物中对应记录数为 0（`firstAlertComparisons`、`outcomeDistributions` 长度 0，`quality.horizons[*].total` 全 0，7 个 dataset 均为 `<case>:unavailable`，4 份 cohort `observedBirthCount` 全 0）。`artifacts/p5/report.md` 本身诚实。要求：验收文档明确写「本次运行未产生任何告警、结局窗口或首告警对比记录，这些能力仅由合成 fixture 测试覆盖」。
- **M2 delay=0 结果窗口径**：`src/replay/outcomes.ts:55` `startSec = triggerMinuteStartSec + 60 + delay*60`，调用方 `src/replay/experiments.ts:199` 取证据分钟 `close-60`，于是 delay=0 从告警所在分钟第 0 秒起算，最多把告警发出前 59 秒计入结局，方向是乐观偏差。要求：在报告中注明 delay=0 含发报当分钟，并以 delay≥1 作主口径；或把 delay=0 改为从告警所在分钟的下一分钟起。
- **M3 「1 条 / 100 条读取」是恒等变换**：`src/replay/reader.ts:94-97` 先整份 `JSON.parse` 再切片，`readChunkSize` 全库无其他用途，`tests/integration/replay-equivalence.test.ts:28-35` 的等价断言恒真。要求：实现真正的分块 / 流式读取，或删掉该参数与断言，不要让它冒充证据。
- **M4 计划复选框**：`docs/superpowers/plans/2026-09-08-p5-history.md:91` 勾选了 1M/500k 事后 episode 描述标签，代码中不存在该标签（禁止半边满足：网格上限 1m 50k / 5m 100k）。要求：实现 `episodeMagnitudeLabel` 或改回未完成。
- **M5 失败路径测试空白**：14 个 issue code 只有 `minute-boundary-missing`、`code-hash-mismatch`、`abi-hash-mismatch` 被断言。要求：至少为 `unaccepted-batch`、`artifact-unavailable`、`artifact-hash-mismatch`、`projection-input-incomplete`、`historical-overlap`、`coverage-window-limit` 补断言。
- **M6 cohort 无 per-pool 历史缺块通道**：`src/replay/cohort.ts:44` `incomplete = !range.discoveryComplete || creation === null`，队列表会把缺块池显示为 complete，缺块只靠 outcomes 的 window reasons 表达。要求：`CohortRegistration` 增加 `historyComplete`（由 study 从 `report.coverage` 求交）并并入 `incomplete`。
- **M7 minute-close 传给引擎的 coverage 标签**：`src/replay/runner.ts:256-258` 取 `w.recentClosed1m`（最近已关闭分钟）而非目标分钟 `floor(watermark/60)*60 - 60`，目标分钟为 gap 而更早分钟 closed 时会标 `complete` 并写入 `AlertRecord.coverage`。引擎独立守卫（`engine.ts:73-81`）保证不出假告警，但标签会说谎。要求：按 `w.minutes` 中目标分钟的 status 取值。
- **M8 `split === 'outside'` 告警不截尾却计入 alarmCount**：`src/replay/experiments.ts:184-215`，`splitOutcomeEnd` 对 outside 返回原 `endSec`，`summarizeDataset` 统计全部 alerts。当前 7 个案例都在切分区间内，不触发；加入区间外案例时会混入未截尾观测。
- **M9 退出码 4 语义重叠**：`src/replay/study-cli.ts:32`、`src/replay/cli.ts:47` 用 4 表示数据不完整，`src/cli.ts:269` 已用 4 表示 RPC 预算耗尽。study / replay 不发 RPC，实践无歧义，README 需注明。
- **M10 cohortMode 词表不一致**：`src/replay/cohort.ts:16` 为 `'as-of-watchlist' | 'retrospective-cohort'`，`src/replay/reader.ts:19` 为 `'as-of' | 'retrospective-cohort'`；`study.ts:232-246` 从不传 `cohortMode`，as-of 分支不可达。默认值保守，统一词表即可。
- **M11 发现 scope 分钟索引不做完整性检查**：`src/replay/runner.ts:146-153` 对所有批次关闭 timing 检查，`checkMinuteIntegrity` 只对主 scope 跑；发现 scope 的边界缺口只间接表现为 `creationMinuteStartSec = null`，`report.status` 可能显示 complete 而发现历史有洞。
- **M12 显式 `buckets: 2` 与省略行为相同但 configVersion 不同**：`src/signals/config.ts:60-64` 对解析后 JSON 做 hash，省略时不含该键（`p4-v2:3e1fe9c3…`），显式 2 得 `p4-v2:8759e5f4…`，换 hash 触发全量重置并改变 episodeId / alertId。不影响当前配置，文档注明即可。

### Nit

- `src/replay/experiments.ts:199` 把 `triggerMinuteStartSec` 记为 `floor(sec/60)*60 - 60`，对 5m 确认告警这是确认桶的最后一分钟，窗口起点正确，纯标签问题。
- `tests/unit/experiment-split.test.ts:38-49` 直接测 `dependencyReport`，导出到 results.json 的 `leaveOneTokenOut` 已被 `experiments.ts:498` 用 cohort-only 的 `sensitivity` 替换。
- `src/replay/runner.ts:395` `replayRunId` 含 `randomUUID()`，无法从 run id 判断两次运行是否同一实验，只能比 `businessHash`。
- `src/replay/reader.ts:63` 的产物文件名推断依赖 `scopeId === discoveryScope` 约定且无版本标记；真实 manifest 不写 `path`，约定坏掉时表现为 `artifact-unavailable`。
- `artifacts/p5/results.json` 2.4MB、`tests.json` 187KB 未被 `.gitignore` 排除。计划要求产出 results.json，属有意为之，仅提示体积。

## 需求逐条核对

| # | 需求 | 结论 | 依据 |
|---|---|---|---|
| 1 | 回放完全离线，quote/metadata/state 只来自 manifest | 符合 | `runner.ts` 相对 import 传递闭包 44 个模块，不含 `src/rpc/*`、`ingest/fetch-range.ts`；`src/replay/` 唯一 viem 引用是 `reader.ts:4` 的 type-only；`study.ts:120` 拒绝 `scheme://` manifest；`tests/integration/study.test.ts:20-23,40` stub `fetch` 并断言未调用。提示：`vitest.config.ts` 无全局网络禁用，靠结构不可达 |
| 2 | recorded-observed 保留原批次边界与 observedAt；分组读取不改业务 hash | 符合，但证据为空 | `runner.ts:186, 268-274`；`businessHash = contentHash(frames)` 含完整 metrics + alerts。分块读取是恒等变换（M3） |
| 3 | minute-close 无部分 / 未来分钟数据进入规则；最早秒不从分钟桶反推 | 符合 | `clock.ts:26-30` 双重过滤（`blockNumber < to` 且 `minuteStartSec < close`）；`coverage.ts:204` → `windows.ts:246-256` → `windows.ts:406`；`engine.ts:71-81` 要求 `recentClosed1m.minuteStartSec === currentMinute`。加强 fixture 实测 `max(valuationMinuteEnd - close) = 0`。未覆盖：边界区块时间戳落到 `close + 60` 之后的情形（出块间隔 ≥60s），fixture 恒有 `at.timestampSec === boundary.timestampSec` |
| 4 | 缺片 / 缺边界 ⇒ incomplete，不补零不静默跳过 | **不符合（C1、I2）** | 通过：删中间 shard → `shard-incomplete`；删中间批次文件 → `artifact-unavailable`；重复分钟边界不抵消缺失分钟（`integrity.ts:34, 63-69`）；不只查首尾。失败：跨批次范围缺口在 minute-close 下崩溃；真实 manifest 产物被截断仍报 complete |
| 5 | 替换配置版本 ⇒ 新 replayRun，不覆盖旧实验 | 符合 | `runner.ts:395` runId = configHash 前 12 位 + UUID；`runner.ts:409-432` `flag:'wx'`；`study.ts:335-338` 同 |
| 6 | 队列：死亡池入分母 / 不足 3h censored / 缺块 incomplete / 既有池分列 / retrospective 标记 | 大部分符合 | `cohort.ts:70, 43, 83-85, 75`；unresolved 不入分母也不删除。打折：per-pool 缺块无输入通道（M6） |
| 7 | 结局：三档窗口、覆盖与右截尾、排除整个触发分钟、未知不写零、bigint 无损 | 符合，口径需澄清 | `outcomes.ts:55, 63, 65, 69, 103`；`feeConfidence='not-estimated'`；`domain/json.ts:4`。delay=0 口径见 M2 |
| 8 | 引擎实时路径逐位等价；`buckets` 未设时仍要求两根相邻 | 符合 | 12,000 组差分 0 不一致；`engine.ts:126`；`tests/unit/signals-confirmation.test.ts:63-72`；`.strict()` 不改变严格性，`buckets: 3` 被拒 |
| 9 | 36 组网格、300s 冷却、全部披露、关闭并行 confirmRelative | 符合 | `experiments.ts:35-40, 64-66, 72`；`gridSchema` `cooldownSeconds: z.literal(300)`；`selectedAsWinner` 全 false |
| 10 | 时间切分与右截尾、同币跨期依赖、leave-one-token-out | 符合 | `experiments.ts:81-100, 455-483`；`crossPeriodTokens` 列出 `0x385f4f8a…`（MEME） |
| 11 | 0/1/5 分钟延迟为真实位移 | 符合 | `outcomes.ts:55` 起算点随 delay 位移；`experiments.test.ts:81-83` |
| 12 | 1M/500k 不作实时输入 / 作事后标签 | 禁止半边符合，允许半边未实现 | 见 M4 |
| 13 | 命名案例与出生队列不合并为独立分母 | 符合 | `experiments.ts:417-420, 460-473, 492-494`；`independentSamples: false` |
| 14 | 无数据为 null/unknown 而非 0 | 符合 | `experiments.ts:296-312`；`report.ts:10-13` |
| 15 | study 不触发 RPC / 回填；退出码 4 | 符合 | `study-exit.json` `networkCalls: 0`；退出码语义重叠见 M9 |

## 修复后的验收要求

1. `pnpm typecheck`、`pnpm lint`、`pnpm exec vitest run` 退出 0，贴真实输出。
2. C1 回归：中间批次未接纳、区块缺口两种输入，minute-close 返回 `status: 'incomplete'` 不抛错。
3. I1 回归：同 episode 两次 candidate 在 minute-close 下的告警身份数为 1，并说明 `experiments.ts` 使用哪个集合计算 alarmCount。
4. I2(a) 回归：产物截断后回放必须报 incomplete；缺 `sha256` 记 `artifact-hash-unavailable`。
5. I4 回归：`buckets: 1` 最新一根不达标时 reason 为新字符串。
6. 更新 `2026-09-10-p5-acceptance.md` 与计划复选框，使文档与交付物记录数一致。
7. 未修的 Important（I2(b)、I3）以已知限制写入验收文档并给出实测数字。

## 范围与来源

复审由主控 session 组织两位 Opus 审查员分别覆盖回放核心与研究 / 信号改动，主控独立复核了全部引用行号、C1 的正则与 `IncompleteRangeError` 消息集合、I4 的引擎分支、M3 的分块逻辑、M2 的窗口起算点、四份 manifest 的时间范围与 results.json 的空结果。差分测试、复杂度计时、缺口注入实测由审查员在 scratchpad 完成，脚本未写入仓库。未修改任何仓库文件、未切分支、未提交。
