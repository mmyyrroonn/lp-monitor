# 2026-09-15 Live Runtime Performance 实施记录

- 原仓库：`E:\lp-monitor`
- 实施 worktree：`E:\lp-monitor\.worktrees\live-runtime-performance`
- 分支：`codex/live-runtime-performance`
- 基线 commit：`6ed70d7d6f7bd5fecbe22f2324b3e4ffad71acfa`
- 依据：`docs/superpowers/plans/2026-09-15-live-performance-00-master.md` 第 4 节记录格式

说明：上述 00–05 计划、`docs/superpowers/specs/2026-09-15-live-runtime-performance-design.md` 与 `docs/reviews/2026-09-15-live-runtime-performance-review.md` 是审查者放进本 worktree 的**输入**，按「只 stage 本子计划文件」的要求**未**纳入本分支提交，与验收后的处置一并交回审查者。本文件与代码改动则按计划要求提交，以便按提交复核。

写在该文件里的一切数字都来自本 worktree 内真实执行的命令；未执行的项在每个任务的“兼容性与未执行项”里明确写出，不写成已通过。

主要禁令（全程遵守，汇总在此便于复核）：不动原工作区运行中的 follow/dashboard、`.env`、实际 config 或 `data` 数据库；不发起新的真实 RPC 采样；V4 Manager 只做默认关闭的离线实验；不 merge main、不 push、不删除分支；禁止 reset/clean。

---

### A1

- 状态：完成

- 修改文件：
  - 新增 `tests/helpers/live-scale-fixture.ts`（确定性规模夹具：8 万池注册/事件/覆盖/watermark）
  - 新增 `tests/unit/live-scale-fixture.test.ts`（6 个用例：形状、出生高度、覆盖连续性、股票共池、事件合法性、计数器接线）
  - 新增 `src/ops/work-counters.ts`（`WorkCounts`/`WorkCounterKey`/`emptyWorkCounts()`/`setWorkCounter()`/`countWork()`，模块级 sink 默认 `null`）
  - 新增 `scripts/benchmark-live-performance.mjs`（离线基准脚本，仅用夹具 + `os.tmpdir()` 临时库）
  - 修改 `src/storage/raw-store.ts`（`pools()` 解码前 `countWork('registryRowsRead', rows.length)`）
  - 修改 `src/storage/payload-store.ts`（`readBatch()` 行命中后 `countWork('rawBatchDecodes')`）
  - 修改 `src/metrics/notional.ts`（`valueSwap()` 入口 `countWork('valuationComputes')`）
  - 修改 `src/metrics/windows.ts`（`buildMinuteMetrics()` 组装前 `countWork('evaluatedPools', groups.size)`）
  - 修改 `src/registry/pools.ts`（`equivalent()` 两侧编码处 `countWork('registryRowsSerialized', 2)`）
  - 修改 `src/storage/live-projection.ts`（脏比较与游标写入两处真实序列化点计数）
  - 修改 `src/ops/recorder.ts`（metadata 目标循环后 `countWork('metadataCandidates', targets.length)`）
  - 新增 `artifacts/performance/baseline-80k/benchmark.json`、`artifacts/performance/baseline-80k-recheck/benchmark.json`（基线原始样本，保留未覆盖）

- RED：
  1. 夹具/计数器 RED（纯新增夹具，按 00-master 第 3 节允许的“模块缺失”形态）。复现命令：
     `mv tests/helpers/live-scale-fixture.ts … && mv src/ops/work-counters.ts … && pnpm exec vitest run tests/unit/live-scale-fixture.test.ts`
     失败输出（退出码 1）：
     ```
     Error: Cannot find module '../ops/work-counters.js' imported from E:/…/src/metrics/notional.ts
      Test Files  1 failed (1)
           Tests  no tests
     ```
     为什么是原问题：计数必须来自生产代码里的真实 SQL 读取/序列化/估值/评估点；模块不存在时这些点根本不产生数据，任何“测试里手写期望值”的写法都会在移除模块后照样通过，因此该 RED 钉住的是“计数源在被测代码内”。
  2. 性能目标 RED（本条不修，留作 A1 基线证据）。命令：
     `pnpm exec tsx scripts/benchmark-live-performance.mjs --pools 80000 --active 400 --iterations 3 --out artifacts/performance/baseline-80k`
     结果 p95 `2750.083ms`，验收目标为 20 批 localProcessing p95 `< 2000ms` → 基线不达标，原结果按要求保留在 `artifacts/performance/baseline-80k/benchmark.json`，未覆盖。

- GREEN：
  - `pnpm exec vitest run tests/unit/live-scale-fixture.test.ts` → `Test Files 1 passed (1)`，`Tests 6 passed (6)`，退出码 0。
  - `pnpm test`（全套）→ `Test Files 113 passed (113)`，`Tests 921 passed (921)`，退出码 0。
  - `pnpm typecheck`（`tsc --noEmit && tsc -p tsconfig.scripts.json`，脚本目录 `allowJs+checkJs`）→ 退出码 0。
  - `pnpm exec prettier --check` 对本任务新增/修改的全部文件 → `All matched files use Prettier code style!`，退出码 0。
  - 基线复跑（用最终脚本版本，未覆盖原基线）：`--out artifacts/performance/baseline-80k-recheck` → 退出码 0，p50 `2272.551ms` / p95 `2449.896ms`，结构计数与原基线一致，确认记录中的数字可由当前树内脚本复现。

- 行为差异：
  - 生产代码只做了“计数增量”插入，计数 sink 默认 `null`，`countWork()` 在 `null` 时直接返回，不改变任何返回值、异常路径或数据库内容；`pnpm test` 全绿即为“无行为变化”的回归证据。
  - `src/storage/live-projection.ts` 的脏比较由“直接比较两个 JSON 字符串”改为先 `encodeJson(a ?? null)`/`encodeJson(b ?? null)` 再比较，字符串内容与比较语义不变，只是让序列化次数可计数。
  - `src/registry/pools.ts` 的 `equivalent()` 只增计数，合并判定逻辑未改。
  - 新增计数器键的语义：`registryRowsRead`=从 SQLite 取出的注册行数；`registryRowsSerialized`=JSON 编码次数（单行计 1，`equivalent()` 两侧成对计 2）；`rawBatchDecodes`=批次体解码次数；`valuationComputes`=`valueSwap` 调用次数；`evaluatedPools`=`buildMinuteMetrics` 实际装配窗口的池数；`metadataCandidates`=一轮 metadata 目标数。
  - 无 schema/DDL 变化，无配置默认值变化。

- 性能：样本规模 80000 池 / 400 活跃 / 194 资产 / 181 分钟覆盖；无预热轮之外的特殊处理，每轮先 `setWorkCounter` 再跑真实路径；迭代 3 次（受本机时间预算限制，20 次留到 E3 验收）；离线（不发任何 RPC）。

  | 阶段 | 基线 p50 | 基线 p95 | 复跑 p50 | 复跑 p95 |
  |---|---|---|---|---|
  | registryRead | 287.781ms | 289.357ms | 268.677ms | 275.212ms |
  | registryMerge | 190.707ms | 380.588ms | 179.883ms | 346.318ms |
  | batchDecode | 1209.220ms | 1216.980ms | 1072.270ms | 1096.045ms |
  | windows | 324.433ms | 371.810ms | 303.505ms | 306.022ms |
  | rolling | 480.958ms | 520.209ms | 430.063ms | 448.861ms |
  | valuation | 1.177ms | 2.245ms | 0.731ms | 1.596ms |
  | **合计** | **2491.375ms** | **2750.083ms** | **2272.551ms** | **2449.896ms** |

  结构计数（每轮，两次运行一致）：`registryRowsRead=80000`、`registryRowsSerialized=0`、`rawBatchDecodes=1`、`valuationComputes=800`、`evaluatedPools=80400`、`metadataCandidates=0`。
  其他：`initMs` 10486.6ms（基线）/9742.7ms（复跑），`fixtureMs` 158.6/170.8ms，RSS ≈3.26GB，临时库 233MB，`node v24.5.0`，`win32 x64`。
  读数说明：`registryRowsSerialized=0` 是因为该轮路径没走 `equivalent()`/游标写入的全量序列化（全量序列化在 B 系列要解决的问题路径上，届时由同一计数器暴露）；`evaluatedPools=80400 = 80000 + 400`，多出的 400 是 `buildRollingMetrics` 内部对活跃池再次调用 `buildMinuteMetrics` 的正常累加，不是重复计数缺陷（已用注册 id 与事件池 id 逐一比对确认无遗漏/无重复）。

- 兼容性与未执行项：
  - 兼容：新增文件均为纯新增；生产改动为默认关闭的可选回调；旧库、旧批次格式、`dist`、原工作区 `data/recorder.sqlite` 均未被读写或改写；基准脚本用 `finally` 删除 `os.tmpdir()` 临时库，且拒绝写入已存在的 `--out` 目录。
  - 未执行：真实 provider 验证；运行中 follow/dashboard 重启或迁移；线上 Manager 切换；新 RPC 采样；两小时 soak；160k 规模样本（E3 验收）；20 次迭代的正式样本（本记录为 3 次）；merge/push。

- Commit：`eb206cb9ec3af99e90f3a82139ad7cecc401d8db`（子计划 01 单一提交，A1–A4 全部在内；本行哈希的补写位于其后的一个小提交）

---

### A2

- 状态：完成

- 修改文件：
  - 新增 `src/ops/batch-timings.ts`（`BatchStage` 11 个真实边界、`measureStage()`、`BatchTimings`（可注入时钟、`measure`/`measureAsync` 在 `finally` 累计、`snapshot()` 省略未跑阶段）、`BatchTimingRecord`）
  - 新增 `tests/unit/batch-timings.test.ts`（4 个用例：抛错仍计入、单阶段多次访问累加且阶段间独立、`measureAsync` 成功/失败都计入、未跑阶段缺席且默认时钟测真实墙钟）
  - 修改 `src/ops/work-counters.ts`（新增 `openWorkCounts()`：临时替换 sink 并把增量收进本地桶，返回 `close()` 复原，用于按批取计数）
  - 修改 `src/ops/recorder.ts`（批内开 `BatchTimings` + `openWorkCounts()`；11 个阶段包裹；批记录新增 `stageMs`/`localProcessingMs`/`headObservedAgeMs`/`acceptedDataAgeMs`/`counts`；新增 `batch-timing` 单批日志；外层 `finally` 与提前返回路径都关闭计数作用域）
  - 修改 `src/ops/runtime-telemetry.ts`（`RuntimeBatchTiming extends BatchTimingSample, BatchTimingRecord`，旧字段定义未动）
  - 修改 `src/signals/project.ts`（`projectSignals()` 第 6 个可选参数 `timings`；`commitAcceptedSignalBatch()` 的 `options` 收 `startNewSegment` 与 `timings`；`signals`/`projection` 阶段包裹）
  - 修改 `src/storage/metric-store.ts`（`MetricBuildOptions.timings?`；`projection`/`registry`/`coverage`/`valuation`/`windows` 阶段包裹）
  - 修改 `tests/integration/runtime-recorder.test.ts`（断言 11 个阶段均被测量、`localProcessingMs === processingLatencyMs`、两个 data age ≥ 0、结构计数 ≥ 阈值、`batch-timing` 日志可解析且不含 endpoint）

- RED：
  1. 模块缺失形态（同 A1 的允许形态）。命令：
     `rm src/ops/batch-timings.ts && pnpm exec vitest run tests/unit/batch-timings.test.ts`
     失败输出：
     ```
     FAIL  tests/unit/batch-timings.test.ts [ tests/unit/batch-timings.test.ts ]
     Error: Cannot find module '../../src/ops/batch-timings.js' imported from E:/…/tests/unit/batch-timings.test.ts
      ❯ tests/unit/batch-timings.test.ts:2:1
      Test Files  1 failed (1)
           Tests  no tests
     ```
     为什么是原问题：A2 要证明的是“每条阶段耗时来自生产路径上的真实边界”，不是测试里另写一套计时。模块不存在时生产代码里根本不存在阶段边界，测试无法自证。
  2. 记录未按阶段测量的 RED。把 `src/ops/recorder.ts` 批记录中的 `stageMs: timings.snapshot()` 换成 `stageMs: undefined as never`（只此一处），复现命令：
     `pnpm exec vitest run tests/integration/runtime-recorder.test.ts -t 'real recorder persists measured'`
     失败输出（退出码 1）：
     ```
     FAIL  tests/integration/runtime-recorder.test.ts > real recorder persists measured evidence-to-outbox timing, phase budgets and current health without endpoint secrets
     TypeError: Cannot read properties of undefined (reading 'rpcAcquisition')
      ❯ tests/integration/runtime-recorder.test.ts:143:14
         143|       expect(stageMs[stage], `${stage} must be measured`).toBeGreaterT…
      Test Files  1 failed (1)
           Tests  1 failed | 6 skipped (7)
     ```
     为什么是原问题：这条 RED 钉住的是“真实 recorder 写出的批记录里必须真的带阶段耗时”。只要没有真实测量，断言就炸；不存在“测试端手写理想值”能通过的空间。取证后已还原（`git status --short src/ops/batch-timings.ts tests/unit/batch-timings.test.ts` 两文件仍为 `??` 未跟踪态，生产改动完整）。

- GREEN：
  - `pnpm exec vitest run tests/unit/batch-timings.test.ts tests/integration/runtime-recorder.test.ts tests/integration/follow-runtime-summary.test.ts` → `Test Files 3 passed (3)`，`Tests 12 passed (12)`，退出码 0。
  - `pnpm test`（全套）→ `Test Files 114 passed (114)`，`Tests 925 passed (925)`，退出码 0。
  - `pnpm typecheck`（`tsc --noEmit && tsc -p tsconfig.scripts.json`）→ 退出码 0。
  - `pnpm exec prettier --check` 对本任务新增/修改的全部文件 → `All matched files use Prettier code style!`，退出码 0。

- 行为差异：
  - 新增开关默认关闭：`measureStage(timings, …)` 在 `timings === undefined` 时直接 `work()`，不读时钟、不建对象；CLI report / dashboard snapshot / replay 这些离线调用方全部传 `undefined`，行为与耗时不变（`pnpm test` 全绿为回归证据）。
  - 计时口径按真实边界落位，关键的三个“窗口不重叠”处理：
    - 旧的 `rpcAcquisitionMs`（聚合报告里的既有字段）保持**宽口径不变**：采集 + 原始落盘 + 锚点解析，为了与审查报告的历史数字可比，没有改。新增的 `stageMs.rpcAcquisition` 才是**纯网络取数**边界。真实日志已经证明两者不同：`rpcAcquisitionMs: 466` vs `stageMs.rpcAcquisition: 71.695`（写入延迟与锚点解析被旧口径吞掉，正是 A 系列要暴露的“计时误导”）。
    - `coverage` 阶段包含分钟边界锚点的 RPC 校验，因此**不计入** local processing；它的耗时在真实日志里是最大项（388.542ms），这也解释了“本地处理很慢”的表象里有网络成分。
    - `writeLatencyMs` 保持旧定义（raw 保存 + 事务内 CPU/SQL），与 local processing 重叠，文档中明确写入“不得相加”。
  - `localProcessingMs` **沿用**既有的 evidence-to-outbox 口径（`completeEvidenceAtMs` → `outboxDurableAtMs`，与 `processingLatencyMs` 和聚合报告 `latency.localProcessingMs` 同源），集成测试断言两者相等；没有另造一个竞争口径，验收指标与审查报告可直接对比。
  - 计数改为**按批作用域**：`openWorkCounts()` 在批开始时接管 sink、批结束时复原并把增量写进该批的 `counts`。sink 仍是模块级单槽，嵌套会互相覆盖；`runRecorder` 是单批串行，且外层 `finally` 与提前返回路径都调用 `close()`（幂等），不会把上一个批的计数漏到下一个批。
  - 单批日志只输出 runId/batchId/phase/captureMode/块区间/logs 数/各阶段毫秒/结构计数/data age；不含 RPC URL、凭据、也不含池列表（集成测试对日志与报告同时断言不含 `fixture.invalid`）。
  - 无 schema/DDL 变化，无配置默认值变化，无算法/公式改动。

- 性能：本任务本身是“把耗时测准”，不改快慢；耗时为真实 recorder 夹具（离线、`https://fixture.invalid` 不可达，走 fixture factory）的一批真实记录，取自 `console.log` 的 `batch-timing` 行：
  ```json
  { "event": "batch-timing", "phase": "steady", "captureMode": "live", "fromBlock": "100", "toBlock": "200", "logs": 2,
    "rpcAcquisitionMs": 466, "writeLatencyMs": 15, "localProcessingMs": 61, "headObservedAgeMs": 527, "acceptedDataAgeMs": 1789466493872,
    "stageMs": { "registry": 0.384, "rpcAcquisition": 71.695, "rawPersist": 0.866, "coverage": 388.542, "artifactPersist": 6.167,
                 "commitOther": 0.029, "projection": 6.242, "valuation": 0.448, "windows": 1.242, "signals": 1.246, "notify": 0.05 },
    "counts": { "registryRowsRead": 7, "registryRowsSerialized": 7, "rawBatchDecodes": 2, "valuationComputes": 2,
                "evaluatedPools": 1, "metadataCandidates": 3 } }
  ```
  读数说明（不粉饰）：
  - `acceptedDataAgeMs: 1789466493872`（≈56 年）是夹具的产物，不是生产缺陷：recorder 夹具的 `end.timestampSec` 是合成值，而 `Date.now()` 是真实时间。该字段的口径本身正确，只是夹具不具备真实时间语义；真实链上数据下它会回落到秒级。此数字**不作为**任何验收依据。
  - `coverage: 388.542ms` 是这批的最大项，与旧的 `rpcAcquisitionMs: 466ms` 高度重合，正是 A 系列判断“慢在哪”要看的证据；`localProcessingMs: 61ms` 与之相差一个量级，说明旧口径把网络等待算进了本地处理。
  - `registryRowsSerialized: 7` 与 A1 基线里的 `0` 不同：本批走了注册表全量序列化路径（A1 基线轮次没走），计数器如实暴露，不是回归。
  - 单批日志是本机一次真实记录，样本量 1，不作为性能验收样本；正式样本在 E3。

- 兼容性与未执行项：
  - 兼容：所有新增均为可选参数/可选字段；产出的 manifest 只是多了字段，旧读取方（按需取字段）不受影响；旧库与旧批次格式未改；未触碰原工作区运行中的 follow/dashboard、`.env`、实际 config 或 `data` 数据库。
  - 未执行：真实 provider 验证；运行中 follow/dashboard 重启或迁移；线上 Manager 切换；新 RPC 采样；两小时 soak；80k/160k 正式样本（E3）；merge/push。

- Commit：`eb206cb9ec3af99e90f3a82139ad7cecc401d8db`（子计划 01 单一提交，A1–A4 全部在内；本行哈希的补写位于其后的一个小提交）

---

### A3

- 状态：完成

- 修改文件：
  - 修改 `src/rpc/rate-limit.ts`（按 01 计划给定算法重写恢复曲线：`baseIntervalMs = ceil(1000/perSecond)`；`penalize()` 令 `cooldownDelayMs = min(30000, max(1000, cooldownDelayMs*2))`、`cooldownUntilMs = max(cooldownUntilMs, now+cooldownDelayMs)`、`effectiveIntervalMs = max(base, min(2000, effectiveIntervalMs*2))`、`consecutiveSuccesses = 0`；每 3 次成功对二者减半；新增 `state()`；新增 60 秒空闲回落；`acquire` 等待 `max(nextMs, cooldownUntilMs, additional.nextMs, additional.cooldownUntilMs)` 并在每次 sleep 后重读；占位后 `nextMs` 只加 `effectiveIntervalMs`）
  - 修改 `tests/unit/rate-limit.test.ts`（新增 8 个用例；原有用例的间隔断言按新曲线收紧）
  - 修改 `tests/unit/client.test.ts`（新增「无 retry 的 429 仍拖慢同 provider 下一次调用」）
  - 修改 `tests/unit/rpc-review.test.ts`（`times[2]-times[1]` 的期望值随曲线更新，见下）
  - 未改 configured RPS / maxConcurrent / maxRetries / `client.ts` 的 retry 判定逻辑

- RED：
  1. 恢复曲线无界。命令 `pnpm exec vitest run tests/unit/rate-limit.test.ts tests/unit/client.test.ts`（新用例已写入，实现未改）：
     ```
     FAIL  tests/unit/rate-limit.test.ts > recovery after six 429s stays bounded and returns to the configured interval
     AssertionError: expected 443500 to be less than or equal to 45000
      ❯ tests/unit/rate-limit.test.ts:36:24
      Test Files  1 failed | 1 passed (2)
           Tests  7 failed | 7 passed (14)
     ```
     为什么是原问题：旧实现把 `penaltyMs` 直接当作后续每一次占位的间隔，6 次 429 后 `penaltyMs` 顶到 30 秒，15 次成功共 443.5 秒；计划要求同一场景 ≤ 45 秒且末尾回到 200ms。
  2. 无可观测状态。同一轮里 5 个用例以 `TypeError: limiter.state is not a function` 失败（`state()` 尚不存在），钉住「限流器当前曲线必须可被外部读到」，而不是只靠时序间接推断。
  3. vacuous-green 防护：与 `state()` 有关的读数断言都先要求真实数值，避免「缺省 0 满足上界」这类假通过。

- GREEN：
  - `pnpm exec vitest run tests/unit/rate-limit.test.ts tests/unit/client.test.ts tests/unit/rpc-review.test.ts` → `Test Files 3 passed (3)`，`Tests 49 passed (49)`，退出码 0。
  - `pnpm test`（全套）→ `Test Files 115 passed (115)`，`Tests 943 passed (943)`，退出码 0。
  - `pnpm typecheck` → 退出码 0。
  - `pnpm exec prettier --check` 对本任务全部文件 → `All matched files use Prettier code style!`，退出码 0。

- 行为差异：
  - 曲线按计划精确实现。5 RPS 下 6 次 429 后连续 15 次成功的调度序列（fake timers 实测）：占位时刻 30000、32000、34000、36000、37000、38000、39000、39500、40000、40500、40750、41000、41250、41450、41650，总 41.85 秒 ≤ 45 秒，末尾 `effectiveIntervalMs = 200`。间隔经历 2000→1000→500→250→200（每 3 次成功减半，且不会低于 base）。
  - 关键语义拆分：`cooldownUntilMs`（429 之后的冷却，指数增长、上限 30 秒）与 `effectiveIntervalMs`（占位间隔，上限 2 秒）现在是两个独立量。旧实现把两者混为一谈，导致冷却结束后的每一次调用都继续被 30 秒间隔拖住。
  - `Math.max(this.baseIntervalMs, Math.min(2000, ...))` 的顺序保证低速率配置不会被 2 秒上限“提速”：`perSecond=0.4` 时 base=2500ms，6 次 429 与 15 次成功后仍是 2500ms，实测占位时刻 30000/32500/35000。
  - 60 秒无 429 后在下一次 `acquire`/`penalize` 前回落到 base 并清零 `cooldownDelayMs`；回落只动曲线，**不动 `nextMs`**，因此尚未到期的显式 `defer()` 不会被提前（实测 `defer(90000)` 在 61 秒空闲 + 3 次成功后仍在 90000 才占位）。
  - `succeed()` 不再使用旧的 `penaltyMs -= 250`（该式在低速率下会让惩罚永不归零）；只做减半。
  - `acquire` 由「一次算好等待时长」改为「每次 sleep 后重读四个上限」，因此等待期间落下的惩罚会被遵守，且 additional（backfill）限流器的冷却同样被计入。
  - `client.ts` 未改：429 无 retry 时仍 `penalize()`（该分支在 `retryFollows` 判定之前），未知错误只在真的有下一次 retry 时 `defer()`。新增测试证明前者在当前实现下成立；它是回归护栏而非 RED（旧实现已满足，如实记录）。
  - 既有测试期望值更新（只此一处，且收紧未放松）：`tests/unit/rpc-review.test.ts` 的 `times[2]-times[1]` 由 `1000` 改为 `200`。旧值编码的是「冷却延迟会继续当作占位间隔」这一被修掉的行为；新值 200ms 恰好是 base（100ms）的一次加倍，仍然证明「429 之后调用被拖慢、且随后恢复」。`times[1]-times[0] === 1000`（冷却）与末尾 `=== 100`（恢复基线）两条断言未动。
  - 无 schema/DDL 变化，无配置默认值变化。

- 性能：本任务不改吞吐上限，只修恢复速度；无独立性能样本（规模样本属 D/E 系列）。给出的是可复现的调度时刻，见「行为差异」。

- 兼容性与未执行项：
  - 兼容：`RateLimiter` 构造签名、`acquire`/`enter`/`defer`/`penalize`/`succeed` 全部保留，`state()` 为纯新增只读快照；`additional` 参数语义保留并加强。
  - 未执行：真实 provider 验证；运行中 follow/dashboard 重启或迁移；线上 Manager 切换；新 RPC 采样；两小时 soak；80k/160k 正式样本；merge/push。

- Commit：`eb206cb9ec3af99e90f3a82139ad7cecc401d8db`（子计划 01 单一提交，A1–A4 全部在内；本行哈希的补写位于其后的一个小提交）

---

### A4

- 状态：完成

- 修改文件：
  - 修改 `src/metrics/rolling.ts`（新增 `RollingCoverageIndex` 与 `prepareRollingCoverage()`；抽出 `coverageReasons()`；`window()` 改收已建好的索引；`buildRollingMetrics` 内按 coverage 集合建一次索引并复用；dormant 缓存键按 `earliest` 归一化 birth，并改为按索引分组 + rawToken/birth 双键；scope 过滤结果按 scopeId 记忆化，使索引缓存可以数组标识为键）
  - 修改 `src/ops/work-counters.ts`（新增计数键 `coverageIndexBuilds`；sink 为 null 时零开销）
  - 新增 `tests/helpers/rolling-reference.ts`（**独立**的逐池参考实现：自带一份 coverage reason 计算，不调用被测模块；不跨池缓存。仅测试使用，不进生产路径）
  - 新增 `tests/unit/rolling-dormant-scale.test.ts`（8 个用例：共享范围、逐组等价、窗口内出生不共享、边界出生共享、未知时间事件不命中空缓存、索引只建一次的结构计数、不跨 build 复用、gap 覆盖等价）
  - 修改 `tests/unit/rolling-windows.test.ts`（新增公开入口 `rollingCoverage` 与 `prepareRollingCoverage` 答案逐条一致的用例，含 watermark-partial 前缀、窗口内出生、覆盖缺口）

