# 03 实时计算与元数据 Implementation Plan

> **For agentic workers:** 按C1→C5执行。先限制计算输入，再移动网络等待；不能用“只有新swap才更新”替代现有状态机。

**Goal:** 每批只处理新增/修订事件、有界窗口和有状态的池；metadata不再扫描历史目录或阻塞accepted commit。
**Architecture:** RegistryView + 事务安全事件索引 + 热池集合 + 原有纯指标/信号函数 + 单飞metadata后台任务。
**Tech Stack:** TypeScript / better-sqlite3 / 现有RPC reader及AsyncLocalStorage。
**Spec:** `docs/superpowers/specs/2026-09-15-live-runtime-performance-design.md`。

## Global Constraints

继承Spec全部约束，依赖01/02。013用于live workset，014用于metadata queue/revision；编号冲突按00处理。下面接口为新增契约，类型从现有domain/storage文件import，不复制定义。所有进程内可变缓存采用B2的prepare/publish/discard：只在最外层事务成功后发布。

## C1. 建立有界事件索引和热池集合

**文件**：新增 `src/storage/live-event-index.ts`、`src/storage/live-workset.ts`、`src/storage/migrations/013-live-workset.sql`、`tests/integration/live-event-index.test.ts`、`tests/integration/live-workset.test.ts`；修改 `src/storage/live-projection.ts`、`src/storage/database.ts`。

**接口**：

```ts
export type EventDelta = {
  upserts: readonly PoolEvent[];
  deletedKeys: readonly string[]; // rawLogKey，删除前取得
};
export interface LiveEventIndex {
  apply(delta: EventDelta): void;
  eventsFor(poolIds: ReadonlySet<string>): readonly PoolEvent[];
  poolsForToken(address: string): ReadonlySet<string>;
  expire(bounds: {sinceSec:number; sinceBlock:bigint|null}): ReadonlySet<string>;
}
export type WorksetInput = {
  changedPoolIds: ReadonlySet<string>;
  dependencyPoolIds: ReadonlySet<string>;
  watermarkSec: number;
  coverageChanged: boolean;
};
export interface LiveWorkset {
  select(input: WorksetInput): ReadonlySet<string>;
}
```

接口中的apply只作用于prepared临时视图，成功后发布。实现可导出工厂创建上述接口；不要把interface直接new。

- [ ] RED：插入一个swap、重复输入、时间修订、移除事件、reorg替换事件。维护rawLogKey→event、poolId→event keys、token→涉及池三种索引；同key修订先移除旧贡献再放新值。
- [ ] 扩展LiveProjectionChanges，增加 `eventDelta?:EventDelta` 和 `coverageChanged?:boolean`，保留原repairFrom/affectedPoolIds。sync在实际INSERT/UPDATE/DELETE位置收集变更，不再为了发现变化读所有live_events；同时包含旧事件关联池。
- [ ] 首次只加载既有live projection所需的有界窗口及有界unknown-time输入。保留read中“没有分钟边界时unknown不得无限扫描、必须标记windowContextIncomplete”规则。
- [ ] 保留至少现有historyMinutes及read使用的120秒边界余量；不得只留最近1小时，因为baseline/历史窗口仍需180分钟上下文。expire只清理派生内存/缓存，不删raw_logs或live_events历史事实。
- [ ] known-time过期按实际窗口输入边界处理；unknown-time只能在可验证sinceBlock之前退出。不知道时间也不知道块边界时保留contextIncomplete，不靠接收时间丢弃。
- [ ] 新表 `live_signal_workset(scope_id TEXT,pool_id TEXT,PRIMARY KEY(scope_id,pool_id))`只保存有持续信号记忆的池；状态由signal_snapshots事实恢复。C3负责同事务维护，不新增第二份signal snapshot。
- [ ] workset = 窗口内事件池 ∪ 有状态池 ∪ 本轮注册/事件变化池 ∪ 估值依赖变化池。watermark推进时保守重评整个workset，以保留每秒偏移的rolling baseline；不能遍历全部历史注册池。
- [ ] 事件最后过期的池本轮仍要评一次才能从热变冷。只有确认不再有窗口输入、持久信号记忆或本轮修订时，下一轮才移出。
- [ ] 进程重启一次性读取有界事件和live_signal_workset；旧库首次可扫描signal_snapshots生成workset，计为初始化。之后不可每批全表解码signal_snapshots判断热池。

测试至少包括：400热池+80k注册，空新批推进watermark仍更新热池；最后事件出窗后得到正确0/unknown并退出；冷池新增只进一次；no-boundary unknown；rollback；关闭重开后的候选/冷却状态一致。

运行：`pnpm exec vitest run tests/integration/live-event-index.test.ts tests/integration/live-workset.test.ts tests/integration/live-projection.test.ts tests/integration/live-faults.test.ts`。

