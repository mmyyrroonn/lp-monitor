# P6 独立复审与修复清单 — 2026-09-10

复审对象：分支 `codex/p6-live-validation` 上**未提交**的 P6 实现（`src/ops/{recorder,report,runtime-telemetry,shutdown,status,status-cli}.ts`、`src/ingest/follow.ts`、`src/rpc/{client,rate-limit,request-meter}.ts`、`src/storage/raw-store.ts`、`src/metrics/coverage.ts`、`src/cli.ts`、`src/config/chain.ts`、`config/runtime.local.json`、10 个新增测试文件、`artifacts/p6/`、`docs/runbook.md` 与状态文档）。复审不采信 [实现者中期验收](2026-09-10-p6-acceptance.md) 的结论，独立读码并实测。

复审时点：2026-09-10 19:40–20:10（Asia/Shanghai）。**复审期间实现者仍在修改文档与计划文件，且第二次 2 小时观察（runId `2026-09-10T11-26-39-675Z-15113771`）正在运行**；本文以复审时点工作区快照为准，2 小时结果不在本次范围内。

结论：**typecheck / lint / build / `git diff --check` 全部退出 0，713/713 测试通过；未发现 Critical；发现 12 个 Important。** 实现者验收文档中「最终独立复查无剩余 Critical/Important」的说法与本次复审结果不符。其中 I-1 / I-3 / I-4 / I-7 / I-11 直接影响 2 小时观察能否得出可信结论，建议在解读 2 小时结果之前先修。raw 保存冲突修复本身正确且收窄（见「正面观察」）。

## 复审者独立核实

| 项目 | 结果 |
|---|---|
| `pnpm typecheck` | 退出 0 |
| `pnpm lint` | 退出 0 |
| `pnpm test --reporter=json` | 79 suites / 72 文件，713/713 通过，0 失败 0 跳过；与 `artifacts/p6/tests.json` 逐项一致 |
| `pnpm build` + `node dist/cli.js --help` | 退出 0（产物路径是 `dist/cli.js`） |
| `git diff --check` | 退出 0 |
| 工作区 | 命令前后变更文件数一致（35），构建/测试未写入仓库跟踪文件 |
| 冒烟 run `2026-09-10T10-17-21-077Z-46e19a36` 的 `requests.jsonl`（687 条） | 数字块 `eth_getBlockByNumber` 前置间隔 p50 1002 ms（n=237）；`eth_getLogs` p50 278 ms；`latest` 轮询周期 p50 3724 ms |
| 同 run `manifest.json` | `rpcAcquisitionMs` p50 3941 / p95 20911 / max 55623 ms；2/177 批次 > 30 s；`headGapBlocks` 分布 {0:175, 71:2, 75:2, null:1} |
| 同 run `ops-report.json` | backfill 阶段 201 calls / 200.7 s = 1.00 calls/s；`localProcessingMs` p95 1592（全样本）/ 1603（仅含日志批次，n=68）/ max 3203；`peakConcurrentRpc` 恒为 1 |
| `manifestSha256` | smoke-report 与 soak-failed-1-report 均与实际 manifest 逐字节吻合 |
| 构建指纹 | smoke-code → soak-failed-1-code 差异 `dist/metrics/coverage.js`；soak-failed-1-code → soak-code 差异 `dist/ops/recorder.js`、`dist/storage/raw-store.js`；soak-code 与当前 `dist/` 一致 |
| 凭据扫描 | `artifacts/p6/` 全目录（含 runs、requests.jsonl）无 URL、无 token/secret；命中项均为 ERC20 地址字段与测试 fixture 字符串 |
| 磁盘 | 冒烟 run 目录 600.8 MB / 184 文件；单个 `range-*.json` 平均 3.42 MB，其中 `poolRegistrations` 占 2.63 MB（该批次仅 6 条日志） |
| 实测脚本 | 真实 `runRecorder` + SIGINT：exit 0 / `stopped` / `follow: null` / `failures: []`；duration 截止在积压中：`complete:false` → `incomplete` → exit 4，`failures: []`；伪造 2 小时前崩溃的 sidecar：`status` 报 `runtimeState: healthy`；`runtimeState: 'starting'` 经 `status` 读取为 `null`；`RequestMeter` 嵌套归因时 `backfill` 桶恒空 |

