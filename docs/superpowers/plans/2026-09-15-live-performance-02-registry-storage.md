# 02 注册目录与批次存储 Implementation Plan

> **For agentic workers:** 按B1→B6执行；禁止只把JSON变小却丢失事件解释或覆盖证据。

**Goal:** 普通批次不再复制、比较、保存8万池目录；保留旧格式和完整性语义。
**Architecture:** pools事实表+注册变更日志+事务外发布的进程索引；新批次只保留相关注册依赖；覆盖证明在接受时验证一次。
**Tech Stack:** TypeScript / SQLite / 现有payload codec。
**Spec:** `docs/superpowers/specs/2026-09-15-live-runtime-performance-design.md`。

## Global Constraints

继承Spec全部约束。依赖A1计数和A2计时。迁移编号在本系列预留：011注册变更、012覆盖证明；若实施时已有同号文件，按实际顺延并更新本系列所有引用，不覆盖旧迁移。

## B1. 持久化注册变更日志

**文件**：新增 `src/storage/migrations/011-registry-changes.sql`、`src/storage/registry-changes.ts`、`tests/integration/registry-changes.test.ts`；修改 `src/storage/database.ts`注册迁移。

**接口/存储**：

```sql
CREATE TABLE IF NOT EXISTS registry_changes(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 scope_id TEXT NOT NULL, pool_key TEXT NOT NULL,
 before_json TEXT, after_json TEXT
);
CREATE INDEX IF NOT EXISTS registry_changes_scope_seq
 ON registry_changes(scope_id,seq);
```

```ts
export type RegistryChange = {
  seq:number; scopeId:string; poolKey:string;
  before:import('../registry/pools.js').PoolRegistration|null;
  after:import('../registry/pools.js').PoolRegistration|null;
};
export function registryRevision(db:Database.Database,scopeId:string):number;
export function registryChangesAfter(db:Database.Database,
  scopeId:string,seq:number):RegistryChange[];
```

- [ ] 写INSERT/真实UPDATE/DELETE/rollback测试。现有pools表的scope_id/pool_key/payload_json是输入，不新增第二份当前目录事实表。
- [ ] 新增三个trigger：INSERT记null→new；DELETE记old→null；UPDATE只在key/scope/payload真变化时记old→new。scope或key变化时记旧scope删除+新scope插入。现有live_source_revisions触发器保留。
- [ ] `registryRevision`用索引查询该scope最大seq，无记录返回0。journal读取按seq排序，用现有注册revive/normalize规则恢复bigint。
- [ ] rollback后journal和revision结果均不变；INSERT OR IGNORE命中旧池不新增记录。
- [ ] 当前工作不做journal在线清理；不扫描或补写8万条既存记录到journal。消费者首次加载当前pools作为起点即可。

核心断言：

```ts
const before=registryRevision(db,'s');
expect(()=>db.transaction(()=>{insertPool();throw Error('rollback')})()).toThrow();
expect(registryRevision(db,'s')).toBe(before);
expect(registryChangesAfter(db,'s',before)).toEqual([]);
```

测试内insertPool定义为对pools插入合法fixture行，并不是待实现生产函数。运行：`pnpm exec vitest run tests/integration/registry-changes.test.ts tests/integration/raw-store.test.ts`。

## B2. 常驻RegistryView和事务overlay

**文件**：新增 `src/storage/registry-cache.ts`、`tests/integration/registry-cache.test.ts`；修改 `src/registry/pools.ts`，增加O(1) get和按变更更新方法；旧snapshot/preview/registerAll保持调用兼容。

**接口**：

```ts
export interface RegistryView {
  get(poolId:string):PoolRegistration|undefined;
  isDiscoveryRef(rawLogKey:string):boolean;
  getByV3Address(address:string):PoolRegistration|undefined;
  getByV4Id(manager:string,poolId:string):PoolRegistration|undefined;
  forAsset(address:string):Iterable<PoolRegistration>;
  all():Iterable<PoolRegistration>;
  readonly revisionKey:string;
}
export type PreparedRegistry = {
  view:RegistryView; changedPoolIds:ReadonlySet<string>;
  publish():void; discard():void;
};
export class RegistryCache {
  constructor(db:Database.Database,registryScopeId:string,operationScopeId:string);
  prepare():PreparedRegistry;
  invalidate():void;
}
```

