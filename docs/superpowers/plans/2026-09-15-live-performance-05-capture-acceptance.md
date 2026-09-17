# 05 V4采集实验与最终验收 Implementation Plan

> **For agentic workers:** 按E1→E3执行。V4部分是默认关闭的离线实验；最终验收必须同时报告默认pool-ids路径的剩余RPC规模成本。

**Goal:** 提供可验证的Manager短范围采集候选，并证明前四阶段在真实目录规模下有效且语义不变。
**Architecture:** 现有poolId策略保持默认；显式实验参数构造Manager事件过滤，使用既有有界fetch；最终离线回归和性能报告交回原审查者。
**Tech Stack:** 现有filter-plan/fetch-range/record-range及Vitest；不引入provider SDK。
**Spec:** `docs/superpowers/specs/2026-09-15-live-runtime-performance-design.md`。

## Global Constraints

继承Spec全部约束。依赖01–04。本阶段不调用真实provider、不改config/robinhood.json、不启动真实follow、不提高RPS/预算/并发。

## E1. 新增显式Manager过滤实验入口

**文件**：修改 `src/ingest/filter-plan.ts`、`src/ingest/record-range.ts`；新增 `src/ingest/v4-capture-experiment.ts`、`tests/unit/v4-capture-plan.test.ts`。检查 `src/ingest/fetch-range.ts`，只在测试发现真实契约缺口时做最小修正。

**接口**：

```ts
export type V4OperationMode='pool-ids'|'manager';
// buildOperationFilterPlan在现有参数末尾追加可选options：
// {v4OperationMode?:V4OperationMode}，缺省pool-ids
// FetchRangeOptions同样增加可选v4OperationMode；正常recorder不传它。
export type V4ExperimentResult={
  mode:V4OperationMode;
  complete:boolean;
  eligibleForLive:boolean;
  reasons:string[];
  watchedLogKeys:string[];
  unknownLogKeys:string[];
  requestCount:number;
  responseBytes:number;
};
```

- [ ] RED：77,628 V4注册/maxFilterValues=1000，默认仍产生78个V4 poolId filter；manager产生1个Manager地址+相同event-topic集合的filter，不按poolId分片。V3/discovery策略完全不变。
- [ ] manager filter形状为 `address:[v4Manager]`、`topics:[v4OperationTopics]`，from/to完全保留。不要用空topics抓所有合约事件，不要删Initialize/ModifyLiquidity/Donate等已有事件家族。
- [ ] 默认缺省参数与显式pool-ids的filter、scopeId、manifest及hash输出逐值一致。mode=manager时filterPlanHash自然包含实际不同过滤器；额外把实验策略写入实验报告，不能只改日志文字。
- [ ] scopeId仍表示当前watch universe/协议事件范围，不能为性能实验擅改全项目scope算法。因为Manager多采了非目标证据，实验必须使用独立临时数据库/内存输入，不和默认scope实时accepted ranges混合。
- [ ] record-range继续先discovery再当前批operations，新发现同块首笔事件可识别；B4相关注册依赖仍包括这些新池。
- [ ] Manager响应用原fetchBoundedLogs范围拆分、guard、provider maxLogsPerResponse、retry和manifest验证。触及数量上限或疑似截断时必须拆更小区间；单块仍不完整则明确失败，不标complete。
- [ ] batch.logs/manifest保留真实完整响应及相同去重/冲突规则。禁止先本地过滤Manager结果再计算response hash、logCount或宣称provider返回的内容完整。
- [ ] 实验模块在完整原始证据之外构造watchedLogKeys：仅按已知registry依赖匹配目标池；未识别poolId单列unknownLogKeys。未知原始证据不得删除，不能填空池0或拿它证明已覆盖所有未注册旧池。
- [ ] 只有完整捕获、watch目标等价且不存在未解释覆盖问题时eligibleForLive才能true；它也只表示离线候选条件满足，不表示真实provider已验收。存在unknown时保持false并列原因，不通过放宽quality校验变true。
- [ ] 不把manager接入正常recorder CLI默认或修改运行配置；显式实验入口由测试/离线比较器使用。待再次Review和真实provider有界样本后，另行决定生产开关接线、未知非目标池分类和上线。

测试三类：全为已注册目标池；新池同块；包含未知旧池。第三类应验证原始证据保留、unknown可见、eligibleForLive=false，不能要求它伪装与干净目标样本等价。

运行：`pnpm exec vitest run tests/unit/v4-capture-plan.test.ts tests/integration/recorder.test.ts tests/integration/catalogue-follow.test.ts tests/unit/rpc-review.test.ts`。