## 修复清单

每条按「位置 / 问题 / 触发或实测 / 要求」给出。修复后需补回归测试并把真实命令输出贴回。

### Critical

无。

### Important

#### I-1　所有数字块 anchor 被当成 backfill，实时热路径被压到 1 rps 且阻塞主队列

- 位置：`src/ops/recorder.ts:227`（`block === 'latest' ? work() : reader.meter.withBackfill(work)`）；`src/rpc/rate-limit.ts:36-48`（`acquire` 共用一条 `tail` 串行）。
- 问题：注释称「Numeric anchors are historical acquisition」，但走这条分支的还有稳态实时路径：`follow.ts:108` 分叉检查 anchor、`follow.ts:151` 批次末端 anchor、`recorder.ts:503-510` 分钟索引 anchor。它们全部受 `maxBackfillRpcRps=1` 限制；backfill 闸门等待期间整个主队列被阻塞（`tests/integration/p6-review-fixes.test.ts:43` 断言 `queueDepth > 0` 正说明这一点）。
- 实测：冒烟证据中数字块 anchor 前置间隔 p50 1002 ms，`eth_getLogs` p50 278 ms；每批 `rpcAcquisitionMs` p95 20.9 s、max 55.6 s；`latest` 轮询实际周期 p50 3.7 s，而计划要求默认 2 秒轮询。
- 要求：把「历史回填」与「实时批次必要 anchor」分开：分钟边界 / 分叉检查 / 批次末端 anchor 走 5 rps 全局预算；1 rps 只保留给 bootstrap 与 `phase==='backfill'` 追赶。或至少让 backfill 闸门不共用前台 `tail`。补回归：稳态单批中的分钟 anchor 派发间隔不受 1 rps 约束。

#### I-2　30 秒收尾宽限小于实测最坏单批耗时，收尾超时被判成 exit 4

- 位置：`src/ops/recorder.ts:186`（`rpcDrainDeadlineMs = stopAtMs + 30_000`）；`src/rpc/client.ts:59` 抛 `RpcFailure('deadline')`，`retryable=false`；`follow.ts:199-205` 直接重抛；`recorder.ts:632-637` 映射 exit 4。
- 实测：冒烟 run 中 2/177 批次 `rpcAcquisitionMs` > 30000 ms，最大 55623 ms。宽限值已被实测数据证伪；I-1 修复后该数字会改善，但仍需按实测推导。
- 要求：宽限由实测 p99 或剩余 RPC 工作量推导；「收尾期超时」归类为正常停止（`stopped` + `stopReason`），不是 exit 4。

#### I-3　按时长正常截止时若处于追赶中 → `incomplete` + exit 4，且 `failures` 为空

- 位置：`src/ingest/follow.ts:105`/`152`（`if (stopping()) break;`）→ `follow.ts:180-191` 判 gap → `follow.ts:209` `result.complete = !gap` → `src/ops/recorder.ts:606-608`。
- 问题：SIGINT 路径有 `status='stopped'` / exit 0 的对称处理，时长截止没有。健康运行恰好在两批之间被截断即得 `complete=false` → exit 4，`failures: []` 无法解释。`artifacts/p6/assess-run.mjs:191` 把任何 `status!=='complete'` 转成 `recorder-<status>` 直接判不通过，这正是 2 小时验收的门槛。
- 实测：`{"acceptedRanges":3,"failures":[],"complete":false}` → `incomplete` → exit 4。
- 要求：时长截止且无真实故障时与 SIGINT 同样处理（`stopped` + exit 0 + `stopReason:'duration'`），或写入显式原因（如 `stopped-mid-backlog`）。补回归：截止时 tip < target 且 failures 为空 → exit 0。

#### I-4　SIGINT 时 `follow` 的结果整段丢失