## C2. metrics只生成所选池窗口，估值按依赖失效

**文件**：修改 `src/storage/metric-store.ts`、`src/storage/live-metric-cache.ts`、`src/storage/live-projection.ts`；新增 `src/metrics/valuation-index.ts`、`tests/integration/live-metric-workset.test.ts`、`tests/unit/valuation-index.test.ts`。

**输入扩展**：保留MetricBuildOptions旧入口；增加可选live context，旧离线调用不受影响。

```ts
// 放入MetricBuildOptions.live中；historyMinutes仍必填
poolIds?: ReadonlySet<string>;
registry?: RegistryView;
eventIndex?: LiveEventIndex;
// 输出新增：明确部分report，防止下游当作完整目录。
// selection: {kind:'all'} | {kind:'pools';poolIds:readonly string[]}
```

- [ ] 写小型全量参考report与选定池report对比测试。输出windows/annotations/valuations必须与全量report对这些池的结果一致，按值比较而非只看长度。
- [ ] 有poolIds时，不创建完整PoolRegistry、不raw.pools、不读取全部live_observations。新增read参数或readSelected方法，用scope+poolId索引查所选池观察状态；分组占位符不超过900，空集合不生成IN()或退化全表。
- [ ] 注册数据从RegistryView.get读取；不存在的池生成既有unknown/质量语义，不能自动造token/decimals。
- [ ] 报价输入不能只看selected池：通过registry.forAsset和已有报价规则补齐相关RWA/USDG报价池；事件索引选取这些依赖池的必要输入。报价最大年龄、同交易顺序、before/after约束沿用price.ts/notional.ts。
- [ ] 建立估值缓存键：rawLogKey + 事件内容revision + 使用的token metadata revision + 实际preceding quote身份/内容revision + 估值规则版本。不要每轮序列化整个metadata或全体quotes。
- [ ] 新增/修订报价可能改变旧事件的preceding quote。维护token→窗口内swap keys依赖索引；该token报价变化时保守检查其窗口内事件，不能只失效曾成功使用旧quote的事件（之前unpriced也需重算）。
- [ ] metadata补齐、anchor失效、token注册修订同样按token/池索引失效。只命中相同依赖的重复事件不得再次调用valueSwap；窗口移动不改变事件估值。报价保留范围必须覆盖原price规则允许的最大preceding年龄；必要时按token索引取窗口之前最后一个合法quote，不能因事件索引刚过期就丢失仍可用于估值的报价。
- [ ] 持久live_metric_cache保留用于恢复；新增内存命中层可避免反复JSON decode/hash。read-only reader仅使用内存层，不能构造会写库的cache分支。
- [ ] 调用现有buildRollingMetrics处理selected registrations和对应事件；保留四窗口、交易去重、全部reasons和rolling history。此处不重写统计公式。
- [ ] report.rwa必须显式遵守selection：partial report不可声称完整股票/全市场汇总。D1单独在完整热事件集上聚合股票，并用目录索引补足登记池数和无交易覆盖语义。

```ts
expect(selected.selection.kind).toBe('pools');
expect(selected.windows).toEqual(full.windows.filter(w=>ids.has(w.poolId)));
// 同一输入第二次计算
expect(counts.valuationComputes).toBe(0);
```

全量参考从改动前固定小样本保存expected JSON（使用现有bigint codec），或者测试中使用独立旧纯算法；不得调用选定池新路径自己生成expected。

运行：`pnpm exec vitest run tests/integration/live-metric-workset.test.ts tests/unit/valuation-index.test.ts tests/integration/live-metrics.test.ts tests/integration/live-metric-cache.test.ts tests/integration/metrics-repair.test.ts tests/integration/metrics-chain.test.ts`。

## C3. 信号只评workset，并保持事务、过期与撤回

**文件**：修改 `src/signals/project.ts`、`src/ops/recorder.ts`、`src/storage/live-workset.ts`；新增 `tests/integration/signal-workset-equivalence.test.ts`。通常不应修改 `src/signals/engine.ts`；如果必须改，只做适配并逐条解释数值不变。

