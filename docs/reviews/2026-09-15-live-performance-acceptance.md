# 实时性能与 V4 采集实验：验收报告（子计划 05 · E3.3 / E3.4）

- worktree：`E:\lp-monitor\.worktrees\live-runtime-performance`
- 分支：`codex/live-runtime-performance`
- base：`6ed70d7d6f7bd5fecbe22f2324b3e4ffad71acfa`
- E3 之前的 head：`7c3c39b`（子计划 01–04 的 8 个提交；本提交在其上）
- 实现记录（逐任务 RED/GREEN）：`docs/reviews/2026-09-15-live-performance-implementation.md`
- V4 实验报告：`docs/reviews/2026-09-15-v4-capture-experiment.md`

**未做的线上动作**：没有 merge、没有 push、没有删分支。没有对原工作区运行中的 follow/dashboard、`.env`、实际 config 或 data 数据库做任何事；没有发起新的真实 RPC 采样（V4 manager 只做默认关闭的离线实验）；`artifacts/` 下的原样本只在 worktree 内落盘，没有复制 `.env`、运行数据库或整份 `artifacts/`。

---

## 1. E3.3 验收表（逐项）

`证据` 列指向实现记录中对应的任务小节（`docs/reviews/2026-09-15-live-performance-implementation.md`），
带「主控复验」的行是本次验收阶段由主控自己重跑、不是转述实现者的结论。

| 验收项 | 通过条件 | 结论 | 证据 |
|---|---|---|---|
| 数值与状态 | 固定小样本逐批与旧实现/独立参考一致，明确列允许变化 | 通过 | E2：`tests/integration/v4-capture-equivalence.test.ts` 逐窗口（1m/5m/15m/1h）数值、`coverage`/`qualityErrors`/`rwa`、`projectionSourceHash`、`alert_outbox` 的 kind/status/revision/poolId/logicalTimeSec/reasons/ruleVersion 与投递顺序全等；**唯一**排除 `atBatchId` 且测试**显式断言它确实不同**，不是静默丢弃。`tests/integration/signal-workset-equivalence.test.ts:417` 把十二池样本的逐批 alerts、outbox、revision、logicalTime、reasons、快照状态序列全部冻结（主控复验：该文件 4 passed）。允许变化清单见本节末 |
| 限流恢复 | A3 虚拟时钟 <=45 秒恢复，预算与 defer 不可绕过 | 通过 | A3（含「未通过项」里对恢复曲线口径的记录） |
| 注册目录 | 预热后 0 变化批次全目录 read/serialize 均 0 | 通过 | B1/B2/B3（journal + `RegistryCache`）/ C1/C3；真实计数 `registryRowsRead=0`、`registryRowsSerialized=0` 见 C3 与 `tests/integration/live-workset.test.ts:225`。**主控复验**：`live-workset.test.ts` 9 passed。**大样本逐样本计数（80k）**：预热第 1 轮 800 read / 2,400 serialize（init 之后的第一次追平），此后 **23 个普通样本（预热 2–3、fresh 14、advance 3、repeat 3）全部 0 / 0**；`new-registration-first-swap` 修复轮 0 read / **2** serialize（只有那一条新注册），`history-revision` 修复轮 80,401 read / 800 serialize（该轮本就要求按修订重读目录）。160k **逐样本同形**（取值集合 {0, 800, 160401}，且预热首轮的 800 read / 2,400 serialize 与 80k **逐值相同**——那次读的是**批次引用到的注册**，不是目录规模；只有 `history-revision` 修复轮按目录规模读到 160,401） |
| 新 raw 批次 | 只携带新池及本批引用池，无隐藏全量副本 | 通过（含一条边界） | B4/B5：`referenced-v1` 的 bytes 与 IDs 见 B5 的 RED/GREEN；B5「未通过项 1」记录该模式在 `src/` 下无行为消费者 |
| 事件估值 | 相同依赖重复事件实际 `valueSwap` 调用 0 | 通过 | A2 + C2：计数与用例见 C2「事件估值」段。**主控复验**：C2 清单 6 文件 41 passed |
| 信号工作量 | 仅热池/有状态/受影响池，空推进仍过期 | 通过（本轮修正后重测） | C1/C3 + E3-a 的 `evaluatedPools`，以及见 §2.2。**本轮修了 R06 的 workset 退化**：修前 80 活跃池的 8000 池目录每轮评 8000 个，修后每轮评 80 个；轮级回归 `tests/integration/signal-workset-equivalence.test.ts:964-1051`（主控复验：4 passed；把谓词换回旧实现后该条 RED，失败于 `:1011`，逐字节还原 sha256 `944851097C9517AD7AAF73BA22AB9169C55428EB0F59788D69D6666228D887F9`），详见实现记录 E3-修正 一节。**大样本证据**：80k/160k 两组各 26 个样本（含预热与修复轮）里 `evaluatedPools` 与 `evaluatedWorksetPools` **逐样本相等**，均为 400（三个修复轮为 401）——目录从 80,000 涨到 160,000 而每轮评估量不变 |
| metadata | 当前需求优先、不扫描 62k 地址、慢请求不阻塞 commit | 通过 | C4/C5（C5「未通过项」逐条列出计划外补充与留白） |
| HTTP | warm summary GET p95<1 秒、<1 MiB、核心计算计数 0 | **通过**（p95 46/48 ms；响应 292,473/292,474 B；`readModel*` 核心计算计数在 26×2 个样本里全 0） | D1/D2/D3 + §2.2 的请求样本 |
| 本地批次 | 普通样本 p95<2 秒；80k→160k 固定活跃量耗时比<=1.5 | **一半通过、一半未达标**：耗时比在四个口径下全部达标（最严 1.42）；**p95 未达标**（80k 4,204 ms / 160k 4,506 ms，约为门槛的 2.1–2.3 倍）。已按计划 05:127 保存失败样本、定位最慢阶段并交回，详见 §2.2 | §2.2 / §2.3 / §2.4 |
| 重启/失败 | rollback、reorg、metadata 同 tip 修订、outbox 重试正确 | 通过 | C1/C3（`a round that rolled back leaves no standing watermark for its retry to trust`、`alert-reorg`、`alert-new-pool`、`rolling-replay`）、D2（同 tip 修订的缓存失效缺陷已修并转正用例）、B4；**主控复验**：C3 清单 11 文件 96 passed |
| 旧库/格式 | readonly 不迁移；inline/ref-v1/ref-v2 与 referenced 可混合读 | 通过（含一条如实记录的口径） | B5/B6 + 本报告 §5、§6。注意只读路径「不迁移」成立，但旧库缺 014 表时**不会被探测到**（§5 步骤 5） |
| V4 实验 | 离线有界等价/失败可见；真实 provider 与生产切换未执行 | 通过（离线部分） | E1/E2 + `docs/reviews/2026-09-15-v4-capture-experiment.md` 第 8 节。**R05 = 离线候选已实现；真实 provider 验证及上线接线未执行** |

### 允许变化（计划 05:125 原文的逐条落实）

计划允许变化仅限：metadata 先 unpriced 后更新；网页 v2 汇总/分页结构及 loading 文案；惩罚恢复速度；没有业务历史的冷池不预写 watch 行；更准确的工作量/计时日志。