- 位置：`src/ops/recorder.ts:434`/`482`/`544`（`shutdown.throwIfRequested()`）与 `recorder.ts:603-604`（`result.follow = followResult`）。
- 问题：`ShutdownRequested` 从 `recordRange` 抛穿 `follow()`，`result.follow` 永远为 `null`，`followResult.failures`（累计的 `incomplete-range` / `rate-limit`）不并入 `result.failures`。`assess-run.mjs:215` 把 `manifest.follow` 写进验收产物，被停止的运行给不出 acceptedRanges / reorgs / 失败记录，与计划 6.2「无未解释的范围缺口」冲突。
- 实测：真实 `runRecorder` + SIGINT 得 `follow: null`、`failures: []`。
- 要求：`follow` 在 `shouldStop` 时正常返回部分结果，或 recorder 通过回调持续累计 follow 级统计。

#### I-5　收到停机请求后仍会发起数十秒的新 RPC，且这些工作被丢弃

- 位置：`src/ops/recorder.ts:470-483`（停机检查点）与 `recorder.ts:502-510`（`resolveLogTimes(metered('minuteAnchors'), ...)`）、`recorder.ts:544`。
- 问题：470 之后到 544 之前无停机检查；`resolveLogTimes` 发起全新分钟 anchor 请求并受 I-1 的 1 rps 限制。SIGINT 落在 470 之后，进程要跑完整批分钟索引（实测最坏 55.6 s）才在 544 抛出，且未提交而作废。reader deadline 为 `stopAtMs+30s`，对 2 小时运行早期的 SIGINT 等于不设限。
- 要求：`resolveLogTimes` 之前增加停机检查（或把 shutdown 传入定时解析）；停机后剩余 RPC 设独立短 deadline。

#### I-6　`status` 对 sidecar 派生字段没有过期标记，进程崩溃后仍报告 healthy

- 位置：`src/ops/status.ts:85`（`sampledAtMs: options.nowMs ?? Date.now()`）、`status.ts:84-109`。
- 问题：sidecar 自身的 `sampledAtMs` 被读取时刻覆盖；`runtimeState` / `gap` / `queueDepth` / `inflight` / `rpc` / 延迟字段全部来自 sidecar，可任意陈旧却无年龄字段。唯一线索 `headObservationAgeMs` 在 `head` 为 null 或时钟回拨时也为 null。
- 实测：伪造「2 小时前刚观测完 head 就崩溃」的 sidecar，`inspectDatabaseStatus` 返回 `runtimeState: healthy`、`gap: false`、`sampledAtMs` = 当前时间。
- 要求：输出 `sidecarSampledAtMs` 与 `sidecarAgeMs`；超过阈值（poll 间隔若干倍）时 `runtimeState` 降级为 `stale`/`unknown`；runbook「查看状态」说明整段 runtime 字段同样陈旧。

#### I-7　`headLagBlocks` / `headLagSeconds` 结构上恒为 0，真正落后时反而变 null

- 位置：`src/ops/report.ts:43-46`（`validGap` 要求 `head >= scanned`）、`report.ts:50`、`report.ts:56-59`；采样点只有 `src/ops/recorder.ts:586` 的 `onProgress`。
- 问题：`telemetry.sample()` 只在 follow 外层轮询结束后调用，此时内层循环已推进到本轮 head，差值天然为 0；追头期间（内层连续多批）sidecar 不刷新，`scanned` 超过陈旧 `head`，`validGap` 为 false，两字段一起变 null。
- 实测：冒烟 180 个 healthSamples 中 97% 为 0，非零值只在两次 degraded 期间出现；在第二次 2 小时观察追头阶段跑 `pnpm lp status`，`scanned` 比 `head` 高 2940 块、`headObservationAgeMs` 378946，而 `headGapBlocks: null`。
- 影响：`ops-report` 的 `headLagBlocks p95 = 0` 不能作为「跟得上链速」的证据，也无法支撑计划 6.1「额度不足即报告 head lag」。
- 要求：追头期间也采样（`recordRange` 内或按时间间隔）；`scanned > head` 时报告「head 观测过期」而非 null；报告口径说明该指标测的是什么。