- [ ] 第一次在同一SQLite读快照中加载两个scope目录+两个journal revision，合并规则复用PoolRegistry，建立byId、V3地址、V4(manager,id)、asset→poolIds索引；双股票池两侧都加入。
- [ ] 后续prepare只查询两个revision，变化时只读journal增量。不调用raw.pools、不对全Map排序或encodeJson。
- [ ] 未提交变化使用overlay Map和deleted Set；读取先查overlay再查基础Map。不要为了隔离事务执行`new Map(allPools)`。
- [ ] prepare产生的view可供当前同步事务内部使用；成功提交后publish仅应用delta；失败discard不改共享缓存。publish只能在db.inTransaction=false时运行。
- [ ] 跨连接更新由journal revision发现；同连接事务rollback不会留下“最新缓存”。Readonly旧库无journal时保留兼容全读，不DDL，并标记不具备新快路径。
- [ ] PoolRegistry.preview仍可供离线使用；实时新路径用overlay，不能每批preview全表。所有需要稳定排序的完整快照只在显式导出/初始化生成。

测试：80k初次允许读全目录，第二次无变化`registryRowsRead=0`；新增2池只读2条变化；删除、seed替换、跨scope冲突与旧PoolRegistry行为一致；rollback后view一致。

```ts
const first=cache.prepare(); first.publish();
resetWorkCounts();
const second=cache.prepare(); second.publish();
expect(counts.registryRowsRead).toBe(0);
expect(counts.registryRowsSerialized).toBe(0);
```

resetWorkCounts/counts由A1真实计数回调在测试中创建。运行：`pnpm exec vitest run tests/integration/registry-cache.test.ts tests/integration/live-projection.test.ts tests/integration/catalogue-follow.test.ts`。

## B3. 将投影与信号目录证据切到注册增量

**文件**：修改 `src/storage/live-projection.ts`、`src/state/project-range.ts`、`src/signals/project.ts`、`src/ops/recorder.ts`；新增 `tests/integration/live-registry-incremental.test.ts`。

- [ ] `LiveProjectionStore.sync`增加可选PreparedRegistry参数。用changedPoolIds比较旧/新注册；before记录来自journal，不再解析/比较全部旧目录。
- [ ] 现有registry_json列采用显式小引用格式；旧数组首次读取一次用于兼容初始化，随后写引用。不要仅因目录存储格式变化提高PROJECTION_VERSION并触发全历史重新解码。

```ts
type RegistryCursorV1={format:'registry-cursor-v1';revisionKey:string};
// registry_json只存这个小对象；完整数据保留在pools及journal中。
```

- [ ] 初次旧数组→新引用的本地一次性目录比较记录为initialization；后续新事件不得触发它。
- [ ] `readEvidence`不再每轮读取/哈希全目录；目录证据使用revisionKey和journal变化中的pool依赖。事件/时间/报价证据仍保留现有有界验证。
- [ ] repairedFrom的注册变化由journal.before/after及changedPoolIds推导；移除、seed→链上替换、同高度hash冲突必须撤回相关提醒，不能因为目录引用不同就每次全局撤回。
- [ ] LiveProjectionStore.sync当前传完整registry给projectRange，后者内部snapshot并为每个注册池建空observation，这个隐藏全量循环也必须消除。新增 `projectRangeSelected(batch,logs,times,registryView)` 适配入口在src/state/project-range.ts：从dirty logs的V3地址/V4 id及discovery ref索引选择小注册集合，再复用原解码逻辑；旧projectRange完整离线行为保留。registry索引新增 `isDiscoveryRef(rawLogKey:string):boolean`，由B2按注册增删维护，避免识别Factory日志时全表some。未知日志仍quality error，不能因选小集合误把合法discovery当未知池。
- [ ] recorder在最外层accepted transaction成功后publish；内部nested transaction不能提前publish。旧调用者不传参数时创建同样事务安全上下文，不能有一条入口仍全读而被测试漏过。

测试场景：0注册变化+新swap；2新池；删除一个热池；无关冷池新增；交易rollback；关闭重开进程。断言前者不全读、不全比较，后者结果与旧路径一致。

运行：`pnpm exec vitest run tests/integration/live-registry-incremental.test.ts tests/integration/projection-repair.test.ts tests/integration/alert-reorg.test.ts tests/integration/alert-recorder-review.test.ts`。

## B4. 缩小新批次的poolRegistrations