- RED：
  1. 空池不可共享。`pnpm exec vitest run tests/unit/rolling-dormant-scale.test.ts`（实现未改）：
     ```
     FAIL  rolling-dormant-scale.test.ts > an empty pool born before the covered window cannot move the rolling cache key
     AssertionError: expected [] to have a length of 295 but got +0
     FAIL  rolling-dormant-scale.test.ts > every shared group still matches an independent per-pool computation
     AssertionError: expected [ …(300) ] to have a length of 6 but got 300
      Test Files  1 failed (1)
           Tests  4 failed | 4 passed (8)
     ```
     为什么是原问题：300 个空池各自持有一个 `rolling` 对象（300 组），没有任何共享。旧键 `JSON.stringify([rawToken, discoveredAtBlock])` 把发现高度写进键，于是「出生早于可验证边界」这一对结果无影响的差异也让缓存全部落空。
  2. 边界出生不共享（第 3 条失败 `expected {...} to be {...}`）：`birth = earliest` 与 `birth = earliest-1` 的两个池结果相同却各自计算，钉住归一化条件必须是 `birth <= earliest`。
  3. `coverageIndexBuilds` 的 `toBeGreaterThan(0)` 先失败（计数尚未接入真实路径），保证「索引只建一次」不是 `0 <= 2` 的假通过。
  4. 第 4 条失败是测试自身的窗口边界写错（把 10 分钟前的缺口断言到 5m 窗口上）；已改为断言 15m/1h 含 `coverage-missing`、5m 保持 `closed`。按实际语义修正，不是放宽。

- GREEN：
  - `pnpm exec vitest run tests/unit/rolling-windows.test.ts tests/unit/rolling-dormant-scale.test.ts tests/integration/rolling-replay.test.ts` → `Test Files 3 passed (3)`，`Tests 18 passed (18)`，退出码 0。
  - `pnpm test`（全套）→ `Test Files 115 passed (115)`，`Tests 943 passed (943)`，退出码 0。
  - `pnpm typecheck` → 退出码 0。
  - `pnpm exec prettier --check` 对本任务全部文件 → `All matched files use Prettier code style!`，退出码 0。
  - 结构计数（300 空池 / 181 分钟覆盖 / 单 scope）：`evaluatedPools = 300`，`coverageIndexBuilds = 1`。对照的旧行为：改动前每个窗口查询各建一次索引（每池 222 次查询），300 池合计 66600 次。

- 行为差异：
  - `rollingCoverage(coverage, start, end, watermark, birth)` 的**签名与语义完全不变**，内部改为 `prepareRollingCoverage(coverage).reasons(...)`；dashboard snapshot 与 metric-store 的既有调用点未改。新增的 `prepareRollingCoverage` 是给「一次 build 内多次查询」用的辅助入口。
  - 共享范围严格由 `earliest` 决定：`earliest` = 本次实际使用 coverage 集合（`cs`）中**非 null** `fromBlock` 的最小值。只有 `birth <= earliest` 时键里的 birth 才写为 `null`；`earliest === null`（没有任何可验证边界）时保留原 birth。因为 `pool-lifetime-incomplete` 只在 `c.fromBlock < birth` 时触发，而窗口内任何 `c.fromBlock >= earliest`，所以 `birth <= earliest` 时该分支恒不触发，归一化不改变任何输出。
  - **不修改原 registration**：`registration.discoveredAtBlock` 仍按原值传给 `window()` 计算，归一化只影响缓存键的构造。
  - 缓存作用域：`dormant` 现在是 build 内的局部变量，并按「索引对象」再分一层，键只含 `rawToken` 与归一化后的 birth。跨 build 不共享（有用例断言两次 build 返回不同对象且值相等），避免在水位移动后复用过期结果。
  - 未知时间事件天然不命中空池缓存：读缓存的入口是 `es.length === 0`，而带未知时间事件的池 `es.length > 0`，且它自己也不会写缓存。有用例断言二者对象不同且各自与独立参考实现一致。
  - 索引缓存以 `cs` 数组标识为键，因此同一 scope 的过滤结果在一次 build 内只构造一次（按 scopeId 记忆化）；`scopes.size !== 1` 且 coverage 多 scope 时 `cs` 为共享空数组。
  - 无算法/公式改动：`inRollingWindow`、窗口拼接、baseline、`natural5mBuckets` 等一律未动；等价性由独立参考实现逐字段比对（不调用被测模块，避免「自己对自己」）。
  - 无 schema/DDL 变化，无配置默认值变化；A4 未触碰 `rate-limit.ts`。

- 性能：本任务的收益是「一次 build 内少做重复工作」，不改变单次窗口计算的复杂度。结构计数是真实、可复现的证据（见 GREEN 末行），未用挂钟时间做验收（计划明确不要求 CI 跑绝对 2.58ms）。正式规模样本在 D/E 系列与 A1 的 80k/160k 报告中给出。

- 兼容性与未执行项：
  - 兼容：`buildRollingMetrics` 默认签名与返回结构未变；`prepareRollingCoverage` 为纯新增导出；`rollingCoverage` 旧调用兼容。
  - 未执行：真实 provider 验证；运行中 follow/dashboard 重启或迁移；线上 Manager 切换；新 RPC 采样；两小时 soak；80k/160k 正式样本（E3）；merge/push。

- Commit：`eb206cb9ec3af99e90f3a82139ad7cecc401d8db`（子计划 01 单一提交，A1–A4 全部在内；本行哈希的补写位于其后的一个小提交）

- 附注（对 A2 记录的一处更正）：A3 收尾跑全套 `pnpm typecheck` 时发现 A2 新增的 `batch-timing` 日志解析块用了过窄的 `as { event?: string }`，导致 4 处 `TS2339`。已在 `tests/integration/runtime-recorder.test.ts` 补全该断言类型（`stageMs`/`counts`/`headObservedAgeMs`/`acceptedDataAgeMs`），并重跑 A2 目标测试（2 文件 / 11 用例通过）与 `pnpm typecheck`（退出码 0）。A2 记录中「typecheck 退出码 0」以本次修复后的树为准。

---

### B1

- 状态：完成

- 修改文件：
  - 新增 `src/storage/migrations/011-registry-changes.sql`（`registry_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, scope_id, pool_key, before_json, after_json)` + `(scope_id, seq)` 索引 + 4 个触发器：insert 记 `(NULL, new.payload_json)`、delete 记 `(old.payload_json, NULL)`、update 仅当 `new.payload_json IS NOT old.payload_json` 时记一条原地改写、move 当 `scope_id`/`pool_key` 变化时记「旧scope删除 + 新scope插入」两条）
  - 修改 `src/storage/database.ts`（迁移列表追加 `011-registry-changes.sql`）
  - 新增 `src/storage/registration-codec.ts`（从 raw-store 抽出的共享编解码：`storedPoolKey()`、`normalizeStoredRegistration()`、`storedRegistrationJson()`、`decodeStoredRegistration()`）
  - 修改 `src/storage/raw-store.ts`（改用上述 codec；本文件内原有的 `poolKey`/`normalizePoolRegistration`/`decodePoolRegistration` 删除，调用点不变）
  - 新增 `src/storage/registry-changes.ts`（`RegistryChange`、`registryRevision(db, scopeId)`、`registryChangesAfter(db, scopeId, seq)`，后者对读到的行数记 `registryChangesRead`）
  - 修改 `src/ops/work-counters.ts`（新增计数键 `registryChangesRead`）
  - 新增 `tests/integration/registry-changes.test.ts`（6 个用例：rollback 后 journal 与 revision 均不变；insert/真实 update/delete 各一条且 seq 有序、bigint 高度被还原；无变化的重写（同 payload 的 update、仅改列、`insert or ignore` 重复 upsert）不记任何条目；跨 scope 移动记两条；pool_key 改写记「旧键移除 + 新键出现」；revision 按 scope 独立且无行时为 0）

- RED：
  1. 模块缺失形态（00-master 第 3 节允许）。命令：
     `rm src/storage/registry-changes.ts && pnpm exec vitest run tests/integration/registry-changes.test.ts`
     失败输出：`Error: Cannot find module '../../src/storage/registry-changes.js' imported from …/tests/integration/registry-changes.test.ts`，`Test Files 1 failed (1)`，`Tests  no tests`。
     为什么是原问题：本条要证明的是「按 scope 的注册变更序列由数据库真实写入产生」，不是测试里另造一份变更列表；模块不存在时数据库里也不存在任何日志表与触发器，测试无法自证。
  2. 无变化重写的 RED（取出真实触发器里的不变量）。把 `pools_change_update` 的 `AND new.payload_json IS NOT old.payload_json` 去掉（只此一处），复现命令：
     `pnpm exec vitest run tests/integration/registry-changes.test.ts`
     失败输出（退出码 1）：
     ```
     FAIL  tests/integration/registry-changes.test.ts > a rewrite that changes nothing records nothing
     AssertionError: expected 3 to be 1 // Object.is equality
      Test Files  1 failed (1)
           Tests  1 failed | 5 passed (6)
     ```
     为什么是原问题：同 payload 的 update、只改列的 update、`insert or ignore` 重复 upsert 这三种「什么都没变」的写入，在朴素触发器下各记一条变更；它们会让每个读者每批都误判注册表移动，正是 B2 要消除的「每批全目录」的另一种形态。
  3. 移动/改键只记一半的 RED。删掉整个 `pools_change_move` 触发器，同一命令输出（退出码 1）：
     ```
     FAIL  … > an update that moves a pool between scopes records an old-scope delete and a new-scope insert
     AssertionError: expected [] to match object [ { scopeId: 'scope-a', …(2) } ]
     FAIL  … > a key rewrite records the old key as removed and the new key as present
     AssertionError: expected [] to match object [ { scopeId: 'scope-a', …(3) }, …(1) ]
      Test Files  1 failed (1)
           Tests  2 failed | 4 passed (6)
     ```
     为什么是原问题：日志的键是 `(scope_id, pool_key)`，一行移到别的 scope（或改键）在**旧键一侧**也是一次真实的消失；只记新键会让跟随旧键的读者永远持有已经不属于它的池。两次变异取证后均已还原（`011-registry-changes.sql` 与备份逐字节相同）。

- GREEN：
  - `pnpm exec vitest run tests/integration/registry-changes.test.ts` → `Test Files 1 passed (1)`，`Tests 6 passed (6)`，退出码 0。
  - `pnpm exec vitest run tests/integration/registry-changes.test.ts tests/integration/raw-store.test.ts tests/integration/payload-retention.test.ts tests/integration/catalogue-follow.test.ts`（受影响面：codec 抽取 + 迁移）→ `Test Files 4 passed (4)`，`Tests 25 passed (25)`，退出码 0。（本行于 B2 收尾时重跑复核，非当时粘贴值。）
  - `pnpm test`（全套）→ `Test Files 116 passed (116)`，`Tests 949 passed (949)`，退出码 0。
  - `pnpm typecheck` → 退出码 0；`pnpm exec prettier --check` 对本任务全部 `.ts` 文件 → `All matched files use Prettier code style!`，退出码 0。

- 行为差异：
  - 迁移 011 是**纯新增**：只建一张新表和它的索引/触发器，不改 `pools` 列、不改既有表；旧库打开时 `CREATE TABLE/TRIGGER IF NOT EXISTS` 直接生效，不需要回填——回填靠「首个读者读一次全目录并把 revision 记在当时的 `max(seq)`」完成（见 B2 的 `prepare()`）。
  - `pools_change_update` 的 `WHEN` 里带 `payload_json IS NOT`：`IS NOT` 对 NULL 也成立（左侧两列是 NOT NULL），因此一行 payload 从有到无/从无到有的迁移不会被漏记。
  - `pools_change_move` 与 `pools_change_update` 互斥（前者要求 `scope_id`/`pool_key` 至少一个变化，后者要求两者都不变），一次 update 只会命中一个，不会重复记录。
  - codec 抽取是**等价搬移**：`storedPoolKey`/`storedRegistrationJson`/`decodeStoredRegistration` 与原 raw-store 内的私有实现逐字相同（含 `discoveredAt.blockNumber` 以十进制字符串落库、读回时 `BigInt()` 还原），迁移编号 011 与计划预留一致（012 未占用）。
  - 无配置默认值变化，无窗口/信号公式改动。

- 性能：本任务只增加写入侧的一个 journal 追加（每行一次 INSERT，走 `(scope_id, seq)` 索引），不改读取路径的复杂度；读取侧收益由 B2 度量。无独立性能样本。

- 兼容性与未执行项：
  - 兼容：`raw-store.ts` 的公开方法签名与返回值未变；新增表对旧读取方不可见；旧库、旧批次格式、原工作区 `data/` 数据库均未被读写。
  - 未执行：真实 provider 验证；运行中 follow/dashboard 重启或迁移；线上 Manager 切换；新 RPC 采样；两小时 soak；80k/160k 正式样本（E3）；merge/push。

- Commit：随子计划 02 提交（见 B6 末尾汇总行）。

---

### B2

- 状态：完成

- 修改文件：
  - 新增 `src/storage/registry-cache.ts`（`RegistryView`/`PreparedRegistry`/`RegistryCache`：首次在同一 SQLite 读快照内读两个 scope 目录并记下两个 `registryRevision`；此后只查两个 revision，有变化才读 journal 增量；`overlay` Map + `deleted` Set 承载未提交变化；`publish()` 只在 `inTransaction === false` 时执行 delta 合并；无 journal 的旧库走兼容全读并标记 `revisionKey === 'legacy'`）
  - 修改 `src/registry/pools.ts`（新增 `registrationsEqual()`；把 `preview()` 的合并判定抽成导出的 `mergeRegistration()`，`preview` 改调它；`PoolRegistry` 新增 O(1) `get()`、`apply()`、`remove()`；`registerAll()` 由「clear + 全量排序」改为并集循环）
  - 修改 `src/ops/work-counters.ts`（`WorkCounts` 收 `registryChangesRead`，B1 已加，此处只在缓存里接线）
  - 新增 `tests/integration/registry-cache.test.ts`（11 个用例，见 RED/GREEN）
  - 未改：`raw-store.ts` 的 `pools()` 仍保留（旧读法回归用），离线 `PoolRegistry.preview`/`snapshot` 调用点未动

- RED：
  1. 「每批回退到全目录」变异。把 `RegistryCache.prepare()` 的 `if (!this.#loaded)` 改成 `if (true)`（只此一处），复现命令：
     `pnpm exec vitest run tests/integration/registry-cache.test.ts`
     失败输出（退出码 1）：
     ```
     × … > the first prepare reads both catalogues once and an unchanged prepare reads nothing
       → expected 80000 to be +0 // Object.is equality
     × … > two new pools cost two journal rows and never a catalogue read
       → expected 5 to be +0 // Object.is equality
     × … > a deleted pool disappears and a rewritten pool shows its new record
       → expected 4 to be +0 // Object.is equality
     × … > the journal speaks about a row while the registry speaks about a pool
       → expected +0 to be 1 // Object.is equality
     × … > uncommitted work is visible to its own view and reaches the cache only on publish
       → expected undefined to deeply equal { pool: { chainId: 4663, …(2) }, …(8) }
      Test Files  1 failed (1)
           Tests  5 failed | 6 passed (11)
     ```
     为什么是原问题：这正是改动前的行为——每个批次都要读满 8 万行目录；第一行把差异量化成 `registryRowsRead 80000 vs 0`，而不是「感觉快了」。
  2. 「删除时保留旧记录」变异（钉住 journal 说的是行、注册表说的是池）。把删除分支的 `derivePool()` 结果换成 `mergeRegistration(current, survivor)`（只此一处），同一命令输出（退出码 1）：
     ```
     × … > a deleted pool disappears and a rewritten pool shows its new record
       → Conflicting pool registration 4663:v3:0x0000000000000000000000000000000000000003
     × … > the journal speaks about a row while the registry speaks about a pool
       → expected 1001n to be 5000n // Object.is equality
     × … > uncommitted work is visible to its own view and reaches the cache only on publish
       → expected [ …(2) ] to deeply equal [ Array(1) ]
      Test Files  1 failed (1)
           Tests  3 failed | 8 passed (11)
     ```
     为什么是原问题：一条发现行被删掉后，池是否还在、由哪条幸存行描述，只能由**剩余行按目录读序折叠**回答；按「元数据相同就保留旧记录」回答会留下已经不存在的那行的时间戳（`1001n vs 5000n`），而同一条规则遇到真实内容冲突时又会误抛 `Conflicting pool registration`。两次变异取证后均已还原。

- GREEN：
  - `pnpm exec vitest run tests/integration/registry-cache.test.ts` → `Test Files 1 passed (1)`，`Tests 11 passed (11)`，退出码 0（80k 用例 4.1s，未超 120s 上限）。
  - `pnpm exec vitest run tests/integration/registry-cache.test.ts tests/integration/live-projection.test.ts tests/integration/catalogue-follow.test.ts`（计划点名的三件套）→ `Test Files 3 passed (3)`，`Tests 24 passed (24)`，退出码 0。
  - B1+B2 连同回归面 `tests/integration/registry-changes.test.ts` → 4 文件 / 30 用例通过，退出码 0。
  - `pnpm test`（全套）→ `Test Files 117 passed (117)`，`Tests 960 passed (960)`，退出码 0。
  - `pnpm typecheck` → 退出码 0；`pnpm exec prettier --check` 对本任务全部 `.ts` 文件 → `All matched files use Prettier code style!`，退出码 0。
  - 结构计数（89800 行目录 = 两个 scope 各 4 万 / 80000 池，`openWorkCounts()` 真实计数）：
    - 首次 `prepare()`：`registryRowsRead = 80000`、`registryChangesRead = 0`、`changedPoolIds.size = 80000`。
    - 无变更的第二次 `prepare()`：`registryRowsRead = 0`、`registryChangesRead = 0`、`registryRowsSerialized = 0`、`changedPoolIds.size = 0`。
    - 新增 2 池：`registryChangesRead = 2`、`registryRowsRead = 0`、`changedPoolIds` 恰为这 2 个 id。
    - 删除 1 池 + seed 记录被链上记录替换 + 原地改写 1 池：`registryChangesRead = 3`、`registryRowsRead = 3`（被替换的池跨两个 scope 各 1 行 + 改写池 1 行；被删掉的池只花一条 journal，不读行）。

- 行为差异：
  - **合并规则未改**：`mergeRegistration()` 是 `preview()` 原有判定的逐字抽取（相同 → 保留已持有；元数据不同 → 抛 `Conflicting pool registration`；已持有非 seed → 保留；已持有是 seed 且候选非 seed → 采用候选）。`preview()` 与离线 `PoolRegistry` 的语义因此完全不变，缓存复用它。
  - `registerAll()` 由「清空 + 全量重建 + 排序」改为并集循环（原实现 `preview` 返回旧∪新后再整体重建，语义等价），去掉了每批一次全量排序；需要稳定顺序的调用方仍走 `snapshot()`/`preview()` 的排序返回。
  - 缓存的三条路径：
    - **首次**：在同一 `database.transaction()` 读快照里先读两个 scope 的目录、**后**读两个 revision——加载期间落地的写入已经在行里，不会被再回放一次。
    - **增量**：只比两个 revision；有变化才按 seq 读两段 journal（registry scope 在前，与目录读序一致）。
    - **旧库**：`sqlite_master` 探不到 `registry_changes` 时保持全读，`revisionKey === 'legacy'`，且每个池都报为 changed（无从得知谁动了，保守答案）；不执行任何 DDL。
  - 回放规则按「变更条目」分两种：插入一个**本缓存从未持有**的映射时直接采用该条 payload（因此发现新池零额外读取）；其余（新增第二行、原地改写、删除、改键/跨 scope）都按 `derivePool(pool_key)` 折叠该键**仍然存活**的行——registry scope 在前、`discovered_block_number, pool_key` 升序——结果与「重读目录」对同一池得到的记录逐字节一致。`changedPoolIds` 只在记录真的不同（`registrationsEqual`）时才报。
  - `overlay`/`deleted` 的读取优先级：`get`/`all`/`forAsset`/`isDiscoveryRef` 一律「overlay 先、再 deleted、再基础 Map」，即本批未提交的发现永远是最新事实；`stage()` 会把 id 从 `deleted` 移除，`discard()` 只丢 overlay，`publish()` 才把 overlay 按合并规则并入共享缓存。
  - `publish()` 在 `database.inTransaction` 为真时抛错（计划要求「只能在 `db.inTransaction=false` 时运行」）；`publish()` **不**推进记住的 revision，下一次 `prepare()` 会把自己的提交按 seq 幂等回放一遍（回放对同一条记录是 `registrationsEqual` 短路），因此不存在「publish 与 revision 之间的空窗」。
  - 未使用 `new Map(allPools)` 做事务隔离（计划明令禁止）：隔离由 overlay/deleted 承担，80k 规模下不复制目录。
  - 无 schema/DDL 变化（011 在 B1），无配置默认值变化，无窗口/信号公式改动；`src/storage/raw-store.ts` 未改。

- 性能：本条不引入新的挂钟样本（规模样本属 E3），给出的是**结构计数**（见 GREEN 末段）——它是可复现的整数，不依赖机器负载。旧路径每个批次 `registryRowsRead = 80000`（A1 基线数字），新路径在无变更批次为 0、在「新增 2 池」批次为 0、在「删除+替换+改写」批次为 3。

- 兼容性与未执行项：
  - 兼容：`PoolRegistry` 既有构造/`snapshot`/`preview`/`registerAccepted`/`invalidateAfter` 签名未变；`RegistryCache` 是纯新增导出，尚未接入 `recorder`（B3 接线）；离线 `preview` 路径保留可用；旧库全读路径有回归用例；无 DDL、无迁移回填。
  - 未执行：真实 provider 验证；运行中 follow/dashboard 重启或迁移；线上 Manager 切换；新 RPC 采样；两小时 soak；80k/160k 正式样本（E3）；merge/push。

- Commit：随子计划 02 提交（见 B6 末尾汇总行）。

---

### B3

- 状态：完成

- 修改文件：
  - 修改 `src/storage/live-projection.ts`（自基线的累计差异 782 行，含 A1 的计数与 A2 的 `projection` 阶段计时）：
    - `sync()` 新增第 4 个可选参数 `PreparedRegistry`；新增 `RegistryMove`、`RegistryEvidenceChange`、`RegistryEvidence` 类型
    - `registry_json` 由「全目录数组」改为小引用 `{format:'registry-cursor-v1', registryScopeId, operationScopeId, registrySeq, operationSeq}`；旧数组只被读一次做兼容比较（`movesSinceArray`），比较结果记 `registryInitialization = journaled`，随后写回引用
    - 新增 `movesAfter()`：由 journal 增量推导 moves（两个 scope 各一段 `registryChangesAfter`），只有 move 涉及的地址/manager 与它们的 discovery log 被标 dirty/forced
    - token 未变时提前返回 `{repairFrom:null, affectedPoolIds:[], registryInitialization:false, registry:{revisionKey, changes:[]}}`（journal 存在时）：`pools` 的每次写入都动 revision，token 未变即证明「没有变更」，不是「没读出来」
    - 投影改为单一调用 `projectRangeSelected({...}, logs, times, view)`：不再 `registry.snapshot()`、不再为每个注册池建空 observation
  - 修改 `src/state/project-range.ts`（85 行）：新增 `projectRangeSelected(batch, activeLogs, logTimes, view)`；把原 `projectRange` 的取数口抽成 `{byPoolId, isDiscovery, preseed}`，`projectRange` 保持完整离线语义（`preseed: registrations`），两条路径共用同一个 `project()` 解码循环
  - 修改 `src/signals/project.ts`（73 行）：`Evidence.registry`；`readEvidence()` 第 4 个参数；`repairedFrom()` 的增量分支；`commitAcceptedSignalBatch()` 的 `options.registry` 透传给 `LiveProjectionStore.sync`
  - 修改 `src/ops/recorder.ts`（37 行）：accepted transaction **之前** `prepare()` + `stage(timed.poolRegistrations)`，`catch` 里 `discard()`，`commitAcceptedSignalBatch` 之后 `publish()`
  - 新增 `tests/integration/live-registry-incremental.test.ts`（10 用例，568 行）
  - 未改：`PROJECTION_VERSION`（仍 `p2-v2`）、`raw-store.ts` 的 `pools()`、离线 `PoolRegistry` 调用点、窗口/信号公式
  - 附：B2 的一条用例期望被纠正，见文末“附注”。

- RED：
  1. 「目录证据未接线」变异。把 `src/signals/project.ts:484` 的 `readEvidence(db, input, report, liveChanges?.registry)` 第四个实参去掉（只此一处），复现命令
     `pnpm exec vitest run tests/integration/live-registry-incremental.test.ts`，失败输出（退出码 1）：
     ```
     × zero registry change over a large catalogue costs nothing in the sync path
       AssertionError: expected 16004 to be 8002 // Object.is equality
     × an identity a registry delta omits is never withdrawn on the strength of the omission
       AssertionError: expected [ …(3) ] to deeply equal [ Array(1) ]
      Test Files  1 failed (1)
           Tests  2 failed | 8 passed (10)
     ```
     为什么是原问题：这正是 B3 之前的行为——信号证据每轮自己再读一遍全目录，并把「目录」当成「增量」写进游标。4001 池 × 两个 scope 名 = 8002 是 C1 仍持有的 metric 合并成本，变异后成为 16004，多出来的一整遍正是这条证据；第二条里游标的 `pools` 组从「本窗口真正移动的那 1 个身份」变成 3 个身份。
  2. 「增量被当成全目录」变异。把 `src/signals/project.ts:322` 的 `if (group === 'pools' && registryDelta)` 改成 `if (false && …)`（只此一处），同一命令，失败输出（退出码 1）：
     ```
     × an identity a registry delta omits is never withdrawn on the strength of the omission
       AssertionError: expected [ [ 'hot', …(1) ], …(3) ] to deeply equal [ [ 'hot', …(1) ], …(2) ]
     + [ 'retracted', '4663:v3:0x…0009' ]
      Test Files  1 failed (1)
           Tests  1 failed | 9 passed (10)
     ```
     为什么是原问题：旧的全目录比较把「增量里没有的身份」当成「已经被移除」，于是把一个仍然注册在案、本窗口只是没有移动的池的告警撤掉（多出一条 `retracted …0009`）。增量的语义是「变了什么」，不是「有什么」，这两件事在只有增量的证据里不能互换。
     两次变异取证后均已还原：`grep -n "false &&\|console.log" src/signals/project.ts` 只剩原有的 `item.complete === false &&`（第 335 行），该用例集回到 10/10，`git diff --stat` 与本记录一致。