- [ ] 先保存固定12池多批样本的旧输出：alert、revision、retraction、outbox、SignalSnapshot业务字段。包括watch→candidate→hot→cooling→watch、liquidity-watch和同批新池。
- [ ] projectSignals在同一accepted transaction内prepare注册/事件/workset，C2生成对应report，再按确定poolId顺序调用原evaluateSignal。
- [ ] 保留现有“仅snapshotChanged或新状态才写、审计只写有意义变化”的条件；不声称原代码每池每次必写。优化目标是少查、少评、少构造。
- [ ] 没有snapshot且从未活跃的冷池不预创建watch行。初次被选中时使用原initialSignalSnapshot。已存在的历史snapshot仍是事实，不为省空间删除。
- [ ] workset持久成员规则采用保守白名单：只要snapshot.state不是watch，或episodeId/lastAlertSec/lastHeatSec/candidateFingerprint/entryThreshold/lastAlertKind等记忆尚存在，就保留。只有与原始initialSignalSnapshot业务状态等价且窗口无事件才可移出；不能自行发明更短冷却期。
- [ ] 任何watermark推进都选择workset；没有新swap也应产生冷却/撤回/过期结果。链未推进不得用Date.now代替链时间推进窗口。
- [ ] 目录、coverage、metadata或报价在同watermark下修订必须打破source hash短路；依据affected pool进行修复。scope级unknown/gap可以保守影响全部热池/有提醒池，但不是全部历史静默池。
- [ ] 不合并或删去repairFrom、live_pending_signal_repairs、branchRecovery、retractSignals现有语义。历史/backfill批次提醒保持历史sink边界。
- [ ] accepted range、projection cursor、signal snapshot、outbox和workset变更在原最外层事务提交；任何中途throw全部rollback，prepared缓存discard；通知I/O只在提交后执行。
- [ ] 模拟进程关闭重开、失败后重试同batch：最终输出与连续运行等价，无重复live提醒；新缓存为空也不能跳过待冷却状态。

运行：`pnpm exec vitest run tests/integration/signal-workset-equivalence.test.ts tests/integration/alert-recorder.test.ts tests/integration/alert-recorder-review.test.ts tests/integration/alert-reorg.test.ts tests/integration/alert-new-pool.test.ts tests/integration/alert-outbox.test.ts tests/integration/rolling-replay.test.ts`。

## C4. metadata使用地址索引和需求队列

**文件**：新增 `src/metrics/metadata-index.ts`、`src/storage/metadata-queue.ts`、`src/storage/migrations/014-metadata-queue.sql`、`tests/unit/metadata-index.test.ts`、`tests/integration/metadata-queue.test.ts`；修改 `src/metrics/metadata.ts`、`src/storage/token-metadata.ts`、`src/storage/database.ts`。

**接口**：

```ts
export interface MetadataIndex {
  decimalsAt(address:string,block:bigint):number|null;
  revisionFor(address:string):string;
}
export type MetadataDemand={
  address:Address; blockNumber:bigint;
  priority:0|1|2; // 0当前缺估值；1报价依赖；2监控资产启动需求
};
export type MetadataLease={scopeId:string;leaseId:string;owner:string;
  expiresAtMs:number;demand:MetadataDemand};
export interface MetadataQueue {
  enqueue(scopeId:string,demands:readonly MetadataDemand[],nowMs:number):void;
  lease(scopeId:string,nowMs:number,owner:string):MetadataLease|null;
  stats(scopeId:string,nowMs:number):{
    eligible:number;retryWaiting:number;inflight:number;
  };
}
```

- [ ] MetadataIndex按lowercase address分组，每组按observedAtBlock升序；二分找到<=请求高度最后一项。原decimalsAt保留兼容，可通过WeakMap对不可变metadata对象复用索引；禁止缓存后原地改entries导致旧结果。
- [ ] 测试同地址多锚、先后顺序、请求早于最早锚返回null、hash失效、native地址不请求。与旧decimalsAt逐值一致。
- [ ] queue表键为(scope_id,address)，保存needed_block、priority、next_retry_ms、lease_id、lease_owner、lease_until_ms、updated_at_ms。索引(scope_id,priority,next_retry_ms)。同地址合并到最早仍待解决需求；不会因新一轮重复enqueue重置失败退避。
- [ ] 新增metadata revision及地址变更journal，监听token_metadata和invalid_anchors真实变化，供C2/D2低成本失效。invalid anchor要找到实际受影响地址；无变更不能每次全表哈希。seed文件版本独立加入revision key。
- [ ] 活跃需求来自accepted新增/修订事件所涉及token和实际quote依赖；初始194股票+USDG可以低优先级入队一次。不得遍历全部注册目录生成62,552项队列。
- [ ] 活跃需求的blockNumber取需要估值事件的链上高度；旧缓存锚晚于该高度仍需较早高度查询。不要用latest decimals反向填历史。
- [ ] lease每次只取一个token，过期时间30秒，owner为runId，leaseId为每次租赁独立UUID；结果必须匹配当前leaseId才能落库。未完成进程崩溃后可恢复。轮次只在单飞worker空闲时lease下一项，不会自己重复租赁正在处理的token。
- [ ] 有新更早需求在inflight期间到达时保留；旧结果仅完成它实际覆盖的需求，不按地址粗暴删除。作用域/分支失效后丢弃旧租约结果并重新排队。
- [ ] 原failures数据迁移为按需查询的退避输入，不全量复制未知历史地址到queue。普通失败沿用至少60秒退避；高优先级也不能绕过next_retry_ms。
- [ ] enqueue/lease/stats只访问少量需求和索引行；统计eligible包含真实当前需求，deferred改名/补充字段说明“等待队列”，不能继续把历史所有未知地址显示为本轮待办。

