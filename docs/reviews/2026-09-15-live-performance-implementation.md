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