## E2. 离线比较器与将来真实验证清单

**文件**：新增 `tests/integration/v4-capture-equivalence.test.ts`、`scripts/compare-v4-capture.mjs`、`docs/reviews/2026-09-15-v4-capture-experiment.md`；复用合法ABI和fake reader，不默认访问网络。

- [ ] 构造同一固定from/to和同一终点hash的fake链；provider按请求filter真实筛选fixture logs，不能mock为无论请求什么都返回同一数组。
- [ ] 两策略各自通过实际buildOperationFilterPlan→fetchBoundedLogs→recordRange，保留原始响应、manifest、计数。冻结链后对目标池日志按rawLogKey排序比较内容；同tx多个log不能合并成一条。
- [ ] 再用相同registry/metadata/coverage解释目标池事件，比较四窗口数值、quality reasons、信号提醒和撤回；仅“日志数量相等”不足以通过。
- [ ] 包含响应上限导致二分、恰好等于上限、单块仍超上限、429后恢复、预算耗尽、deadline、响应同key不同内容、终点hash变化、未知池、两个股票共池。
- [ ] 测试应断言不完整结果eligibleForLive=false且不能用于构造complete coverage。不要为了让实验通过删除原完整性测试。
- [ ] compare-v4-capture脚本参数 `--fixture <本地JSON> --out <不存在目录>`；只读取显式离线fixture，由A1/本测试生成并写明schemaVersion和bigint codec。拒绝http(s)输入、不读.env、不得含自动网络fallback。
- [ ] 输出两策略requests/response bytes/log keys差异、已知目标/未知池数量、decode/metrics差异、完整性状态；离线数量下降不换算成真实provider延迟改善。

运行：`pnpm exec vitest run tests/integration/v4-capture-equivalence.test.ts tests/integration/compact-batches.test.ts tests/integration/metrics-coverage.test.ts tests/integration/reorg.test.ts tests/integration/replay-export-integrity.test.ts`。

实验文档必须保留以下未执行清单，供原审查者以后安排，不在本次实施执行：

1. 固定同一已知小区间和终点hash；设置总请求预算及<=60秒墙钟上限，两模式共享预算而不是各自偷偷翻倍。
2. 使用现有meter/limiter/evidence写入，保存真实响应bytes、429、分裂次数、elapsed及目标日志差异；不要打印RPC URL。
3. 有未知池、截断或metadata不足时保留未验证状态；明确区分完整目标池结果与更广Manager宇宙覆盖。
4. 只有边界、等价和实际provider延迟都通过后，才讨论生产开关；当前仍用pool-ids。

本阶段报告R05为“离线候选已实现；真实provider验证及上线接线未执行”。不要写“85次请求已在线降至8次”之类没有实测的话。

## E3. 最终回归、规模验证与Review交接

**文件**：完善 `scripts/benchmark-live-performance.mjs`；新增 `tests/integration/live-performance-contract.test.ts`；完成 `docs/reviews/2026-09-15-live-performance-implementation.md`、`docs/reviews/2026-09-15-live-performance-acceptance.md`。所有产物写本次worktree的artifacts/performance，不读取运行库。

### E3.1 接通端到端规模脚本

- [ ] A1夹具写入临时SQLite，使用真实saveRaw/acceptRange/commitAcceptedSignalBatch、RegistryCache、metrics、metadata queue和dashboard coordinator；只mock网络边界。不能只benchmark纯buildRollingMetrics代替整条链。
- [ ] 初始化80k/160k注册及181分钟覆盖；活跃池固定400、股票194。目录用不同历史birth，元数据有已知/缺失混合；加入股票共池与同tx多swap。
- [ ] 初始化单独计时；预热3轮不计入20轮普通批次统计。普通样本固定14轮新事件、3轮仅watermark推进、3轮重复事件。随后额外执行新注册+首swap、metadata补齐、受影响历史修订各1轮，作为修复/依赖变更样本单列，不混入普通批次p95。
- [ ] iterations参数表示普通样本数，默认20；其他值按70%新增、剩余数量分为推进/重复（取整差额补新增）确定性分配，记录实际各类数量。额外3轮始终另列。
- [ ] 每个样本包括localProcessingMs、stageMs、WorkCounts、rawBatchBytes、poolRegistrationsBytes、manifestBytes、HTTP延迟/responseBytes、RSS。raw payload/manifest分开，不能隐藏全目录进“其他”字段。
- [ ] stage计时互斥或明确嵌套；localProcessing从RPC结果已齐到落库、派生状态、artifact完成为止，通知I/O和网络等待另列。后台metadata ready apply的CPU计入本地处理，网络不计入该指标。
- [ ] p95定义为升序samples[Math.ceil(0.95*n)-1]，同时输出全部原始samples和p50；不要取最快值。记录Node版本、CPU型号、是否并行有其他负载和git HEAD。
- [ ] 固定活跃规模下比80k/160k，另跑至少2k注册全部活跃压力样本；后者只报告随活跃量增长的成本，不要求恒定。不得为大样本省略coverage、计价、signals、JSON/artifact或数据库提交。
- [ ] 默认pool-ids filter构造和manifest仍随注册数量增长，这是R05未上线部分，必须实测并分项报告；不能为了本地目标隐藏这部分。若导致端到端比值/2秒目标失败，验收标未达标并指出占比。

