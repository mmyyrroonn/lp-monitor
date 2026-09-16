# 2026-09-15 V4 采集实验（子计划 05 / E2）离线比较报告

- 原仓库：`E:\lp-monitor`
- 实施 worktree：`E:\lp-monitor\.worktrees\live-runtime-performance`
- 分支：`codex/live-runtime-performance`
- 依据：`docs/superpowers/plans/2026-09-15-live-performance-05-capture-acceptance.md` 第 52–73 行；记录格式见 00-master 第 4 节
- 依赖：E1（`src/ingest/v4-capture-experiment.ts`、`filter-plan.ts` 的 `v4OperationMode`）已交付

本文件里的每个数字都来自本 worktree 内真实执行的命令；没有执行过的事情写在「未执行清单」里，不写成已通过。本轮**没有**发起任何真实 RPC、没有联网、没有读取 `.env` 或运行库，也没有改动 `config/`、迁移、CI 或 lockfile。

---

## 1. 交付物

| 文件 | 作用 |
|---|---|
| `tests/integration/v4-capture-equivalence.test.ts` | 冻结假链上两种策略的采集等价性与边界回归（10 个用例） |
| `scripts/compare-v4-capture.mjs` | 离线比较器：只读显式本地 fixture，产出两策略比较报告 |
| `docs/reviews/2026-09-15-v4-capture-experiment.md` | 本文件 |
| `artifacts/performance/v4-capture-fixture.json` | 供复核者重跑比较器的离线 fixture（未跟踪产物） |
| `artifacts/performance/v4-capture-comparison/{comparison.json,summary.md}` | 本文件引用的比较器真实输出（未跟踪产物） |

未新增或修改 `tests/helpers/**`：现有 `recorder-fixture.ts` 依赖 `config/robinhood.json` 与真实归档产物，与本任务的 v4 链无关，因此夹具完全建在新测试文件内。

## 2. 这次比较为什么是真的

- **provider 按请求筛选**：`eth_getLogs` 的响应恒为 `fixture.logs.filter(matches(request))`，按请求自己的 address、topic 备选与块区间过滤。不存在「无论请求什么都返回同一数组」的 mock；要得少的策略就会拿到少。
- **两策略都走生产路径**：`buildOperationFilterPlan` → `fetchBoundedLogs` → `fetchRange`（`record-range.ts`），持久化与哈希在调用方；随后用 `resolveLogTimes` → `commitAcceptedSignalBatch` → `buildMetricsReport` 解释。测试没有直接调用 `evaluateSignal` 或手算窗口。
- **两个策略各自一个内存库**：manager 模式会采到 watch universe 之外的证据，因此它的 accepted range 绝不与默认 scope 混库（计划第 40 行）。
- **夹具不写字面期望值**：锚点、边界、日志时间全部从 provider 自己的回答读回；断言比对的是两策略彼此，以及一个冻结样本内部可推导的差值（例如「撤掉那笔爆发后 1h 窗口少了正好 30,000 USDG」）。

## 3. 离线等价性结果

命令与真实输出：

```
$ pnpm exec vitest run tests/integration/v4-capture-equivalence.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

```
$ pnpm exec vitest run tests/integration/v4-capture-equivalence.test.ts tests/integration/compact-batches.test.ts tests/integration/metrics-coverage.test.ts tests/integration/reorg.test.ts tests/integration/replay-export-integrity.test.ts
 Test Files  5 passed (5)
      Tests  44 passed (44)