- **没有业务历史的冷池不预写 watch 行**：本轮 E3-修正正落在这一条上（`snapshotHasMemory` 改白名单）。它只影响 `live_signal_workset` 的成员，不动 `signal_snapshots` 行。
- 其余四条在上表各自的项内体现。
- **数值、已有提醒身份/去重、范围和 coverage 语义不在允许变化中**：本轮的 `signal-workset-equivalence.test.ts:417` 与 `v4-capture-equivalence.test.ts` 是这两条的直接证据，且在本次修正**之后**重跑通过。

---

## 2. 性能测量（E3.2）

三组全部按计划 05:95-104 的命令逐字执行，**串行**（前一组退出码 0 之后才起下一组），同一个 worktree、同一个 `gitHead 7c3c39b`。每组报告落在各自的 `artifacts/performance/<组>/benchmark.json`（另有 `summary.json`）。

### 2.1 三组运行与机器状态

| 组 | 参数 | 退出码 | 日志 |
|---|---|---|---|
| 80k | `--pools 80000 --active 400 --iterations 20 --out artifacts/performance/80k` | `EXIT_80K=0` | `%TEMP%\e32-bench.log` |
| 160k | `--pools 160000 --active 400 --iterations 20 --out artifacts/performance/160k` | `EXIT_160K=0` | 同上 |
| all-active | `--pools 2000 --active 2000 --iterations 20 --out artifacts/performance/all-active` | `EXIT_ALLACTIVE=0` | 同上 |

样本分配三组一致且与计划 05:83 相符：普通样本 20 = fresh 14 / advance 3（仅 watermark 推进）/ repeat 3（重复事件）；另有 3 轮修复样本单列，不混入 p95：`new-registration-first-swap`、`metadata-backfill`、`history-revision`。

**机器与负载**（逐字取自 `environment`，三组一致）：Node `v24.5.0`、`win32 x64`、`AMD Ryzen 9 9950X 16-Core Processor`、32 逻辑核、内存 100,558,983,168 B。`parallelLoad` 记录为
`dashboard snapshot worker thread (in-process, started by this run); operator report: none - quiescent Windows desktop, no other benchmark or test job running`
——唯一并行的负载是本进程按 D1/D2 设计自己启动的仪表盘 worker 线程；三组期间没有第二份基准、测试或构建作业。

**初始化单独计时**（不计入 20 轮普通样本）：

| 组 | fixtureMs | catalogueMs | coverageMs | init totalMs | getLogsRequests |
|---|---|---|---|---|---|
| 80k | 172.0 | 23,709.96 | 64,587.25 | 88,469.21 | 84 |
| 160k | 313.2 | 48,256.69 | 145,668.79 | 194,238.63 | 164 |
| all-active | 5.4 | 463.56 | 8,917.99 | 9,386.99 | 7 |

初始化随目录规模近似线性（80k→160k：catalogue ×2.04、coverage ×2.26、总时长 ×2.20），与计划 05:89 对 R05 未上线部分的预期一致。

### 2.2 门槛判定

计划 05:110-123 的 12 行里，只有「HTTP」与「本地批次」两行由本节的测量决定；其余 10 行由测试路径判定（见 §1）。这两行的三个 HTTP 子条件与两个本地批次子条件在本表逐条拆开。

| 门槛 | 条件 | 实测 | 结论 |
|---|---|---|---|
| HTTP（warm summary GET） | p95 < 1 秒 | 80k **46 ms** / 160k **48 ms**（各 26 次请求，全部 `status:200`，样本逐条见 `benchmark.json.http.samples`） | **通过** |
| HTTP（响应体） | < 1 MiB | 80k **292,473 B** / 160k **292,474 B**（p95；两者几乎相同——首页只回已发布汇总，不随目录规模增长） | **通过** |
| HTTP（核心计算计数） | 0 | `readModelIndexBuilds`、`readModelRegistryScans`、`readModelPoolsBuilt` 在 **26×2 个样本里全部为 0**（逐样本核对，非抽样） | **通过** |
| 本地批次日 p95 | 普通样本 p95 < 2 秒 | 80k **4,204 ms** / 160k **4,506 ms**（p50 3,346 / 3,972；max 5,662 / 4,545） | **未达标（约 2.1–2.3 倍）** |
| 本地批次日 p50 回落到 2 秒以内的可能性 | —— | 三组里**没有任何一个样本**（含不计入统计的预热轮）低于 2 秒：最快的一次是 80k 预热 3/3 的 **2,490 ms**（另两次 2,595 / 3,390） | 系统性差距，不是尾部分布噪声 |

**这是本次唯一一项未达标**，按计划 05:127 的处置要求逐条落实：

- **保存失败样本**：`artifacts/performance/80k/benchmark.json` 与 `artifacts/performance/160k/benchmark.json`（20 个普通样本 + 3 个修复样本的 `localProcessingMs`、`stageMs`、WorkCounts、bytes、HTTP、RSS 全量原样保留，未覆盖、未改写）。workset 退化那一轮的修前/修后失败样本是 `%TEMP%\e3-workset-probe`（`evaluated=8000`）与 `e3-workset-probe3`（`evaluated=80`），逐字输出见实现记录 E3-修正；**`artifacts/performance/e3a-smoke/` 不是这项的失败样本**——它是 E3-a 的验收冒烟跑（`--pools 2000 --active 2000 --iterations 5`），该配置下每个池本来就是活跃池，`evaluated=2000` 是正确行为，退化的判别要在「大目录 + 少活跃」的配置上才成立。
- **用 `stageMs` 定位最慢阶段**（`localProcessingMs` 的 20 个普通样本，p50 / p95，单位 ms）：

| 阶段 | 80k p50 / p95 | 160k p50 / p95 | 占 80k 本地 p95 | 归属 |
|---|---|---|---|---|
| **windows** | **1,306.6 / 1,794.4** | **1,334.1 / 1,385.4** | **42.7%** | C2 |
| projection | 685.0 / 972.0 | 1,280.7 / 1,496.2 | 23.1% | R06 / C1 |
| coverage | 556.0 / 883.6 | 611.4 / 881.0 | 21.0% | R03 / B4–B6 |
| rawPersist | 104.9 / 114.8 | 186.6 / 194.5 | 2.7% | B4 |
| valuation | 83.8 / 99.4 | 89.1 / 101.5 | 2.4% | C2 |
| signals | 56.7 / 81.4 | 66.3 / 69.6 | 1.9% | C3 |
| artifactPersist | 33.5 / 55.9 | 59.0 / 63.2 | 1.3% | B4 |
| （`rpcAcquisition`） | 1,307.1 / 1,486.4 | 2,486.6 / 2,852.3 | —— | **在本指标之外**（计划 05:86） |
| （`notify`） | 0.04 / 0.07 | 0.03 / 0.16 | —— | **在本指标之外** |

  `stageAccounting` 已声明 `rawPersist`…`signals` 这些阶段**划分**同一个窗口（各自只测一次，其和至多等于 `localProcessingMs`），`rpcAcquisition` 与 `notify` stand outside；`networkWaitMsAfterFetch` 在 80k/160k 的普通样本里只有 **2–42 ms**（all-active 满负载下最大 90 ms），所以 `localProcessingMs` 是干净的本机计算量，不含网络等待。