- GREEN：
  - 计划命令 `pnpm exec vitest run tests/integration/live-registry-incremental.test.ts tests/integration/projection-repair.test.ts tests/integration/alert-reorg.test.ts tests/integration/alert-recorder-review.test.ts` → `Test Files 4 passed (4)`，`Tests 52 passed (52)`，退出码 0。（B2 收尾时同一命令为 51；新增第 10 个用例后为 52。）
  - B1+B2+B3 联合（`registry-changes.test.ts` + `registry-cache.test.ts` + `live-registry-incremental.test.ts`）→ `Test Files 3 passed (3)`，`Tests 27 passed (27)`，退出码 0。
  - `pnpm test`（全套）→ `Test Files 118 passed (118)`，`Tests 970 passed (970)`，退出码 0。
  - `pnpm typecheck`（`tsc --noEmit && tsc -p tsconfig.scripts.json`）→ 退出码 0；`pnpm lint`（`node scripts/check-scripts.mjs && prettier --check`）→ `All matched files use Prettier code style!`，退出码 0。
  - 结构计数（来自真实路径的计数，不是挂钟）：
    - 0 注册变更 + 1 条新 swap 的接受批次（用例 9，目录 4001 池）：`registryRowsRead = 2 × 4001 = 8002`、`registryRowsSerialized = 8002`、`registryChangesRead = 0`；随后一次 `sync()`：`0 / 0 / 0`，`registry.changes = []`，`registryInitialization = false`。2×size 全部来自 C1 仍持有的 metric 合并（两个 scope 名各读一遍），注册增量与由它构造的证据在其上**加 0**。
    - 2 个新池（用例 2）：`registryRowsRead = 0`、`registryChangesRead = 4`（每个池 1 条 journal、被读两次：一次折进注册表视图、一次界定本批要 repair 的身份），`registry.changes` 恰为这 2 个身份、`block` 均为出生高度、`record` 非空。
    - 接受批次用自己 staged 的上下文（用例 8）：`registryRowsRead = 0`、`registryRowsSerialized = 2 × 本批注册数`（`covers()` 对每条 staged 注册做一次 `registrationsEqual`，两侧各序列化一次），`registry.changes` 恰为本批发现的 1 个身份；`publish()` 之后的下一次 `prepare()`：`0 / 0`、`changedPoolIds.size = 0`，但视图里**有**该池——按 `pools` 行折叠得出，不是本批 stage 进去的。
    - 旧数组游标（用例 5）：首次 `sync` 为 `registryInitialization = true`、`registryRowsSerialized > 0`，游标被改写成 `registry-cursor-v1` 且 `registry_json` 不含 `token0`；第二次 `sync` 三个计数全 0。
    - 进程重启（用例 6）：`registryRowsRead = catalogue(db,'s').length`（只此一次冷加载）、`registryRowsSerialized = 0`、`changes` 恰为停机期间被外部写入的 1 个身份；紧接着的第二次 `sync` 全 0。

- 行为差异：
  - **`PROJECTION_VERSION` 未改**（仍 `p2-v2`），因此没有因为「目录存储格式变化」触发全历史重新解码——这是 B3 点名禁止的做法。取代它的是游标自身的存储版本 `VERSION = PROJECTION_VERSION + '-incremental-v1'`：既有游标行会因此重建一次（一次 live 投影重建，不是全历史重放），此后一直走引用。旧数组游标的兼容路径并不依赖这个版本号也能工作（`parseRegistryCursor` 对数组返回 null → 走 `movesSinceArray` 的一次性比较），版本号只是把「游标行结构变了」显式化。
  - 引用里记的是两个 scope 各自的 seq。引用描述的 scope 对不上当前请求时，按「与版本变化一样陈旧」处理：走 `syncOnce(..., forceRebuild=true)` 重读目录，而不是拿一份描述别的注册表的引用继续用。
  - **证据组语义**：有注册表上下文时，`Evidence.pools` 是「自上一窗口以来移动过的身份」的**增量**（每个身份一条；`record === null` 表示该身份已不在目录里，用哨兵摘要 `no-longer-registered` 与任何真实注册摘要区分开），并带 `registry.format = 'registry-evidence-v1'`；没有上下文时（离线路径、无 journal 的旧库）仍是原来的全目录。`repairedFrom()` 按 `old.registry?.format` 分流：增量分支只修复「上一窗口报过且摘要变了」或「上一窗口没报过且出生在本窗口 tip 之前」的身份——**省略不等于撤回**。
  - 移除、seed→链上替换、同高度 hash 冲突都会让该身份的 journal `before/after` 不同，从而进入 moves、被标 dirty/forced，再按既有 `retractSignals` 规则撤回相关提醒；不会因为「引用不同」就每次全局撤回（全局撤回只发生在 `repairFrom = 0n` 的重建路径上，与 B3 之前一致）。
  - 投影不再为每个注册池建空 observation：`projectRangeSelected` 只按日志命名的身份向视图取记录，`isDiscoveryRef` 由 B2 维护的索引回答（识别 Factory 日志不再全表 `some`）。两条路径共用同一个 `project()` 解码循环，未知日志仍按原规则报 quality error——不会因为「集合选小了」就把合法 discovery 误判成未知池。
  - 事务语义：`prepare`/`stage` 在 accepted transaction **之前**，`sync` 在事务**内**（视图 = 本批自己 stage 的 overlay + 已提交状态），`publish` 只在最外层事务提交**之后**；`publish()` 在 `database.inTransaction` 为真时抛错。回滚路径（用例 7）实测：事务内抛错 → `discard()` → 游标行的 `registry_json`/`source_hash` 与批前**逐字节相同**，且该发现随后真正落库时 journal 仍然只报它一个。
  - `sync` 只在「视图的 revisionKey 就是刚读到的位置」或「自视图位置以来写入的每一行都是本视图 stage 的」两种情况下采用调用方传进来的上下文（`covers()`），否则自己 `cache.prepare()`。因此不能有一条入口靠「传了个对象」就绕过正确性检查。
  - 旧调用者不传 `registry` 时行为不变：`sync` 自己 `cache.prepare()`，`readEvidence` 走全目录分支（`pnpm test` 全绿是回归证据；用例 5/6/9/10 与 `liveSync()` 辅助走的正是这条入口）。
  - 无 schema/DDL 变化（011 在 B1），无配置默认值变化，无窗口/信号公式改动。

- 性能：本条不引入新的挂钟样本（80k/160k 正式样本属 E3），给出的是结构计数（见 GREEN 末段）。要点是**「读多少行」与「目录多大」解耦**：0 变更批次的注册表增量为 0 行、0 次序列化；2 个新池为 2 条 journal（每条读两次）；接受批次用 staged 上下文时为 0 次目录读。仍在真实路径上、**尚未**消除的目录成本有两处，交回后续子计划，不在此声称已解决：
  - `src/ops/recorder.ts:743` 附近的 discovery fetch 仍用 `new PoolRegistry(store.pools(discoveryScope))` 规划整轮请求；这是 B4 的 `OperationFilterIndex`（E1 再加 Manager 分支）要处理的对象。
  - `src/ops/recorder.ts:928` 附近的 batch `registry` 阶段仍 `[...store.pools(discoveryScope), ...store.pools(scopeId)]` 读两份目录（用例 9 里的 `2 × size` 就是它），C1 负责把 metric 归并的这一遍压下去。
  - 同一条 journal 小段在一次接受批次里会被读若干次（`prepare` 折入视图、`covers()` 证明「视图就等于该位置」、`movesAfter()` 界定修复范围、`publish()` 步过），每次的量都由**本批自己的变更行数**界定（用例 2 的 `registryChangesRead = 4` 即「2 个新池 × 2 次」），不随目录规模增长。

- 兼容性与未执行项：
  - 兼容：`sync` 新参数可选，`read`/离线 `SqliteProjectionStore` 未改；旧的 `registry_json` 数组格式有专门用例与兼容分支；旧库无 journal 时 `registryJournalAvailable()` 为假，证据组退回全目录、不写引用、`revisionKey === 'legacy'`；未触碰原工作区运行中的 follow/dashboard、`.env`、实际 config 或 `data` 数据库。
  - 未执行：真实 provider 验证；运行中 follow/dashboard 重启或迁移；线上 Manager 切换；新 RPC 采样；两小时 soak；80k/160k 正式样本（E3）；merge/push。

- Commit：随子计划 02 提交（见 B6 末尾汇总行）。

- 附注（对 B2 记录的两处更正）：
  1. `prepare()` 的快照读序。B2 首版把「读两个 revision」放在 `reload()` **之前**：同一个读快照里先取到的 revision 可能早于随后读到的行，加载期间落地的写入就既在行里、又会被按 journal 回放一次。已改为先 `reload()` 再读两个 revision（`src/storage/registry-cache.ts:168-173`）。B2 记录「缓存的三条路径 → 首次」描述的是修正后的行为。
  2. 「未提交工作只在自己视图里可见」用例的陈旧期望。该用例原先在 `stage([staged])` 之后**不写 `pools` 行**就断言 `publish()` 后视图仍持有该池。真实路径不是这样：`recorder` 的 `publish()` 发生在 accepted transaction 提交之后，行已经在 `pools` 里；而 `publish()` 从 B2 起就按 `derivePool()` 折叠行、不采信「批次要求了什么」（这正是「批次拒绝落库的注册不会成为本视图声称的池」的保证）。已把该用例改为写入 accepted transaction 会写的那一行（`seed(database, REGISTRY_SCOPE, [staged])`）再 `publish()`，断言收在「视图与目录逐条相同」+「下一次 `prepare()` 的 `registryRowsRead`/`registryChangesRead` 均为 0」（证明是折入而非重读）。B2 记录里引用到的那条失败文本（`expected undefined to deeply equal { pool: … }`）出自修改前的用例体：同一变异（`if (true)`）在修改后的用例下仍失败 5/11，其中三条断言文本逐字不变（`expected 80000 to be +0`、`expected 5 to be +0`、`expected +0 to be 1`），另外两条本次首先触发的是 `expected 4 to be 3` 与 `expected 2 to be +0`。

- Commit：随子计划 02 提交（见 B6 末尾汇总行）。


---

### B4

- 状态：完成

- 修改文件：
  - 修改 `src/storage/manifest.ts`（+6 行）：`RecordedRangeBatch.registryMode?: 'referenced-v1'`，字段可选，未标记的旧批次语义不变。
  - 修改 `src/ingest/record-range.ts`（+74 −12）：`FetchRangeOptions.registry` / `operationFilters` 二选一（`validateRange` 里 `(pools === undefined) === (registry === undefined)` 即抛错，并要求 index 的 deployments 与 maxFilterValues 与本轮一致）；referenced 分支不再走 `pools.preview()`，operations 计划改为 `operationFilters.prepare(registry, staged).plan(from, to)`；`candidateRegistrations` 最终由 `referencedRegistrations(allLogs, staged, registry.view, deployments)` 求出；`...(referenced ? { registryMode: 'referenced-v1' } : {})`。
  - 修改 `src/ingest/filter-plan.ts`（+145 −61）：把「请求要问哪些值」从「请求本身」里分出来，供 `OperationFilterIndex` 长期持有。新增 `OperationFamily`、`ShardFilter`（只有值，没有区块范围）、`OperationShard`、`OperationFilterValues`、`lower`（保类型的 lowerCase，`record-range` 与索引共用同一个小写口径）、`isV4OperationTopic`、`ensureFilterValueLimit`（原来的值上限校验提取成函数，两条通路都先跑它）、`partitionValues`（`partitionPlans` 的值切分部分）、`identityValues`、`operationFilterValues`（一个目录要问的全部池身份，去重且按同一排序）、`buildOperationShardFilters`（切到值上限为止、不带区块范围的请求模板）。`buildOperationFilterPlan` 保留为整批一次成型的老入口，其输出由既有真实调用路径的集成测试覆盖（`recorder` / `runtime-recorder` / `batch-registry-dependencies` / `metrics-repair` 等），无既有测试被改写。
  - 修改 `src/ops/recorder.ts`（B4 部分 4 处）：`const operationFilters = new OperationFilterIndex(deployments, config.maxFilterValues)`（第 160 行，每轮 run 一个）；`fetchRange` 调用处透传 `operationFilters: prepared === null ? undefined : operationFilters`（965）；accepted transaction 提交后 `operationFilters.publish()`（1117）、`finally` 里 `operationFilters.discard()`（1191）——与 `prepared` 同一处结算，成功才留下本批 discovery。
  - 修改 `src/storage/raw-store.ts`（B4 部分 2 处）：`transportJson` 写入 `registryMode`（immutable 传输载荷的一部分，因此丢字段的改写会被 `saveRaw` 拒绝）；`pools` 行与批次数组共用同一套 `registration-codec.ts` 编码。
  - 修改 `src/storage/payload-store.ts`（+1）：`canonicalBatch` 携带该字段，保证「写进去的」与「读出来的」逐字段一致。
  - 新增 `src/ingest/registry-dependencies.ts`（83 行）：`referencedRegistrations`。四类引用（本批 discovery log、本批 staged 的 V3 地址/V4 poolId、视图按 V3 地址、部署的 V4 Manager + 已支持的操作事件 topic + 合法 poolId），其余日志一律不动；未知池只留原始 log，不伪造注册；结果按 `poolRegistrationId` 排序。
  - 新增 `src/ingest/operation-filter-index.ts`（212 行）：`OperationFilterIndex`。按 scopeKey/revisionKey 缓存无 from/to 的模板；无变化轮只重新包装 bounds（复用同一 `address`/`topics` 数组）；变化轮只重建被移动的协议并计 `operationFilterRebuilds`/`operationFilterValuesScanned`；`prepare()` 返回 lease，`publish()`/`discard()` 决定本批 staged 身份的去留。
  - 新增 `tests/integration/batch-registry-dependencies.test.ts`（9 用例，634 行）、`tests/unit/operation-filter-index.test.ts`（9 用例，304 行）。
  - 未改：窗口/信号公式、`PROJECTION_VERSION`、`acceptRange` 的接受/回滚语义、`reconcilePools` 的删除条件（仍要求 discovered_block_number 落在本批区间**且**对应发现日志 inactive）。

- RED（三处单点变异，均只改一处、跑完即还原；失败文本为退出码 1 的原文）：
  1. 「批次又背回整本目录」。把 `src/ingest/record-range.ts` 的 `candidateRegistrations = referencedRegistrations(allLogs, staged, options.registry!.view, deployments)` 换成 `[...options.registry!.view.all()]`（只此一处），`pnpm exec vitest run tests/integration/batch-registry-dependencies.test.ts`：
     ```
     ❯ tests/integration/batch-registry-dependencies.test.ts (9 tests | 8 failed) 2050ms
       ❯ the plan holds at the review scale (1)
         × an 80k catalogue is adopted once and costs nothing per unchanged round 2012ms
       ❯ a batch carries the registrations its own logs depend on (6)
         × an old pool swap and a new pool in one batch carry exactly those two registrations 5ms
         ...
     AssertionError: expected [ { pool: { …(4) }, …(8) }, …(79999) ] to have a length of 1 but got 80000
     ❯ tests/integration/batch-registry-dependencies.test.ts:416:38
     ```
     为什么是原问题：这正是 B4 之前的行为——每批带的不是「本批日志依赖了谁」而是「目录里有什么」，于是一个只碰 1 个池的批次序列化 80,000 条注册。用例 1 在同一变异下拿到的是被 seed 的 v3 池而不是本批发现的 v4 池（`expected { chainId: 4663, protocol: 'v3' } to match object { protocol: 'v4' }`），即数组的内容与次序都由目录决定。
  2. 「数组不再声明怎么读」。把 `...(referenced ? { registryMode: 'referenced-v1' as const } : {})` 删掉（只此一处），同一命令：
     ```
     ❯ tests/integration/batch-registry-dependencies.test.ts (9 tests | 6 failed) 2029ms
     AssertionError: expected undefined to be 'referenced-v1' // Object.is equality
     ❯ tests/integration/batch-registry-dependencies.test.ts:441:32
     ```
     为什么是原问题：小数组本身没有意义——`[]` 既能表示「本批没依赖任何池」，也能表示「目录里没有池」。少了这个标记，旧读法会把 referenced 数组当成完整目录，于是未列出的池会被当成已撤回。变异下 6 条用例失败，含 `survives both stores, refuses a rewrite that drops it, and never deletes a silent pool`：两个 store 都不再能拒绝「丢掉标记的改写」。
  3. 「模板没有接入真实路径」。把 referenced 分支的 `options.operationFilters!.prepare(options.registry, staged).plan(...)` 换成只 `plan(...)`（即从未 `prepare`，只此一处），`pnpm exec vitest run tests/integration/runtime-recorder.test.ts`：
     ```
     ❯ tests/integration/runtime-recorder.test.ts (7 tests | 1 failed) 7473ms
       × a stop during minute resolution prevents later RPC admissions and preserves raw evidence 479ms
     AssertionError: expected false to be true // Object.is equality
     ❯ tests/integration/runtime-recorder.test.ts:334:7
     Test Files  1 failed (1)
          Tests  1 failed | 6 passed (7)
     ```
     为什么是原问题：没有 `prepare` 就没有视图，operations 计划为空，整批只发 discovery 请求、0 条操作日志——**这正是「新模块只导出函数给单测调用、没接进真实调用路径」的样子**，而它由 recorder 自己的停机遇例触发（该用例要求停机前留下的未接受批次有 `logs > 0` 的原始证据）。这条是三条 RED 里唯一由既有真实路径用例发现的，也是 B4 接线正确的证据。

- GREEN：
  - 计划命令 `pnpm exec vitest run tests/unit/operation-filter-index.test.ts tests/integration/batch-registry-dependencies.test.ts tests/integration/compact-batches.test.ts tests/integration/raw-save-failure.test.ts tests/integration/recorder.test.ts` → `Test Files 5 passed (5)`，`Tests 34 passed (34)`，退出码 0。
  - 追加的相邻回归 `pnpm exec vitest run tests/integration/runtime-recorder.test.ts tests/integration/live-registry-incremental.test.ts tests/integration/registry-changes.test.ts tests/integration/registry-cache.test.ts` → 全通过。
  - `pnpm typecheck`（`tsc --noEmit && tsc -p tsconfig.scripts.json`）→ 退出码 0。
  - `pnpm test`（全套）→ `Test Files 120 passed (120)`，`Tests 988 passed (988)`，退出码 0。（B3 收尾为 118/970，差值 2 个文件 / 18 条用例 = B4 新增的两个测试文件，无既有用例被改写。）
  - 80k 结构计数（`tests/integration/batch-registry-dependencies.test.ts` 最后一条用例，真实 `fetchRange` + `OperationFilterIndex` + `RegistryCache` 路径，计数器由生产代码自增，用例耗时 2.0 s）：
    - 目录 80,000 池（78,000 v4 + 2,000 v3）：**采纳一次** = `operationFilterRebuilds = 2`（每个协议一次）、`operationFilterValuesScanned = 80_000`。
    - 紧接着的**零注册变更**轮（同 index、同 revisionKey，只加 1 条 swap）：`operationFilterRebuilds = 0`、`operationFilterValuesScanned = 0`——模板数组按引用复用（单测里以 `toBe` 断言 `address`/`topics` 是同一数组，只有外层 filter 与 from/to 是新的）。
    - 同一批 `batch.poolRegistrations.length = 1`（目录 80,000），且该轮**仍然向 provider 要了全部 80,000 个池**（断言存在 `address.length === 1000` 的请求）。
    - **未缩小项，分开报告**：`batch.manifest.shards.length = 84`（80,000 v4 ÷ 1000 + 2,000 v3 ÷ 1000 + 2 条 discovery），即原始 RPC 请求参数仍随目录规模增长。B4 只缩小 `poolRegistrations`；manifest 这一项按计划留给 R05，不在这里声称解决。

- 行为差异：
  - **未标记的旧批次语义不变**：`registryMode` 缺省时一切照旧（整目录数组）。`readBatch` 只解释该字段，不会把 referenced 数组自动扩展成 80k 数组，也不会反过来把旧数组当成依赖集。
  - **referenced 不是目录**。`acceptRange` 仍走原有 `persistDerived`（`insert or ignore`，只增不删）；`reconcilePools` 的删除条件仍是「本批区间内的发现 + 对应 discovery 日志不再 active」。因此一个 referenced 批次既不会因为数组变小而撤回未列出的池，也不会伪造：`an empty referenced batch claims nothing about the pools it did not see` 断言空数组 + 标记齐全时 `pools(scopeId)` 仍是 2 行。
  - **发现的依赖可以来自更早的批次**。`acceptRange` 的 `persistTransport` 会重写本批自带的每条 raw log，而更早的发现日志本来就已在 `raw_logs`（FK `discovered_raw_log_id INTEGER NOT NULL REFERENCES raw_logs(id)`，且全仓无 `delete from raw_logs`），所以引用总能落到本地证据上，这条路径没有任何 RPC 读取入口。用例 `carries a dependency an earlier accepted batch discovered` 用两个真实批次串起来验证：第二批只带 1 条 swap，注册数组是第一批那条记录，`acceptRange` 后 `pools` 仍 1 行、游标推进到 200、发现日志计数仍为 1（不重复写、不重取历史）。
  - **immutable 传输包含新字段**：`transportJson` 里带 `registryMode`，因此「写 compact 再 inline 写」「读回来」「丢字段改写」三种情况分别得到「equal」「`payload_json` 里出现 `referenced-v1`」「抛 `immutable`」。
  - 未知池/无关日志不伪造注册：`keeps an unresolvable log as raw evidence and fabricates no registration for it` 让 provider 主动返回 3 条没人请求的日志（陌生池地址的 V3 swap、非操作事件的 manager 事件、本目录不持有的 poolId），批次把 4 条原始日志全部保留，注册数组仍只有目录那条记录。V4 只在「部署的 Manager + 已支持的操作事件 topic + 32 字节 poolId」三条同时成立时才识别，任意 topic[1] 不当 poolId。
  - 事务语义未变：`prepare()`/`stage()` 仍在 accepted transaction **之前**，`publish()` 在提交**之后**，`finally` 里 `discard()`；`prepare()` 会先丢弃上一轮未结算的 lease（未提交批次不留下成员）。
  - 无 schema/DDL 变化，无配置默认值变化，无窗口/信号公式改动。

- Commit：随子计划 02 提交（见 B6 末尾汇总行）。

### B5

- 状态：完成（含一处 RED 敏感性限制与两条已记录的边界，见「未通过项」）

- 修改文件：
  - 新增 `tests/integration/referenced-batch-replay.test.ts`（10 用例，670 行）。
  - 修改 `src/replay/reader.ts`（B5 部分）：`ReplayCatalogueSnapshot` / `ReplayCatalogueSource` / `ReplayCatalogueRead`、`height()`、`readCatalogue()`、`ReplayInputSnapshot.catalogue?`。
  - 修改 `src/replay/export.ts`（B5 部分）：`catalogueSnapshot()`（206–223 行）与 `inputSnapshotMeta()` 里的 catalogue 摘要（177–201 行）。
  - 修改 `src/replay/runner.ts`（B5 部分）：`readCatalogue` 调用与按发现高度排序的 `catalogue`（179–190）、`adopted` / `deferred` / `adoptUpTo`（191–202）、三处调用点（263 recorded-observed、283 minute-close、362 收尾）。
  - 说明：`src/replay/clock.ts` 的 `mergeHistoricalBatches` 标记传播（+5 行）在本任务开始前已在工作树中，非 B5 新增；B5 只新增用例 9 把它固定下来。
  - 未改：窗口/信号公式、`PROJECTION_VERSION`、`acceptRange` 的接受/回滚语义、`reconcilePools` 的删除条件、`payload-store` 的三种编码与分块/gzip 上限。

- 消费者审计（计划 B5 第一条：`src` 内 `poolRegistrations` / `readBatch(` 的逐点判定，是否有人把数组当整本目录）：
  - 生产：`src/ingest/record-range.ts:455` 写 `complete ? candidateRegistrations : []`，referenced 轮带标记；`src/storage/payload-store.ts:291-294`（`canonicalBatch`）与 `src/storage/raw-store.ts:1166`（`transportJson`）——后者**丢** `poolRegistrations`、**留** `registryMode`。
  - 暂存/解码视图：`src/ops/recorder.ts:1105` `prepared?.stage(timed.poolRegistrations ?? [])`；`:1082` 只把数组当「本批要抓哪些 token 元数据」的候选（`metadataCandidates`），不当作寄存器。
  - 只增不删的并集：`src/registry/pools.ts:158` `registerAll(batch.poolRegistrations ?? [])`——Map 并集，任何数组都不会撤下已注册的池。
  - 有界过滤：`src/replay/clock.ts:53`（`prefixAt` 按 `discoveredAt.blockNumber < to`）、`:84-103`（merge 按 pool 键并集）。
  - 落库：`src/storage/raw-store.ts:925-938` `insert or ignore into pools`；仅当发现高度落在本批区间且 shard 的 `filterId` 家族被本批覆盖时要求一条 `active_logs` 行，否则跳过（不删、不伪造）。
  - `readBatch` 消费者：`src/metrics/coverage.ts:157`、`src/ops/history.ts:129`、`src/ops/storage-audit.ts:199`、`src/replay/export.ts:275,344`，另有不可改写比对 `src/storage/payload-store.ts:366` 与 `src/storage/raw-store.ts:674`。解码路径对 inline / `batch-ref-v1` / `batch-ref-v2` 三种编码不变，只在读回时带上 `registryMode`。
  - 结论：`src` 中没有任何点位在 `registryMode` 缺省/存在时改变读法，也没有任何点位把 referenced 数组展开成目录、或把旧数组反向当依赖集。

- RED（四次单点变异，每次只改一处、跑完即还原；失败文本为 vitest 原文）：
  1. 「目录被读出来又扔掉」。把 `src/replay/reader.ts` 最后一个 return 换成 `return undefined;`（只此一处），`pnpm exec vitest run tests/integration/referenced-batch-replay.test.ts`：
     ```
     FAIL ... > replays from four payload encodings with the source gone, as the un-migrated reader did
     FAIL ... > shows a pool that never traded as a zero under complete coverage, never as a gap
     FAIL ... > reads a catalogue that belongs to another scope, another assets version or no range
     FAIL ... > keeps a pool whose discovery evidence the dataset lacks unknown, and never a zero
     FAIL ... > cannot present a catalogue read after the study point as an as-of claim
           Tests  5 failed | 5 passed (10)
     ```
     为什么是原问题：inline 批次读回时数组与 `logTimes` / `anchors` / `boundaries` 一起被 `transportJson` 丢掉（只留下「怎么读」的标记），所以「从批次里凑寄存器」这条旧路径在混合编码的数据集上比真实寄存器**少**——用例 1 的未迁移写法等价性对比、用例 3 的静默池零分钟、用例 5 的三个守卫、用例 6 的未知池、用例 8 的 as-of 拒绝同时失败。这正是 B5 要修的读法。
  2. 「高度按字面读」。把 `height()` 换成 `value as unknown as bigint | null`（只此一处），同一命令：
     ```
     FAIL ... (7 条，含 refuses a catalogue row it cannot read rather than reading a smaller one)
           Tests  7 failed | 3 passed (10)
     ```
     为什么是原问题：manifest 是 JSON，高度以十进制字符串到达；不做 `^\d+$` 校验时 `'not-a-height'` 会被当成合法高度读进去，于是坏行只丢一行而不是整本拒收（用例 7 的「拒收整本、不读一个更小的目录」失败）；`'2460' > 2460n` 这类比较也不再是同一个问题。
  3. 「先落寄存器，再接受它依赖的证据」。把 `src/replay/runner.ts` minute-close 分支的 `store.acceptRange(b);` / `adoptUpTo(b.end.number - 1n);` 两句交换（只此一处），同一命令：
     ```
     FAIL ... > shows a pool that never traded as a zero under complete coverage, never as a gap
     AssertionError: expected false to be true // Object.is equality
           Tests  1 failed | 9 passed (10)
     ```
     这是四条 RED 里唯一「测试先不够、补强后才抓到」的一处，过程如实记录：变异首次运行时**用例 3 仍是 10/10 通过**（它的断言是「≥30 个 closed 分钟」，对少一帧不敏感）。用临时 trace（`adoptUpTo` 与帧循环各打一行到文件，跑完删除）看到真实时序：
     ```
     adopt 119 ready 0001,0004 unplaced 0001,0004
     frame close 180 block 120 shown
     adopt 179 ready 0001,0004 unplaced
     frame close 240 block 180 shown 0001,0004
     ```
     即承载发现日志的那一帧 `shown` 为**空**，`deferred` 在下一帧才补上。据此把用例 3 改成结构性断言——「第一个接受区间已包含发现日志的帧里，池必须已经在寄存器里」（不自写理想值，第一帧由 `frame.metrics.at.number > birth.silent.blockNumber` 求出）——变异随即 1/10 失败、还原后 10/10 通过。
  4. 「并集不说明数组是怎么写的」。删掉 `src/replay/clock.ts` 中 `mergeHistoricalBatches` 的 `registryMode` 传播（只此一处），同一命令：
     ```
     FAIL ... > keeps a union of referenced histories referenced
     AssertionError: expected undefined to be 'referenced-v1' // Object.is equality
           Tests  1 failed | 9 passed (10)
     ```
     为什么是原问题：并集后的数组与输入一样只是依赖集，不该在合并时升格成目录。这条同时暴露一个事实——`registryMode` 在 `src` 内**没有行为消费者**（`reconcilePools` 只看 shard `filterId` 家族与 `active_logs`，`PoolRegistry.registerAll` 是只增不减的并集），所以丢标记只会被「数据保真」这一条断言抓到，任何窗口/信号输出都不变。