### E3.2 最终命令（worktree内执行）

先对本次修改的源文件定向prettier；不要运行全仓format制造无关diff。随后：

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm lint
git diff --check
pnpm exec tsx scripts/benchmark-live-performance.mjs --pools 80000 --active 400 --iterations 20 --out artifacts/performance/80k
pnpm exec tsx scripts/benchmark-live-performance.mjs --pools 160000 --active 400 --iterations 20 --out artifacts/performance/160k
pnpm exec tsx scripts/benchmark-live-performance.mjs --pools 2000 --active 2000 --iterations 20 --out artifacts/performance/all-active
```

scripts下mjs在现有tsconfig.scripts.json/check-scripts检查范围内；TS类型用JSDoc，不在.mjs写TypeScript语法。tsx加载夹具时用能被该工具解析的相对导入，并通过上述实际命令验证，不能只让Vitest通过。输出目录已存在时选新后缀并记录，不覆盖原样本。

### E3.3 必须逐项填写的验收表

| 验收项 | 通过条件 | 证据 |
|---|---|---|
| 数值与状态 | 固定小样本逐批与旧实现/独立参考一致，明确列允许变化 | diff JSON与测试 |
| 限流恢复 | A3虚拟时钟<=45秒恢复，预算与defer不可绕过 | test输出 |
| 注册目录 | 预热后0变化批次全目录read/serialize均0 | 真实计数 |
| 新raw批次 | 只携带新池及本批引用池，无隐藏全量副本 | bytes及IDs |
| 事件估值 | 相同依赖重复事件实际valueSwap调用0 | counter |
| 信号工作量 | 仅热池/有状态/受影响池，空推进仍过期 | evaluatedPools+等价测试 |
| metadata | 当前需求优先、不扫描62k地址、慢请求不阻塞commit | queue/worker测试 |
| HTTP | warm summary GET p95<1秒、<1 MiB、核心计算计数0 | 请求样本 |
| 本地批次 | 普通样本p95<2秒；80k→160k固定活跃量耗时比<=1.5 | 两组报告 |
| 重启/失败 | rollback、reorg、metadata同tip修订、outbox重试正确 | 测试路径 |
| 旧库/格式 | readonly不迁移；inline/ref-v1/ref-v2与referenced可混合读 | 测试路径 |
| V4实验 | 离线有界等价/失败可见；真实provider与生产切换未执行 | E2报告 |

允许变化仅限：metadata先unpriced后更新；网页v2汇总/分页结构及loading文案；惩罚恢复速度；没有业务历史的冷池不预写watch行；更准确的工作量/计时日志。数值、已有提醒身份/去重、范围和coverage语义不在允许变化中。

性能门槛未达时：保存失败样本；用stageMs定位最慢阶段，在对应原任务内修正；不得提高门槛或关闭校验。若本轮无法达到，明确标该任务未完成并交回证据，不宣称全部完成。

### E3.4 交回Review

- [ ] 完成A1–E3状态、每阶段commit、新增迁移及旧库行为说明；保存小样本旧/新结果、benchmark原样本、测试命令/通过数/退出码。
- [ ] 列R01–R07定位到最终文件/函数；R05保留未上线状态；列所有计划偏离和具体原因。
- [ ] 在独立测试库测试新迁移可重复执行；不在运行库迁移。新派生表/journal/proof是附加结构，不删除旧事实。回滚方案先在副本验证：停用新构建并恢复旧构建读取原字段是否兼容；不要写“直接降级一定安全”，B3 cursor新格式尤其要验证/提供派生cursor重建步骤。
- [ ] 只stage明确本次文件，提交 `test: verify live performance and v4 capture experiment`；列git status中未提交内容，不merge、不push、不删分支。
- [ ] 生成一段给原审查者的交接：worktree/branch/base/head、5个commit、验收报告路径、未通过项目、未做线上动作。

完成后停止在功能分支，等待用户安排Review。