- **最慢阶段是 `windows`**（C2 的窗口重算），在两个规模上都稳定在 1.3–1.8 秒，占 80k 本地 p95 的 42.7%；其次是随目录规模增长的 `projection`（685 → 1,281 ms）与规模无关的 `coverage`（≈880 ms）。
- **是否在本轮修**：`windows` 要把 1.3–1.8 秒压到 < 2 秒门槛还留有余量，等于重写逐分钟窗口装配。子计划 05 只授权「用 stageMs 定位最慢阶段，在对应原任务内修正」，而 `windows` 属于 C2，其公式与数值语义受本次交接的硬约束保护（「不要重写窗口/信号公式」「数值…不在允许变化中」）。**因此判定：本轮不修**，按计划 05:127 后半句**明确标该项未完成并交回证据**，不宣称全部完成；是否继续修、以及可否放宽窗口语义，交由原审查者裁决。

### 2.3 80k → 160k 固定活跃量耗时比

固定 `--active 400`，只把注册规模翻倍。四个口径**全部 ≤ 1.5**：

| 口径 | 80k | 160k | 比值 |
|---|---|---|---|
| `localProcessingMs` p95 | 4,204 | 4,506 | **1.07** |
| `localProcessingMs` p50 | 3,346 | 3,972 | **1.19** |
| `totalMs` p95 | 5,614 | 7,017 | **1.25** |
| `totalMs` p50 | 4,398 | 6,240 | **1.42**（最严口径，仍达标） |

即目录从 78,000 个 V4 poolId 值涨到 156,000、`getLogsRequests` 从 2,271 涨到 4,431 的情况下，**本地处理**只涨 7%；涨得多的是 `totalMs`（含 `rpcAcquisition`：1,307 → 2,487 ms），正是 §2.4 归因的那部分。这与「固定活跃量下耗时比 ≤ 1.5」的门槛同向；门槛本身说的是端到端还是本地，计划未写明，故两套都列出，**按最严的 `totalMs` p50 = 1.42 判定为通过**。

### 2.4 R05 未上线部分的分项占比（计划 05:89 要求）

计划 05:89：默认 `pool-ids` filter 构造与 manifest 仍随注册数量增长，**必须实测并分项报告；若导致端到端比值/2 秒目标失败，验收标未达标并指出占比**。

**这部分确实是随注册数线性增长的**，且在第一手数据里可见：

| 量 | 80k | 160k | 倍数 |
|---|---|---|---|
| `filterPlan.v4PoolIdValues` | 78,000 | 156,000 | ×2.00 |
| `filterPlan.v4ShardCount` | 78 | 156 | ×2.00 |
| `filterPlan.manifestBytesPerRound` p50 | 5,643,322 B | 11,173,228 B | ×1.98 |
| `filterPlan.getLogsRequests` | 2,271 | 4,431 | ×1.95 |
| `filterPlan.poolRegistrationsBytesPerRound` p50 | 263,151 B | 263,151 B | ×1.00（活跃量固定，符合预期） |

**分项归因**（`rawBatchBytesPerRound` p50 = 6,280,479 → 11,810,385，而 `manifest + poolRegistrations` = 5,906,473 → 11,436,379；两者之差 374,006 B 在两侧**逐字节相同**，正是固定的 405 条日志负载——所以翻倍的确实是 manifest 本身）：

1. **在 `localProcessingMs` 之外**：`operationFilterValues` 扫描（78k / 156k 个值）+ 分片 filter 构造落在 `rpcAcquisition`，p50 **1,307 → 2,487 ms**（+1,180 ms），占 160k `totalMs` p50 的 **40%**。它随目录规模线性增长，是端到端成本随注册数增长的主因。
2. **在 `localProcessingMs` 之内**：manifest 随原始批次落盘，故体现为 `rawPersist`（p50 104.9 → 186.6）与 `artifactPersist`（p50 33.5 → 59.0）。这两段在 160k 的 p95 合计 **≤ 257.7 ms**，占该组本地 p95 的 **≤ 5.7%**（其中还含固定的日志负载，故是上界）；80k→160k 的**增量**为 p95 +87.0 ms、p50 +107.2 ms。

**结论（回答 05:89 的条件句）**：R05 未上线部分**没有**导致 2 秒目标失败。即便把它在本地窗口内的占用整段扣掉（p95 扣 87 ms），80k/160k 的本地 p95 仍是 4,117 / 4,419 ms，**仍约为门槛的 2.1–2.2 倍**；而它在本地窗口内只占 ≤ 5.7%，在窗口外则占端到端 p50 的 40%（后者不计入本门槛的口径）。失败项在 `windows` / `projection` / `coverage`，全部属于本轮已上线的范围内。

### 2.5 2000 注册全活跃压力样本（计划 05:88：「只报告随活跃量增长的成本，不要求恒定」）

`--pools 2000 --active 2000`，即**目录里每个池都是活跃池**——与 80k/160k 的「大目录、400 活跃」正好互补，用来量「成本随活跃量怎么走」。

| 量 | 80k（400 活跃） | 160k（400 活跃） | all-active（2000 活跃） |
|---|---|---|---|
| 普通样本 `localProcessingMs` p50 / p95 | 3,346 / 4,204 | 3,972 / 4,506 | **15,320 / 18,765** |
| 普通样本 `totalMs` p50 / p95 | 4,398 / 5,614 | 6,240 / 7,017 | **15,620 / 19,030** |
| **每个活跃池的本地成本**（local p50 ÷ 活跃数） | **8.37 ms** | **9.93 ms** | **7.66 ms** |
| HTTP p95 / 响应体 p95 | 46 ms / 292,473 B | 48 ms / 292,474 B | 187 ms / 293,039 B |
| `readModel*` 核心计算计数 | 全 0 | 全 0 | **仍全 0（26/26 样本）** |
| `evaluatedPools` / `evaluatedWorksetPools` | 400 / 400 | 400 / 400 | **2,000 / 2,000**（修复轮 2,001） |

- **成本随活跃量近似线性**：每池成本在三组之间是 7.7–9.9 ms 的量级，随活跃池数从 400 涨到 2,000，本地 p50 从 ~3.3 s 涨到 ~15.3 s（×4.6，活跃量 ×5）。这符合计划「不要求恒定、只报告增长」的口径。
- **`stageMs` 结构随活跃量变**：`windows` 6,598 / 6,949（占本地 p95 的 43.5%）与 `coverage` 4,508 / 7,100（37.8%）成为两个主导项，`projection` 1,582 / 1,760、`valuation` 454 / 716、`signals` 262 / 292；`rpcAcquisition` 只有 265 / 325 ms——因为目录小（`v4PoolIdValues` 1,950、2 个分片、manifest 483 KB），R05 未上线那部分在这个样本里几乎不占成本。
- **诚实记录一处未深究的现象**：这 20 轮内本地耗时**自身在漂**——第 1 轮 11,038 ms → 第 20 轮 16,847 ms（+53%），前 10 轮中位数 13,789 ms vs 后 10 轮 17,237 ms（+25%）。三个修复轮的 `registryRowsRead` / `registryRowsSerialized`（4,000/4,000 与 12,000）说明大目录读写只出现在既定的修复轮，**漂移不来自它们**。本轮**没有**去定位这个漂移（超出「只报告成本」的范围，且计划未要求该样本恒定），在此单列以免被误读为稳定值。它不影响 80k/160k 的结论：那两组的普通样本 p50 分别是 3,346 / 3,972 ms，组内没有同量级的漂移（80k：2,577 → 3,435；160k：3,623 → 4,349）。
- **HTTP 在满负载下仍然达标**：p95 187 ms（< 1 秒）、293,039 B（< 1 MiB），且 `readModel*` 核心计算计数仍为 0——即使每一轮都在评 2,000 个池，GET 路径也没有被拉进核心计算。