- GREEN：
  - 计划命令 `pnpm exec vitest run tests/integration/referenced-batch-replay.test.ts tests/integration/replay-export-evidence.test.ts tests/integration/replay-export-integrity.test.ts tests/integration/history-job-integrity.test.ts tests/integration/evidence-portability.test.ts tests/integration/payload-retention.test.ts` → `Test Files 6 passed (6)`，`Tests 33 passed (33)`，退出码 0，9.68s；其中新文件 `10 passed (10)`，8.04s。
  - `pnpm typecheck`（`tsc --noEmit && tsc -p tsconfig.scripts.json`）→ 退出码 0。
  - `pnpm test`（全套）→ `Test Files 121 passed (121)`，`Tests 998 passed (998)`，退出码 0，34.85s。（B4 收尾为 120/988，差值 1 个文件 / 10 条用例 = 本任务新增的测试文件，无既有用例被改写。）

- 固定输入（按计划）：旧 inline 一批、旧 `batch-ref-v1` 一批、`batch-ref-v2` 一批、新 referenced 一批，共 4 批 / 块 60–2460 / 每批 600 块；目录 3 个池（交易池、从不交易的静默池、块 2400 才发现的晚池）；`ref-v2` 那批由生产者自己的 v1 分块字节重新装封（只重装封套、不改内容）；导出后 `rmSync` 删掉源库再重放，并与「未迁移写法」的另一份 bundle（每批都写整目录、无标记）逐项对比。
  - 覆盖点：四种编码读回一致；源库删除后仍可重放；静默池 ≥30 个 `closed` 分钟且 `swapCount = 0` / `activeMinutes = 0`、无 `gap`、无 `unknownTimeBlockCounts`；晚池出现在部分帧而非全部帧、最早出现时刻 > 2400、其生前分钟为 `warming`（`swapCount: null`）；目录只声明一次（`manifest.export.inputSnapshot.catalogue` 摘要 + `replay.input.catalogue`，`asOfBlock = '2460'`，`source = {reader:'local-pools', availability:'retrospective'}`，四个 segment 里的池恰好是「交易池 + 晚池」、从不出现静默池）；`catalogue-scope-mismatch` / `catalogue-asset-version-mismatch` / `catalogue-cutoff-beyond-export` / `catalogue-snapshot-invalid` / `catalogue-pool-unknown` / `catalogue-not-as-of` 六个守卫；合并历史保标记；`registryMode` 与传输载荷同存（compact 行拒绝丢字段的改写，inline 行读回时保标记、丢数组），被篡改的 payload 读回时按 gzip 失败拒收。

- 行为差异：
  - **目录只声明一次，并被双重上界裁剪**：`catalogueSnapshot()` 在导出时按 `options.toBlock` 过滤，`readCatalogue()` 再按 `min(asOfBlock, cutoffBlock)` 过滤，而 runner 传入的 `cutoffBlock = max(所有批次的 toBlock, manifest.export.toBlock)`。导出窗口比录制短时，目录不会替数据集宣称窗口内的历史。
  - **目录的可用性如实标注**：本地读取恒为 `retrospective`（导出发生在录制库已接受未知轮次之后，无法证明寄存器在 study point 就闭合），故 `cohortMode: 'as-of'` 时会额外产出 `catalogue-not-as-of`；只有来源能证明闭合时才允许 `as-of`。
  - **缺目录与坏目录是两种结论**：`catalogue` 字段不存在 → 不报问题、按旧读法从批次凑（用例 7 后半段的 `absent`）；字段存在但读不动 / 不属本 scope / 有不可读行 → `pools: []` 整本拒收并给对应 issue，绝不「读一个更小的目录」（fail closed）。
  - **寄存器写入与证据同批抵达**：`acceptRange(b)` 之后才 `adoptUpTo(b.end.number - 1n)`；证据已在本帧的池本帧可见，其上的池不可见，尚不可落地的行进 `deferred` 等下一次 adoption，不写也不丢。
  - 旧批次不可变、坏引用拒收的边界未动：`transportJson` 的不可改写比对、`readBatch` 对 `batch-ref-v1` / `batch-ref-v2` 的分块校验与 gzip 上限、`registryMode` 缺省即旧读法。
  - 无 schema/DDL 变化，无配置默认值变化，无窗口/信号公式改动。

- Commit：随子计划 02 提交（见 B6 末尾汇总行）。

- 未通过项 / 已记录的边界：
  1. **RED 敏感性**：变异 4（并集丢标记）只被用例 9 的数据保真断言抓到，任何窗口/信号输出都不变——因为 `registryMode` 目前没有行为消费者。如实记录，不额外造一个消费者来把它变成行为测试。
  2. **`catalogue-cutoff-beyond-export` 由固定输入触发（改写 `asOfBlock = '9999'`），不是由夹具里的第五条批次触发**：夹具窗口 60–2460 内只有晚池（2400）在窗口内被发现，没有「窗口外发现」的真实批次。要端到端覆盖它需再加一条 2461+ 的批次并让导出窗口停在 2460；本任务按计划的最小固定输入执行，未加。
  3. **一个需要契约违约才成立的边界（已记录、不为此加保护）**：目录里的池若其发现日志不在后续批次的 discovery shard 内，`reconcilePools` 可能在它落地后把它删掉，而 `adopted` 游标是单向的、不会再把它放回。这要求 bundle 违反自身的 shard-coverage 契约（批次声明覆盖了发现家族、却没有那条日志），正常导出路径不会产生；按计划不自行增删保护逻辑。
  4. 真实 provider 验证、运行时迁移与生产切换均**未执行**（属验收阶段，见后续记录）。

### B6

- 状态：完成

- 修改文件：
  - 新增 `src/storage/migrations/012-batch-coverage.sql`（78 行）：`batch_coverage_proofs(batch_id TEXT PRIMARY KEY REFERENCES ingest_batches(id) ON DELETE CASCADE, proof_json TEXT NOT NULL, proof_digest TEXT NOT NULL)`、单行 `batch_coverage_epoch(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL)` + `insert or ignore ... values (1,0)`、4 个递增 epoch 的触发器（`raw_logs_evidence_change` 对全部 12 个内容列做空值安全 `IS NOT` 比较、`raw_logs_evidence_delete`、`payload_object_change`、`payload_object_delete`）、4 个删除证明的触发器（`ingest_batch_change`、`ingest_batch_delete`、`fetch_shard_change`、`fetch_shard_delete`）。
  - 修改 `src/storage/database.ts`（+2）：迁移列表加入 `'012-batch-coverage.sql'`（001…012）。
  - 新增 `src/storage/batch-coverage.ts`（194 行）：`BatchCoverageProof` / `BatchCoverageStore`（`accept` / `read`）。`accept()` 的两个判据就是严格读取器自己的两个判据（`successfulShardRowsMatch(shards, batch) && completePartitions(batch)`），绝不只看 `batch.completeness`；`read()` 逐项比对证明自身摘要 → `wellFormed()`（version/batchId/scopeId/十进制 from-to/manifestHash/payloadRefDigest/shardDigest/mutationEpoch/非空 filters）→ 批次行的 scope/范围/manifest → payload 引用摘要 → shard 摘要 → 全局 epoch，任一不符即 `null`。`available()` 按 Database 用 WeakMap 记忆化 `sqlite_master` 查询；`storedBatch()` 用 `length(payload_json)` 度量而不读文本；`epoch()` 只读单行。
  - 修改 `src/storage/raw-store.ts`（B6 部分 +2 行，`src/storage/raw-store.ts:16` 的 import 与 `src/storage/raw-store.ts:126-130` 的调用）：`acceptRange` 在 `this.persistTransport(batch)`（第 125 行）之后、`this.reconcileActive(...)` 之前调用 `new BatchCoverageStore(this.database).accept(batch)`——与接受判定同一事务同一点位。
  - 修改 `src/ingest/completeness.ts`（+84）：新增导出 `StoredShardRow`（111）、`BlockInterval`（119）、`coversIntervals`（121，从 coverage.ts 逐字移来，原 `covers` 改名）、`successfulShardRowsMatch`（140，原读取器内联的 `complete` 谓词）、`completePartitions`（161，从 coverage.ts 移来并保留其原始注释）。三条判据现在只有一份实现，接受端与读取端引用同一函数。
  - 修改 `src/metrics/coverage.ts`（B6 部分）：删除本地 `covers`，改引 `coversIntervals`；新增辅助函数 `shardRows` / `strictSignature` / `proofSignature` / `verifiedBatch`（34-99 行）；主循环（161-191 行）按批先取 `proofs.read(batchId)`，命中的证明与严格解码共用一个按 `scopeId + '\0' + batchId` 键的缓存条目，用来源标记签名区分（`'proof\0' + sha256(JSON.stringify([mutationEpoch, manifestHash, payloadRefDigest, shardDigest, fromBlock, toBlock, filters]))` 对 `sha256(payload_json + JSON.stringify(shardRows))`）。
  - 修改 `src/replay/integrity.ts`（+6）：在 `checkBatchIntegrity` 上方写明严格入口**有意不查**完整证明——审计要问的是「存下来的载荷现在还支持这个结论吗」，所以它必须解码。
  - 修改 `tests/integration/metrics-coverage.test.ts`（+9）：三处一行式 `delete from batch_coverage_proofs`，把这三个既有的 `JSON.parse` 计数用例固定在严格读取路径上（理由见「未通过项 1」）。
  - 新增 `tests/integration/batch-coverage-cache.test.ts`（500 行，15 用例）：夹具为「100..120 两个地址分区 + 一条块 105 的事件 + 边界 120/180」，`measured()` 用 `openWorkCounts()` 包裹一次读取并返回 `{value, decodes}`。其中第 15 条把计划里「原始证据 strict 审计仍重新解压并检验 hash，不用 proof 替代」固定下来。
  - 未改：窗口/信号公式、`PROJECTION_VERSION`、`acceptRange` 的接受/回滚语义、`reconcilePools`、三种 payload 编码、`fetch_shards` / `payload_objects` / `raw_logs` 的任何写路径（B6 只**读**它们）。

- RED（四次单点变异，每次只改 `src/storage/batch-coverage.ts` 一处、跑完即还原；失败文本为 vitest 原文）：
  1. 「证明写出来但读不出来」。把 `read` 结尾的 `return proof;` 换成 `return null;`（只此一处），`pnpm exec vitest run tests/integration/batch-coverage-cache.test.ts tests/integration/metrics-coverage.test.ts`：
     ```
     × a batch accepted in its own transaction answers later reads without decoding it 12ms
     × a bounded horizon decodes neither the proven window batch nor an old batch outside it 8ms
     × a stored batch without a proof decodes, and an explicit warm-up proves only what it is given 4ms
     × payload object content and deletion are refused by the epoch, not by losing the proof row 4ms
     × raw evidence changes invalidate the proof and the reader re-derives the minute 3ms
     × a raw evidence deletion invalidates the proof even for an already re-derived verdict 3ms
     × a rolled back accept leaves no proof and a rolled back change leaves the proof standing 8ms
     AssertionError: expected null not to be null
     AssertionError: expected 1 to be +0 // Object.is equality
     Test Files  1 failed | 1 passed (2)
          Tests  7 failed | 32 passed (39)
     ```
     为什么是原问题：这七条正是「证明路径生效」的全部可观察面——`read` 恒 null 即退化为 B6 之前的行为，每一批都得解码（`expected 1 to be +0` 就是 `rawBatchDecodes` 从 0 变回 1）。同时 `metrics-coverage.test.ts` 仍 **32/32 通过**，证明严格路径的回归在 B6 之前就已独立成立，不是被证明路径顺带带过的。
  2. 「只有整批 complete 就发证明」。把 `accept` 的 `if (!successfulShardRowsMatch(shards, batch) || !completePartitions(batch)) return;` 截成 `if (!successfulShardRowsMatch(shards, batch)) return;`（只此一处），同一命令：
     ```
     × a batch whose address partitions do not all cover its range is accepted without a proof 7ms
     × a successful short address partition cannot borrow coverage from another address 7ms
     AssertionError: expected { version: 1, batchId: 'a', …(8) } to be null
     AssertionError: expected true to be false // Object.is equality
     Test Files  2 failed (2)
          Tests  2 failed | 37 passed (39)
     ```
     为什么是原问题：`acceptRange` 的整批 filter 检查弱于读取器的按地址分区检查（夹具里 `secondTo=110` 的 shard 覆盖整批范围但没覆盖它自己的地址分区）。少了 `completePartitions`，证明就会替一个严格读取器会拒绝的批次宣称覆盖，于是**既有的** `a successful short address partition cannot borrow coverage from another address`（B6 之前就存在的用例，一行未改）也一起失败——证明路径不能把严格判据洗白，这条变异同时证明了新判据的来源是读取器自己而不是 `batch.completeness`。
  3. 「证明不看 epoch」。删掉 `read` 里的 `if (this.epoch() !== proof.mutationEpoch) return null;`（只此一处），同一命令：
     ```
     × payload object content and deletion are refused by the epoch, not by losing the proof row 8ms
     × raw evidence changes invalidate the proof and the reader re-derives the minute 4ms
     × a raw evidence deletion invalidates the proof even for an already re-derived verdict 4ms
     AssertionError: expected { version: 1, batchId: 'a', …(8) } to be null
     Test Files  1 failed | 1 passed (2)
          Tests  3 failed | 36 passed (39)
     ```
     为什么是原问题：这三条覆盖的都是**证明行本身没有变**的变更——`payload_objects` 改写/删除（`ingest_batches` 与 `fetch_shards` 都没动，所以删证明的触发器不会响）与 `raw_logs` 改写/删除（B6 之前根本不参与批次验证）。没有 epoch 比较，证明会继续为一份已经换掉的压缩载荷担保，读者拿到的是「按旧载荷得出的覆盖」。这三条用例同时断言 `proofRows` 仍为 1 / `epochOf` 递增，即区分「证明行仍在、被 epoch 拒绝」与「证明行被删掉」两种不同的失效方式。
  4. 「证明不看批次行」。删掉 `read` 里的批次行比较（`row.scope_id !== proof.scopeId || String(row.from_block) !== proof.fromBlock || String(row.to_block) !== proof.toBlock || row.manifest_hash !== proof.manifestHash`）与 `if (payloadReference(row.bytes) !== proof.payloadRefDigest) return null;`（两处一起，其余不动），同一命令：
     ```
     × the stored row comparisons refuse a proof whose batch row moved without the trigger 6ms
     AssertionError: expected { version: 1, batchId: 'a', …(8) } to be null
     Test Files  1 failed | 1 passed (2)
          Tests  1 failed | 38 passed (39)
     ```
     为什么是原问题：触发器不是唯一防线。该用例显式 `drop trigger ingest_batch_change` 后把 `toBlock` 改到 1,000,000 并保留证明行，此时只有「读时比对当前批次行」能拦下它——没有这一条，读者会把该批次的覆盖当作 100..1000000 报出去（用例后半段断言 `acceptedMetricRanges` 为空）。这条 RED 是四次里唯一只被一条用例抓到的，说明该防线目前只有单点覆盖，如实记录。
  5. 「审计拿存下来的结论当结论」。把 `src/replay/integrity.ts` 的 `checkBatchIntegrity` 在 `verifySuccessfulShardCoverage` 之前插一句 `if (issues.length === 0) return [];`（只此一处，模拟「审计不再重新推导、直接采信已存判定」），`pnpm exec vitest run tests/integration/batch-coverage-cache.test.ts`：
     ```
     × a stored proof never substitutes for the strict audit that re-derives coverage 8ms
     AssertionError: expected [] to deeply equal [ { code: 'shard-incomplete', …(2) } ]
     Test Files  1 failed (1)
          Tests  1 failed | 14 passed (15)
     ```
     为什么是原问题：`checkBatchIntegrity` 的签名是 `(batch: RecordedRangeBatch, timing?) => ReplayIssue[]`——它**没有 `Database` 句柄**，因此在结构上就不可能去查证明表；导出路径（`src/replay/export.ts:275-277`）也是先 `readBatch(sourceDb, row.id)` 再把它交给审计。这条用例把这个结构性事实变成可观察断言：一个批次 id 在库里明明有证明，只要它载荷自带的 shard 证据被改成 failed，审计必须报 `shard-incomplete`。变异下它退化为「采信已存判定」并返回空数组，用例随即失败。这也是四次变异里唯一针对「不得因证明而跳过解压与哈希核验」的 RED。

- GREEN：
  - 计划命令 `pnpm exec vitest run tests/integration/batch-coverage-cache.test.ts tests/integration/metrics-coverage.test.ts tests/integration/metrics-repair.test.ts tests/integration/projection-readonly.test.ts tests/integration/replay-export-integrity.test.ts` → `Test Files 5 passed (5)`，`Tests 64 passed (64)`，退出码 0。
  - 五次变异逐一还原后复核：`pnpm typecheck`（`tsc --noEmit && tsc -p tsconfig.scripts.json`）→ 退出码 0；五条守卫 + `src/replay/integrity.ts` 的变异标记逐一 `grep -c` 复核（`completePartitions(batch)) return` / `row.manifest_hash !== proof.manifestHash` / `payloadReference(row.bytes) !== proof.payloadRefDigest` / `mutationEpoch) return null` / `return proof;` 各 1 处，`Mutation` 标记 0 处）。
  - `pnpm test`（全套）→ `Test Files 122 passed (122)`，`Tests 1013 passed (1013)`，退出码 0，34.65s。（B5 收尾为 121/998，差值 1 个文件 / 15 条用例 = B6 新增的测试文件；既有用例只被改动 3 处，均为 `metrics-coverage.test.ts` 里一行式删证明，无断言被削弱。）
  - 计划里两处点名可能受影响的既有解码计数，实测**不受影响**，逐条核对如下：
    - `tests/integration/runtime-recorder.test.ts:148` `expect(timing.counts.rawBatchDecodes).toBeGreaterThanOrEqual(1)`：断言的是 live 管线自己那一轮的接受路径（该轮批次此前从未被读过），证明只在 `acceptedMetricRanges` 里被查询，且查询失败/缺失一律回退严格路径，因此下界仍成立。
    - `tests/unit/live-scale-fixture.test.ts:178` `expect(counts.rawBatchDecodes).toBe(1)`：该计数由直接调用 `readBatch(db, stored.id)` 产生，不经 coverage，按设计完全不受 B6 影响。
  - 计划 B6 草图写的是 `resetWorkCounts()`；仓库只有 `openWorkCounts()`（返回 `{counts, close}`，无 reset）。测试用后者包一次读取并读 `scope.counts.rawBatchDecodes`，语义等价且不需要新增生产接口。

- 行为差异：
  - **证明只在接受判定发生的地方写**：`accept()` 由 `acceptRange` 在 `persistTransport` 之后、`reconcileActive` 之前、同一事务内调用；读取器（`coverage.ts`）**从不**写证明。因此一次回滚的接受不会留下任何证明（用例 10 前半段：事务抛错后 `ingest_batches` 与 `batch_coverage_proofs` 都是 0 行），而一次回滚的变更不会撤掉证明（后半段）。
  - **证明失败一律回退，不是报错**：`read` 的每一条不信任都返回 `null`，调用方转而解码该批次——严格路径永远有权回答。这使 012 之前建立的只读快照（无证明表、无触发器）读法与迁移前完全一致（用例 14：备份成只读库后结果与证明路径的期望值逐项相等）。
  - **命中证明的读取不解码、不读 `payload_json` 文本**：`payloadRefDigest` 取 `length(payload_json)`（值头，不触溢出页），批次行的篡改由 `ingest_batches` 的 UPDATE 触发器删证明来处理。用例 1 的重复读取 `rawBatchDecodes = 0`，有界窗口读取对有证明的批次与窗口外的旧批次都是 0（用例 2）。
  - **缓存占用与淘汰在行为上不变**：证明判定与严格判定共用同一条按批缓存条目，签名由来源标记区分。因此 B6 之前依赖「缓存命中不再 `JSON.parse`」的既有用例（`accepted coverage cache reuses immutable validation…` 等）在严格路径上逐字未改地通过，`saturated cache retains admitted validations…` 的 `toHaveBeenCalledTimes(3)` 与 `sliding bounded windows…` 的调用次数也都不变。代价是每批每次读取多一次证明行读取（小 JSON），这是让 epoch 与逐批触发器生效的必要成本。
  - **旧批次走严格路径，预热是显式的**：迁移到 012 的库里既有的已接受批次没有证明，继续解码。用例 3 把它固定下来：冷读 `decodes = 1`，随后**一个显式维护事务**（`db.transaction(() => { for (const id of ['a']) proofs.accept(readBatch(db, id)); })()`）恰好花 1 次解码把具名批次预热好，之后的读取 `decodes = 0`（计划原文「预热后重复 metrics 读取 `rawBatchDecodes=0`」）。仓库里没有任何路径会扫描历史去批量建证明，冷启动成本就是「被点名的批次数 × 1 次解码」。
  - **相同值的 UPDATE 不动 epoch**：`raw_logs_evidence_change` 的 12 个内容列全部用空值安全 `IS NOT` 比较，live 路径重写同样的行不递增 epoch（用例 8 前半段：`update raw_logs set data=data` 后 `epochOf` 仍为 0、证明仍可用）。只有真实内容变化才递增（后半段：改 `block_number` 后 `epochOf = 1`、证明行仍在但被拒，读取重新推导出 `event-time-mismatch`）。
  - **reorg 截断不能借用原始边界**：证明只提供 `{fromBlock, toBlock, filters}`，`acceptedMetricRanges` 仍与当前 `accepted_ranges` 求交集后逐区间判定（`coverage.ts:196-214` 未动）。用例 11 同时验证「另一 scope 的证明不会被复用」（`accepted_ranges` 里另插一行 `scope_id='other'`，读 `other` 得空且 `decodes = 0`——它连 `ingest_batches` 的行都对不上）。
  - **shard 证据的修复不会自动恢复证明**：用例 5 把某 shard 改成 `failed`（证明被触发器删掉、批次需重验），再改回 `success` 时证明**不会**回来，该批继续解码直到被重新接受——读取器不写数据库这一条由此可观察。
  - 无窗口/信号公式改动，无配置默认值改动；唯一 schema 变化是本任务新增的 012。

- 未通过项 / 已记录的边界：
  1. **每批每次读取多一次证明行读取，会让「`JSON.parse` 调用次数」类断言漂移**。首轮五文件命令失败 3 条（`expected 2 to be 1`、`expected 4 to be 3`、`expected [] to have a length of 1`），全部落在 `metrics-coverage.test.ts` 三个用 `vi.spyOn(JSON, 'parse')` 计数的用例上：证明行也是 JSON，`read` 每次都会解析一次小的 `proof_json`。**未**把这些数字改成新值（那等于按实现改测试、削弱回归），而是给这三个用例各加一行 `delete from batch_coverage_proofs`，让它们继续只断言严格读取器的解析次数；证明路径的对应行为由 `batch-coverage-cache.test.ts` 用 `rawBatchDecodes` 独立覆盖。这三行是本任务对既有测试的全部改动。
  2. **「读时比对批次行」这条防线只有单点用例覆盖**：变异 4 只被 `the stored row comparisons refuse a proof whose batch row moved without the trigger` 一条抓到（隔离方式是 `drop trigger ingest_batches` 的 UPDATE 触发器）。正常路径下触发器会先删掉证明，所以这条防线是纵深防御而不是主路径；如实记录其测试覆盖只有一处。
  3. **全局 epoch 是保守失效**：任何 `raw_logs` / `payload_objects` 的真实变更都会递增全局 epoch，使**所有**证明失效回到严格路径，直到被显式预热或重新接受。live 常规轮次只增不改，因此稳态下不会触发；但一次离群变更（或任何树外进程直接改这两张表）会把读取打回严格路径。这是安全方向上的选择，不额外做按 scope / 按批次细化的 epoch。
  4. **证明是「本库的行」的证明，不是载荷的证明**：`checkBatchIntegrity`（严格审计）仍解压并逐项重核哈希，有意不查证明——它的签名里根本没有 `Database`，结构上查不到；导出路径 `src/replay/export.ts:275-277` 也是先 `readBatch` 再交给它（`src/replay/integrity.ts:10-15` 已写明）。证明也不声称任何 RPC 事实、不缓存任何窗口/信号输出；物理文件损坏仍由 strict 审计处理，不宣称「有证明就无需核验原文件」。该要求由第 15 条用例固定（变异 5）。
  5. 真实 provider 验证、运行时迁移与生产切换均**未执行**（属验收阶段，见后续记录）。

- Commit：`129d5b61d93abd2fd2bc6fd3001074eb8917a3b6`（子计划 02 单一提交，B1–B6 全部在内，36 文件 / +6836 −762，且**未**包含 00–05 计划、spec 与 review 这些输入文件）。本行哈希的补写位于其后的一个小提交（与子计划 01 同一做法）。

### C1

- 状态：完成