#### I-8　`runtimeState: 'starting'` 被 `status` 静默丢成 null

- 位置：`src/ops/status.ts:136` 白名单缺 `'starting'`；写入方 `src/ops/recorder.ts:290`。
- 实测：`starting -> null`，其余五个状态原样返回；`tests/integration/runtime-recorder.test.ts:141` 只断言 sidecar 文件内容，未走 status 读取路径。冷启动 registry 扫描约 394 s（`bootstrap-result.json`），整个窗口 `status` 报 null，与「没有 sidecar」不可区分。
- 要求：白名单补 `starting`；ops-status 测试补 CLI 路径断言；runbook 列出 runtimeState 合法取值。

#### I-9　本机错误被兜底归类成 RPC 故障 `request-failed`

- 位置：`src/ops/recorder.ts:629`（`classifyRpcError(error).kind`）→ `src/rpc/errors.ts:60` 兜底 `request-failed`。
- 实测：`artifacts/p6/soak-failed-1-report.json` 记 `failuresRecorded: ["request-failed"]`，`raw-save-failure` 事件 0 次；真实原因是 `Raw log payload is immutable`（`save-raw-reproduction/report.json`）。本轮只为 `RawSaveFailure` 和 `SignalEvaluationFailure` 做了专门分类，其他本机缺陷（投影、文件系统）仍会记成 RPC 请求失败。
- 要求：兜底加 `local-error`/`unclassified` 类别，或在 manifest 记录脱敏的 `errorConstructor`，使「RPC 不稳定」与「代码缺陷」在运行记录上可区分。

#### I-10　`.gitignore` 排除了主证据目录，破坏 smoke-report 的证据引用链

- 位置：`.gitignore` 新增 `/artifacts/p6/runs/`、`/artifacts/p6/*.stdout.log`。
- 问题：`smoke-report.json` 的 `manifestPath` / `manifestSha256` 指向 `artifacts/p6/runs/<run-id>/manifest.json`，runbook 也告知运维证据在此目录；提交后第三方无法复核 sha256，也拿不到 batchTimings / healthSamples / meterCheckpoints 原始数据。`ops-report.json`（仅 2 KB）同样被忽略。
- 实测：`git check-ignore -q` 对 manifest.json、ops-report.json 均返回 IGNORED。
- 要求：用 `!` 规则豁免每次运行的 `manifest.json` 与 `ops-report.json`，只忽略 `range-*.json`、`discovery-*.json`、`requests.jsonl`、`*.stdout.log`；或在 `artifacts/p6/` 顶层保留哈希绑定副本。

#### I-11　冒烟证据对应的构建已被取代，当前构建从未跑完 30 分钟冒烟

- 位置：`artifacts/p6/smoke-code.json`（18:32:46 采集，冒烟 18:17:21 启动）、`soak-failed-1-code.json`、`soak-code.json`。
- 实测：smoke → soak-failed-1 之间 `dist/metrics/coverage.js` 变化；soak-failed-1 → soak 之间 `dist/ops/recorder.js`、`dist/storage/raw-store.js` 变化。`performance-before/after.json`（18:29 / 18:37）显示 coverage 优化落在冒烟运行中途。
- 影响：状态文档与 START_HERE 把「30 分钟冒烟 passed，p95 1.592 s」作为当前代码证据，实际是三个 dist 文件之前的构建。实现者验收文档已诚实注明「不能证明整个冒烟进程加载的所有模块版本」，但 runbook 与 implementation-status 的冒烟段没有这句。
- 要求：最终验收用当前构建重跑一次 30 分钟冒烟，或在能力表中注明该项未用当前构建复现；runbook 冒烟段与 implementation-status 补上构建差异文件清单。

#### I-12　磁盘成本被低估约 8 倍，主因是每批重复序列化整份 pool registry