---

## 3. R01–R07 定位到最终文件 / 函数

> 行号取自本分支 E3 之前的 head `7c3c39b` 加上子计划 05 的在飞改动。逐条先由一个只读检索 agent 定位、再由主控复核；**§R04 的结论是主控自查后推翻 agent 初判得到的**，§R06 在 E3 验收阶段被实测发现未真正达标并已修正。

| Finding | 最终位置（文件:行 · 函数） | 改了什么 | 状态 |
|---|---|---|---|
| **R01** 网页平方级池匹配 + 每次请求全量生成池明细 | `src/dashboard/read-model.ts:338` `PoolIndex`（`:365 add()` 只标脏被碰到的 token）、`:205 CoverageQuery`（`:237 rangeMin` 稀疏区间最小值）、`:801 DashboardReadModel.pools()`（只构造本页）、`:723 publish()` / `:984 #dropViews()`；`src/dashboard/snapshot-worker.ts:169` `SnapshotWorker`（worker 线程 + 常驻只读连接，`#refresh` 单读事务）；`src/dashboard/snapshot-coordinator.ts:174 latest()`（纯内存同步）；`src/dashboard/server.ts:217`、`:304` | `registrations.filter(p => r.poolIds.includes(...))` 的嵌套线性查找被 `token→poolId 集合` 的成员判断取代；逐池窗口判定化为一次区间最小值比较；首页只回已发布汇总，池详情改独立路由按 `offset/limit` 分页且只构造本页；GET 路径不再做核心计算（`latest()` 只读内存），快照由 worker 线程按 revision 后台重算并携带 `generation`/`sourceHash`/`sourceChainTimeSec`/`coverage` | 已实现 |
| **R02** 限流惩罚被当作每次正常调用间隔 | `src/rpc/rate-limit.ts:59 penalize()`、`:78 succeed()`、`:87 acquire()`、`:52 state()` | `cooldownUntilMs`（429 冷却，指数，上限 30s）与 `effectiveIntervalMs`（稳态占位间隔，上限 2s）拆成两个独立量；`acquire` 每次 sleep 后重读四个上限；每 3 次成功两者减半，另有 60s 无 429 空闲回落；占位后 `nextMs` 只加 `effectiveIntervalMs` | 已实现 |
| **R03** 每批重复携带/压缩/核验整份目录 | `src/storage/migrations/011-registry-changes.sql`（journal + 4 触发器）、`src/storage/registry-changes.ts:43 registryChangesAfter`、`src/storage/registry-cache.ts:169 prepare()`、`src/storage/live-projection.ts:235 movesAfter()` / `:646` 游标改 `registry-cursor-v1`、`src/ingest/operation-filter-index.ts:51`（`:184 #rebuild`）、`src/ingest/registry-dependencies.ts:30 referencedRegistrations`、`src/ingest/record-range.ts:377`（`:471 registryMode:'referenced-v1'`）、`src/storage/migrations/012-batch-coverage.sql` + `src/storage/batch-coverage.ts:77`、`src/storage/raw-store.ts:130`（同事务 `accept`）、`src/metrics/coverage.ts:167` | 目录写入由数据库触发器记增量日志，读者只比两个 `registryRevision`，无变化就不读行；批次里 `poolRegistrations` 改为「本批日志真正依赖的注册」并标 `referenced-v1`；投影游标只存 seq 引用；接受成功时同事务写一份可独立校验的 coverage 证明，普通窗口读取命中即不再解压原始批次 | 已实现 |
| **R04** metadata 队列按全目录补全、阻塞提交 | `src/storage/metadata-queue.ts:93 DemandQueue`、`:129 lease()`、`:166 activeMissing`；`src/ops/metadata-worker.ts:97 createMetadataWorker`（真调用点 `src/ops/recorder.ts:324`）；`src/metrics/metadata-index.ts:91 buildMetadataIndex`（`:54 decimalsAtOrBelow` 组内二分）；`src/storage/token-metadata.ts:343 enqueueTokenMetadata` / `:209 lookupMetadata` / `:296 applyMetadataLookup` / `:71 readCachedMetricMetadata`；`src/metrics/metadata.ts:48 decimalsAt` | 目标数从「全部未知名地址」变为「本批 `poolRegistrations` 真正用到的 token + USDG + 启动预热」；补全改为有界需求队列 + 单飞 worker，批内只 `enqueue+kick` 不 await，结果在 accepted 事务或 `onWait` 短维护事务落库；失败 60s 退避且不 starvation；`decimalsAt` 换成按地址分组的有序锚点二分 | 已实现 |
| **R05** V4 实时请求数随历史池总数线性增长 | `src/ingest/filter-plan.ts:288`（manager 分支 `address:[v4Manager]` + `topics:[v4OperationTopics]`，`:22` 定义 `V4OperationMode`）、`src/ingest/v4-capture-experiment.ts:186 runV4CaptureExperiment`、`src/ingest/record-range.ts:238`（manager+registry 组合显式拒绝）、`:342`（选项透传目录路径）、`scripts/compare-v4-capture.mjs:330` | 新增显式 `manager` 实验模式：整段 V4 操作日志收成单个 `operation-v4` shard，由常驻 poolId 索引本地筛选。**默认仍是 `pool-ids`** | **离线候选已实现；真实 provider 验证及上线接线未执行** |
| **R06** 增量投影与信号证据仍反复扫描整份目录 | `src/storage/live-projection.ts:235 movesAfter()`、`:259 movesSinceArray()`（`:268 countWork('registryRowsSerialized')`）、`:274 sync()`、`:323-345`（token 未变早返回空 `eventDelta`）、`:428`、`:646`、`:674`、`:688`；`src/signals/project.ts:295-311`、`:447 selectWorkset()`、`:481 projectSignals()`；`src/storage/live-workset.ts:36 MEMORY_FIELDS` / `:60 snapshotHasMemory()` / `:102 select()` / `:162 retain()`；`src/storage/live-event-index.ts:87/37/168/208/296/328`；`src/storage/registry-changes.ts:35/43`；`src/storage/registry-cache.ts:143/169` | 投影不再重扫目录：变更从 011 的 registry journal 按 pool identity 取，cursor 只存 `registry-cursor-v1` 引用，无变化时早返回空增量；信号侧把「本轮池集合」变成 workset 选择（窗口 ∪ 过期 ∪ 变更 ∪ 依赖池）；事件索引只读有界窗口行而非全量 `live_events`。**E3 验收阶段实测发现 `snapshotHasMemory` 恒真、workset 退化成整份目录，已按计划 03:103 的白名单语义修正**（见 §1「信号工作量」行与实现记录 E3-修正） | 已实现（含本轮修正） |
| **R07** dormant 空池缓存按精确出生高度做键 | `src/metrics/rolling.ts:64 prepareRollingCoverage()`、`:72 rollingCoverage()`、`:188 buildRollingMetrics()`、`:196`、`:244-251`（`birth <= earliest → birthKey = null`；`dormantKey = JSON.stringify([rawToken, birthKey])`）、`:326` | 缓存键从「精确出生高度」改为 `[rawToken, birthKey]`：出生高度早于或等于该覆盖最早可验证边界的池，其窗口不可能被出生高度截短，于是共享一次计算而非每个发现高度各算一次 | 已实现 |