- 修改文件：
  - 新增 `src/storage/migrations/013-live-workset.sql`（20 行）：`live_signal_workset(scope_id TEXT, pool_id TEXT, PRIMARY KEY(scope_id,pool_id))` 与 `live_workset_state(scope_id TEXT PRIMARY KEY, seeded_at_ms INTEGER)`。前者只保存**有持续信号记忆**的池——冷池的证据是它的窗口事件，不是这张表；业务状态仍留在 `signal_snapshots`，本任务不新增第二份快照。后者的存在使「合法的空 workset」与「从未填充过」可区分，否则每次打开都会再扫一遍 `signal_snapshots`。
  - 修改 `src/storage/database.ts`（+1）：迁移列表加入 `'013-live-workset.sql'`（001…013）。
  - 新增 `src/storage/live-event-index.ts`（344 行）：`EventDelta` / `EventWindowBounds` / `LiveEventIndex` / `LiveEventIndexStore` / `eventIndexFor` / `reviveEvent`。三套索引：`#byKey`（rawLogKey→{poolId,event}）、`#keysByPool`（poolId→key 集合）、`#poolsByToken`（token→池集合，附 `#tokenRefs` 引用计数，使同一池的多个事件共享一个 token 时摘除才是对的）。原 `live-projection.ts` 的 `reviveEvent` 逐字搬来这里，后者改为 import（纯搬家，无行为改动）。
  - 修改 `src/ops/work-counters.ts`（+8）：`WorkCounts` / `WORK_COUNTER_KEYS` / `emptyWorkCounts()` 三处各增 `liveEventRowsRead`（为推导窗口而解码的 `live_events` 行数）与 `evaluatedWorksetPools`（本轮选中的池数）。
  - 修改 `src/storage/live-projection.ts`（+62 −18，其中 −14 是搬走的 `reviveEvent`）：`LiveProjectionChanges` 增加 `eventDelta?: EventDelta`（99 行）与 `coverageChanged?: boolean`（101 行），`repairFrom` / `affectedPoolIds` / `registry` 全部保留。458 行建立收集器；488 行在「这个 key 原先有事件、本轮不再有」处按旧 payload 取 `rawLogKey` 记入 `deletedKeys`；502 行在真实写入处记入 `upserts`；593 行 `events.mark(token)`、597 行 `events.apply(eventDelta)`，位置在游标写入之后、清 `live_dirty_logs` 之前。未变 token 的 no-op 分支（252-253 行）同样 `mark` + `apply` 一个空 delta，并返回显式空 delta 与 `coverageChanged:false`；强制重建分支则把同一个 `events` 句柄递归传回 `syncOnce`，使重建与普通轮次走同一条收尾。
  - 新增 `tests/integration/live-event-index.test.ts`（351 行，9 用例）、`tests/integration/live-workset.test.ts`（377 行，8 用例）。既有测试文件一行未改（`git status` 中两个新文件之外无 `M`）。
  - 未改：窗口/信号/指标公式、`PROJECTION_VERSION`、`acceptRange` 的接受与回滚语义、`live_events` / `live_inputs` / `raw_logs` 的任何写路径（C1 只在原有写点**顺手记下**已经要写的值，不新增读写）。唯一 schema 变化是 013。

- RED（十个单点变异，每次只改一处、跑完即还原；失败文本为 vitest 原文）：

  1. 「同 key 修订不摘旧贡献」。把 `install` 里的 `if (previous !== undefined) this.unlink(key, previous);` 整行换成注释，`pnpm exec vitest run tests/integration/live-event-index.test.ts`：
     ```
     × a revised registration moves the same key to its new tokens without leaving the old ones 10ms
     AssertionError: expected Set{ '4663:v3:0x00000000000000000000…' } to deeply equal Set{}
     ❯ tests/integration/live-event-index.test.ts:238:23
     Test Files  1 failed (1)
          Tests  1 failed | 8 passed (9)
     ```
     为什么是原问题：该用例先把注册的 `token0` 从 rwa 改成下一个资产再同步，同一个 rawLogKey 于是应当**只**属于新 token。少了「先摘旧贡献」，`RWA→池` 这条边永远留了下来（238 行断言的正是它）。token→池倒排是 C2 决定「哪些事件要因报价变化重算」的输入，一条不会被清理的陈旧边会让失效范围失真。变异下 `index.size` 与 `blocksOf(index)` 仍然正确（1 与 `[105]`），说明命中的正是「同一 key 换了归属」这条通道，而非整个安装逻辑。
  2. 「删除分支整体消失」。删掉 `apply` 的 `for (const key of delta.deletedKeys) this.remove(key);`，`pnpm exec vitest run tests/integration/live-event-index.test.ts`：
     ```
     × a removal retires its key from the window, the pool index and the token index 9ms
     × a window that outlived a rolled back round is derived again from the rows that survived 10ms
     AssertionError: expected 1 to be +0 // Object.is equality        (live-event-index.test.ts:210)
     AssertionError: expected [ 105, 110 ] to deeply equal [ 110 ]   (live-event-index.test.ts:345)
     Test Files  1 failed (1)
          Tests  2 failed | 7 passed (9)
     ```
     为什么是原问题：`deletedKeys` 是 delta 的另一半。第一条用例删掉 `active_logs` 的行再同步，窗口不移除该 key 就停在 `size=1`、token 倒排仍挂着该池（210 行）。第二条暴露得更彻底：批次 b 的 swap(110) 替换了 swap(105)，回滚后重放的 delta 里 105 正是被删的那个 key，移除分支没了就变成 `[105,110]` 两个事件并存——「重组后旧块的事件还在窗口里」是 live 路径最不能出错的地方。
  3. 「窗口不再核对游标 token」。把 `ensureCurrent()` 的三行判断整体换成注释（函数变成空操作），同一命令：
     ```
     × a window that outlived a rolled back round is derived again from the rows that survived 12ms
     AssertionError: expected +0 to be 1 // Object.is equality
     ❯ tests/integration/live-event-index.test.ts:338:26
     Test Files  1 failed (1)
          Tests  1 failed | 8 passed (9)
     ```
     为什么是原问题：这是整段持久性设计的单点。回滚的事务没有留下它写过的游标（`live_projection_cursors.source_hash` 退回旧值），内存窗口却仍持有那次未提交写入的事件；下一次 `expire` 本应重新读行（`rows` 计 1）却直接沿用内存（`rows` 为 0），随后 `size` / `blocksOf` 一并失守。这条变异是十个里**唯一**能抓住 `ensureCurrent()` 的，即「事务回滚 ⇒ 窗口作废」这条防线目前只有回滚用例一处覆盖，而它是 `apply` / `eventsFor` / `poolsForToken` 三个入口共用的守卫，如实记录其覆盖只有单点。
  4. 「首次装载忽略窗口」。把 `WINDOW_ROWS` 换成无界的 `select payload_json from live_events where scope_id=?`，同一命令：
     ```
     × the first load reads only the window rows and a later round reads none of them 33ms
     AssertionError: expected 60 to be 20 // Object.is equality
     ❯ tests/integration/live-event-index.test.ts:308:34
     Test Files  1 failed (1)
          Tests  1 failed | 8 passed (9)
     ```
     为什么是原问题：这是「有界」二字的字面检验。60 个事件分属 60 个不同分钟，`sinceSec=2520` 的窗口只应包含最后 20 个（同用例的 `blocksOf(index)[0] === 101` 一并固定了边界含义）。变异下 `countWork('liveEventRowsRead', …)` 立刻从 20 变 60，即首次装载的代价重新与 scope 的全部历史成正比。
  5. 「无块边界时把未知时间事件丢弃」。把 `insideWindow` 的 `return bounds.sinceBlock === null || event.ref.blockNumber >= bounds.sinceBlock;` 改成 `return bounds.sinceBlock !== null && …`（即「没有边界就一定在窗外」），`pnpm exec vitest run tests/integration/live-event-index.test.ts tests/integration/live-workset.test.ts`：
     ```
     × an unknown-time event is held while no boundary can bound it, and the window says so 9ms
     × a verified boundary releases the unknown-time event it can bound 6ms
     AssertionError: expected Set{ '4663:v3:0x00000000000000000000…' } to deeply equal Set{}
     ❯ tests/integration/live-event-index.test.ts:274:61
     ❯ tests/integration/live-event-index.test.ts:287:61
     Test Files  1 failed | 1 passed (2)
          Tests  2 failed | 15 passed (17)
     ```
     为什么是原问题：未知时间的事件既没有分钟证据也没有块边界，只可能靠「接收时间」猜——而计划原文要求「不知道时间也不知道块边界时保留 `contextIncomplete`，不靠接收时间丢弃」。274 行断言有分钟的那条该走、无分钟的那条该留；287 行断言窗口必须回答 `windowContextIncomplete === true`。变异把两条都变成「静默丢弃一个可能在窗口内的事件」。
  6. 「有记忆的池每轮都重评」。把 `if (!standing || input.coverageChanged) for (const poolId of this.members()) selected.add(poolId);` 截成无条件并入，`pnpm exec vitest run tests/integration/live-workset.test.ts`：
     ```
     × an empty round that advances the watermark still reconsiders the pools with signal memory 11ms
     AssertionError: expected 8 to be 4 // Object.is equality
     ❯ tests/integration/live-workset.test.ts:227:46
     Test Files  1 failed (1)
          Tests  1 failed | 7 passed (8)
     ```
     为什么是原问题：这个条件是「live 成本与活动量成正比」的另一半——没有它，任何带冷却/候选状态的池在水位线没有推进、输入根本没变的情况下每轮都会被重新求值。用例的 8/4/8/4 序列正是这条规则的四个观测点（首轮重评、常驻水位线不重评、水位线推进再重评、再次常驻）。
  7. 「有记忆的池永不重评」。把同一行整行换成注释，同一命令：
     ```
     × an empty round that advances the watermark still reconsiders the pools with signal memory 11ms
     × a reopened database selects the same cooling and candidate pools it did before 28ms
     AssertionError: expected 4 to be 8 // Object.is equality        (live-workset.test.ts:226)
     AssertionError: expected [ …(3) ] to deeply equal [ …(5) ]      (live-workset.test.ts:366)
     Test Files  1 failed (1)
          Tests  2 failed | 6 passed (8)
     ```
     为什么是原问题：反向的单点。首轮（`standing` 为假、水位线首次确立）必须并入 members，这正是进程重启后从 `signal_snapshots` 恢复冷却与候选状态的路径；重开用例显示少了它，新进程完全看不见 `cooling-a` / `candidate-b`（366 行）。**未**把 `#lastWatermarkSec` 的初值改成 0 之类的哨兵值来「顺手」实现首轮重评，因为水位线 0 是合法输入。
  8. 「本轮读上一轮过期的结果，而不推进自己的窗口」。把 `select` 首行的 `const expired = this.events.expire(input.bounds);` 换成 `const expired = this.events.recentlyExpired;`，同一命令：
     ```
     × the last event leaving the window selects its pool once, and then the round has nothing to do 10ms
     × an unknown-time event without a boundary keeps its pool in the round and says why 6ms
     × a reopened database selects the same cooling and candidate pools it did before 30ms
     AssertionError: expected 4 to be +0 // Object.is equality           (live-workset.test.ts:267)
     AssertionError: expected false to be true // Object.is equality     (live-workset.test.ts:288)
     AssertionError: expected [ 'candidate-b', 'cooling-a' ] to deeply equal [ …(5) ]
     Test Files  1 failed | 1 passed (2)
          Tests  3 failed | 14 passed (17)
     ```
     为什么是原问题：C1 把「推进窗口」并进 `select` 的第一步（`WorksetInput.bounds`），这条变异把它退回「读上一轮留下的结果」。三处失败各说明一半：窗口从未被推进（`size` 停在 4）、`windowContextIncomplete` 从未被算出、重开后窗口根本没被装载因而热池全不在选中集合里（只剩两个 members）。第三条的输出被 vitest 折叠成 `…(5)`，此处按原样引用。
  9. 「记忆只认初始快照今天写明的字段」。把 `snapshotHasMemory` 的 `for (const key of new Set([...Object.keys(initial), ...Object.keys(stored)]))` 改成 `for (const key of Object.keys(initial))`，同一命令：
     ```
     × a snapshot counts as memory when any business field differs from the initial one 4ms
     AssertionError: expected false to be true // Object.is equality
     ❯ tests/integration/live-workset.test.ts:301:5
     Test Files  1 failed (1)
          Tests  1 failed | 7 passed (8)
     ```
     为什么是原问题：`initialSignalSnapshot()` 今天只列出 `state` / `episodeId` / `configVersion` / `lastAlertSec` / `lastAlertVolume` / `lastAlertScale` / `lastFiveEndSec` / `lowBuckets` / `entryThreshold` / `lastAlertKind` 十个字段，而状态机实际会写下的记忆不止这些——用例 300-301 行的 `candidateFingerprint` / `lastHeatSec`、312 行的 `candidateMinuteStartSec` 都不在这个列表里。只按 `Object.keys(initial)` 比较，就会把「候选指纹」「热标记」判成没有记忆，于是一个正在候选/冷却中的池会被移出 workset。并集比较是保守方向的选择：将来 `SignalSnapshot` 再加字段，旧快照一律算作有记忆，代价只是多评一轮，不会丢池。这也是为什么**没有**加一个「记忆字段清单」常量——清单短于状态机保存的状态时，丢池是静默的。
  10. 「retain 只增不删」。删掉 `retain` 的 `for (const poolId of present) if (!next.has(poolId)) remove.run(this.scopeId, poolId);`，同一命令：
      ```
      × the first fill is a one-time scan, and a rolled back fill is a fill that never happened 11ms
      AssertionError: expected Set{ 'hot-0', 'hot-1', 'hot-2' } to deeply equal Set{}
      ❯ tests/integration/live-workset.test.ts:352:29
      Test Files  1 failed (1)
           Tests  1 failed | 7 passed (8)
      ```
      为什么是原问题：`retain` 是调用者宣告「这一轮之后还有哪些池携带记忆」的唯一出口，计划原文要求「只有确认不再有窗口输入、持久信号记忆或本轮修订时，下一轮才移出」。变异下 `retain([])` 之后成员仍在，即池永远不退出 workset、热池集合只增不减，回到「成本随历史增长」的老问题。用例后半段的 `seed` 断言（353-354 行）进一步固定「合法的空 workset 不是需要重新填充的 workset」。

- GREEN：
  - 计划命令 `pnpm exec vitest run tests/integration/live-event-index.test.ts tests/integration/live-workset.test.ts tests/integration/live-projection.test.ts tests/integration/live-faults.test.ts` → `Test Files 4 passed (4)`，`Tests 37 passed (37)`，退出码 0，3.88s。
  - 十个变异逐一还原后复核：`pnpm typecheck`（`tsc --noEmit && tsc -p tsconfig.scripts.json`）→ 退出码 0；`pnpm test`（全套）→ `Test Files 124 passed (124)`，`Tests 1030 passed (1030)`，退出码 0，34.79s。B6 收尾为 122/1013，差值正好是 C1 新增的两个测试文件（9+8=17 条用例），既有测试文件一行未改、无一被削弱。
  - 规模核验：`tests/integration/live-workset.test.ts` 的夹具是**真的 80k 行注册**（`with recursive` 批量插入 `pools`，断言 `select count(*) n from pools` 等于 80000）与 400 个有窗口事件的池；整个文件（含建库与五次全选）约 1.2s，因此计划要求的目录规模可以在常规测试里跑，不需要标 `skip`。
  - 计数口径：用例断言的不是「感觉没扫」，而是 `openWorkCounts()` 包住一次选择后的 `registryRowsRead === 0` 与 `evaluatedWorksetPools === 400`；事件读取一律用 `liveEventRowsRead` 断言 0 或确切行数。所有「本应零读取」的回读都包在 `measured(...)` 里，避免 `ensureLoaded()` 的隐式装载把「索引维护正确」与「每次从磁盘重读一遍」混为一谈。

- 行为差异：
  - **窗口由 delta 推进，而不是「读完所有 `live_events` 再对比」**：`sync` 在真实 INSERT / UPDATE / DELETE 位置收集 `eventDelta`（488、502 行），三条路径（普通轮次、未变 token 的 no-op、强制重建）都返回一个显式的 delta，调用方永远不会看到 `undefined`。重建路径不再需要单独的「重新装载」——它的 delta 已经包含该 scope 的每一个事件，而 `apply` 对仍在窗外的事件走移除分支，所以重建过程中的窗口也始终有界。
  - **回滚安全靠游标，而不靠额外记账**：每条可能产生非空 delta 的路径都会递增 `live_source_revisions.revision`，而 `syncOnce` 在 `old.source_hash === token` 时提前返回，因此 **delta ≠ ∅ ⟹ token ≠ 旧 `source_hash`**。窗口与游标由同一个事务写下，回滚的事务两个都没留下，`ensureCurrent()` 一次索引行读取就能发现分歧并重新推导。这条是 C1 唯一新增的持久性机制，没有新的表、没有版本号字段。
  - **`expire` 的语义是「欠一次评估」而不是「删掉」**：首次调用用给定 bounds 装载并返回空集（此前的进程没有窗口，不欠任何池一次评估；进程重启后的恢复靠 `live_signal_workset` 与快照，不靠「上一轮过期」）。此后每次返回「因此不再有窗口内事件」的池，且每个池只在离开的那一刻出现一次——`recentlyExpired` 与新结果**求并**而非替换，故一轮读两次窗口不会丢掉第一次的过期池，多带一个池的代价也只是多评一次。
  - **未知时间事件只在可验证边界之内退出**：`minuteStartSec !== null` 的事件按分钟离开；无分钟的只能在 `sinceBlock` 之前离开，而 `sinceBlock` 为 `null` 时一律保留并让 `windowContextIncomplete` 为真。这与 `read` 原有的规则同义（`contextIncomplete` 就是照抄 `read` 的判据：`sinceSec > 0 && sinceBlock === null && 存在 minute 为空的 live_events`）。
  - **窗口推进是选择的第一步**：`WorksetInput.bounds` 是必填字段，`select` 的第一行就是 `expire`。原先把「先 expire 再 select」写成文档约定，热路径上没有任何东西强制它；现在调用者无法用一个窗口选择、再用另一个窗口评估。
  - **常驻水位线与代次**：同一水位线下（且 `coverageChanged` 为假）不重评有记忆的池；水位线推进、coverage 变化、或窗口 `generation` 变化（重建代表「上一轮的评估不能假定仍然有效」）时并入整个 workset。首轮必然并入，因为 `#lastWatermarkSec` 初值为 `null`，没有用哨兵数值。
  - **workset 的持久成员在调用者事务内维护**：`retain` 是差集插入/删除，`seed` 是显式的一次性扫描（返回填充数量并写 `live_workset_state`，二次调用返回 0）。仓库里没有任何路径会每轮扫描 `signal_snapshots`——`snapshotHasMemory` 只在 `seed` 里对快照做一次判断。
  - `reviveEvent` 从 `live-projection.ts` 搬到 `live-event-index.ts`（`projection-store.ts` 里另有一个同名局部函数，与本任务无关，未动）。无窗口/信号公式改动、无配置默认值改动。

- 未通过项 / 已记录的边界：
  1. **本任务只建表与接口，`live_signal_workset` 的实际写入者尚未接入**。除测试外，`retain` / `seed` 目前没有生产调用方——按计划分工，同事务维护由 C3 负责。因此在 C2/C3 完成之前，一个全新数据库的 workset 实际只有「窗口内事件池」这一部分生效，重启后的冷却/候选恢复路径已实现且已被重开用例固定，但还没有接到实时轮次上。这是任务边界，不是缺口遗漏。
  2. **`coverageChanged` 与 token 倒排索引目前只有生产侧的定义与测试侧的消费**。`LiveProjectionChanges.coverageChanged`（由 `coverageRepair !== undefined` 得出）与 `poolsForToken` 都要到 C2 才被真正读取；C1 只保证它们被正确地算出来并已被单测固定。
  3. **`ensureCurrent()` 这条防线只有一条用例覆盖**（变异 3 是唯一抓到它的）。它在 `apply` / `eventsFor` / `poolsForToken` 三个入口共用，但可观察面目前只有「回滚轮次之后的一次 `expire`」。C2 接入真实调用路径后应会出现更多覆盖点，届时复核。
  4. **`liveEventRowsRead` 只计窗口装载的行**（`reload()` 里 `WINDOW_ROWS` 的返回行数），不含 `cursorToken()`、`seeded()`、`members()` 这类单行索引读取，也不含 `live_signal_workset` 的读取。这是刻意的口径：它度量的是「为了得出窗口而解码了多少事件」，不是所有 SQLite 往返。
  5. **80k 目录由测试自己批量插入**，不经 `reconcilePools`。因此该用例证明的是「选择不会去读目录」，而不是「真实注册路径能产出 80k 目录」；真实的 80k/160k 性能样本属子计划 05（E 系列）。
  6. **`snapshotHasMemory` 的保守方向**：`initialSignalSnapshot()` 将来新增字段且默认值非 null 时，所有既有快照会被判为「有记忆」，workset 一次性变大直到这些池各自走完冷却。这是安全方向的选择，不额外做「记忆字段白名单」（变异 9 记录了白名单为何不可取）。
  7. **窗口之外的估值报价不在本任务范围内**：计划要求「必要时按 token 索引取窗口之前最后一个合法 quote」，那属于 C2 的 quote 依赖与缓存键设计；C1 只提供 token→窗口内事件池的倒排。
  8. 真实 provider 验证、运行时迁移与生产切换均**未执行**（属验收阶段，见后续记录）。

- Commit：随子计划 03 提交（见 C5 末尾汇总行）。

### C2

- 状态：完成

- 修改文件：
  - 新增 `src/metrics/valuation-index.ts`（265 行）：`VALUATION_RULE_VERSION`、`eventRevision` / `metadataRevision` / `quoteRevision`、`valuationKey`、`ValuationIndex`（`size` / `lookup` / `invalidateQuotesAfter` / `clear` / `expireOutside`）、`valuationIndexFor`。`ValuationIndex` 持三样东西：`#byKey`（键→`{value, ref, minuteStartSec, blockNumber, tokens}`）、`#keysByToken`（token→键集合，失效用）。**类注释的核心是一句纠正**：正确性由键承担，不靠失效——调用方每轮都用 `findPrecedingQuote` 重新求出的 `preceding` 参与建键，所以「报价内容变了」必然是不同的键，「报价消失或离窗」根本不会再被查找；`invalidateQuotesAfter` / `clear` / `expireOutside` 全部只是「至多丢一条」的保守回收，丢掉的键下次仍按完整的键重算。`valuationIndexFor` 用 `WeakMap<Database, Map<scopeId, ValuationIndex>>`，同一数据库的两个 builder 共用一份、只读库各自持有一份内存实例（`db.readonly` 的调用方永远不会走到写路径）。
  - 修改 `src/storage/metric-store.ts`（+216 −，见 `git diff --stat`）：本任务的全部接入点，逐条如下。
    - `inSelection(event)`：`workset === null` 时恒真；`event.pool === null` 时恒假（`PoolEvent = Swap | LiquidityChange | AncillaryEvent`，只有 `AncillaryEvent` 的 `pool` 可空）。`registrationFor` 的形参从 `PoolEvent` 收窄为 `Swap`，因为只有 swap 走到它。
    - 估值索引与失效（244-259 行）：`valuationIndex = workset ? valuationIndexFor(db, input.scopeId) : null`；`!changes || changes.eventDelta === undefined || changes.eventDelta.deletedKeys.length > 0` 时整表 `clear()`（**删除**是唯一键看不见的输入变化：一个被删掉的报价仍被用到它的估值写在自己的键里；同样地，一个没有 journal 可读的调用方也看不见报价的**到来**），否则只对 `eventDelta.upserts` 里的 swap 做 `invalidateQuotesAfter([tokenIn, tokenOut], ref)`；随后 `expireOutside({ sinceSec: sinceSec - 120, sinceBlock: null })`。
    - 估值循环（298-394 行）：每个事件先取 `selected`；**未选中的池只发布报价**——`quoteFromRwaUsdgSwap` 命中就 `quotes.push` 然后 `continue`，它不进 `valuations` / `valuedByRwa` / `metricEvents` / `grossFees` / `recentLiquidityByPool` 中的任何一个。选中的池走 `valuationIndex.lookup(valuationKey({eventId: rawLogKey(event.ref), event, metadata, preceding}), [asset.address], event, compute)`，`compute` 仍是原来的 `cache.memo(...)` 或 `valueSwap(...)`；索引只是**坐在持久缓存前面**，命中时既不序列化输入也不解码 payload。`metricEvents.push` 前有 `if (!selected) continue;`，`recentLiquidityByPool` 的首条件加 `!inSelection(event) ||`，`grossFees` 的过滤器链前面加 `.filter(inSelection)`。
    - `sourceHash` 的 `encodeJson({...})` 增加 `...(workset ? { selection: workset.poolIds } : {})`，返回值新增顶层 `selection`，`notes` 末尾增加两条有界报告专属说明（第一条恒定，第二条只在 `absentPoolIds.length > 0` 时出现并带真实分子/分母）。
  - 新增 `tests/integration/live-metric-workset.test.ts`（435 行，5 用例）、`tests/unit/valuation-index.test.ts`（279 行，8 用例）。既有测试文件一行未改。
  - **未修改 `src/storage/live-metric-cache.ts`**（本任务唯一「本该动而没动」的文件，理由见「未通过项 / 已记录的边界」第 8 条）。
  - 未改：窗口/信号/指标公式、`PROJECTION_VERSION`、任何 schema、`acceptRange` 的接受与回滚语义、`{kind:'all'}` 路径的任何输出。