- 位置：`src/ops/recorder.ts:472`、`recorder.ts:527`（每批 `saveJson('range-<id>.json')`）；证据结构 `src/storage/manifest.ts:62` 的 `poolRegistrations`。
- 实测：单个 range 文件 3,341,601 字节中 `poolRegistrations` 占 2,627,556 字节，该批次仅 6 条日志；冒烟 30 分钟 run 目录 600.8 MB（约 1.2 GB/h），而 `ops-report.disk.steady.growthBytesPerHour` 只有 157 MB/h（仅 SQLite）。第二次 2 小时观察 14 分钟已 234 MB，全程约 2 GB。这也解释了 `localProcessingMs` 与日志数几乎无关（零日志批次同样约 1.5 s）。
- 要求：cost-report 把 `runArtifactBytes` 与 SQLite 增长并列（`report-acceptance.mjs` 已有该字段，尚未运行）；runbook 提示证据目录体积与清理；评估 range 证据改为引用 registry 快照哈希而非每批内联。

### Minor

- M-1　`src/rpc/request-meter.ts:2-3, 47-51`：`RpcPurpose` 的 `'backfill'` 在真实路径永远拿不到归因（内层 `withPurpose` 覆盖），所有真实 run 报告的 `purposes` 只有 logs / endpoint-anchor / minute-boundary / metadata。建议改名或移出 purpose 枚举。
- M-2　`src/rpc/request-meter.ts:132-139`：`addElements` 无调用点，`'RPC elements require a purpose context'` 为死代码；`elementsTotal` 实际等于 calls。
- M-3　`src/ops/recorder.ts:686`：`stopReason` 用 `Date.now() >= stopAtMs` 推断，截止时刻附近失败的运行会被标成 `'duration'`。
- M-4　`src/ops/recorder.ts:471` 写 `range-<id>.json` 用裸 `batch`，`recorder.ts:531` 写 `{...timed, timingFailures}`，同名模式两种结构。
- M-5　`src/metrics/coverage.ts:148-150`：缓存命中不刷新顺序，`CACHE_LIMIT=2048` 的淘汰是 FIFO 非 LRU。
- M-6　`src/config/chain.ts:63`：`maxBackfillRpcRps` 未与 `rpcPerSecond` 做关系校验，配大于全局速率时被主限流器吞掉、静默无效。
- M-7　`tests/helpers/recorder-fixture.ts:54`、`tests/integration/recorder.test.ts:64` 把 `maxBackfillRpcRps` 设为 100000，既有 recorder 套件完全不经过 backfill 限流。
- M-8　`src/ops/shutdown.ts:14`：`reason ??= why` 只首次赋值，第二次 SIGINT 不会强制退出；Node 默认 Ctrl+C 终止行为已被替换，而 runbook 劝阻强杀。建议第二次 SIGINT 提示并 `process.exit`。
- M-9　`tests/integration/ops-status.test.ts:38` 与 `:68` 测试名完全相同，前者基本是后者子集。
- M-10　`tests/integration/live-faults.test.ts:160` 用裸 `rejects.toThrow()`，fixture 自身出错也通过；同文件其他五个故障用例都带匹配串。
- M-11　`src/ops/status.ts:128`/`:130`：显式 `--scope` 时缺 `databasePath`/`scopeId` 的 sidecar 被接受；默认推断路径是严的。
- M-12　`artifacts/p6/assess-run.mjs:211`：`snapshotDatabasePath` 恒等于 `databasePath`，冒烟实际运行库 `data/p6.sqlite`、评估库 `data/p6-smoke.sqlite` 无法从字段区分。
- M-13　10/20/100 块比较（`comparison-2026-09-10T10-15-17-902Z`）窗口在冒烟启动前 2 分钟，未「纳入首次 30 分钟观察」；runbook 已如实标注零日志限制。
- M-14　「每分钟新增 anchor 请求」未按分钟量化：冒烟 `minuteAnchors=472` 对应 236 条日志，是按日志摊销；「不退回全块头循环」成立（472 次 vs 约 23,000 块）。
- M-15　`src/ops/report.ts:157`：`usage.*.methods` 对 first/last 求并集，出现 `eth_chainId: 0` 等零值噪声。
- M-16　`docs/implementation-status.md` P6 表格行缺证据链接，P0–P5 每行都有。
- M-17　`src/ingest/follow.ts:91-94` 的顶部 `stopping()` 分支基本不可达，命中时返回 `complete=false` 且无失败原因。
- M-18　`.gitignore` 与计划 6.3「保留所有 raw 与报告」的关系需在交接文档中说明：per-run raw / range / requests 证据只存在于本机磁盘。