### 与 Review 字面不同的两处（**不是**实现偏离计划）

1. **R04 的 metadata 优先级次序**。Review 字面建议「USDG/观察名单 RWA 优先，其次当前新事件实际用到的代币」。实现的取值是批次内池 token `priority: 0`、批次内 USDG `priority: 1`、启动预热（195 地址含 RWA）`priority: 2`（`src/ops/recorder.ts:1229-1240`、`:590-596`；`lease()` 升序，`src/storage/metadata-queue.ts:149`，故 0 最先租走）。
   **依据**：子计划 03 第 125 行原文 `priority:0|1|2; // 0当前缺估值；1报价依赖；2监控资产启动需求`，第 142 行原文「初始194股票+USDG可以低优先级入队一次」。实现与计划**逐值一致**。故这是**计划相对 Review 字面的再裁决**，不属于 E3.4 要求列的「计划偏离」。
   **处置**：不改代码。理由：① 无正确性缺陷，观测量（「metadata 先 unpriced 后更新」）本身在 E3.3 允许变化列内；② 改常量会使 C4/C5 的已验证证据全部失效并需重跑；③ 本轮约束不新发真实 RPC。
   **遗留**：作为**待议调优项**交原审查者——USDG 是每次估值都依赖的通用报价资产，其 `priority: 1` 低于批次池 token 的 `0`，因此 USDG 首次解析会被排在本轮全部批次 token 之后。
2. **R01 的 `?at=` 越界语义**。legacy 路径对超出保留范围的 `at` 抛 400 `RangeError`，新路径改为 200 + `status:'error'`（D2 行为差异 3，D3 裁决一决定不恢复）。语法类非法 `at` 仍 400。

### 自己承认的零消费者 / 未通过项（照录，不美化；并附主控复核）

- `registryMode: 'referenced-v1'`（`src/ingest/record-range.ts:471`）**无行为消费者**。**主控复核修正**：`src/` 下并非"一次引用都没有"——`src/replay/clock.ts:106-108` 会读 `registryMode`，把标记原样带到合并后的重放批次上（保真传递）。它**不因该值改变任何计算**，没有任何路径据此跳过全目录读取或改变语义，所以「无行为消费者」成立，「无读取者」不成立。本条只由数据保真断言守住（B5 RED 4 / 未通过项 1）。
- `metadataAddressChanges`（`src/storage/metadata-queue.ts:351`）只被测试调用（C4 未通过项 1）。主控复核：`src/` 零命中，测试两处命中。
- `refreshTokenMetadata`（`src/storage/token-metadata.ts:388`）在 `src/` 下**已无调用者**，只剩 `tests/integration/token-metadata.test.ts`——真实路径改走「队列 + worker」。**主控自查确认**：新模块本身接线正确（`createMetadataWorker` → `src/ops/recorder.ts:324`；`demandMetadata` → `:590`、`:1245`），故「新模块必须接入真实调用路径」这条约束**满足**；但该导出函数已成为测试专用入口，如实列出供审查者处置。
- 记录 C3「未通过项」6：`coverageChanged`/`branchMoved` 无独立 RED；「未通过项」8：启动重投影分支从不调 `commit()`。
- 迁移 012 之前已接受的批次没有 coverage 证明，会继续解码直到被重新接受或显式预热；仓库内**没有**任何路径会扫历史批量补证明（B6 行为差异）——与回滚/预热成本相关，见 §1「旧库/格式」行。

---

## 4. 计划偏离清单

本节只列**相对 00–05 计划原文**的偏离。「未通过项」不是偏离，列在 §7；相对 **Review 字面**（而非计划）的两处已在 §3 末尾单列并给出「为何不算偏离计划」的依据。

| # | 位置 | 计划原文 | 实际做法 | 原因 / 处置 |
|---|---|---|---|---|
| 1 | `tests/helpers/dashboard-worker.ts`（D3） | 计划未规定该夹具的批次 id 形态 | `appendBatch` 的批次 id 由固定 `'extend'` 改为 `` `extend-${toBlock}` `` | `ingest_batches` 行不可变，固定 id 会让同一夹具只能追加一次；改后同高度二次追加**响亮失败**而不是静默覆盖。实现记录 :2119 记为「主控已接受为授权内偏离」 |
| 2 | `src/ops/metadata-worker.ts`（C5） | 计划只在 shutdown 条目写「在现有总体 drain deadline 内等待已发请求」，未要求收尾入口 | 新增 `drain()` 与 `METADATA_DRAIN_LIMIT = 256`，并在 `src/ops/recorder.ts:324` 接上真实调用路径 | 一次性运行（`command: 'ingest'`、follow 自然结束）没有第二个安全点，最后一批观测不可能在它之后才被收集，而这笔查询已经付过钱。`drain()` 三种情况立即返回（`stoppingNow()`、`fatal !== null`、一次 kick 零租约），不新增等待语义；`METADATA_DRAIN_LIMIT` 是背压不是预算（实现记录 :1512） |
| 3 | `tests/integration/live-workset.test.ts`（E3-修正） | 计划 03:103/105 要求白名单语义 | 两处**既有断言反向**：未知名段不再算记忆、`lastFiveEndSec` 不再算记忆 | 这两条断言固化的正是本轮缺陷本身（谓词恒真）。按计划修正**不等于**删除保护逻辑：白名单以外的保护一条未动，且新增了轮级回归。依据是计划 03:51「只有确认不再有窗口输入、持久信号记忆或本轮修订时，下一轮才移出」 |
| 4 | 子计划 05 的提交信息（仅记录行文） | 计划 E3.4 指定 `test: verify live performance and v4 capture experiment` | E3-a 的记录行曾写作「落在同一个 `perf:` 提交里」 | 以**计划为准**：实际提交用计划的 `test:` 信息，记录行已按其改正。子计划 01–04 已提交的 `fix:`/`perf:` 信息不受影响 |

除以上四条，未发现实现与计划原文的其它偏离；§3 的两处「与 Review 字面不同」经比对**与计划逐值一致**，故不计入本表。

---

## 5. 新增迁移、可重复性与旧库行为