- RED（八个单点变异，每次只改一处、跑完即还原到与 `git diff --stat` 一致的字节；失败文本为 vitest 原文）：

  1. 「有界轮次不走内存索引，全量落到持久缓存」。把 `const side = valuationIndex ? valuationIndex.lookup(...) : compute();` 整段换成 `const side = valuationIndex ? compute() : compute();`（保留变量以免变成另一个变异），`pnpm exec vitest run tests/integration/live-metric-workset.test.ts`：
     ```
       × a repeated selection computes no valuation again and never touches the durable cache 12ms
       × a window that advanced past the pool that priced the selection stops publishing its quote 16ms
     AssertionError: expected [ [ …(4) ], [ …(4) ] ] to deeply equal []      (live-metric-workset.test.ts:330:86)
     AssertionError: expected 0 to be greater than 0                          (live-metric-workset.test.ts:395:23)
          Tests  2 failed | 3 passed (5)
     ```
     为什么是原问题：这是整段设计里**唯一**需要两个断言才能证明的点。第一轮已经把两条估值写进 `live_metric_cache`，所以第二轮即便完全绕过索引，`countWork('valuationComputes')` 依然是 0——区分「内存索引命中」与「持久缓存命中」的是 `LiveMetricCache.prototype.memo` 有没有被以 `valuation:` 前缀调用（330 行的 `durable.mock.calls.filter(...)` 断言它为空数组），变异下它收到两条 `valuation:4663:0x…65:…:…044d:0:…0011` / `120` / 完整 `{event, metadata, preceding}` 的调用记录，即第二轮仍然把输入序列化并解码了一遍。这正是计划原文「不能只用把代码移到 worker 或提高超时就宣称性能问题解决」要挡的那个偷懒答案。第二条失败（`:395`）是同一变异的连带面：索引不再持有任何东西，`afterSecond` 为 0。
  2. 「未选中的池不再发布报价」。把 333-337 行的 `if (quote) quotes.push(quote);` 换成 `void quote;`（保留解构以免变成 TS 未使用变量），同一命令：
     ```
       × a selected report reproduces the full report for its pools from the pools that price them 34ms
       × a window that advanced past the pool that priced the selection stops publishing its quote 7ms
     AssertionError: expected [ { ref: { …(5) }, …(13) } ] to deeply equal [ { ref: { …(5) }, …(13) } ]
     -     "quality": "usd-estimate",
     -     "quoteEvidence": {
     +     "quality": "unpriced",
     +     "quoteEvidence": null,
     -     "usdMicros": 3000000n,
     +     "usdMicros": null,
     ❯ tests/integration/live-metric-workset.test.ts:259:30
     AssertionError: expected [] to have a length of 1 but got +0     (live-metric-workset.test.ts:369:24)
     ```
     为什么是原问题：选中池 `SELECTED` 的 token 是 STOCK_A / STOCK_B，自己一个 USDG 都不沾，所以它的价格**只可能**来自那个没被选中的 `QUOTE_POOL`。「只评选中池」的字面做法会把依赖池一起排除，于是选中池的估值静默退化成 `unpriced`——报告看起来仍然「成功」，只是所有 USD 金额变成 null。这是「有界化」最危险的失败形态，因此用例的置信点不是「快」，而是 `quality === 'usd-estimate'` 且 `usdMicros` 与全量路径**逐值相等**（269-271 行）。
  3. 「`readSelected` 把 expire 挪到 events 之后」。把 `request.index.expire({...})` 整块移到 `const events = request.index.eventsFor(...)` 之后，同一命令：
     ```
       × a window that advanced past the pool that priced the selection stops publishing its quote 19ms
     AssertionError: expected [ { …(8) } ] to deeply equal []      (live-metric-workset.test.ts:387:27)
          Tests  1 failed | 4 passed (5)
     ```
     为什么是原问题：这条是「120 秒余量与顺序约束」的可观测面。可用报价必须满足 `upperAgeSec ≤ 60`，所以任何对窗内事件可用的报价都落在 `read` 的读窗口 `sinceSec - 120` 内；由此 `expire → poolsForToken → eventsFor` 这个顺序**不影响任何估值**，它唯一影响的是 `report.quotes` 这个被上报字段——没有先 expire，已经离窗的依赖池仍会被 `poolsForToken` 收进 `poolIds`，它的报价会被**第二次发布**。用例推进水位线三轮（block 101/minute 6060 → block 200/minute 12000 → block 300/minute 18000），第二轮起报价池已离窗，387 行断言 `advanced.quotes` 与独立 reference 库的全量路径 `full.quotes` 同时为空。**这一条是本次唯一一次「先写测试再被证明必要」的变异**：该用例是我第一次跑这个变异没被任何测试抓住之后补的（当时的失败是 `Tests 21 passed (21)`，见「未通过项 / 已记录的边界」第 1 条）。
  4. 「索引只增不减（`expireOutside` 不接线）」。把 `if (sinceSec !== null) valuationIndex.expireOutside({ sinceSec: sinceSec - 120, sinceBlock: null });` 换成 `if (sinceSec !== null) void sinceSec;`，同一命令：
     ```
       × a window that advanced past the pool that priced the selection stops publishing its quote 24ms
     AssertionError: expected 7 to be less than 5
     ❯ tests/integration/live-metric-workset.test.ts:415:45
          Tests  1 failed | 4 passed (5)
     ```
     为什么是原问题：这条变异清掉了**我自己引入的一个真实缺陷**。`expireOutside` 原本只被单测调用，生产路径上一次都没调过——正是计划原文禁止的「只导出一个未使用的优化函数给单测调用」。后果不是算错，是内存：内存索引在一条 7×24 小时的 live 轮次上只增不减，每一轮把所有曾经在窗内出现过的 (swap, 侧) 对永久留住。用例的第三轮把窗口推过第一批 swap 之后，有界版本回到 4 条（每个仍在读窗口内的 swap × 选中池的两个监测侧），无界版本是 7 = 5 + 2。断言写成 `toBeLessThan(afterSecond)` 与 `toBe(moved.valuations.length * WATCHED_SIDES)` 两条，都是**从窗口结构推出的**，没有手写理想值。
  5. 「`metricEvents` 不再按选中过滤」。删掉 381-384 行的 `if (!selected) { continue; }` 整块，同一命令：
     ```
       × a selected report reproduces the full report for its pools from the pools that price them 26ms
       × a repeated selection computes no valuation again and never touches the durable cache 8ms
       × a window that advanced past the pool that priced the selection stops publishing its quote 6ms
       × a selection names no window for a pool the registry does not have 6ms
     TypeError: Cannot read properties of undefined (reading 'source')
     ❯ src/storage/metric-store.ts:496:22
          Tests  4 failed | 1 passed (5)
     ```
     为什么是原问题：这条变异的失败形态与其余八条不同——它**抛异常而非给出错值**，因为 `windows` 是从 `metricEvents` 推导的，而 `annotations` 又要为每个 window 取 `byId.get(w.poolId)!`（496 行）。有界读取根本没有带回未选中池的注册，于是「未选中的池进入 `metricEvents`」立刻变成「为一个没有注册的池组装窗口」。这比错值更好：它说明这道门不是防御性的，去掉它整个有界报告连组装都完不成。**如实记录其局限**：本变异给出的 RED 是崩溃而不是数值差异，因此它证明的是「这道门在真实路径上承重」，不能证明「去掉它会静默多算」——后者被第 6、7 条覆盖。
  6. 「`grossFees` 不再按选中过滤」。把 `.filter(inSelection)` 换成 `.filter((e) => workset === null || true)`，同一命令：
     ```
       × a selected report reproduces the full report for its pools from the pools that price them 33ms
     AssertionError: expected [ …(2) ] to deeply equal [ Array(1) ]
     - Expected
     + Received
       [
     +   "4663:0x0000000000000000000000000000000000000000000000000000000000000064:0x0000…044c:0",
         "4663:0x0000000000000000000000000000000000000000000000000000000000000065:0x0000…044d:0",
       ]
     ❯ tests/integration/live-metric-workset.test.ts:279:51
          Tests  1 failed | 4 passed (5)
     ```
     为什么是原问题：多出来的那条是 block `0x64` = 100，即**依赖池** `QUOTE_POOL` 的 swap。手续费估算 `estimateGrossSwapFee(s.amountIn, ...)` 是按事件逐个计的，一份「只覆盖选中池」的报告如果把依赖池的交易也计进去，费用口径就与它自己的窗口、计数和总和互相矛盾——一份**内部不一致**的报告比一份缺项的报告更难被发现。
  7. 「`sourceHash` 不含 selection」。把 `...(workset ? { selection: workset.poolIds } : {})` 换成 `...(workset ? {} : {})`，同一命令：
     ```
       × a selected report reproduces the full report for its pools from the pools that price them 31ms
       × selecting every pool reproduces the whole report and still bounds the valuation index 11ms
     AssertionError: expected 'd044b1a706622fbfa941c91c346f11f928015…' not to be 'd044b1a706622fbfa941c91c346f11f928015…' //
     Object.is equality                                                  (live-metric-workset.test.ts:266:34)
     AssertionError: expected 'd044b1a706622fbfa941c91c346f11f928015…' not to be 'd044b1a706622fbfa941c91c346f11f928015…' //
     Object.is equality                                                  (live-metric-workset.test.ts:312:35)
          Tests  2 failed | 3 passed (5)
     ```
     为什么是原问题：`sourceHash` 的下游用途是「这份报告是不是同一份输入下的同一份报告」——缓存键、修复判据、审计对账都读它。两个**窗口不同**的报告哈希相同，等于宣称「选中池的子报告」与「全量报告」是同一份产物。第二条失败是更尖锐的一半：即使选中的是**全部三个池**、`windows` / `annotations` / `valuations` / `quotes` / `grossFees` / `rwa` 逐值相等（300-305 行全部通过），它仍然是一次有界轮次、仍然带着 `selection` 与两条额外 notes，因此哈希必须不同。
  8. 「`invalidateQuotesAfter` 的边界从 `>` 放宽成 `>=`」。把 `comparePosition(held.ref, ref) > 0` 改成 `>= 0`，`pnpm exec vitest run tests/unit/valuation-index.test.ts`：
     ```
       × a revision drops only what comes after it, and only for the tokens it names 3ms
     AssertionError: expected 3 to be 4 // Object.is equality
     - Expected
     + Received
     - 4
     + 3
     ❯ tests/unit/valuation-index.test.ts:189:22
          Tests  1 failed | 7 passed (8)
     ```
     为什么是原问题：失效的**方向**是这条规则的唯一内容。「一条在 `ref` 处新增或修订的报价，只可能被 `ref` 之后的 swap 读到」，所以 `ref` 位置上的 swap 必须留下；`>=` 会把它一起丢掉。这个方向错得**不可观测**（丢掉的键下次照原样重算，值仍然正确），只是把「保守回收」变成「每次修订都白丢一条」——所以它只能靠单测固定，这也正是它被放在单测而不是集成用例里的原因。

- GREEN：
  - 计划命令 `pnpm exec vitest run tests/integration/live-metric-workset.test.ts tests/unit/valuation-index.test.ts tests/integration/live-metrics.test.ts tests/integration/live-metric-cache.test.ts tests/integration/metrics-repair.test.ts tests/integration/metrics-chain.test.ts` → `Test Files 6 passed (6)`，`Tests 40 passed (40)`，退出码 0，1.27s。
  - 九个变异逐一还原后复核：`pnpm typecheck`（`tsc --noEmit && tsc -p tsconfig.scripts.json`）→ 退出码 0；`pnpm test`（全套）→ `Test Files 126 passed (126)`，`Tests 1043 passed (1043)`，退出码 0，34.69s。C1 收尾为 124/1030，差值正好是 C2 新增的两个测试文件（5+8=13 条用例），既有测试文件一行未改、无一被削弱。
  - 全量路径未被拖慢或改义：`tests/integration/metrics-repair.test.ts:174` 对整份报告做 `toEqual` 深比较，其中新增的顶层 `selection` 字段在 `{kind:'all'}` 两侧都存在（恒为 `{kind:'all'}`），因此该断言是逐字节等价的——这条是「`{kind:'all'}` 路径不变」的机器证据，不是我的判断。
  - 调试残留已清：`grep -n "console.log\|VALUATION_DEBUG" src/metrics/valuation-index.ts tests/integration/live-metric-workset.test.ts` 无输出；`workset === null || true` 之类的变异中间态同样无残留（`git diff` 与本记录描述一致）。

- 行为差异：
  - **估值的内存索引坐在持久缓存前面，而不是替换它**：命中路径不序列化 `{event, metadata, preceding}`、不解码 payload；未命中路径逐字仍是原来的 `cache.memo('valuation:' + rawLogKey(event.ref) + ':' + asset.address, ...)`。因此索引是**纯加速层**：进程重启后 `WeakMap` 为空，行为退回 C1 的持久缓存，值不变。这也是为什么第 1 条变异必须用 `memo` 的调用记录来取证——`valuationComputes` 为 0 在两个层次上都成立。
  - **正确性由键承担，失效只是保守回收**：`valuationKey` = 规则版本 + `rawLogKey(event.ref)` + `eventRevision`（事件自身逐字段，含 `tokenIn`/`tokenOut`/两个 raw amount/`amountIn`/`amountOut`/`sqrtPriceX96After`/`liquidityAfter`/`tickAfter`/`effectiveSwapFeePips`/`poolPart`/`refPart`/`timePart`）+ `metadataRevision`（两侧 token 的地址/精度/角色、`rwa`、`usdg`、`usdgDecimals`、`maxQuoteAgeSec`）+ `quoteRevision`（`preceding` 的身份与内容，或字面量 `none`）。`eventRevision` 是 `valueSwap` 实际读取范围的**故意超集**：只流进返回值的字段也算，因为两个在这个串上不同的输入不允许共享一个结果。`SEPARATOR` 取 ``，而每个 part 都是地址、计数或十进制数，都不含它。这套键使「报价内容变了」必然是不同的键、「报价消失/离窗」根本不会再被查找，因此 `invalidateQuotesAfter` / `clear` / `expireOutside` 全部只是至多丢一条的回收，丢掉的键下次仍按完整的键重算——**它们从不承担正确性**。类注释与单测 5 的措辞都是按这个纠正后的因果关系写的。
  - **失效的两种来源被分开处理，因为它们的可见性不同**：`changes.eventDelta.deletedKeys.length > 0` 或「调用方没有 journal 可读」（`changes === undefined`）→ 整表 `clear()`，代价是重算整个窗口；否则只对 delta 里的 swap 按 `(tokenIn, tokenOut)` 做 `invalidateQuotesAfter`。前者的理由是键**看不见输入的消失**（被删掉的报价仍被用到它的估值写在自己键里），后者的理由是键**看不见输入的到来**（没有 journal 就无从知道某个报价刚刚出现，而它可能让一个原本 `unpriced` 的估值变成有价）。两者都是「最多丢一条」方向。
  - **`expireOutside` 的界是读窗口的下界 `sinceSec - 120`，不是 `sinceSec`**：读取用的是 `sinceSec! - 120`，所以位于 `[sinceSec - 120, sinceSec)` 的事件**会被读进来并参与估值**（`inWindow` 用 `minuteStartSec >= sinceSec` 判定，它们不上报，但它们为窗内事件提供报价）。用 `sinceSec` 作界会把它们连同它们的报价一起丢掉，让下一轮立刻重算一遍——不是错，是白干。`sinceBlock` 传 `null`：本路径没有可用的块下界，且读路径本身对无分钟事件就是用 `null` 处理的（见「未通过项 / 已记录的边界」第 2 条）。
  - **依赖池只发布报价**：`inSelection` 为假的池在估值循环里只做一件事——`quoteFromRwaUsdgSwap` 命中就 `quotes.push` 然后 `continue`。它不进 `valuations`（383 行的 `continue` 在 `metricEvents.push` 之前）、不进 `valuedByRwa`、不进 `grossFees`（额外一次 `.filter(inSelection)`）、不进 `recentLiquidityByPool`（首条件 `!inSelection(event) ||`）。这些门是冗余的（`metricEvents` 那道门就足以撑住 `windows`，变异 5 显示没有它直接抛异常），保留是因为它们各自守着不同的下游字段，而变异 6 证明 `grossFees` 那道门确实独立可观测。
  - **`EXPECTED` 与 `ACTUAL` 的对照是「独立 reference 库」而不是「有界路径自己的输出」**：第一个用例建了第三个 in-memory 数据库，只播种选中池真正需要的两个池，跑**未经改动的全量路径**，然后把有界结果与它逐值比较。这样「有界路径等于全量路径」这句话不是自证。
  - **`sourceHash` 把 selection 纳入身份，即使选的是全部池**：`...(workset ? { selection: workset.poolIds } : {})` 在 `workset` 非空时恒加键，所以「选中全部三个池」与「全量报告」即使每个值都相等，哈希也不同（变异 7 第二条）。**没有**采用「只在选中的池少于全部时才加键」的写法——那会让同一份有界报告的哈希随 scope 中池的总数漂移，而哈希的用途是身份而不是内容摘要。
  - **`selection` 是顶层新字段，`notes` 是有条件的**：`{kind:'all'}` 报告带 `selection: {kind:'all'}`；有界报告带 `{kind:'pools', poolIds}`（`resolveWorkset` 用 `[...requested].sort()`，与 `PoolRegistry.snapshot()` 的 `poolRegistrationId` 排序、`buildRollingMetrics` 的 `poolId` 排序同一口径，因此全选时有界报告的 `poolIds` 顺序与全量的 `windows` 顺序一致）。notes 第一条恒定出现，第二条只在确有缺失池时出现并带真实分子分母（`1 of 2 requested pools are absent from the registry and contribute no window.`）。
  - 无窗口/信号/指标公式改动、无 schema 改动、无配置默认值改动；`POP` 与任何既有输出字段的语义未变。

- 未通过项 / 已记录的边界：
  1. **`expire` 在 `readSelected` 里的位置只有「挪到 `eventsFor` 之后」这一种变异被抓得住**。我最初跑的变异是把 `expire` 挪到 `poolsForToken` **之后**、`eventsFor` **之前**，结果是 `Test Files 3 passed (3)` / `Tests 21 passed (21)`——**没有任何测试抓住它**。分析后确认这不可观测：该顺序只会让 `poolIds` 成为一个超集，而一个已经离窗的池在 `eventsFor` 的窗口过滤下不会有任何事件留下，于是输出逐值相同。换句话说 `expire → poolsForToken` 这个先后关系目前**只有文档与注释在守**，测试守不住。我没有删掉这个顺序，也没有为它造一个能抓住的用例（那样的用例必须构造「池的事件刚好横跨窗口边界」的精确夹具，而它证明的仍然只是报告里的 `quotes` 字段），仅在此如实记录其覆盖度。
  2. **`expireOutside` 传 `sinceBlock: null`，因此无分钟的事件在索引里不按块界回收**。`readSelected` 路径没有暴露 `windowOf` 算出的 `cutoff`（它留在 `LiveProjectionStore` 内部），把它接出来要动 `LiveProjection` / `StoredProjection` 的公开形状。当前语义与持久缓存一致：`LiveMetricCache.expireBefore` 也是 `delete ... where minute_start_sec<?`，而缓存的 `memo` 从不存 null 分钟（无分钟事件被写成 tip 的分钟）。**索引与缓存的这点差异是已知的**：缓存那侧不会留下无分钟的行，索引这侧会。影响面是「时间预言机无法定位块」这一降级场景下索引缓慢增长；该场景本身已被 `windowContextIncomplete` / `unknown-time-window-boundary` 标记上报。没有为此引入新字段。
  3. **`eventRevision` 是 `valueSwap` 读取范围的超集，这个「超集」由人工维护**。将来 `Swap` 新增字段或 `valueSwap` 开始读取新字段时，`VALUATION_RULE_VERSION` 必须跟着改（单测 8 把 `'valuation-v1'` 钉死了，改它必须是有意的）。这是本模块唯一需要人记住的约定，已写进类注释第一段。
  4. **依赖池的报价依赖集来自「选中池的注册 token0/token1」**，而不是「哪些池的报价被真正读到」。因此 `request.tokens` 可能包含一个没有任何依赖池的 token（多查一次倒排），也可能——**如果某个选中池的注册缺失**——漏掉它本该提供的 token。后者与 `absentPoolIds` 是同一件事的两面：注册缺失的池本来就没有窗口，不上报，也不提供依赖。这是「选择」与「注册」的一致性由 `resolveWorkset` 的 `registry.get(poolId)` 守住。
  5. **有界报告的三条断言依赖夹具里「选中池恰好有两个监测侧」**（`WATCHED_SIDES = 2`，即 STOCK_A 与 STOCK_B 都在 `input.assets` 里）。这不是手写理想值：`2` 是 `SELECTED` 池注册的 token0/token1 中命中 `input.assets` 的个数，与 `related.length` 同义。但它确实是夹具性质，换一个只有单侧被监测的池就需要改这个常量。
  6. **`valuationIndexFor` 的共享范围是 `(db, scopeId)`，`WeakMap` 的键是 `Database` 对象而不是文件路径**。因此同一个文件被打开两次（两个 `Database` 句柄）时得到两份索引：只读句柄那份纯粹是内存缓存，不会污染写路径；写句柄那份跨 builder 复用。这是刻意的（`openDatabase` 的调用方在测试与 CLI 里都会重复打开同一路径），但它意味着「索引命中率」在双句柄场景下低于理论值。无正确性影响。
  7. **`metricEvents` 那道门的 RED 是崩溃而不是数值差异**（变异 5），因此它只证明这道门承重，不证明去掉它会静默多算。静默多算的那一面由变异 6（`grossFees`）覆盖。如实记录两者的覆盖差别。
  8. **`src/storage/live-metric-cache.ts` 一行未改，这是有意的**。计划原文要求「持久缓存作为恢复层保留」。C2 的新增路径是「索引命中 → 直接返回」，未命中 → `cache.memo(...)`；所以持久缓存在有界路径上仍然是**唯一的重启恢复机制**，且它在 C1 已被 `tests/integration/live-metric-cache.test.ts` 完整覆盖。删掉它或把它降级成纯哈希表都会让重启后第一轮重新估值整个窗口，而这一轮的成本没有测量数据支持。**如果审查者认为索引使持久缓存变成死代码，请指出**——我的判断是它在冷启动与跨进程场景下不可替代，但这一点没有独立的性能样本佐证（属子计划 05）。
  9. 真实 provider 验证、运行时迁移与生产切换均**未执行**（属验收阶段，见后续记录）。

- Commit：随子计划 03 提交（同 C1，见 C5 末尾汇总行）。


### C3

- 状态：完成

- 修改文件：
  - 修改 `src/signals/project.ts`（本任务的全部接入点）：
    - 新增导出 `SignalSelectionContext = { registry?: PreparedRegistry }`，并作为 `projectSignals` 的第七个可选参数。它只承载**本批次已 prepare 的注册视图**：`recorder.ts` 在提交批次时把本批发现的注册 stage 进 prepared 视图而不是共享缓存，所以在这一批里重新 `prepare()` 的视图**看不见它们**（同批新池会被选中、然后被判定为「无注册」）。生产路径的 `registryContext` 非空当且仅当 `metricInput && options.signalConfig`，与 `commitAcceptedSignalBatch` 的调用条件是同一个条件，因此生产上这个参数**恒有值**。
    - 新增模块私有 `selectWorkset()`：算 `branchMoved`（同一高度换 hash，或高度回退）、`coverageChanged`、`bounds = { sinceSec: sinceSec - 120, sinceBlock: null }`，并把 `seeded()` / `seed()` 的一次性初始化放在这里（旧库首次扫描 `signal_snapshots`）。
    - `tip` / `sinceSec` / `eventIndex` / `workspace` / `registry` 全部在 `buildMetricsReport` **之前**算好。`sinceSec` 与 `metric-store.ts` 是同一表达式、同一个 `acceptedTip`，所以「选」与「读」是同一个窗口——C1 用 `WorksetInput.bounds` 必填防的那件事，这里靠同源表达式而不是靠约定。
    - `selectionCursor` / `selectionRepair` 是**选择专用的独立读取**（`signal_cursors`、`live_pending_signal_repairs`）：报告自己还会 sync 一次，读在其后可能拿到本轮还没走到的修复，读在其前只会让带记忆的池被多评一次，是唯一不会丢提醒的方向。
    - `buildMetricsReport` 的 `live` 增加 `poolIds`（=`selected`）、`registry`、`eventIndex`、`changes: liveChanges`。`changes` 是本批自己那次 `sync` 的 delta：报告若自己再 sync 一次，日志那时已经空了。
    - 循环体内第一行 `evaluatedPoolIds.push(w.poolId)`；循环之后按**持久快照重新读**决定 `retain`（不是用 `decision.nextSnapshot`：分支变更时 `previous` 被当作初始快照、存储行并未被覆盖）。
    - `claimed` 标志 + `arm(watermarkSec | null)`：`workspace` 非空的每一轮都 arm，`selected === null` 的那轮 arm `null`（清掉前一次尝试留下的待定值）。`.immediate()` 之后 `if (claimed && !db.inTransaction) commit()`。
    - `commitAcceptedSignalBatch` 在 `.immediate()` 之后 `if (!db.inTransaction) commit()`：`projectSignals` 是在它的事务里跑的，所以不能自己提交，这一行才是「这一轮落地了」的落点。
  - 修改 `src/storage/live-workset.ts`：`LiveWorkset` 接口从 `select` 单方法变为 `select` / `arm` / `commit`（取代此前设计里写的 `commit(watermarkSec)`）。`select` 只读不写水位线；`arm(watermarkSec | null)` 记下本轮「对着哪个水位线选的」；`commit()` 在 armed 非 null 时把它变成常驻值。
  - 新增 `tests/integration/signal-workset-equivalence.test.ts`（3 个用例）：12 池 14 批 + 一次完整重取（去掉 alpha 的 burst 触发修复与撤回）的 golden 样本，冻结 alert 的 kind/revision/status/poolLabel/atBatchId/logicalTimeSec/historical/reasons、alert `id` 与 `episodeId`、撤回 reasons、每池 `SignalSnapshot` 业务字段、liquidity 计数（alpha 0/0/0 对 bravo 1/1/0）、outbox 状态计数（`pending 6 / superseded 6`）。**全部字面量由真实运行读出，没有一条手写**；9 个静默池的快照用 `.map` 推导。另加两个用例：`a live batch evaluates the pools it has input for, not the catalogue it was registered in`（400 条静默注册，见 RED 变异 1）与 `a branch replaced at the same height reconsiders the pool whose only input is its memory`。
  - 修改 `tests/integration/live-workset.test.ts`：新增 `a round that rolled back leaves no standing watermark for its retry to trust`（该文件现 9 个用例），`round()` 辅助函数末尾改为 `arm` + `commit`。
  - 修改 `tests/integration/live-registry-incremental.test.ts`：`zero registry change over a large catalogue costs nothing in the sync path` 的两条成本断言随 C3 更新（见「行为差异」第 2 条）。

- RED（每条都是单点变异，逐字输出）：

  1. **选择门**（`project.ts` 的 `const selected =` 条件前插入 `false &&`，即本轮永不咨询 workset）：
     ```
     FAIL  tests/integration/signal-workset-equivalence.test.ts > a live batch evaluates the pools it has input for, not the catalogue it was registered in
     AssertionError: expected +0 to be 12 // Object.is equality
     - Expected  + Received
     - 12  + 0
      ❯ tests/integration/signal-workset-equivalence.test.ts:882:46
      Test Files  1 failed (1)  Tests  1 failed | 1 passed (2)
     ```
     同一变异下把该行临时换成 `evaluatedPools` 探针（只为读出全量路径的真实值）：
     ```
     AssertionError: expected 412 to be -1 // Object.is equality
      ❯ tests/integration/signal-workset-equivalence.test.ts:882:39
     ```
     为什么是原问题：12 是这一轮真有输入的池，412 = 12 + 400 条静默注册；静默注册确实进了注册表、全量路径确实会为它们逐条组装窗口。选出 0 而评了 412，正是「选择没接到真实调用路径」的样子。
  2. **水位线的提交拆分**（在 `live-workset.ts` 的 `select` 末尾恢复 `this.#lastWatermarkSec = input.watermarkSec;`）：
     ```
     FAIL  tests/integration/live-workset.test.ts > a round that rolled back leaves no standing watermark for its retry to trust
     AssertionError: expected 4 to be 6 // Object.is equality
     - Expected  + Received
     - 6  + 4
      ❯ tests/integration/live-workset.test.ts:258:22
      Test Files  1 failed (1)  Tests  1 failed | 8 passed (9)
     ```
     为什么是原问题：4 = 只有窗口内的四池，6 = 那四池加两个 cooling 池。失败的那次尝试选了它们、arm 了新水位线、然后整个事务回滚；重试少掉的正是这两个 cooling 池——它们既没有窗口事件、又被错误地当作「上一轮已经评过」，那一轮欠它们的重新评估被静默吞掉。这正是计划 bullet 9「失败后重试同 batch 与连续运行等价」。
  3. **记忆判定收窄**（`snapshotHasMemory` 的 `Object.keys` 并集改为只比较 `'state'`）：
     ```
     FAIL  tests/integration/live-workset.test.ts > a snapshot counts as memory when any business field differs from the initial one
     AssertionError: expected false to be true // Object.is equality
     - Expected  + Received
     - true  + false
      ❯ tests/integration/live-workset.test.ts:333:5
      Test Files  1 failed (1)  Tests  1 failed | 8 passed (9)
     ```
     为什么是原问题：`candidateFingerprint` 在候选态、`lastAlertScale` 在冷却态、`entryThreshold` 在热态，各自都可能**单独**是那池唯一的记忆。少算任何一个字段，该池就会在下一轮被移出 workset，而它的冷却/到期再也不会被推进。
  4. **分支回退的加宽**（`const branchMoved = false && …`）：`pnpm exec vitest run tests/integration/signal-workset-equivalence.test.ts tests/integration/alert-reorg.test.ts tests/integration/alert-recorder.test.ts tests/integration/rolling-replay.test.ts` → `Test Files 4 passed (4)` / `Tests 35 passed (35)`。**无 RED**，见「未通过项」第 6 条。
  5. **coverage 加宽**（`selectWorkset` 的 `coverageChanged` 整段前置 `false &&`）：同上再加 `alert-reorg` → `Test Files 2 passed (2)` / `Tests 27 passed (27)`。**无 RED**，见「未通过项」第 6 条。

