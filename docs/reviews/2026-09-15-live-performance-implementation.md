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