## 计划 Task 6.1–6.3 复选项对照

| 条目 | 计划勾选 | 复审结论 |
|---|---|---|
| 6.1-1 SIGINT 后按 cursor 补处理、不重复决策、flush 后关库 | [x] | 已实现 + 有测试（`runtime-recorder.test.ts:37`、`raw-save-failure.test.ts:67`）+ 实测 exit 0。缺口见 I-4 / I-5 |
| 6.1-2 限定 AMC 三类观察池 | [x] | 已实现；1 个 v3Pool + 2 个 v4PoolId |
| 6.1-3 5 / 2 / 1 预算；额度不足报 head lag | [x] | 限流已实现 + 有测试 + 冒烟实测未越限。**「额度不足即报告 head lag」打折**：maxCalls 耗尽路径无测试（`budget.test.ts` 未覆盖），head lag 指标本身失效（I-7），实时 anchor 被误限（I-1）。`peakConcurrentRpc` 恒为 1，`maxConcurrentRpc=2` 未被用到 |
| 6.1-4 累计元素数、分 purpose 统计、无逐块 header | [x] | 已实现 + 有测试 + 有证据。附带 M-1 / M-2 |
| 6.1-5 等待 / RPC / 处理耗时、headLag 趋势、10/20/100 比较 | [x] | **部分**：耗时有实测；headLag 趋势无效（I-7）；比较在冒烟之前（M-13）；「短暂积压需能消化」无测试；实际轮询周期 3.7 s（I-1） |
| 6.1-6 HTTP 轮询、日志时间为 0 时分钟索引、测每分钟新增 anchor | [x] | **部分**：分钟索引启用且不退回全块头循环（有测试）；每分钟 anchor 成本未按分钟量化（M-14） |
| 6.1-7 运行 shutdown + budget 测试 | [x] | 已验证 |
| 6.2-1 六种故障 fixture | [x] | 六种全部有测试（`live-faults.test.ts:92/106/123/137/156/170`），断言完整性不变量与状态变化。注意：这些测试驱动 `follow` + 合成 `recordRange`，不经过 recorder 真实 raw-save / 停机 / telemetry 路径；M-10 |
| 6.2-2 30 分钟冒烟 | [x] | 已运行 + 有证据，但构建已过期（I-11） |
| 6.2-3 无密钥 / 告警字段 / RPC 用量 / 磁盘 / 重复率 | [ ] | 未勾正确。无密钥有测试 + 扫描通过；`rawDuplicateIdentities 0`、`outboxDuplicateRevisions 0`；磁盘口径不完整（I-12）；冒烟期无真实告警样本 |
| 6.2-4 无未解释缺口 / 重复决策；p95 ≤ 2 s | [ ] | 未勾正确。冒烟 p95 1592 ms 达标，2 个失败区间被 accepted coverage 完整解释；max 3203 ms、2/177 超 2 s，余量薄；2 小时未出 |
| 6.2-5 追不上链速时报告瓶颈 | [ ] | 未勾正确；src 内未实现 CPU/资源采样，来自仓库外 `observe-process.ps1` |
| 6.2-6 导出 manifest；replay 对照标暂缓；不虚报实链 reorg | [ ] | manifest 导出已实现有产物（`replayInputs`，`order` 自述不可用）；`replayComparison: incomplete`、`realReorgObserved: false` 如实 |
| 6.3-1 runbook 命令准确；backfill/replay 按实际入口标注；SQLite backup API | [x] | 已核实：`probe/follow/ingest/status/backup/replay` 及参数名全部与 CLI 解析器一致；`recorder-cli.ts:85` 拒绝 `ingest --notify local`；`status.ts:174` 用 `db.backup()`；未实现功能未列成可运行命令 |
| 6.3-2 成本报告 | [ ] | 未勾正确。`aggregateOpsReport` 已按 startup/backfill/steady 分列；`monetaryCost` 恒 null 不编造；`report-acceptance.mjs` 尚未运行，`cost-report.json` / `acceptance.json` 不存在 |
| 6.3-3 停止后补历史不重发旧机会 | [x] | 已实现 + 有代码机制：`recorder.ts:583` 对非 live 批次 `retractionsOnly=true`；`outbox.ts:46` 硬编码 `capture_mode='live'`；runbook 表述一致 |
| 6.3-4 最终能力表 | [ ] | runbook 已有「当前能力边界」表，按最终验收口径保持未勾，一致 |
| 6.3-5 更新为实际验收结果、停止有界进程 | [ ] | 未勾正确；2 小时进程运行中 |