本分支相对 base 新增 4 个迁移，全部是**新增文件**，`001`…`010` 未被修改：

| 迁移 | 建了什么 |
|---|---|
| `011-registry-changes.sql` | 注册变更 journal 表 + 4 个触发器 |
| `012-batch-coverage.sql` | 批次 coverage 证明 |
| `013-live-workset.sql` | `live_signal_workset` + `live_workset_state` |
| `014-metadata-queue.sql` | metadata 需求队列 |

`src/storage/database.ts` 的 `migration` 常量由 10 个文件名扩到 14 个（head `src/storage/database.ts:18-35`），读表逻辑（read-only 探针清单、两条 guard ALTER、backfill UPDATE）与 base 逐字相同。

**替换对象 0 个**：独立佐证是 base 的 `src/` 里对这些新表名一次引用都没有，说明没有任何既有列被换掉语义。

### 步骤 3：可重复性（独立测试库，不在运行库上迁移）

脚本：`C:\Users\myron\AppData\Local\Temp\e3-rollback\exp1-repeat.mts`，用 `openDatabase(tempPath)` 建库后连续开三次。

**主控复验的真实输出**：三次全部成功、无一步抛错；三次 `select name, type from sqlite_master order by type, name` 结果逐字节相同；`schema_version` 恒为 `115`，`user_version` 恒为 0（第二次起 DDL 全部被 `IF NOT EXISTS` 短路，未再改 schema）；`sqlite_master` 行数 162。

### 步骤 4：旧库升级

`exp2-pre014.mts` 手工 `exec` 001…013 十三个文件 + 两条 guard ALTER（含 `protocol` 故意留 NULL 的 `pools` 行、1 行 `raw_logs`、1 行 `ingest_batches`），再用 HEAD 的 `openDatabase()` 打开：升级成功，014 的表与触发器建出，旧行原样可读。

### 步骤 5：只读路径不迁移 —— 成立，但有一条口径必须如实记录

只读打开**一行 DDL 都没执行**（前后 `pools`/`ingest_batches` 逐字节相同，014 触发器数仍为 0）。

**但**：只读探针清单（`src/storage/database.ts:56-79`）与 base（`database.ts:51-65`）逐字相同，只在 11 张表上跑 `select … limit 0`，其中**不包含任何 014 新建的表**。所以「旧库缺 014 表」这件事只读路径**探测不到**，结果不是抛 `ConfigError` 而是「成功」。这不是本分支引入的行为差异（探针清单未改），但它是「readonly 不迁移」这条验收项的真实边界。

---

## 6. 回滚兼容性（先在副本验证；不写「直接降级一定安全」）

结论分两半，**必须分开读**：

- **Claim 1（新迁移可重复、不破坏旧事实）：成立**（§5）。
- **Claim 2（回滚兼容）：不成立 —— 旧 build 无法读新库的游标，回滚必须先重建派生游标。**

### 旧 build 会怎么失败

`live_projection_cursors.registry_json` 的格式从 `PersistedPoolRegistration[]` 变成了
`{format:'registry-cursor-v1',…}` 对象，而 base 与 HEAD 的 `VERSION` 字符串**完全相同**
（两边都是 `PROJECTION_VERSION + '-incremental-v1'`，`PROJECTION_VERSION` 两边都是 `'p2-v2'`），
所以 base 的版本判定（base `live-projection.ts:80`）为假、**不会**走 rebuild 早退，
只要 `old.source_hash !== token`（base:76）就会执行到 88 行：

```
TypeError: previous.map is not a function
    at …/src/storage/live-projection.ts:88:40
```

`JSON.parse` 成功（引用对象是合法 JSON），但 `previous` 是对象不是数组，`previous.map` 是 `undefined`。

**失效时机（重要）**：交接后第一轮是 no-op，旧 build 看起来完全健康；**只要链上新增任何一个批次**
（`live_source_revisions.revision` 变化 → token 变化），下一轮 `sync()` 就抛。
即旧 build 不是「一启动就炸」，而是「下一批数据到达时炸」。

**失败是否破坏数据？不破坏。** 该语句在 `this.db.transaction(...)` 内，且在 base 事务体里第一条写
（`live-projection.ts:117` 的 `delete from ' + table`）之前（88 < 117）。实测回滚后 `live_events` 等派生表内容未变。

`pools` / `ingest_batches` / `projection_cursors` 三个方向逐列兼容，**没有发现任何「新 build 不再写入、旧 build 仍要读」的列**。

### 回滚步骤（在副本上真的跑过）

回滚前（仍在新 build 上、或已停进程），对每个 watch scope 执行一次：

```sql
DELETE FROM live_projection_cursors WHERE scope_id = '<scope_id>';
-- 只有一个 scope 时：DELETE FROM live_projection_cursors;
```

然后启动回滚后的旧 build。它看到游标行不存在 → `rebuild = true`（base `live-projection.ts:106-119`）→
清掉并重新从 `raw_logs` / `active_logs` 派生 `live_events` / `live_observations` / `live_inputs` / `live_quality_errors`，
并把游标按旧格式（整份目录数组）写回。**原始事实表**（`raw_logs`、`ingest_batches`、`fetch_shards`、`pools`、
`accepted_ranges`、`anchors`、`minute_boundaries`、`log_times`、`token_metadata`）**一概未被触碰，无需任何数据修复**。

`exp4` 的反向用例真的跑到了「数组 → 引用」这一转换：将来再升级回 HEAD 时，HEAD **能直接读旧 build 写出的数组游标**
（`registryInitialization = true`，游标被改写为引用）。所以这条重建步骤是**一次性**的，不是每次来回都要做。

**不需要做的事**：不必删表、不必回滚迁移、不必删库重放。011…014 建的表和触发器对新旧 build 都无害
（旧 build 的 `pools` / `ingest_batches` 写入穿过这些触发器实测成功）。

### 未能验证的部分（如实记录）

`projection_cursors` 的**行级**实测缺失：`exp3` 里旧 `select` 返回 `undefined`，因为没有跑离线 `rebuild()`。
替代证据是 base/HEAD 该表 DDL（`002-projections.sql` 未被本分支修改）与两条 SQL 逐字相同（`diff` → `IDENTICAL`），
以及只读探针清单一致。**没有**实际生成离线游标行来跑一次。

---

## 7. 未通过项汇总

### 7.1 本轮唯一未达标项

**本地批次 p95 未达 2 秒**（80k 4,204 ms / 160k 4,506 ms）。定位、占比与「为何本轮不修」见 §2.2，R05 未上线部分的排除见 §2.4。**该项按计划 05:127 标未完成，交回证据，不宣称全部完成。**

### 7.2 需要原审查者裁决的四件事