**文件**：修改 `src/storage/manifest.ts`、`src/ingest/record-range.ts`、`src/storage/payload-store.ts`、`src/storage/raw-store.ts`、`src/ops/recorder.ts`；新增 `tests/integration/batch-registry-dependencies.test.ts`。

**契约**：新增可选 `registryMode?: 'referenced-v1'`；未标记的旧批次保持旧解释。Referenced不是完整目录，不可据此删除未列池。

```ts
export function referencedRegistrations(
  logs:readonly RawLog[], staged:readonly PoolRegistration[], view:RegistryView
):readonly PoolRegistration[];
```

该函数放 `src/ingest/registry-dependencies.ts`。算法：Map先放staged；逐log用V3地址或已知V4 Manager+topics[1]找注册并放入；最后按poolRegistrationId排序小Map。只对受支持的协议事件做池识别；不把任意topic[1]当作PoolId。未知池原始log保留，注册数组不伪造。

- [ ] 写旧池首次swap、新池同块Initialize+Swap、两个股票共池、重复log、只有发现、全空批次测试。
- [ ] operations fetch仍覆盖完整常驻目录；取证与manifest校验维持全量实际响应。只是batch.poolRegistrations换成上述小集合。
- [ ] 新增src/ingest/operation-filter-index.ts及tests/unit/operation-filter-index.test.ts。OperationFilterIndex按registry revision、deployments、maxFilterValues及mode缓存无from/to的filter模板；无注册变化时复用排序后的V3地址/V4 poolId分片，每轮只生成新from/to包装，不调用全量snapshot/preview/flatMap/sort。注册变化只更新受影响的协议索引后重建其模板，计为目录变更成本。模板数组不可原地改动已交付batch；实际manifest仍完整保存请求参数，不能为了计数少而隐藏它的序列化成本。
OperationFilterIndex接口放在新文件中，供record-range长期持有；同一prepared registry的模板仅在提交成功后publish，失败discard。staged传本批discovery结果，先与registry.view建立局部overlay再规划operations，因此同块新池不会被漏采；无新发现传空数组。B4只实现pool-ids；E1再增加Manager分支：

```ts
export class OperationFilterIndex {
  constructor(contracts:ProtocolDeployments,maxFilterValues:number);
  prepare(registry:PreparedRegistry,staged:readonly PoolRegistration[]):{
    plan(fromBlock:bigint,toBlock:bigint):readonly PlannedFilter[];
    publish():void;
    discard():void;
  };
}
```

- [ ] saveRaw/acceptRange/范围JSON都传同一模式；batchBytes/canonicalBatch/transportJson及immutable比较必须一致包含新字段，不能第一次写新字段、接受时丢字段。
- [ ] raw-store仍保存小集合注册记录；旧发现rawId依赖不足时显式报错或补入已存在本地发现证据，不调用RPC偷偷补历史。
- [ ] 完整数组不得隐藏在另一个batch字段、日志对象或artifact附件里。原始RPC请求manifest仍可能按poolId数量增长，R05单独处理，计数分开报告。

```ts
expect(batch.registryMode).toBe('referenced-v1');
expect(batch.poolRegistrations!.map(poolRegistrationId).sort())
  .toEqual([newPoolId,oldActivePoolId].sort());
expect(batch.poolRegistrations).toHaveLength(2);
```

运行：`pnpm exec vitest run tests/unit/operation-filter-index.test.ts tests/integration/batch-registry-dependencies.test.ts tests/integration/compact-batches.test.ts tests/integration/raw-save-failure.test.ts tests/integration/recorder.test.ts`。

## B5. 审计离线消费者，保留旧格式与零活跃池

**文件**：检查并按需修改 `src/replay/export.ts`、`src/replay/reader.ts`、`src/replay/clock.ts`、`src/ops/history.ts`、`src/ops/history-job.ts`、`src/storage/payload-store.ts`；新增 `tests/integration/referenced-batch-replay.test.ts`。

- [ ] 执行 `rg -n 'poolRegistrations|readBatch\(' src`，把所有命中消费者列入实施记录，逐一注明数组是“事件依赖”还是“完整catalogue”。
- [ ] readBatch继续解码inline/ref-v1/ref-v2；只解释registryMode，不自动扩展为8万池数组。
- [ ] replay输出完整目录需求放在独立input snapshot/catalogue快照中一次输出，绑定assetVersion、registry scope和截止高度/来源；利用现有ReplayInputSnapshot接口，不为每批复制。
- [ ] snapshot包含没有swap的池。来源晚于研究时点时维持retrospective口径，不能声称as-of；不拿最新目录伪造历史已知范围。
- [ ] copied/exported bundle应在脱离源DB时重放：事件对应池可解释，静默池保留为完整覆盖下的0或缺覆盖的unknown。
- [ ] 旧raw批次不可变、损坏hash拒绝、ref缺对象拒绝、gzip上限和分块上限不变。新旧格式混合连续重放结果一致。