未发现「勾成完成但实际未验收」的条目；但 6.1-3 / 6.1-5 / 6.1-6 三项勾选内容只有部分成立，建议改为部分完成并注明缺口。

## 证据一致性核对

| 文档声称 | 产物实测 | 结论 |
|---|---|---|
| 冒烟 p95 1,592 ms、1,832,495 ms、177 样本 | `smoke-report.json.measured` 与 run 内 `ops-report.json` 逐字节相等 | 一致；177 样本中 109 个零日志批次应披露 |
| 首次 2 小时 1,144,254 ms 后失败 | `soak-failed-1-report.json.elapsedMs = 1144254`，`recorder-failed` | 一致 |
| 失败根因 = `rawBlockTimestamp` 漂移 | `save-raw-reproduction/report.json` 4 处 `0x6aa28ff3 → 0x0`；`fix-verification.json` 幂等与逐字节不变 | 复现证据充分；但运行记录写的是 `request-failed`（I-9） |
| 2 次失败范围已完整恢复 | `recoveredUnacceptedBatches` 2 条，`unresolvedUnacceptedBatches: []` | 一致 |
| 713 测试 / 72 文件 | tests.json 与本次复跑逐项一致 | 一致；复审开始时三份文档写 710，实现者已在复审期间改为 713 |
| 磁盘增长 steady 157 MB/h | `disk.steady.growthBytesPerHour = 157562741`，仅 SQLite | 自洽但口径不完整（I-12） |
| RPC 用量 | startup 21 + backfill 201 + steady 2081 = 2303 = `elements.total` | 一致 |
| 无带凭据 URL | 全目录扫描无 URL/凭据 | 一致 |
| comparison 标注零日志同链头限制 | `report.json.limitation` 与 runbook 复述一致 | 一致 |

## 未确认疑点

1. 第二次 2 小时观察结果未知（复审时 healthy，rss 569 MB，`gapBlocks 0`）；长时段内存趋势需完整窗口数据。
2. 冒烟进程实际加载的模块无法独立证明（`smoke-code.json` 在运行开始 15 分钟后采集，期间发生过 build）。
3. `src/rpc/client.ts:107-116`：transport promise 在 `onAcquired` 内同步创建、`client.ts:121` 才 await；若 `client.request` 同步抛错理论上可能 unhandledRejection，未能构造复现。
4. `src/ops/recorder.ts:135`：`deliveredAtMs` 在 sink 内对每条告警赋值，记录的是本次 drain 最后一次成功投递时刻；同次 drain 后续失败时仍保留前一条时间，对 `totalDeliveryMs` 口径的影响未验证。
5. `config/runtime.local.json` 的 `warmupMinutes: 1` 远低于默认 60，深度 reorg 触发 `resetForWarmup` 后 60 样本基线需约 1 小时重建；runbook 已写明取舍，未实测此时指标是 incomplete 而非补零。
6. `src/ops/report.ts:181` 对 `disk.growthBytes` 逐区间 `Math.max(0, …)`，WAL checkpoint 锯齿可能把累计正增量当净增长，长时间运行偏差未验证。
7. `src/ops/runtime-telemetry.ts:88`：`transition()` 在 degraded/failed 时把 `gap` 置 null，恢复 healthy 后是否长时间停留 null 未构造用例。
8. 告警 outbox 为 at-least-once（`src/notify/outbox.ts:67-71`）；协作式停机不中断 drain，P6 未引入新的重复通知路径，但 SIGKILL 仍可能重发。属 P4 既有语义，未实验。