1. **本地批次 p95 是否必须在本次达到 2 秒**，以及若需要在 `windows`（占 80k 本地 p95 的 42.7%）上动刀是否可接受（§2.2）。
2. **R04 的 metadata 优先级次序**：实现与计划 03:125/142 逐值一致（批次内池 token `0` → 批次内 USDG `1` → 启动预热 `2`），但计划相对 Review 字面是一次再裁决；USDG 是每次估值都依赖的通用报价资产，其首次解析会被排在本轮全部批次 token 之后（§3 末）。
3. **`lastFiveEndSec` 退席的残余暴露**：reorg 时一个只带 5m 水位的历史静默池不再被选中重评。计划 03:105 明确要求历史静默池不纳入保守范围，故按计划判定、未自行加回（实现记录 E3-修正「未通过项 1」）。
4. **本分支自带的 5 个未格式化文件是否要另开独立任务清理**：`pnpm lint` 是红的（§7.3）。按计划 05:96-100「不要运行全仓 format 制造无关 diff」本轮未动，但这 5 个文件是子计划 01–04 新增的、且此前没有被任何记录显式认领过。

### 7.3 交付前必须如实报告的工具状态

`pnpm lint` **是红的**，`EXIT_LINT=1`。它由两段组成，红只出在第二段：

- `node scripts/check-scripts.mjs` —— 单独跑 `EXIT=0`。
- `prettier --check "src/**/*.ts" "tests/**/*.ts" "scripts/**/*.mjs"` —— 报 9 个文件不合格式，原样抄录：

```
[warn] src/metrics/coverage.ts
[warn] src/replay/export.ts
[warn] src/replay/reader.ts
[warn] src/replay/runner.ts
[warn] src/storage/batch-coverage.ts
[warn] tests/dashboard/read-model.test.ts
[warn] tests/integration/batch-coverage-cache.test.ts
[warn] tests/integration/referenced-batch-replay.test.ts
[warn] tests/unit/operation-filter-index.test.ts
[warn] Code style issues found in 9 files. Run Prettier with --write to fix.
```

这 9 个要分成两类，不能笼统说成「本轮的债」，也不能笼统甩给 HEAD：

- **4 个在 base `6ed70d7` 上就已不合格式**：`src/metrics/coverage.ts`、`src/replay/export.ts`、`src/replay/reader.ts`、`src/replay/runner.ts`。把 base 版本的这 4 个文件取出到临时目录单独跑 `prettier --check`，同样报 `warn`。本分支确实修改过它们，但**这次红不是本分支制造的**。
- **5 个是本分支新增的文件**：`src/storage/batch-coverage.ts`、`tests/dashboard/read-model.test.ts`、`tests/integration/batch-coverage-cache.test.ts`、`tests/integration/referenced-batch-replay.test.ts`、`tests/unit/operation-filter-index.test.ts`（`git cat-file -e 6ed70d7:<path>` 全部不存在）。它们不合格式**是本分支自己的 lint 债**，诚实记为未清。

另外两点也如实报告：

- **本次交付涉及的 11 个文件全部干净**（定向 `prettier --check`，见 §9 第一条，`EXIT_PRETTIER_CHECK_BEFORE=0`）。所以这份红名单里没有一个是 E3 这一轮写坏的。
- 不能拿「以前就红」当挡箭牌：5 个新增文件这条账在本轮之前没有被任何子计划记录显式认领过。

**本轮未做全仓 format 修复**，理由三条，如实列出而非辩解：

1. 计划 05:96-100 明确写「先对本次修改的源文件定向 prettier；**不要运行全仓 format 制造无关 diff**」，全仓 `prettier --write` 正是该条禁止的动作。
2. 这 9 个文件里有实现记录与本报告 R01–R07 映射所引用的行号（例如 `src/metrics/coverage.ts` 在 §3 被引用为 `coverage.ts:167`），format 会移动行号，使已逐条核对过的引用失效。
3. 其中 5 个是子计划 01–04 的产物，本轮擅自重排会让审查者拿到一批与那几份记录对不上的 diff。

**交给审查者裁决**：这 5 个由本分支新增的未格式化文件是否要另开一个独立任务统一 format；若要一次清干净，会连带覆盖上面 4 个既有文件，届时引用行号需一并更新。

### 7.4 其余已记录的边界（逐条一行，细节见所指小节）

- **R05 未上线**：manager 模式只是离线候选，`eligibleForLive` 不代表真实 provider 已验收，未接入 recorder CLI / 运行配置；真实 provider 验证与生产切换均未执行（§1「V4 实验」行、`docs/reviews/2026-09-15-v4-capture-experiment.md` 第 8 节）。
- **零行为消费者**：`registryMode:'referenced-v1'` 在 `src/` 下**有读取者、无行为消费者**（`src/replay/clock.ts:106-108` 只做保真传递）；`metadataAddressChanges`、`refreshTokenMetadata` 在 `src/` 下只剩测试调用（§3）。
- **无独立 RED 的两处保护**：C3「未通过项」6 的 `coverageChanged` / `branchMoved`（加宽变异实测无 RED，按不删保护逻辑保留）；C3「未通过项」8 的启动重投影分支从不调 `commit()`。
- **迁移 012 之前已接受的批次没有 coverage 证明**，且仓库内没有任何路径会扫历史批量补证明（B6 行为差异）——与回滚/预热成本相关。
- **只读路径的真实边界**：「readonly 不迁移」成立，但旧库缺 014 表**探测不到**（只读探针清单未含 014 新建的表，且该清单与 base 逐字相同）（§5 步骤 5）。
- **回滚**：Claim 1（新迁移可重复、不破坏旧事实）成立；**Claim 2（回滚兼容）不成立**——旧 build 读不了新格式游标，`TypeError: previous.map is not a function`（`live-projection.ts:88`），失效时机是**下一批数据到达时**而非启动时，且发生在任何写入之前、不破坏数据。回滚前必须 `DELETE FROM live_projection_cursors WHERE scope_id='<scope_id>';`（§6）。**未验证**：`projection_cursors` 的行级实测缺失，替代证据是该表 DDL 与两条 SQL 逐字节相同。
- **E1 的 M5 变异漏网**：`v4-capture-experiment.ts` 里「请求必须覆盖全部五个事件家族」这一条在完整批次里不可达，保留保护逻辑并按边界记录，不为抓变异去构造真实链路产生不出来的批次。
- **E2 的三条边界**：`scripts/compare-v4-capture.mjs` 无自动化测试（比较非空洞已用已知不等的输入实跑证明）；`artifacts/performance/v4-capture-fixture.json` 由已删除的一次性脚本产出、没有可重复生成入口；`deadline` 用例模拟的是「进入采集后 deadline 已耗尽」，**不等于**真实时钟中途到期。
- **E1/E2 当时未跑全量 `pnpm test` / `pnpm build`**（避免与并行的 dashboard 任务互相干扰）——本轮交付前已由主控在静默机器上补跑，真实输出见 §9。
- **提交数口径**：计划 E3.4 写「5个commit」，分支上按「一个子计划一个功能提交」正是 5 个，但实际还有 4 个 `docs:` 哈希补写小提交（01–04 起的既定做法），如实列出（§8）。

---

## 8. 交接