- GREEN：
  - golden/等价性文件单独跑：
    ```
    pnpm exec vitest run tests/integration/signal-workset-equivalence.test.ts
    → Test Files 1 passed (1)  Tests 3 passed (3)
    ```
    这一条通过本身就是本任务要的非语义性证据：alert `id` 与 `episodeId` 由 `hash([pool.chainId, poolRegistrationId(pool), version, episodeId, kind])` 与 `hash([epoch, version, poolRegistrationId(pool), currentMinute|latest.endSec, kind])`（`engine.ts`）决定，**两者都不读 `report.sourceHash`**；而 C2 已把选择并进 `sourceHash`，所以有界轮次的 `sourceHash` 与全量轮次不同却不会改变任何一条 alert 的身份。这是 C3 能成立的前提，不是巧合。
  - 提醒路径 7 个文件：
    ```
    pnpm exec vitest run tests/integration/signal-workset-equivalence.test.ts tests/integration/alert-recorder.test.ts tests/integration/alert-recorder-review.test.ts tests/integration/alert-reorg.test.ts tests/integration/alert-new-pool.test.ts tests/integration/alert-outbox.test.ts tests/integration/rolling-replay.test.ts
    → Test Files 7 passed (7)  Tests 58 passed (58)
    ```
  - 本任务验证集 9 个文件（再加上 `live-workset.test.ts` 与 `live-registry-incremental.test.ts`）：
    ```
    → Test Files 9 passed (9)  Tests 77 passed (77)
    ```
  - `pnpm typecheck` → 退出码 0。接线中途出现过真实报错 `src/signals/project.ts(444,14): error TS2304: Cannot find name 'LiveWorksetStore'`，补 `type LiveWorksetStore` 导入后消失；记录在此以免被误读为「一次通过」。
  - 全量：`pnpm test` → `Test Files 127 passed (127)` / `Tests 1047 passed (1047)`，退出码 0。改动前基线 126 文件 / 1043 用例；差值为 golden 文件本身与它的两个新用例、以及 `live-workset.test.ts` 的回滚用例。

- 行为差异：
  1. **语义：零差异**，且不是「测出来没差异」而是有上界的：有界轮次与全量轮次唯一可能不同的是 `report.windows` 的**集合**，而 alert 身份与状态机输入都不读选择；golden 的冻结表（含 `episodeId`、`revision`、`status`、reasons、outbox 顺序、快照业务字段）逐条不变即为证。
  2. **成本：一处上限变紧，是刻意的**。`live-registry-incremental.test.ts` 的 `zero registry change over a large catalogue costs nothing in the sync path` 原断言 `registryRowsRead === 2 * size`，现在为 `0`：有界轮次的注册数据来自它选择时所依据的那个视图（`metric-store.ts` 的注释就是这条），目录行一条不读。该测试保留 `expect(size).toBeGreaterThan(SCALE_POOLS)` 作为对照，并保留 `registryChangesRead === 0` 与后续 `liveSync` 三计数为 0、`changes` 为 `[]` 的断言。**这不是把断言放宽**：`0` 比 `8002` 更严，且「全量路径仍会读目录」由同一文件 `:376` 的 `expect(sync.counts.registryRowsRead).toBe(catalogue(db, 's').length)` 继续钉住。代价：这条测试不再能同时证明「目录读被压到一次」，那一面改由 C2 的记录与 `metric-store.ts` 的边界承担。
  3. **重复读取**：`signal_cursors` 与 `live_pending_signal_repairs` 每轮各被读两次（一次为选择、一次为既有的短路判定）。两条都是 `scope_id` 主键点查、量级为 1 行，未合并以免改动既有短路逻辑。
  4. **`retain` 只在 `selected !== null` 时执行**：走全量路径的轮次不动成员表（保守方向）。
  5. **每次有界轮次多一次 `signal_snapshots` 的点查/池**（`retain` 的判据），复用一条 prepared statement。

- 未通过项 / 已记录的边界：
  1. **`liquidity-watch` 无法被样本覆盖**：`AlertKind` 有它、消息格式有它，但 `evaluateSignal` 从不产生它（只有 candidate/hot/reheat/cooling）。造样本时遇到这条并**正确地停下来**而不是伪造一个，改为钉 `expect(records(db).map(r => r.kind)).not.toContain('liquidity-watch')`。将来若真加了规则，这条断言会先失败，而不是让样本悄悄变宽。
  2. **config hash 在同水位线下的变化会迟一轮**：`selectWorkset` 读的是**上一轮**的 `signal_cursors.config_hash`（它属于短路判定，写在报告之后），所以「配置变了但这个水位线没动」的加宽要靠下一轮的 `repair` 分支。计划 bullet 7 要求「目录、coverage、metadata 或报价在同 watermark 下修订必须打破 source hash 短路」——短路确实被打破了（`report.sourceHash` 变），但**选择的加宽**迟一轮。若审查者认为必须同轮，需要把 configHash 的计算提到选择之前（会牵动 `report.version` 的读取顺序）。
  3. **成员集是单调的**：`initialSignalSnapshot` 含 `lastAlertScale` / `lastAlertSec` 等，一个曾经提醒过的池即使回到 `state: 'watch'` 也仍有记忆（golden 里 alpha 的终态就是 `watch` 且在成员表内）。这是刻意的保守（`snapshotHasMemory` 的注释写了「发明一个比状态机实际保留的更短的记忆会丢掉冷却中的池」），代价是成员集只增不减，除非该池的快照逐字段回到初始值。
  4. **`metricSourceHash` 随选择变化 / `commitSignalDecision` 用 `isDeepStrictEqual` 判重**：理论上「选择变了 → `metricSourceHash` 变 → 同快照也可能被当成新 revision」。实测未发生（golden 的 revision 计数与 `pending 6 / superseded 6` 都没动），且同一批次的 `sourceHash` 在一次重放里稳定。**没有独立测试钉住它**，属已知风险。
  5. **`generation` 重置不参与回滚拆分**：`live-event-index.ts` 的窗口代际直接写在内存里。它只在「窗口被重新推导」时变化，本身不携带轮次语义，所以没有事务语义可拆；若审查者认为它也需要回滚语义，这里要重新讨论。
  6. **`coverageChanged` 与 `branchMoved` 没有端到端 RED**：变异 4 与变异 5 都是全过。原因是我在变异 5 之后才确认：分支替换会让事件索引**重新推导窗口**（`ensureCurrent` → `reload` → `generation++`），而 `select` 一见代际变化就作废常驻水位线，于是成员集在同一场景里被重新考虑——两条路殊途同归，测不出是哪条起的效。**保留这两个条件**（只会加宽、不会减少评估，且计划 bullet 7 点名要求），但记录为「无独立 RED」。`coverageChanged` 的**规则本身**在 store 层有 RED：`live-workset.test.ts` 的 `an empty round that advances the watermark still reconsiders the pools with signal memory` 末尾 `expect(round(workset, WATERMARK_SEC + 60, { coverageChanged: true }).size).toBe(8)`。
  7. **`changes: liveChanges` 没有 RED**：把它换成 `undefined` 后该文件的用例全过。本样本里报告自己那次 sync 与「交给它的 delta」结果一致。这个参数是为**修订/撤回**场景准备的，本样本没有把它区分开。
  8. **启动路径的 arm 不 commit**：`recorder.ts` 的重投影分支在自己的事务里直接调 `projectSignals`，事务提交后没有人调 `commit()`。后果只有一个方向：水位线不成为常驻值，下一轮会把带记忆的池**多评一次**（不会漏）。补一行 `commit()` 需要改 `recorder.ts`，本次未改。
  9. **12 池样本每一轮的选择都等于全部 12**：历史窗口（180 分钟 = 10800 块）比整个样本（约 8700 块）还长，样本里没有「选择小于目录」的轮次；那一面由新增的 400 注册用例承担，不是由 golden 样本承担。
  10. 本节引用的 `file:line` 取自当前工作树。前六份记录是分阶段写的，行号以各自当时为准；C1/C2 一节里对 `live-workset.ts` 接口的描述（`select` 单方法、`commit(watermarkSec)`）已被本次的 `arm` / `commit` 拆分取代，以代码为准。

- Commit：随子计划 03 提交（同 C1/C2，见 C5 末尾汇总行）。


### C4

- 状态：完成

- 修改文件：
  - 新增 `src/metrics/metadata-index.ts`（130 行）：`buildMetadataIndex(entries): MetadataIndex`。按 `address.toLowerCase()` 分组，组内按高度升序**稳定**排序，查找是组内二分（`decimalsAtOrBelow`），所以一次查找是 O(log n) 且与缓存总条数无关。`revisionFor(address)` 是该地址锚点集的 sha256（元素为 `[observedAtBlock, decimals, blockHash]`，先按 `compareAnchors` 规范化排序），空锚点集返回 `digest([])`——它是**任意进程都能独立推导的内容摘要**，不是构建计数器、也不是对象身份；地址本身不进摘要（两个锚点相同的地址共享一个 revision，注释里写明要用时得配地址）。摘要覆盖 `blockHash.toLowerCase()`，而 `observedAtBlock` 原样进摘要（换一种拼写就是新内容）。
  - 新增 `src/storage/metadata-queue.ts`（342 行）：`DemandQueue implements MetadataQueue`。`enqueue` / `lease` / `stats` / `settle` 全部在**调用方的事务里**执行，自己从不 BEGIN（嵌套事务会把 accepted batch 写坏，或留下恢复进程看不见的租约）。附 journal 读取侧：`metadataRevision`、`metadataJournalPresent`、`metadataAddressChanges`、`pruneJournal`，常量 `METADATA_LEASE_MS = 30_000`、`METADATA_REVISION_JOURNAL_LIMIT = 256`、`UNNAMED_CHANGE = '*'`。
  - 新增 `src/storage/migrations/014-metadata-queue.sql`（98 行）：`metadata_demand`（主键 `(scope_id,address)`，列 `needed_block` / `priority` / `next_retry_ms` / `lease_id` / `lease_owner` / `lease_until_ms` / `updated_at_ms`）、索引 `(scope_id,priority,next_retry_ms)`、`metadata_revision`（`id=0` 单行计数器）、`metadata_address_changes`（journal），以及 `token_metadata` 的 INSERT/UPDATE/DELETE 与 `token_metadata_invalid_anchors` 的 INSERT/DELETE 五个触发器。
  - 新增 `tests/unit/metadata-index.test.ts`（295 行 / 5 用例）：与**逐字保留的旧实现** `legacyDecimalsAt` 逐值对照（带种子的生成语料：60 地址 × 1–6 个锚点、重复高度、三种大小写拼写；另一条 4000 地址 / 20000 条目 / 4000 次查找，120s 超时）；用 Proxy 统计属性读取次数钉住「同一对象只建一次索引」；`revisionFor` 的等价/不等价矩阵。
  - 新增 `tests/integration/metadata-queue.test.ts`（529 行 / 26 用例）。
  - 修改 `src/metrics/metadata.ts`：`decimalsAt` 增加 `WeakMap<MetricMetadata, MemoizedIndex>`（以条目数组身份 + 长度为守卫）；`reconcileMetricMetadata` 在无冲突时**返回入参本身**。
  - 修改 `src/storage/token-metadata.ts`：`readCachedMetricMetadata` 按 `(db, seed 身份, seed.version, seed.entries.length, metadata revision)` 记忆化；新增 `DEFAULT_METADATA_SCOPE_ID = 'live'`、`METADATA_RETRY_MS = 60_000`、`TokenMetadataTarget.priority?: 0|1|2`、`TokenMetadataUpdate{attempted,resolved,failed,eligible,retryWaiting,inflight}`；新增 `lookupMetadata`（纯网络：锚前检查 → eth_call → 锚后检查）与 `applyMetadataLookup`（同步落库 + settle，跑在调用方事务里）；`refreshTokenMetadata` 改为队列驱动。
  - 修改 `src/storage/database.ts`：迁移清单加 `013-live-workset.sql` 与 `014-metadata-queue.sql`。
  - 修改 `src/ops/recorder.ts`：`refreshMetadata` 传 `scopeId` 与 `owner: id`；启动预热 `priority: 2`、批次内 USDG `priority: 1`、批次内池 token `priority: 0`。
  - 修改 `tests/integration/token-metadata.test.ts`（13 用例，+5）、`tests/unit/metric-metadata.test.ts`（6 用例，恒等契约）、`tests/integration/live-metrics.test.ts`（6 用例，+1，见 RED 5）。

- RED（每条都是单点变异，逐字输出）：

  1. **lease 排序**（`metadata-queue.ts` 的 `order by priority, next_retry_ms, needed_block, address` 去掉 `next_retry_ms`）：
     ```
     FAIL  tests/integration/metadata-queue.test.ts > a never-attempted demand is leased before demands whose retry deadline already passed
     AssertionError: expected [ …(3) ] to deeply equal [ …(3) ]

     - Expected
     + Received

       [
     -   "0x0000000000000000000000000000000000000003",
         "0x0000000000000000000000000000000000000001",
         "0x0000000000000000000000000000000000000002",
     +   "0x0000000000000000000000000000000000000003",
       ]

      ❯ tests/integration/metadata-queue.test.ts:185:17
     Test Files  1 failed (1)  Tests  1 failed | 25 passed (26)
     ```
     为什么是原问题：`3` 从未被尝试（deadline = 入队时的 `nowMs` = 0），`1` 与 `2` 刚失败过（deadline = `now-100` / `now-1`）。排序里不带 deadline，就变成「谁的高度小谁先被租」，一个刚失败的地址抢在一个从没人看过的地址前面——这正是旧实现里 `failed tokens cannot starve a previously unseen token` 那条用例守的性质，在队列层必须有同一条守卫。
  2. **settle 的覆盖谓词**（`row.needed_block >= Number(outcome.anchorBlock)` 反向成 `<=`）：
     ```
     FAIL  tests/integration/metadata-queue.test.ts > a demand that arrives at an earlier height while a lease is out stays queued
     TypeError: Cannot read properties of undefined (reading 'needed_block')
      ❯ tests/integration/metadata-queue.test.ts:252:15
      Test Files  1 failed (1)  Tests  1 failed | 25 passed (26)
     ```
     为什么是原问题：租约是在高度 100 上取的，期间有一个高度 40 的需求合并进来，结果 `40 <= 100` 被判为「已覆盖」于是整行删除，`row()` 直接返回 `undefined`。100 的读数对 40 什么也没说（`decimalsAt` 取的是「at or below」的最后一个锚），删掉就等于谎报已解决：该池在 40 的估值会一直是 unpriced，而那一批早已过去、不会再有谁来重新提出这个需求。这就是计划里「旧结果仅完成它实际覆盖的需求，不按地址粗暴删除」。
  3. **无效锚点的未具名标记**（014 的 `token_metadata_invalid_anchor_insert` 删掉 `'*'` 那条 INSERT）：
     ```
     FAIL  tests/integration/metadata-queue.test.ts > an invalid anchor names the rows at that height and admits the seed may be affected
     AssertionError: expected true to be false // Object.is equality
      ❯ tests/integration/metadata-queue.test.ts:437:28
     FAIL  tests/integration/metadata-queue.test.ts > a real anchor check names the addresses stored at the height it invalidated
     AssertionError: expected true to be false // Object.is equality
      ❯ tests/integration/metadata-queue.test.ts:477:28
      Test Files  1 failed (1)  Tests  2 failed | 24 passed (26)
     ```
     为什么是原问题：被作废的高度上，`token_metadata` 的行能被 SQL 点到名，**seed 文件里同样位于该高度的那条凭空消失**——它的地址不在任何表里，触发器无从写出来。少了这个标记，`complete` 会报 `true`，读者就会把重建窄化到那张地址清单上，于是 seed 条目的失效被静默漏掉。两条用例分别覆盖「无效锚点插入」和「真实 `validateTokenMetadata` 路径」，我把它们的期望从 `true` 改成 `false`：旧期望是本任务之前子代理写下的乐观假设。
  4. **命中缓存的目标不再入队**（`refreshTokenMetadata` 里删掉 `decimalsAt(cached, demand.address, demand.blockNumber) === null` 过滤，即所有目标都入队）：
     ```
     FAIL  tests/integration/token-metadata.test.ts > discovers different token decimals, persists per address and skips cached RPC
     AssertionError: expected "vi.fn()" to be called 2 times, but got 4 times
      ❯ tests/integration/token-metadata.test.ts:51:23
     FAIL  tests/integration/token-metadata.test.ts > verified configuration seeds avoid duplicate RPC lookups
     AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
     Received:
       1st vi.fn() call:
         Array [ "eth_call", Array [ Object { "data": "0x313ce567", "to": "0x0000000000000000000000000000000000000001" }, "0xa" ] ]
     Number of calls: 1
      Test Files  1 failed (1)  Tests  5 failed | 8 passed (13)
     ```
     为什么是原问题：「目标」不是工作清单，是需求：一个已经有锚点覆盖该高度的地址根本不该被排队，否则每一轮都把它重新查一遍，`maxTokens` 的额度就会被已经知道答案的地址吃掉（第 1 条用例从 2 次请求涨到 4 次就是这么来的）。这一条正是 review 里 `deferred:62552` 的根：旧实现把「全部未知地址」当成每轮待办。
  5. **无冲突时的恒等返回**（`reconcileMetricMetadata` 的 `if (conflicts.length === 0) return { metadata: cache, conflicts };` 注释掉，恢复成恒返回 `{ ...cache, entries }`）：
     ```
     FAIL  tests/unit/metric-metadata.test.ts > retains absent-height entries only as the existing historical carry-forward assumption
     AssertionError: expected { version: 'test-v1', …(3) } to be { version: 'test-v1', …(3) } // Object.is equality
     Compared values have no visual difference.
      ❯ tests/unit/metric-metadata.test.ts:78:27
     FAIL  tests/unit/metric-metadata.test.ts > reconciling the same cache twice hands the live path one object to index
     AssertionError: expected { version: 'test-v1', …(3) } to be { version: 'test-v1', …(3) }
      ❯ tests/unit/metric-metadata.test.ts:89:60
     FAIL  tests/integration/live-metrics.test.ts > live bounded metrics > hands consecutive rounds the same metadata object, so one index serves the run
     AssertionError: expected { version: 'test+onchain-v1', …(3) } to be { version: 'test+onchain-v1', …(3) } // Object.is equality
      ❯ tests/integration/live-metrics.test.ts:60:31
      Test Files  2 failed (2)  Tests  3 failed | 20 passed (23)
     ```
     为什么是原问题：`metric-store.ts:211` 每轮把 `reconcileMetricMetadata(...).metadata` 交给 `decimalsAt`，而 `decimalsAt` 的索引按**对象身份**记忆化。逐字相同的副本每轮一次，就是每轮重建一次整张索引（一次排序 + 每个地址一次 sha256），计划门槛「无逐轮完整 metadata 候选构造」要挡的正是这笔开销。失败输出里的 `version: 'test+onchain-v1'` 同时证明走到的是**构建出来的**缓存而不是原样返回的 seed。
  6. **记忆化的复用**（`readCachedMetricMetadata` 的命中条件前置 `false &&`，即永远重建）：
     ```
     FAIL  tests/integration/token-metadata.test.ts > an unchanged cache comes back as the same object and a write is visible on the next read
     AssertionError: expected { version: 'test+onchain-v1', …(3) } to be { version: 'test+onchain-v1', …(3) }
      ❯ tests/integration/token-metadata.test.ts:144:46
     FAIL  tests/integration/live-metrics.test.ts > live bounded metrics > hands consecutive rounds the same metadata object, so one index serves the run
      ❯ tests/integration/live-metrics.test.ts:60:31
      Test Files  2 failed (2)  Tests  2 failed | 17 passed (19)
     ```
     为什么是原问题：没有记忆化，`metric-store.ts:124` 与 `refreshTokenMetadata` 每次都从 `token_metadata` 全表重建一个新对象，恒等链在**上游**就断了——第 5 条的修好了也白搭。两条断言分别钉「同一个 db + 同一个 seed」在缓存层与报告层的同一性。
  7. **记忆化的失效**（`metadataJournalPresent(db) ? metadataRevision(db) : null` 改成 `? 0 : null`）：
     ```
     FAIL  tests/integration/token-metadata.test.ts > forked configuration seed is excluded durably and queried again
     AssertionError: expected null to be 6 // Object.is equality
      ❯ tests/integration/token-metadata.test.ts:117:73
     FAIL  tests/integration/token-metadata.test.ts > an unchanged cache comes back as the same object and a write is visible on the next read
     AssertionError: expected null to be 6
      ❯ tests/integration/token-metadata.test.ts:145:43
     FAIL  tests/integration/token-metadata.test.ts > demands a round does not reach stay queued for the next one
      Test Files  1 failed (1)  Tests  3 failed | 10 passed (13)
     ```
     为什么是原问题：这里要如实说明一件我预判错的事——我原以为这个变异会让第 6 条的性能断言失败，实测 `live-metrics.test.ts` 全过：revision 恒为 0 时命中条件仍然成立，记忆化照旧返回同一个对象。它真正的失效面是**失效语义**：写入之后读回来的还是旧对象（`null` 就是旧缓存里没有这个地址的读数）。所以「记忆化存在」与「记忆化会失效」是两个可独立观测的命题，我分别用变异 6 与变异 7 取证，没有让一个变异同时代表两件事。

- GREEN：
  - 本任务验证集（计划的运行行）：
    ```
    pnpm exec vitest run tests/unit/metadata-index.test.ts tests/integration/metadata-queue.test.ts tests/unit/metric-metadata.test.ts tests/integration/token-metadata.test.ts
    → Test Files 4 passed (4)  Tests 50 passed (50)
    ```
    50 = metadata-index 5 + metadata-queue 26 + metric-metadata 6 + token-metadata 13。
  - 报告路径的恒等断言（不在计划运行行内，是第 5/6 条的第二个见证）：
    ```
    pnpm exec vitest run tests/integration/live-metrics.test.ts
    → Test Files 1 passed (1)  Tests 6 passed (6)
    ```
  - 全量：`pnpm exec vitest run` → `Test Files 129 passed (129)` / `Tests 1085 passed (1085)`，34.93s。C3 结束时是 127 文件 / 1047 用例，本任务 +2 文件 / +38 用例，正好等于 metadata-index 5 + metadata-queue 26 + token-metadata 5 + metric-metadata 1 + live-metrics 1。
  - `pnpm typecheck` → `tsc --noEmit && tsc -p tsconfig.scripts.json`，退出码 0。

- 行为差异：
  1. **`deferred` 改名 `retryWaiting`，而且语义变了**：旧字段是「本轮没轮到、或还在退避里被跳过的目标数」——review 记的 `attempted:16,resolved:16,failed:0,deferred:62552` 就是「全部未知地址被当成本轮待办」的样子；新字段只数「本 scope 队列里 `next_retry_ms` 还没到的真实需求」。仓库内没有消费者（只有 `recorder.ts` 打一行 `event: 'token-metadata'` 日志），但仓库外读这行日志的分析要跟着改口径。
  2. **每 token 两次 `getAnchor`**：实测 4 个 token 同一高度 → 8 次 `eth_getBlockByNumber` + 4 次 `eth_call` = 12 次请求；改动前同一场景是「每高度组 2 次 anchor + 每组 k 次 call」= 6 次。这些请求走的是同一个 150 次总预算与 5rps / 2 并发限流，所以这是**关键路径上真实增加的请求数**（C5 会把这条路整体挪出关键路径，C5 之前它确实更贵）。可以在不削弱保护的前提下把它降回 `k+1`：相邻 lease 在**同一高度**时，把前一个 lease 的锚后观测当作后一个 lease 的锚前观测——每个 token 的调用仍被该高度的两次不同观测夹住，期间换分支必被它自己的锚后检查抓住。这属于改保护逻辑的粒度，我没有自行实施，留给审查者裁决。
  3. **写库事务粒度**：旧实现每个高度组一次事务；新实现每个 lease 一次（`applyMetadataLookup` 设计成跑在调用方事务里，兼容路径自己起一个）。C5 会把 apply 放进 accepted batch 的事务内。
  4. **排队语义**：同一地址跨轮重复 enqueue 只合并 `needed_block`（取更早）与 `priority`（取更急），既不重置 `next_retry_ms`、也不打扰在飞租约；失败后至少 60s 退避，`priority` 0 也不能绕过。
  5. **`readCachedMetricMetadata` 现在可能返回同一个对象**，这正是它的目的；调用方若原地改返回值里的 `entries`，就会污染缓存。契约写进了 `decimalsAt` 的注释（长度守卫能挡住追加/截断，挡不住同长度替换）。
  6. **history 路径不命中记忆化**：`options.metadata ?? loadMetricMetadata('config/metric-metadata.json')` 在调用方没传 metadata 时每次都重新 load，seed 身份不固定 → 每轮重建。该路径是批处理，不在 live 关键路径上，行为与改动前一致（改动前也每轮重建），只是没拿到这次的新收益。
  7. 无 schema 变更（`token_metadata` / `token_metadata_failures` / `token_metadata_invalid_anchors` 三张表的形状与语义未动，014 只加新表）；窗口/信号/指标公式未动；`token_metadata` 的读写口径（`decimalsAt` 的「at or below」语义）未动。