## 正面观察

- raw 保存修复正确且收窄：`src/storage/raw-store.ts:772-779` 只剥离 `rawBlockTimestamp`；`rawLogKey` 由 `blockHash:txHash:logIndex` 构成，不同 blockHash 是新身份而非冲突；data / topics / address / transactionIndex / blockNumber 任一变化仍抛 `immutable`，`raw-store.test.ts` 逐条断言并用真实复现值做漂移回归。`src/ingest/log-time.ts` 明确从不使用 provider 附带时间戳，下游无污染。
- `RawSaveFailure` 是类型化异常，在 `acceptRange` 之前抛出，不产生重复业务决策；`raw-save-failure.test.ts` 对 discovery / operations 两阶段断言 exit 1、cursor 未推进、证据无凭据。
- `src/metrics/coverage.ts` 缓存签名覆盖 `payload_json + fetch_shards`（`order by shard_id`），缓存值只含不可变派生数据，`accepted_ranges` 每次实时重读；5 个新用例堵住「旧缓存被当成当前数据」。
- P1 三处修复在 `follow.ts` 中完好（分叉恢复后刷新 target、`recordRange` 前再查停止条件、`toBlock` 校验）；`onProgress` 移到 toBlock 缺口判定之后是改进。没有新增「积压时扩大批次」逻辑，overlap 20 / 每批 1000 未改。
- `artifacts/p6/assess-run.mjs` + `tests/integration/p6-assessment.test.ts`（21 条）是本轮质量最高的部分：真实拉起验收脚本做反向攻击（篡改 manifest、无关空库、伪造 p95 / peak 值、未覆盖失败区间），全部要求验收失败；5/2/1 预算与 `calls ≤ maxCalls` 为硬性断言。
- 拒绝编造成本：`verifiedRates: null`、`billingUnits` 恒 null，`monetaryCost` 只可能为 null；`ops-report.test.ts:107` 测了「有费率时只对声明单位计价」。
- `tests/fixtures/p6-transport.ts` 用真实归档日志 + 真实 viem transport，在 fetch 层注入真 429 / ECONNRESET / 截断 JSON，说服力高于 stub。
- 凭据卫生彻底：`requests.jsonl` 只记 `sourceAlias`；`outbox.ts` 把 sink 异常文本替换为 `local-delivery-failed`；测试注入带用户名密码的 URL 并断言所有证据不含它。
- 协作式停止边界放置正确：`throwIfRequested()` 都在 better-sqlite3 同步事务之外；`db.close()` 先于 `shutdown.dispose()`；`saveJson` 为临时文件 + rename 的原子写。
- 文档口径克制：失败证据、失败构建指纹、复现产物全部保留；依赖长观察的复选框未提前勾上。

## 建议的修复顺序

1. 先修 I-1 / I-3 / I-4（影响 2 小时观察结论可信度与 exit code 语义），再解读或重跑 2 小时观察。
2. 同批修 I-2 / I-5 / I-7 / I-8 / I-9 与 M-8（停机与状态可观测性）。
3. I-10 / I-11 / I-12 属证据与文档口径，在最终验收文档中处理；I-11 需用当前构建重跑 30 分钟冒烟或明确注明。
4. 修复后重跑 `pnpm typecheck && pnpm lint && pnpm test && pnpm build`，补回归并贴真实输出；再出 [验收更新](2026-09-10-p6-acceptance.md)。

复审通过工程检查不代表 2 小时观察、阈值效果或 LP 收益通过。