- **worktree**：`E:\lp-monitor\.worktrees\live-runtime-performance`
- **分支**：`codex/live-runtime-performance` —— **未 merge、未 push、未删分支**，停在功能分支等 Review。
- **base**：`6ed70d7d6f7bd5fecbe22f2324b3e4ffad71acfa`
- **head**：本子计划的 `test:` 提交（其哈希由紧跟的 `docs:` 补写提交写入本行与实现记录的各行 `- Commit：`）。
- **提交数**：计划 E3.4 的字面是「5个commit」。按「一个子计划一个功能提交」的口径正是 **5 个**（`eb206cb` / `129d5b6` / `a9e28a8` / `c40c0e8` / 本子计划的 `test:` 提交）。分支上的**实际提交数更多**：子计划 01–04 各另有一个 `docs:` 小提交，把该轮 commit 哈希补写回实现记录，本子计划同样如此。这是 01 起确立的既定做法，如实列出以免审查者对不上数。
- **验收报告**：`docs/reviews/2026-09-15-live-performance-acceptance.md`（本文件，E3.3/E3.4）。
  逐任务 RED/GREEN 记录：`docs/reviews/2026-09-15-live-performance-implementation.md`。
  V4 实验报告：`docs/reviews/2026-09-15-v4-capture-experiment.md`。
- **性能原样本**：`artifacts/performance/80k/benchmark.json`、`artifacts/performance/160k/benchmark.json`、`artifacts/performance/all-active/benchmark.json`（各附 `summary.json`），以及 `artifacts/performance/e3a-smoke/benchmark.json`（**E3-a 的验收冒烟跑**，`--pools 2000 --active 2000 --iterations 5`，不是本轮的失败样本）。每次运行的 `artifacts/` 子目录（原始 JSON-RPC 响应，80k 一次 206 MB）**未提交**。
- **未通过项**：见 §7。四件需要审查者裁决的事：
  1. **本地批次 p95 是否必须在本次达到 2 秒**（§2.2）。已按计划 05:127 保存失败样本、用 `stageMs` 定位到最慢阶段 `windows`，并给出了「若继续修要动什么」的判断。
  2. **R04 的 metadata 优先级次序**（§3 末）：USDG 是每次估值都依赖的通用报价资产，其 `priority: 1` 低于批次内池 token 的 `0`。实现与**计划逐值一致**，故未改；但计划相对 Review 字面是一次再裁决，需要审查者确认。
  3. **`lastFiveEndSec` 退席的残余暴露**（实现记录 E3-修正「未通过项 1」）：reorg 时一个只带 5m 水位的历史静默池不再被选中重评。计划 03:105 明确要求历史静默池不纳入保守范围，故按计划判定，未自行加回。
  4. **`pnpm lint` 的红名单**（§7.3）：9 个文件，其中 4 个在 base 上就已不合格式、5 个是本分支新增的。本轮按计划 05:96-100 只做了定向 prettier，未跑全仓 format；5 个新增文件这笔账需要审查者决定是另开任务清掉还是接受。
- **未做的线上动作**：没有 merge、没有 push、没有删分支；没有对原工作区运行中的 follow/dashboard、`.env`、实际 config 或 data 数据库做任何事；**没有发起新的真实 RPC 采样**（V4 manager 只做默认关闭的离线实验）；没有复制 `.env`、运行数据库或整份 `artifacts/`。原工作区不干净的未跟踪文件全部原样保留。

---

## 9. 交付前的验证命令与真实输出

按计划 05:96-100 的顺序实跑。E3.2 的三次基准跑于 10:29:25 结束之后才启动这一串，测试期间没有并行的基准、dashboard 或其它构建任务；下面每一段都是原样抄录，`EXIT_*=rc` 由脚本逐条记录，不是事后补写。

### 9.1 定向 prettier（先做，避免全仓 format 制造无关 diff）

```
$ env pnpm exec prettier --check scripts/benchmark-live-performance.mjs scripts/compare-v4-capture.mjs \
    src/ingest/filter-plan.ts src/ingest/record-range.ts src/ingest/v4-capture-experiment.ts \
    src/storage/live-workset.ts tests/integration/live-workset.test.ts \
    tests/integration/signal-workset-equivalence.test.ts tests/integration/live-performance-contract.test.ts \
    tests/integration/v4-capture-equivalence.test.ts tests/unit/v4-capture-plan.test.ts
Checking formatting...
All matched files use Prettier code style!
EXIT_PRETTIER_CHECK_BEFORE=0
```

本次交付的 11 个文件全部干净，所以不需要为本轮改动重排格式，实现记录里引用的行号保持有效。

### 9.2 typecheck / test / build / lint / diff --check

```
################ TYPECHECK
$ pnpm typecheck
$ tsc --noEmit && tsc -p tsconfig.scripts.json
EXIT_TYPECHECK=0

################ TEST
$ pnpm test
$ vitest run

 RUN  v5.0.0 E:/lp-monitor/.worktrees/live-runtime-performance

 Test Files  138 passed (138)
      Tests  1204 passed (1204)
   Start at  10:30:28
   Duration  350.55s (tests 92%, import 6%, transform 2%)

EXIT_TEST=0

################ BUILD
$ pnpm build
$ node scripts/clean-build.mjs && tsc -p tsconfig.build.json && node scripts/copy-build-assets.mjs
EXIT_BUILD=0

################ LINT
$ pnpm lint
$ node scripts/check-scripts.mjs && prettier --check "src/**/*.ts" "tests/**/*.ts" "scripts/**/*.mjs"
Checking formatting...
[warn] （9 个文件，完整名单与分类见 §7.3）
[warn] Code style issues found in 9 files. Run Prettier with --write to fix.
[ELIFECYCLE] Command failed with exit code 1.
EXIT_LINT=1

################ DIFFCHECK
$ git diff --check
EXIT_DIFFCHECK=0
```

`pnpm test` 是 **138 个测试文件 / 1204 个用例全过**（350.55 秒），不是「只跑了本次新增的测试」。`pnpm build` 产物 `dist/` 被 `.gitignore:2` 忽略，构建没有向工作区留下任何未跟踪文件。全仓唯一红的是 §7.3 的 lint。

### 9.3 提交后的 `git status`（计划 05:131-135 要求列出）

E3.4 的 `test:` 提交只 stage 本次明确文件：上文 3 个文档 + 11 个源/测试文件 + `artifacts/performance/{80k,160k,all-active,e3a-smoke}/{benchmark.json,summary.json}`（8 个 JSON，合计约 323 KB）。**提交后仍留在工作区、故意未提交的**：

- `artifacts/performance/v4-capture-fixture.json`、`artifacts/performance/v4-capture-comparison/` —— 按 `docs/reviews/2026-09-15-v4-capture-experiment.md` 第 20–21 行的定性是「供复核者重跑的未跟踪产物」，故不提交。
- `artifacts/performance/baseline-80k/`、`baseline-80k-recheck/` —— 前几轮的基线样本，不属于本次交付。
- 每次基准跑的 `artifacts/performance/<run>/artifacts/` 子目录（原始 JSON-RPC 响应，80k 一次 206 MB）—— 不提交。
- `docs/superpowers/plans/2026-09-15-live-performance-*.md`、`docs/superpowers/specs/2026-09-15-live-runtime-performance-design.md`、`docs/reviews/2026-09-15-live-runtime-performance-review.md` —— 计划/规格/既有 Review 文件，按 01–04 起的既定做法不纳入本分支的实现提交。

**未做**：没有 merge、没有 push、没有删分支。