```

样本：一条冻结假链，区间 `600..4800`、终点 `0x…12c0`（时间戳 4860），3 个 v4 池由该轮自己的 `Initialize` 发现（其中一个池 `rwaA/rwaB` 被两个股票共池），一名未被目录持有的旧池只在「未知池」用例出现。两段链：第一段带一笔爆发，第二段把该笔撤掉（历史修订）。

主用例断言（全部通过）：

- 两策略的日志**按键与按内容**逐一相等（`rawLogKey` 排序后比对 `encodeJson`），同 tx 的两条 Swap 保持两条（`logIndex` 1 与 2、两个不同 key），没有被合并成一条。
- 两策略的 `filterPlanHash` 与 `expectedShardIds` **不同**：请求确实不同（一个按 poolId 目录、一个按 manager 全域），只是这批链的目录覆盖了链上全部操作事件，所以回答相同。`responseBytes` 因此逐字节相等。
- 解释结果相等：`windows[].rolling` 四窗口（1m/5m/15m/1h）逐值相等，`coverage`/`qualityErrors`/`rwa` 逐值相等，`projectionSourceHash` 相等，`alert_outbox` 的投递顺序、kind、status、revision、poolId、logicalTimeSec、reasons、ruleVersion 相等。
- 样本非空转：三个目标池的 5m 与 1h 窗口均为 `closed` 且有真实数值；第一段产生 `candidate`，第二段产生同池同 episode 的 `retracted`（revision +1，reasons 含 `source-history-revised`）。
- 唯一被排除在比较之外的字段是 `atBatchId`：两种模式的 manifest 不同，批次身份必然不同。测试显式断言两者**确实不同**，而不是把它静默丢掉。

四窗口真实数值（比较器输出，`usdMicros` 为最小单位）：

| 池 | 1m | 5m | 15m | 1h |
|---|---|---|---|---|
| 热池（含爆发段） | 30000e6, 1 swap | 30000e6, 1 swap | 32000e6, 2 swap | 38000e6, 5 swap |
| 第二目标池 | 0e6, 0 swap | 2000e6, 1 swap | 2000e6, 1 swap | 8000e6, 4 swap |
| 共池（rwaA/rwaB，无 USDG 侧） | 0, 0 swap | 0, 0 swap | 原生计价（`usdMicros=null`） | 原生计价 |

共池用 `rawNotional` 而非 `usdMicros` 计价是既有语义，不是本次改动；它同时被两个股票各计一次，池本身仍只有一条。

## 4. 边界与失败可见性（逐项，均有用例）

| 计划要求 | 断言到的真实行为 |
|---|---|
| 响应上限导致二分 | `maxLogsPerResponse=2` 且恰好 2 条可分族的日志：被截断后按区间再按 topic 拆分，最终 `complete`，operation 请求数严格多于对照 |
| 恰好等于上限 | 同上：返回值正好等于上限时**不**被当作答案，必须再拆；只有拆到更小的请求才判 `complete` |
| 单块仍超上限 | 同一块两条同族 Swap、上限 2：无法再拆 → `completeness=incomplete`，manifest 出现 `status=truncated, error=range-limit`，`eligibleForLive=false` |
| 429 后恢复 | 一次 429（真实 `createChainReader` + `maxRetries:1`）后同请求重发，最终 `complete`、`eligibleForLive=true` |
| 预算耗尽 | `maxCalls` 卡在 operation 请求前：provider 只收到 discovery 的 4 个请求，operation 分片记录 `status=failed`，`reasons` 含 `failure:budget` 与 `incomplete-capture` |
| deadline | 第 4 个请求后耗尽 deadline：provider 此后**零**请求，`reasons` 含 `failure:deadline`，`eligibleForLive=false` |
| 响应同 key 不同内容 | 共池的 `Initialize` 被两个 discovery 请求各返回一次且字节不同：`recordingErrors` 出现 `conflicting-log:<key>`，`failureKinds` 含 `conflicting-log-identity`，`eligibleForLive=false`；同样两条**字节相同**时只有一条日志、`complete` |
| 终点 hash 变化 | 日志到手后终点锚改哈希：`recordingErrors` 含 `end-anchor-changed`，`reasons` 含 `failure:anchor-changed`，`eligibleForLive=false` |
| 未知池 | manager 采到目录无法解释的池：原始日志整条保留并进入 `raw_logs`、计入分片 `logKeys`，`unknownLogKeys` 列出它，`eligibleForLive=false` 且 `reasons` 含 `unknown-pool-logs`；pool-ids 侧从未请求它 |
| 两个股票共池 | 该池同时出现在 `rwaA` 与 `rwaB` 行的 `poolIds` 中，且每行 `poolIds` 内不重复；两策略解释相等 |

不完整结果**不能**用于构造 complete coverage：测试对一个被截断的批次直接调用 `SqliteRangeStore.acceptRange`，断言抛出 `IncompleteRangeError`、`acceptedTip` 仍为 `null`、且该批次没有携带 `poolRegistrations`。原有完整性校验一处未删、未放宽。

## 5. 离线比较器

```powershell
pnpm exec tsx scripts/compare-v4-capture.mjs --fixture artifacts/performance/v4-capture-fixture.json --out artifacts/performance/v4-capture-comparison
```

真实输出：

```
pool-ids: 5 requests, 22195 bytes, 18 log keys, complete
manager:  5 requests, 22195 bytes, 18 log keys, complete
decode equal: true; metrics equal: true
wrote …\artifacts\performance\v4-capture-comparison\comparison.json and …\summary.md
```

拒绝行为（真实退出码 1）：

```
$ pnpm exec tsx scripts/compare-v4-capture.mjs --fixture https://example.invalid/logs.json --out artifacts/performance/should-not-exist
--fixture must be a local path, not a URL: https://example.invalid/logs.json   (EXIT=1)
$ pnpm exec tsx scripts/compare-v4-capture.mjs --fixture file:///tmp/x.json --out artifacts/performance/should-not-exist
--fixture must be a local path, not a URL: file:///tmp/x.json                  (EXIT=1)
$ pnpm exec tsx scripts/compare-v4-capture.mjs --fixture artifacts/performance/v4-capture-fixture.json --out artifacts/performance/v4-capture-comparison
--out already exists: …\artifacts\performance\v4-capture-comparison            (EXIT=1)
$ pnpm exec tsx scripts/compare-v4-capture.mjs --fixture artifacts/performance/nope.json --out artifacts/performance/should-not-exist-2
--fixture does not exist: …\artifacts\performance\nope.json                    (EXIT=1)
```

被拒绝时没有产生任何输出目录。脚本不读 `.env`、没有端点选项、没有默认 URL、没有网络回退分支：fixture 缺失或非法就是错误，不是联网的理由。fixture 格式自带 `schemaVersion: 1` 与 `bigintCodec: "decimal-string"`（区块高度、logIndex、金额一律十进制字符串，避免 JSON number 在 2^53 以上丢精度）；时间要么由 `anchors` 记录，要么由 `chain.baseTimestampSec + n * secondsPerBlock` 的线性规则给出。

输出含：两策略的 requests、operation requests、response bytes、log keys、批次目录中的池数、watched/unknown 数量、完整性、`eligibleForLive`；日志 key 差集；reasons；分片形状；逐条 decode 结果（生产 `decodeV4`）；以及完整解释结果（coverage、四窗口、qualityErrors、提醒流）。不完整批次**不进入解释**，直接记为 `incomplete-capture-cannot-build-coverage`。报告与 summary 都写明：这里的请求数/字节是离线规划与载荷事实，**不是** provider 延迟，本报告不把前者换算成后者。

关于请求数：本 fixture 的目录很小（3 个池），两策略的 operation 请求都是 1 个，所以两列相等。manager 相对 poolId 目录的请求数下降要在目录大到按 poolId 分片时才出现（E1 的单元测试在 77,628 条 v4 注册下量到 78 个 poolId 请求 vs 1 个 manager 请求）；那是 E1 的证据，本文件不重复、也不把它当作线上结论。

## 6. 已记录的行为差异与限制

1. **两种模式在「有未知池」的链上不等价，且差异可量化**：manager 采到的那条无法解释的 Swap 使它所在分钟的 coverage 变为 `incomplete`（reason `projection-quality-error`），于是任何覆盖该分钟的窗口（本例是 1h）被判 `coverage-gap`，并且 5m 基线的样本数随之减少（该历史窗口不再 closed）。5m 窗口本身的数值不受影响。这正是 `eligibleForLive=false` 的实质含义：manager 的覆盖更**宽**，不是更**好**。测试断言了这条差异的方向（比较只能变差），而不是要求它伪装成与干净样本等价。
2. **批次身份不同**：两种模式的 manifest 与 `filterPlanHash` 不同，`batch.id`、`atBatchId` 必然不同。语义比较必须排除这一身份字段，测试显式断言它确实不同，以免「相等」是因为比了空气。
3. **`requestCount` 计的是发起次数**：`runV4CaptureExperiment` 的计数在 wrapper 里自增，因此 deadline 已耗尽时它仍会计数，而 provider 一次都没收到。测试用 provider 自己的请求表断言真实分发数。
4. **manager 模式与 registry 模板路径互斥**：`fetchRange` 在同时给出 `registry`/`operationFilters` 与 `v4OperationMode: 'manager'` 时直接抛错（E1 交付）。本任务未触碰该行为。
5. **未产生任何线上结论**：本文所有数字来自内存假链与离线 fixture。

## 7. R05 状态

**R05 = 离线候选已实现；真实 provider 验证及上线接线未执行。**

默认 pool-ids 路径不变，manager 模式仍然只能由显式实验参数进入（`runV4CaptureExperiment` 必填 `v4OperationMode`，正常 recorder 不传）。离线比较证明的是：在目录覆盖链上全部操作事件时，两种策略采集到相同的原始证据并解释出相同的四窗口、覆盖、质量原因与提醒流；在不覆盖时，差异全部指向 manager 多采到的、目录无法解释的日志，并被如实标成不可上线。

## 8. 未执行清单（计划第 66–74 行，原样保留，供原审查者以后安排）

以下各项**本次实施未执行**：

1. 固定同一已知小区间和终点hash；设置总请求预算及<=60秒墙钟上限，两模式共享预算而不是各自偷偷翻倍。
2. 使用现有meter/limiter/evidence写入，保存真实响应bytes、429、分裂次数、elapsed及目标日志差异；不要打印RPC URL。
3. 有未知池、截断或metadata不足时保留未验证状态；明确区分完整目标池结果与更广Manager宇宙覆盖。
4. 只有边界、等价和实际provider延迟都通过后，才讨论生产开关；当前仍用pool-ids。

本轮**没有**任何真实 provider 采样，因此不存在「在线请求从 N 次降到 M 次」这类结论；本文不写这类数字。

## 9. 复核命令

```powershell
pnpm exec vitest run tests/integration/v4-capture-equivalence.test.ts tests/integration/compact-batches.test.ts tests/integration/metrics-coverage.test.ts tests/integration/reorg.test.ts tests/integration/replay-export-integrity.test.ts
pnpm typecheck
pnpm exec prettier --check tests/integration/v4-capture-equivalence.test.ts scripts/compare-v4-capture.mjs
pnpm exec tsx scripts/compare-v4-capture.mjs --fixture artifacts/performance/v4-capture-fixture.json --out artifacts/performance/v4-capture-comparison-2
```

`scripts/compare-v4-capture.mjs` 在 `tsconfig.scripts.json` 的 `checkJs` 范围内（`pnpm typecheck` 的第二段即 `tsc -p tsconfig.scripts.json`），因此脚本本身也在类型检查内。

## 10. 未做到 / 不确定

- `artifacts/performance/v4-capture-fixture.json` 由本任务的一次性生成脚本产出（脚本已删除，不留在仓库）；它的内容与 `tests/integration/v4-capture-equivalence.test.ts` 的链一致（同一批 `Initialize`/`Swap` 规格、同一时间约定），但没有做成可重复生成的正式入口。复核者若需要新 fixture，按第 5 节的 schema 自备即可，比较器只接受显式本地 JSON。
- 未知池用例里「基线样本减少」的具体条数依赖该 fixture 的窗口布局，测试因此断言的是方向（只能减少、且确实减少），不是固定条数。