运行：`pnpm exec vitest run tests/unit/metadata-index.test.ts tests/integration/metadata-queue.test.ts tests/unit/metric-metadata.test.ts tests/integration/token-metadata.test.ts`。

## C5. 将metadata网络查询移出采集关键路径

**文件**：新增 `src/ops/metadata-worker.ts`、`tests/integration/metadata-worker.test.ts`；修改 `src/storage/token-metadata.ts`、`src/ops/recorder.ts`、`src/signals/project.ts`。复用 `src/rpc/request-meter.ts`，不另建RPC client。

**拆分函数**：将refreshTokenMetadata内的“锚前检查→eth_call→锚后检查”抽成纯网络lookup；将保存成功/失败抽成同步apply。原refreshTokenMetadata继续组合二者供兼容调用/旧测试使用。

```ts
export type MetadataLookupResult = {
  lease:MetadataLease; anchor:BlockAnchor|null;
  decimals:number|null; failure:string|null;
};
export interface MetadataWorker {
  kick():void; // 空闲才启动一个任务，立即返回
  prepareDrain():{
    results:readonly MetadataLookupResult[];
    ack():void; // 最外层提交成功后移除本次results
    rollback():void; // 保留results供下一次重试
  }; // 不等待网络，使用期间新完成结果保留在下一批
  fatalError():unknown|null;
  stop():Promise<void>;
}
```

- [ ] RED：fake eth_call悬而未决时，接受一批有swap数据仍可提交；当轮估值明确unpriced，不等待16个token查完。测试deadline使用fake clock，不能真的等30秒。
- [ ] 保留chain/provider身份验证及既有metadata anchor有效性检查，不将身份错误降级为可忽略。启动资产metadata获取改为入队后kick，不await全195个token。
- [ ] worker是同进程异步单飞任务，最多一个token网络序列；所有调用复用reader.meter.withPurpose('metadata',...)、共享provider limiter、请求预算、deadline和evidence flush。AsyncLocalStorage隔离purpose，不能用全局可变purpose字段。
- [ ] 在主循环安全点短事务lease后启动lookup；lookup不持有db transaction，不自行写token_metadata/queue结果。完成后只写内存ready buffer。
- [ ] 下一次accepted transaction前prepareDrain，事务内同步apply；校验租约、需求、当前分支/anchor，再更新metadata、revision、相关metrics/signals。最外层提交成功调用ack；失败调用rollback并保留结果，不能先从buffer永久删除。buffer条目用唯一结果ID，ack只移除本次快照，不移除处理期间新完成的结果。
- [ ] 没有新块时，也要在现有follow轮询安全点做短maintenance transaction，应用ready metadata并修复受影响池。保持相同链watermark，通知仍遵守原live/backfill及撤回规则；没有notify local时不得意外启用通知。
- [ ] kick只在采集请求队列空闲或既有poll间隙发起下一token；主采集有待发请求时暂停新metadata派发，已经inflight的允许完成。实现明确的canStart回调，不靠setInterval同时争抢大量请求。
- [ ] 普通合约失败更新queue退避；budget/deadline/reader-closed/evidence-write/ShutdownRequested沿用现有critical处理，传回主循环并终止/清理，不能当token失败吞掉；所有后台Promise必须有catch。
- [ ] shutdown先停止新lease/kick，再在现有总体drain deadline内等待已发请求，最后flush/close reader；不新增无限等待。未落库ready结果可丢弃但租约可恢复，不能声称resolved已持久化。
- [ ] 日志attempted在实际查询开始计数，resolved在成功持久化后计数；增加eligible/retryWaiting/inflight/activeMissing字段。输出数量与DB事实一致。

测试矩阵：慢metadata不拖accepted commit；两批同地址仅一次inflight；lookup中发生reorg；更早需求插队；DB提交失败后重试；无新块补齐；故意evidence-write失败可见；Ctrl+C/deadline关闭无未处理Promise；不通知模式不产生sink写入。

运行：`pnpm exec vitest run tests/integration/metadata-worker.test.ts tests/integration/token-metadata.test.ts tests/integration/shutdown.test.ts tests/integration/follow-latest.test.ts tests/integration/alert-recorder-review.test.ts tests/unit/recorder-deadline.test.ts`。

## 本子计划完成门槛

C1–C5逐项有RED/GREEN；12池多批逐字段等价；80k目录下evaluatedPools随热池/状态记忆量增长，重复事件valuationComputes=0，无逐轮完整metadata候选构造；pnpm typecheck通过。提交 `perf: bound live evaluation and schedule metadata outside batch commits`，继续04。