- 未通过项 / 已记录的边界：
  1. **`metadataAddressChanges` 与 `MetadataIndex.revisionFor` 目前没有生产消费者**，只有测试在用。计划的意图是「供 C2/D2 低成本失效」：C2 最终用窗口代际做失效，没有接 journal；D2 还没开始。这是「所有新模块要接入真实调用路径」这条要求下**唯一未闭合**的接口，我不在 C4 里替 D2 造功能，明确列在这里：若 D2 也不接，应当连同 014 里的 journal 表一起删，而不是留着只给单测调用。（`metadataRevision` / `metadataJournalPresent` 是有真实消费者的：缓存记忆化的键，以及上面第 5/6 条那条恒等链。）
  2. **队列不随 reorg 回退裁剪**：`recorder.ts` 的 `recover()` 删 `token_metadata where block_number>?`、清空 `token_metadata_failures`，但**不动 `metadata_demand`**。后果有界且方向保守：位于回退高度之上的需求留在队列里，按自己的 `next_retry_ms` 被租出去，查询会失败（`anchor-missing` 一类）并再退避 60s，直到有更早的需求合并进来（`enqueue` 取 min 高度，于是 `settle` 的覆盖谓词随之下移并把它删掉）。不会写错值——落库的永远是刚刚读到的那个分支上的锚点与哈希。同时这也是「`recover()` 清空了 failures，而队列行的 deadline 还在」的一处短暂不一致，同样只影响等待时长，不影响取值。
  3. **记忆化的两个前提**：键含 seed 的**对象身份**与 `entries.length`，所以同长度原地改 seed 不会被发现（`decimalsAt` 的注释已写明这条契约）；每个 db 只有一个记忆槽，同一个 db 上交替使用两个不同 seed 会互相击穿（生产上每个 db 只有一个 seed，reporter 与 refresh 用的是同一个 `options.metricMetadata` 对象）。
  4. **`settle` 不校验 owner，只认 leaseId**：这是「租约过期后另一个进程/owner 可以接管」的实现方式，也就意味着计划里写的「owner 为 runId」是**标识**而不是鉴权；同一 owner 可以同时持有多个 lease（兼容路径顺序单飞、C5 的 worker 自己保证单飞）。
  5. **本节的 RED 里有三条是我发现子代理产出缺陷后补的**（排序、覆盖谓词、未具名标记），另外四条（命中过滤、恒等、记忆化复用、记忆化失效）是我自己写的改动的取证。分工如实说明，便于审查者分配信任权重：`metadata-queue.test.ts` 的 26 条里 23 条出自子代理，我逐条读过并跑过；`metadata-index.*` 全部出自子代理，我用「与逐字保留的旧实现对照」这一形式验收——它的等价性不依赖我对索引实现的理解。
  6. **「无逐轮完整 metadata 候选构造」是链式证据，不是单条端到端断言**：`metadata-index.test.ts`（同一对象只建一次索引，用 Proxy 读计数取证）、`token-metadata.test.ts::an unchanged cache comes back as the same object…`（缓存对象跨轮同一）、`live-metrics.test.ts::hands consecutive rounds the same metadata object…`（报告路径上两次 build 拿回同一对象）。三条都是点测试；没有一条端到端驱动 recorder 多轮循环并统计索引重建次数，`evaluatedWorksetPools` / `valuationComputes` 那类端到端计数在 C2 的记录里。
  7. 真实 provider 验证、运行时迁移与生产切换均**未执行**（属验收阶段，见后续记录）。

- Commit：随子计划 03 提交（同 C1–C3，见 C5 末尾汇总行）。

### C5

- 状态：完成（两处计划外补充、一处必须留白的 shutdown 语义、一处兼容导出的去向待裁决，见「未通过项」1–5）

- 修改文件：
  - 新增 `src/ops/metadata-worker.ts`（188 行）：`createMetadataWorker`。`kick()` 在调用方的安全点**同步**取第一个租约再立刻返回（不等网络），`run()` 的循环每轮先问 `canStart()`、再 `lease`、再 `lookupMetadata`，结果只写内存 ready buffer（`Map<seq, …>`，键是自增序号而不是数组下标）。单飞由 `chain !== null` 保证：一个 token 的网络序列在飞时任何 kick 都只是返回，链尾的 `finally` 清空 `chain`。`attempted()` 在**查询发出处**计数（不是落库处）；`fatalError()` 保存 run 级错误，`stop()` 只等已经发出去的那一次。模块自己不开 client、不开事务、不写库。
  - 新增 `tests/integration/metadata-worker.test.ts`（679 行 / 12 用例）。计划矩阵逐条对应：慢 metadata 不拖 accepted commit（用例 1）、两批同地址仅一次 inflight（2）、更早需求插队（5）、lookup 中发生 reorg（4）、DB 提交失败后重试（6）、无新块补齐（8）、故意 evidence-write 失败可见（9）、shutdown 关闭无未处理 Promise（10）、不通知模式不产生 sink 写入（11）、队列不留残余需求（12）。另外两条（3、7）是我发现断言空转后补的，见「未通过项」6。
  - 修改 `src/ops/recorder.ts`：
    - 建 worker（324–331）：`reader: metadataReader`（既有的那个把两个方法包进 `meter.withPurpose('metadata', …)` 的 reader，C5 没有为 worker 新开 client，也没有引入全局 purpose 字段）、`canStart: () => ingestDepth === 0`、`isStopping: () => shutdown.requested`。
    - `demandMetadata(targets)`（333–337）：`enqueueTokenMetadata` + `kick()`，不 await。「主采集有请求在发时暂停派发」是 `canStart` 与 `ingestDepth` 的组合，不是 setInterval。
    - 启动预热（585–596）：`if (options.command === 'follow')` 只入队（priority 2），不再 await 195 个地址。
    - 批内（1245）：`demandMetadata(targets)`（池 token priority 0、USDG priority 1）。
    - accepted 事务（1258–1289）：提交前 `prepareDrain()` 取快照，在 `commitAcceptedSignalBatch` 的 `applyMetadata` 回调里同步落库；没有 signal 事务时退化成提交后的一个短事务；成功 `ack()`、抛错 `rollback()`。
    - `onWait`（1030–1037）：`maintainMetadata()`（短事务 apply + 修复受影响池）+ `kick()`。
    - 批的 `finally`（1369–1371）：`ingestDepth--` 之后才 `kick()` —— 一轮运行里第一次真正的 lookup 常常在这里发出（批内那次 kick 因 `canStart` 为假而作罢）。
    - 收尾（1440–1446）：`drain` → `stop` → `flushMetadata()` → `reader.close?.()`。
    - 日志行（360–381）：新增 `stale` 与 `activeMissing` 字段。
  - 修改 `src/storage/metadata-queue.ts`：新增 `activeMissing(scopeId)`（该 scope 里 `priority = 0` 的仍未知需求数），供上面那行日志；`holdsLease` 是 C4 的租约门，C5 让 worker 路径也走同一扇门（落库点从 `refreshTokenMetadata` 内挪到 recorder 的事务里，门没换）。
  - 修改 `src/storage/token-metadata.ts`：三步拆分的**调用者**换了（生产路径改为 `enqueueTokenMetadata` + worker + `applyMetadataLookup`），`refreshTokenMetadata` 原样保留——它现在的调用者只有测试，见「未通过项」4。

- RED（每条都是单点变异，逐字输出。变异在仓库外由脚本施加，改完立即按字节还原并逐个 sha256 校验：`src/ops/recorder.ts`、`src/ops/metadata-worker.ts`、`src/storage/metadata-queue.ts`、`tests/integration/metadata-worker.test.ts` 四个文件在整轮 8 次变异前后的哈希一致）：

  1. **批次内换回 C5 之前的同步路径**（`src/ops/recorder.ts:1245` 的 `demandMetadata(targets)` 换回 `await refreshTokenMetadata(db, metadataReader, targets, { seed: seedMetadata, scopeId })`，连同一处临时 import）：
     ```
      ❯ tests/integration/metadata-worker.test.ts (12 tests | 1 failed) 5052ms
        × a slow metadata lookup never delays the batch that demanded it 5049ms
      Test Files  1 failed (1)
           Tests  1 failed (12)
     ⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯
      FAIL  tests/integration/metadata-worker.test.ts > a slow metadata lookup never delays the batch that demanded it
     Error: condition was never reached
      ❯ until tests/integration/metadata-worker.test.ts:65:38
          63|   const deadline = Date.now() + ms;
          64|   while (!predicate()) {
          65|     if (Date.now() > deadline) throw new Error('condition was never re…
            |                                      ^
          66|     await new Promise((resolve) => setTimeout(resolve, 5));
          67|   }
      ❯ tests/integration/metadata-worker.test.ts:193:5
     ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
     ```
     为什么是原问题：193 行等的就是 `batch-timing` 那行日志——一批提交的凭据。把 metadata 查回批内同步路径，gate 不开、批就不提交，5 秒预算内一行都不打。这就是 review 里「accepted commit 被 provider 拖住」的最小复现，也正是计划 C5 第一条 RED 要挡的形状。
  2. **运行结束时的 drain 短路**（`src/ops/recorder.ts` 收尾 `if (!shutdown.requested) await metadataWorker.drain();` 改成 `if (false && …)`）：
     ```
      ❯ tests/integration/metadata-worker.test.ts (12 tests | 1 failed) 760ms
        × a slow metadata lookup never delays the batch that demanded it 758ms
      Test Files  1 failed (1)
           Tests  1 failed (12)
     ⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯
      FAIL  tests/integration/metadata-worker.test.ts > a slow metadata lookup never delays the batch that demanded it
     AssertionError: expected [ { …(2) } ] to deeply equal [ { …(2) }, { …(2) } ]
     - Expected
     + Received
       [
         {
           "address": "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b",
           "decimals": 18,
         },
     -   {
     -     "address": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
     -     "decimals": 6,
     -   },
       ]
      ❯ tests/integration/metadata-worker.test.ts:204:93
         202|   // And the observation is not lost: it is stored by the run's last c…
         203|   // the valuation depends on is the one that had to land.
         204|   expect(db.prepare('select address, decimals from token_metadata orde…
            |                                                                                             ^
         205|     [
         206|       { address: AMC, decimals: 18 },
     ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
     ```
     为什么是原问题：少掉的是 USDG——**估值真正依赖的那个报价资产**，它的查询在这批提交之后才发出去。没有收尾这一次 drain，一次性运行的最后一个观测永远不会被任何事务收集，于是「钱已经花了、结果永远丢了」。这条同时钉住收尾顺序（drain 必须在 `stop()` 之前，否则 stop 会把链上唯一在飞的那次也结束掉）。
  3. **`kick` 不再拒绝已在跑的链**（`src/ops/metadata-worker.ts:134` 去掉 `|| chain !== null`）：
     ```
      ❯ tests/integration/metadata-worker.test.ts (12 tests | 1 failed) 738ms
        × a batch that asks while one lookup is out waits its turn instead of opening a second 18ms
      Test Files  1 failed (1)
           Tests  1 failed | 2 passed (12)
     ⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯
      FAIL  tests/integration/metadata-worker.test.ts > a batch that asks while one lookup is out waits its turn instead of opening a second
     AssertionError: expected { Object (eligible, retryWaiting, ...) } to deeply equal { eligible: 1, retryWaiting: +0, …(1) }
     - Expected
     + Received
       {
     -   "eligible": 1,
     -   "inflight": 1,
     +   "eligible": 0,
     +   "inflight": 2,
         "retryWaiting": 0,
       }
      ❯ tests/integration/metadata-worker.test.ts:269:33
         267|   worker.kick();
         268|   expect(gate.started()).toBe(1);
         269|   expect(queue.stats(SCOPE, 0)).toEqual({ eligible: 1, retryWaiting: 0…
            |                                 ^
         270|   gate.open();
         271|   // Once the chain is free the queued demand is the run's next query,…
     ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
     ```
     为什么是原问题：两个不同地址同时被租出去（`inflight: 2`），而计划要求「轮次只在单飞 worker 空闲时 lease 下一项，不会自己重复租赁正在处理的 token」——单飞一旦不成立，第二节点的请求就会挤占第一节点的限流与预算，`canStart` 的「采集优先」也随之失效。第一次做这条变异时它是**存活**的（原用例只重复了同一地址，第二次 kick 恰好被队列租约挡住），所以我把该用例补上 kick，另加了一条不同地址的用例。
  4. **`holdsLease` 恒真**（`src/storage/metadata-queue.ts:163` 的 `return row?.lease_id === leaseId;` 改成 `return true;`）：
     ```
      ❯ tests/integration/metadata-worker.test.ts (12 tests | 1 failed) 793ms
        × a batch that fails to commit keeps its results, and the retry is refused once its lease is gone 20ms
      Test Files  1 failed (1)
           Tests  1 failed | 5 passed (12)
     ⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯
      FAIL  tests/integration/metadata-worker.test.ts > a batch that fails to commit keeps its results, and the retry is refused once its lease is gone
     AssertionError: expected { resolved: 2, failed: +0, stale: +0 } to deeply equal { resolved: 1, failed: +0, stale: 1 }
     - Expected
     + Received
       {
         "failed": 0,
     -   "resolved": 1,
     -   "stale": 1,
     +   "resolved": 2,
     +   "stale": 0,
       }
      ❯ tests/integration/metadata-worker.test.ts:396:34
         394|   expect(second.results).toHaveLength(2);
         395|   expect(gate.started()).toBe(2);
         396|   expect(apply(db, second, now)).toEqual({ resolved: 1, failed: 0, sta…
            |                                  ^
         397|   expect(db.prepare('select address, decimals from token_metadata').al…
         398|     { address: addr(1), decimals: 6 },
     ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
     ```
     为什么是原问题：第一次的结果因为那批事务回滚而**留在 buffer 里**（既没 ack 也没写库，租约也没被 settle），租约到期后需求被重新租出去；门一撤，第二次 apply 就会把「上一轮租约读到的观测」也算成自己的结果落库（`resolved: 2`），于是同一个高度写两遍、旧租约的读数覆盖新租约的读数。这条是 worker 路径（事务回滚后重试）对 C4 那扇门的取证，不是新增门。
  5. **`run()` 的 catch 吞掉错误**（`src/ops/metadata-worker.ts:129` 的 `fatal = error;` 改成 `void error;`）：
     ```
      ❯ tests/integration/metadata-worker.test.ts (12 tests | 1 failed) 3704ms
        × an evidence-write failure stops the worker and is never read as a token without decimals 7ms
      Test Files  1 failed (1)
           Tests  1 failed | 8 passed (12)
     ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯
      FAIL  tests/integration/metadata-worker.test.ts > an evidence-write failure stops the worker and is never read as a token without decimals
     AssertionError: expected null to be Error: RPC evidence-write { …(4) } // Object.is equality
     - Expected:
     RpcFailure {
       "message": "RPC evidence-write",
       "kind": "evidence-write",
       "status": "unknown",
       "retryable": false,
       "evidenceFailure": undefined,
     }
     + Received:
     null
      ❯ tests/integration/metadata-worker.test.ts:531:31
         529|   // The error belongs to the run, not to the token: it is kept for th…
         530|   // worker starts nothing more.
         531|   expect(worker.fatalError()).toBe(failure);
            |                               ^
         532|   expect(worker.attempted()).toBe(1);
         533|   expect(worker.prepareDrain().results).toEqual([]);
     ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
     ```
     为什么是原问题：evidence-write 失败意味着「证据没有落盘」，把它当成一次普通的 token 失败吞掉，run 会继续用一个已经不可信的 provider 采集下去，而计划要求这类 critical 必须「传回主循环并终止/清理，不能当token失败吞掉」。`fatalError()` 为 null 就是这条被吞掉的直接证据；同一条用例还钉住「失败的那次不算 token 没有小数」。
  6. **`onWait` 里去掉 `maintainMetadata()`**（`src/ops/recorder.ts:1036`）：
     ```
      ❯ tests/integration/metadata-worker.test.ts (12 tests | 1 failed) 5756ms
        × metadata that lands with no new block repairs the pools it re-priced, without a new range 4932ms
      Test Files  1 failed (1)
           Tests  1 failed | 7 passed (12)
     ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯
      FAIL  tests/integration/metadata-worker.test.ts > metadata that lands with no new block repairs the pools it re-priced, without a new range
     AssertionError: expected 0 to be greater than 0
      ❯ tests/integration/metadata-worker.test.ts:501:5
         499|   expect(
         500|     count(db, "select count(*) as n from signal_evaluations where batc…
         501|   ).toBeGreaterThan(0);
            |     ^
         502|   expect(
         503|     count(db, "select count(*) as n from accepted_ranges where batch_i…
     ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
     ```
     为什么是原问题：没有新块时 follow 循环唯一的安全点就是轮询间隙。少了这次 maintenance，metadata 补齐后**没有任何一轮重算那些池**——估值停在 unpriced，信号不撤回也不新发，链不推进就永远不修。这就是计划里「没有新块时，也要在现有follow轮询安全点做短maintenance transaction」那一条，且 5 秒预算内 `signal_evaluations` 一行都没有，说明它不是「慢」而是根本没发生。
  7. **`ack` 清空整个 ready buffer**（`src/ops/metadata-worker.ts:170-172` 换成 `ack: () => ready.clear(),`）：
     ```
      ❯ tests/integration/metadata-worker.test.ts (12 tests | 1 failed) 815ms
        × an ack removes the snapshot it was handed and not what completed beside it 18ms
      Test Files  1 failed (1)
           Tests  1 failed | 6 passed (12)
     ⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯
      FAIL  tests/integration/metadata-worker.test.ts > an ack removes the snapshot it was handed and not what completed beside it
     AssertionError: expected [] to deeply equal [ Array(1) ]
     - Expected
     + Received
     - [
     -   "0x0000000000000000000000000000000000000002",
     - ]
     + []
      ❯ tests/integration/metadata-worker.test.ts:448:86
         446|   // stored is still there for the next one: a buffer cleared wholesal…
         447|   // and with it a query the run has already paid for.
         448|   expect(worker.prepareDrain().results.map((result) => result.lease.de…
            |                                                                                      ^
         449|     addr(2),
         450|   ]);
     ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
     ```
     为什么是原问题：第二条结果是在第一份快照被取走之后、事务提交之前完成的。整表清空把它一起删了，而它对应的查询**已经花掉**——这一次的运行里再没有任何人会看到它，需求也已经从队列里删除（resolved 才删），于是这个地址在这一轮永远是 unpriced。计划原话：「buffer条目用唯一结果ID，ack只移除本次快照，不移除处理期间新完成的结果」。
  8. **启动预热后 await 一次 drain**（`src/ops/recorder.ts:596` 之后插入 `if (options.command === 'follow') await metadataWorker.drain();`）：
     ```
      ❯ tests/integration/metadata-worker.test.ts (12 tests | 1 failed) 5912ms
        × metadata that lands with no new block repairs the pools it re-priced, without a new range 5033ms
      Test Files  1 failed (1)
           Tests  1 failed | 7 passed (12)
     ⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯
      FAIL  tests/integration/metadata-worker.test.ts > metadata that lands with no new block repairs the pools it re-priced, without a new range
     Error: condition was never reached
      ❯ until tests/integration/metadata-worker.test.ts:65:38
          63|   const deadline = Date.now() + ms;
          64|   while (!predicate()) {
          65|     if (Date.now() > deadline) throw new Error('condition was never re…
            |                                      ^
          66|     await new Promise((resolve) => setTimeout(resolve, 5));
          67|   }
      ❯ tests/integration/metadata-worker.test.ts:483:5
     ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
     ```
     为什么是原问题：483 行等的是这一轮 follow 的 `batch-timing`。启动预热只要被 await，195 个地址就会挡在第一批前面，follow 循环迟迟进不去——这正是旧行为的一个可观测形态，也正是计划「启动资产metadata获取改为入队后kick，不await全195个token」要改掉的。注意这条变异**不是**把第一处探针卡住（那是测试 fixture 的问题，见「未通过项」7），而是把「入队不 await」改回「入队后 await」，两者失败形态相同、根因不同。

- GREEN：
  - 计划的运行行（同一命令连跑两次一致）：
    ```
    pnpm exec vitest run tests/integration/metadata-worker.test.ts tests/integration/token-metadata.test.ts tests/integration/shutdown.test.ts tests/integration/follow-latest.test.ts tests/integration/alert-recorder-review.test.ts tests/unit/recorder-deadline.test.ts
    → Test Files  6 passed (6)  Tests  44 passed (44)
    ```
    44 = metadata-worker 12 + token-metadata 16 + alert-recorder-review 8 + follow-latest 4 + shutdown 2 + recorder-deadline 2（按 `--reporter=json` 的逐文件计数，不是估算）。
  - 全量：`pnpm exec vitest run` → `Test Files 130 passed (130)  Tests 1100 passed (1100)`（35s）。
  - `pnpm typecheck` → `$ tsc --noEmit && tsc -p tsconfig.scripts.json`，无输出、退出码 0。
  - 本次新增/修改文件的格式：`prettier --check` 逐个通过；`pnpm lint` 整体仍红，原因见「未通过项」8。

- 行为差异：
  1. **批不再等 metadata**：旧路径在批内同步 lease 并查最多 16 个 token 之后才提交；现在批只提交它**已经拿到**的结果，批内新提出的需求由 `finally` 里那次 kick 交给后台。
  2. **启动预热不再 await**：195 个地址降级为“最冷的工作”进队列（priority 2），批内真需要的地址会在同一行需求上合并并提高到更高优先级。这改变了「run 开始时哪些 token 已有 decimals」的时点：第一批可能仍有 unpriced 池，由后续轮次补齐——这是计划明确的取舍。
  3. **`token-metadata` 日志行的口径变了**（仓库外若有解析这行日志的分析要跟着改）：`attempted` 现在累计「worker 已发出的查询数」且行里打的是**增量**；`resolved`/`failed` 只在实际持久化之后计（事务提交后才算数），因此不再有「先报 resolved 再回滚」的窗口；新增 `stale`（租约已易主的丢弃数）与 `activeMissing`（priority 0 的仍未知需求数）。`attempted` 与 `resolved + failed + stale` 的差额就是「在飞或已丢弃」，不是丢失。
  4. **无新块也有工作**：`onWait` 的 maintenance 事务会 apply 已完成的观测并修复受影响的池（估值与信号），链的 watermark 不动、不发新范围、不产生新的 accepted range。
  5. **运行结束多一步**：非 shutdown 结束时先 `drain` 再 `flushMetadata`——一次性 ingest 在最后一批之后完成的观测因此会落库（见 RED 2）。
  6. **shutdown 期间的语义**：见「未通过项」1。
  7. 窗口/信号/指标公式未动；`token_metadata` 的读写口径（`decimalsAt` 的“at or below”）未动；`metadata_demand`/journal 的表形状未动（C5 没有新增迁移）。

- 未通过项 / 已记录的边界：
  1. **shutdown 会丢弃恰好“在飞”的一次观测**：`metadataReader` 的 `getAnchor`/`request` 都在入口 `shutdown.throwIfRequested()`，lookup 的**锚后检查**用的正是这个方法，所以停止信号到达时在飞的那次查询会在锚后检查处抛出 → `critical()` 原样抛出 → worker 记 `fatal` → 观测被丢弃：不落库、不写失败、需求留在队列。依据是计划 03 第 181–182 行（ShutdownRequested 保持 critical 并把错误传回主循环）与「未落库ready结果可丢弃但租约可恢复，不能声称resolved已持久化」。用例 10 因此写的是**诚实契约**：什么都没存、什么都没失败、一条租约仍在、过了 `METADATA_LEASE_MS` 可被下一个持有者租到、run 结束后 `gate.started()` 仍是 1。我第一次写下的是「在飞结果应当落库」的期望，实测失败后按上面两条计划条文重写了用例——若审查者认为正确做法是「stop 时把已读到的结果也落库」或「停止时把租约立即 requeue 而不是等它过期」，那是改保护逻辑粒度，我没有自行实施。
  2. **计划外补充：`drain()` 与 `METADATA_DRAIN_LIMIT = 256`**（计划只在 shutdown 条目里写「在现有总体 drain deadline 内等待已发请求」，没有要求一个“收尾收集”入口）。理由：一次性运行（`command: 'ingest'`，以及 follow 自然结束）没有第二个安全点，最后一批不可能收集在它之后才完成的观测，而这笔查询已经付过钱（RED 2 就是它的变异）。边界写进注释与代码：它不是无限等待——三种情况立即返回（`stoppingNow()`、`fatal !== null`、一次 kick 什么也没租到），且不新增等待语义（复用 reader 自身的 budget/deadline）。`METADATA_DRAIN_LIMIT` 是背压而不是预算：队列一行一个地址、本身有界，这个数只挡「队列被反复填满」的病态情形。
  3. **ready buffer 的 ack 按结果 id 而不是位置**：计划第 178 行原文要求如此（RED 7 取证）。代价是 buffer 的键是进程内自增序号——它只在一次运行内唯一，不跨进程；这是有意的，ready buffer 本身就是内存态、随进程结束消失。
  4. **`refreshTokenMetadata` 现在只有测试调用者**（25 处，全在 `tests/integration/token-metadata.test.ts`），生产路径改走 `enqueueTokenMetadata` + worker + `applyMetadataLookup`。计划第 155 行明说保留它「供兼容调用/旧测试使用」，所以我没有删；但按「所有新模块要接入真实调用路径，不能只导出给单测调用」这条口径，它是一个**只在测试里被调用的导出**，请审查者裁决是否连同那批老用例一起改写或删掉。C5 新增的导出（`createMetadataWorker`、`MetadataDrain`、`activeMissing`）都确认有生产调用者。
  5. **C4/C5 的任务归属有一处记不干净**：计划 C5 条目把「拆出纯网络 lookup 与同步 apply」列为 C5 的工作，而 C4 的记录里已经列了 `lookupMetadata`/`applyMetadataLookup`；`metadata-queue.ts` 的 `activeMissing`（C5 条目点名）与 `enqueueTokenMetadata` 的拆分同样无法用 git 证据分离——C1–C5 全部未提交、同一工作树、最终落在同一个提交里。C5 能确证的是这两个 API 的**真实调用者**都在 C5 新增/改写的代码里（`activeMissing` → `recorder.ts` 的 `token-metadata` 日志行 374 行；`enqueueTokenMetadata` → `demandMetadata` 335 行）。
  6. **两条用例是我发现断言空转后补的**：原用例 3 只重复了同一地址，第二次 kick 因租约冲突而本就什么都不会发生，于是「单飞」这条断言是空的（RED 3 第一次跑时变异存活）；用例 7 原本断言的是结果**数量**而不是**身份**，`ready.clear()` 这种整表清空能穿透。我补了不同地址的单飞用例与按地址取身份的 ack 用例，并把 RED 3/7 重跑成 RED。这属于「补覆盖」，不是计划矩阵里的条目，如实列出。
  7. **测试的 gate 必须按 purpose 判别，不能只按 selector**：`0x313ce567`（`decimals()`）在仓库里有三个发出点——`src/storage/token-metadata.ts:229`（本任务要拦的那个）、`src/ops/capabilities.ts:197`（CLI 能力探针）、`src/registry/identity.ts:150`（`erc20Abi` 的 `decimals`，由 `verifyIdentity` 在**启动**时调用）。只按 selector 卡的 gate 会连启动探针一起卡住：实测 `batch-timing` 被推迟到第 3.6 秒，5 秒预算的 `until` 已经贴边（慢一点的机器就是假失败）。fixture 因此用 `reader.meter.currentPurpose === 'metadata'` 判别——这恰好是计划里「AsyncLocalStorage 隔离 purpose，不能用全局可变 purpose 字段」这条要求（03 第 176 行）在测试侧的直接体现。同时注意 `verifyIdentity` 跑在 `withBackfill(...)` 里，那里 `currentPurpose` 是 `undefined`，所以判别式必须写成「等于 metadata」而不是「不是 backfill」。
  8. **`pnpm lint` 整体是红的（HEAD 起就红，与本任务无关）**：`src/metrics/coverage.ts`、`src/replay/export.ts`、`src/replay/reader.ts`、`src/replay/runner.ts`、`src/storage/batch-coverage.ts`、`tests/integration/batch-coverage-cache.test.ts`、`tests/integration/referenced-batch-replay.test.ts`、`tests/unit/operation-filter-index.test.ts` 八个文件不过 `prettier --check`；这八个都不在本次改动列表里（`git status` 可核），我没有为了跑绿而重排它们的格式。`node scripts/check-scripts.mjs` 一节通过。
  9. 真实 provider 的端到端验证、运行时迁移与生产切换均**未执行**（属验收阶段，见后续记录）。

- Commit：`a9e28a82d64431bdb3762c5d741c0c1d54648a5e`（子计划 03 单一提交，C1–C5 全部在内，29 文件 / +7802 −263，且**未**包含 00–05 计划、spec 与 review 这些输入文件）。本行哈希的补写位于其后的一个小提交（与子计划 01/02 同一做法）。