最少固定测试输入：旧inline一批、旧ref-v1一批、ref-v2一批、新referenced一批、独立目录含一个未交易池；删除源路径后重放，并和未迁移逻辑比较。

运行：`pnpm exec vitest run tests/integration/referenced-batch-replay.test.ts tests/integration/replay-export-evidence.test.ts tests/integration/replay-export-integrity.test.ts tests/integration/history-job-integrity.test.ts tests/integration/evidence-portability.test.ts tests/integration/payload-retention.test.ts`。

## B6. 接受时保存覆盖证明，读取时不解压旧批次

**文件**：新增 `src/storage/migrations/012-batch-coverage.sql`、`src/storage/batch-coverage.ts`、`tests/integration/batch-coverage-cache.test.ts`；修改 `src/storage/database.ts`、`src/storage/raw-store.ts`、`src/metrics/coverage.ts`、`src/replay/integrity.ts`（保留strict入口）。

**接口**：

```ts
export type BatchCoverageProof={
 version:1; batchId:string; scopeId:string;
 fromBlock:string; toBlock:string; manifestHash:string;
 payloadRefDigest:string; shardDigest:string;
 mutationEpoch:number; filters:readonly string[];
};
export class BatchCoverageStore {
 constructor(db:Database.Database);
 accept(batch:RecordedRangeBatch):void;
 read(batchId:string):BatchCoverageProof|null;
}
```

- [ ] 先写旧cache破坏样本：修改fetch_shards状态/计数、ingest_batches payload、payload_objects内容/删除、raw_logs内容/删除后，不能继续返回complete。
- [ ] proof表以batch_id主键，保存上述JSON和自身canonical digest；mutation epoch表只有一行。对payload_objects和raw_logs的真实内容UPDATE/DELETE递增epoch；同值UPDATE及正常INSERT不变，避免无效upsert每轮清空快路径。对ingest_batches/fetch_shards的UPDATE/DELETE令对应proof失效。触发器与数据修改同事务。
- [ ] `accept`仅在acceptRange同一事务内，调用现有verifySuccessfulShardCoverage及completePartitions通过之后保存；先保留旧验证函数，必要时把completePartitions导出为同义纯函数。绝不能只看batch.completeness字符串。
- [ ] proof读取比较当前batch scope/range/manifest hash、当前payload引用摘要、当前shard摘要、epoch及proof自身digest；不同返回null。仍与当前accepted_ranges交集组合，reorg截短不能借用原batch完整区间。
- [ ] readonly无proof表或缺proof时使用旧严格验证；可在同一reader生命周期缓存验证结果，但不能写库。当前新库首次预热旧批次时可在显式本地维护/初始化事务生成proof，记录冷启动成本，不偷偷扫描全历史。
- [ ] 原始证据strict审计仍重新解压并检验hash，不用proof替代。该证明优化正常SQLite逻辑更新路径；物理文件损坏由strict审计处理，不能宣传无需核验原文件。
- [ ] 预热后重复metrics读取`rawBatchDecodes=0`；变更后必须重验或unknown；其他scope/事务rollback不会错误复用。

```ts
const before=readMetricCoverage(db,scope,[],tip,180,true);
resetWorkCounts();
expect(readMetricCoverage(db,scope,[],tip,180,true)).toEqual(before);
expect(counts.rawBatchDecodes).toBe(0);
// SQL修改某shard为failed之后，对应区间不能complete。
```

运行：`pnpm exec vitest run tests/integration/batch-coverage-cache.test.ts tests/integration/metrics-coverage.test.ts tests/integration/metrics-repair.test.ts tests/integration/projection-readonly.test.ts tests/integration/replay-export-integrity.test.ts`。

## 本子计划完成门槛

B1–B6通过；80k零注册变更批次无全目录读取/比较/序列化；旧读法和完整离线目录均有回归；pnpm typecheck通过。提交 `perf: apply registry deltas and retain bounded batch dependencies`，继续03。
