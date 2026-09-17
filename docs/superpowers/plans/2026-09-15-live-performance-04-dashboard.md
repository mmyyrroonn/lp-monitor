# 04 网页读取与响应隔离 Implementation Plan

> **For agentic workers:** 按D1→D3执行。移动到worker之后仍须缩小计算输入；仅把原30秒全量计算搬到线程里不算完成。

**Goal:** GET不计算指标、不读取原始batch，汇总小于1 MiB；池详情真实后端分页，慢快照不再被统一显示为“数据库连接失败”。
**Architecture:** 只读worker持有一个DB连接和有界读模型；主HTTP线程持有已发布JSON汇总；细节由worker基于相同generation按需生成。
**Tech Stack:** node:worker_threads / 现有node:http及浏览器TypeScript；不添加前端框架。
**Spec:** `docs/superpowers/specs/2026-09-15-live-runtime-performance-design.md`。

## Global Constraints

继承Spec全部约束。依赖B2/B6/C1/C2；不依赖follow启用notify。保留现有布局、收藏、搜索、窗口选择、历史时点、双股票归属及本地same-origin限制。不把仪表盘连接改成可写库。

## D1. 汇总、历史图表和池分页分开

**文件**：修改 `src/dashboard/types.ts`、`src/dashboard/snapshot.ts`；新增 `src/dashboard/read-model.ts`、`tests/dashboard/read-model.test.ts`、`tests/dashboard/pool-page.test.ts`。旧buildDashboardSnapshot/readSnapshot保留作为明确legacy接口，默认新路径不调用它。

**新增JSON契约**：

```ts
export type DashboardTokenSummary = Omit<DashboardToken,'poolIds'|'pools'|'minutes'> & {
  poolCount:number;
  activePoolCount:Record<WindowName,number>;
};
export type DashboardSummary = Omit<DashboardSnapshot,'tokens'> & {
  apiVersion:2;
  generation:string|null;
  refreshing:boolean;
  tokens:DashboardTokenSummary[];
};
export type PoolPage = {
  generation:string; tokenAddress:string; window:WindowName;
  offset:number; limit:number; total:number;
  nextOffset:number|null; items:DashboardPool[];
};
export type TokenHistory = {
  generation:string; tokenAddress:string;
  minutes:TokenMinute[]; // 保留当前图表时间范围和gap/warming语义
};
```

- [ ] 保存原12池/双股票/同tx多swap/无池股票/零活跃股票/缺覆盖样本expected。新summary所有窗口和旧结果一致；activePoolCount精确等于原对应window txCount>0的池数；不以swapCount替代txCount。
- [ ] 建立每股票→登记池ID索引及poolCount，首次读取一次目录，后续B2增量更新；两股票共池两侧都入索引。不能每股票执行registrations.filter+poolIds.includes，也不能每批重新构造8万池Set。
- [ ] 股票汇总在完整有界热事件集上按原aggregate规则计算：每股票txHash去重，金额按既有归属。C2 partial report的rwa不得直接当全股票结果。
- [ ] 静默池仍贡献登记/覆盖状态，不能从股票结果消失。为每股票维护静默池覆盖组：早于当前可验证窗口的birth合并，窗口内birth保留精确边界，unknown birth单独组；按组计算是否存在gap/warming/no-registered-pools，不为每个静默池生成四套窗口对象。
- [ ] watermark移动使birth跨组时更新索引；用按birth排序的游标消费进入old组的池，不每次扫描全部。比较原aggregate的reasons/available，出生前不能合成0。初次分组O(P)允许记录，重复每轮不允许。
- [ ] summary不含poolIds、pools、minutes；历史图表在选择某股票时读取TokenHistory。分钟数组遵守当前图表范围/截止时间；不因减少summary字段而删除图表。
- [ ] poolPage默认limit=20，最大100；offset为非负安全整数，window为1m/5m/15m/1h。按该窗口交易数降序、poolId字典序稳定排序，冷池排在有效活跃池之后。具体null/0排序与原app排序核对并写测试，不能擅自更改未知状态展示。
- [ ] 只给当前页所需池调用窗口纯函数/构造DashboardPool；页序基于轻量ID索引+热池排序。禁止先生成所有池详情再slice。池多页包含所有登记池，不能只提供热池。
- [ ] 一次generation固定registry视图、projection/source、metadata版本、coverage、cutoff。页和history从该generation保存的有界输入生成，禁止查询当前DB后冒用旧generation标签。
- [ ] B2基础Map提交后会更新，不能直接把可变RegistryView引用当旧代快照。保留generation时给它建立小型undo overlay：新一轮目录delta发布前，把该代尚未记录的受影响pool旧值及成员关系存入overlay；old-generation读取先看overlay再看基础Map。分页旧成员用base索引与新增/删除修正集合合并，只构造所需ID页。没有目录变更时不复制目录；测试“旧代池删除/改token后，旧代详情仍一致”，避免仅测无注册变化的翻页。
- [ ] worker只保留最近2个generation，加最多4个历史时点的有界缓存；共享不可变基础目录，delta写时隔离，不为每代深拷贝8万注册。poolPage缓存最多64页，超过LRU淘汰；单页最多100对象。

```ts
expect(summary.apiVersion).toBe(2);
expect(summary.tokens[0]).not.toHaveProperty('pools');
expect(summary.tokens[0]).not.toHaveProperty('poolIds');
expect(Buffer.byteLength(JSON.stringify(summary),'utf8')).toBeLessThan(1024*1024);
expect(first.items).toHaveLength(20);
expect(new Set([...first.items,...second.items].map(p=>p.poolId)).size).toBe(40);
```

测试：目录80k/股票194/活跃400；窗口切换排序；offset超total返回空页；孤立池、共池；gap和unknown金额；新一代发布后旧代翻页仍一致；超过保留代返回明确过期错误，不混数据。

运行：`pnpm exec vitest run tests/dashboard/read-model.test.ts tests/dashboard/pool-page.test.ts tests/dashboard/snapshot.test.ts tests/dashboard/view-model.test.ts`。

## D2. 只读worker与SnapshotCoordinator

**文件**：新增 `src/dashboard/snapshot-worker.ts`、`src/dashboard/snapshot-coordinator.ts`、`tests/dashboard/snapshot-coordinator.test.ts`、`tests/dashboard/snapshot-worker.test.ts`；修改 `src/dashboard/cli.ts`、`src/dashboard/snapshot.ts`、`scripts/copy-build-assets.mjs`（仅在当前build复制列表确需追加时）。

**主线程接口**：

```ts
export interface SnapshotCoordinator {
  latest(at?:number):DashboardSummary; // 同步、内存读取、无计算
  refresh(at?:number):void; // 合并同一请求，立即返回
  pools(query:{generation:string;address:string;window:WindowName;
    offset:number;limit:number}):Promise<PoolPage>;
  history(query:{generation:string;address:string}):Promise<TokenHistory>;
  close():Promise<void>;
}
```

- [ ] RED：fake worker延迟30秒计算时，latest在一个事件循环轮次内返回empty或上一次summary；重复refresh只启动一个job。测试不实际睡30秒。
- [ ] worker入口使用 `new URL('./snapshot-worker.js',import.meta.url)` 对接构建产物；TS测试通过注入worker factory或现有tsx测试入口，不硬编码源码绝对路径。显式验证pnpm build产物能启动真实worker。
- [ ] worker内部只调用openDatabase(path,{readonly:true})；一次持有一个连接，close时释放。asset/config/metadata传可序列化配置或文件路径，在worker重建AssetRegistry；不能跨线程传class实例、Map状态或DB句柄。
- [ ] 默认每5秒检查轻量source revision和tip；无变化不重算。generation包含scope、registryScope、asset/config/seed版本、projection source、registry revision、metadata revision、选定cutoff；不能仅用tip高度或PRAGMA data_version作为业务版本。
- [ ] 新库使用B2和B6；旧库缺新表时只读兼容、连接内缓存严格检查结果。旧库初次慢可以显示warming，但不能执行迁移、后台project --rebuild或写proof。
- [ ] worker取数阶段在同一短read transaction内读取revision、tip、coverage、有界事件、所需观察和注册delta；随后关闭读事务再做纯CPU计算。保留不可变输入，不能在两次DB快照中拼一代结果。不要在计算期间长时间持有WAL读事务。
- [ ] 跨进程没有C1 eventDelta时，worker可按source变化重新读取有界事件并按rawLogKey/content diff索引；不读取全历史或全部live_observations，未改事件不重新估值。该成本按窗口事件量计入，不假称完全O(新增事件)。
- [ ] source存在live cursor但stale时维持既有freshness拒绝逻辑，不能回退更老offline cursor假装实时。follow未启用notify且投影不可用时显示真实状态，不在worker写投影。
- [ ] worker→main只发送已完成summary的JSON安全对象，不传所有pool详情。主线程收到完整结果后原子替换。refreshing=true时保留旧generatedAt/source时间，不把当前接收时间伪装数据新鲜。
- [ ] 首次尚未有summary：status='empty'、generation=null、refreshing=true、message='正在生成首个快照'。已有summary后worker错误/超时：status='stale'、原值保留，并附简短原因；真实无库/不兼容为error，禁止泄漏SQL/本地完整路径/配置值到页面。
- [ ] 最多一个计算job；refresh积压只保留最新live请求和一个显式历史请求，不建立无限队列。历史请求与live缓存分开，不能把live结果返回给选定at。
- [ ] 主线程正常刷新job看门狗10秒，首次初始化单列60秒上限：超时保留stale/empty结果，终止该worker、清理pending promises；最多每30秒自动重启一次，防止重启风暴。HTTP不等待这些时限。看门狗是故障恢复边界，不是性能验收目标；初始化成本单独报告。
- [ ] 明细请求并发上限8，超过返回可重试busy；同页请求合并。细节等待上限2秒，超时返回明确SNAPSHOT_BUSY而非无限挂起；CPU任务占用worker时主summary仍立即响应。
- [ ] SIGINT/SIGTERM关闭HTTP、coordinator和worker，移除timer/listener，终止未完成请求；保留当前CLI退出码规则。

只读测试用独立临时库：记录schema_version、total_changes和业务表行数；worker前后不变。SQLite只读访问可能生成/使用WAL/SHM侧文件，不能以“任何文件字节都不变”作为错误验收。另测写连接并发提交后generation更新且旧页保持一致。

运行：`pnpm exec vitest run tests/dashboard/snapshot-coordinator.test.ts tests/dashboard/snapshot-worker.test.ts tests/integration/projection-readonly.test.ts`。

## D3. 接线HTTP与现有网页

**文件**：修改 `src/dashboard/server.ts`、`src/dashboard/cli.ts`、`src/dashboard/web/app.ts`、`src/dashboard/web/view-model.ts`、`tests/dashboard/server.test.ts`、`tests/dashboard/view-model.test.ts`；新增 `tests/dashboard/api-v2.test.ts`。

**路由**：

```text
GET /api/snapshot[?at=<原有合法分钟末秒>]
GET /api/tokens/<address>/pools?generation=...&window=5m&offset=0&limit=20
GET /api/tokens/<address>/history?generation=...
```

snapshot默认返回DashboardSummary；legacy-snapshot显式模式继续旧格式，前端通过apiVersion区分。默认请求绝不调用旧buildDashboardSnapshot。server option以明确union区分v2 coordinator和legacy readSnapshot，避免同时传入时选错路径。

- [ ] /api/snapshot先refresh，再latest；没有新结果也立即返回200的empty/stale结构。HTTP GET过程中核心计数rawBatchDecodes/valuationComputes/evaluatedPools全为0。
- [ ] 原at校验（非负安全整数、%60===59、重复/未知query拒绝）保留。pools/history严格校验地址、generation长度<=128、window、offset/limit及重复/额外参数；错误400。
- [ ] generation不存在/被淘汰返回409 `{code:'SNAPSHOT_EXPIRED',error:'Snapshot expired'}`；任务繁忙/超时503 `{code:'SNAPSHOT_BUSY',error:'Snapshot is refreshing'}`；不可用503使用SNAPSHOT_UNAVAILABLE。禁止返回底层error.stack。
- [ ] localhost绑定、Host/Origin/remoteAddress、GET/HEAD限制、CSP/static白名单完全保留，新增路由也经过同一检查。
- [ ] 总览用poolCount和activePoolCount[windowName]替换poolIds.length及t.pools.filter；保持原搜索、排行、收藏和金额/时间格式。
- [ ] 选中股票才fetch history和第一页；“加载更多”取nextOffset，不先下载全池。切换股票/窗口/at时AbortController取消旧请求，响应generation/address不匹配当前选择则丢弃。
- [ ] 收到新summary后当前详情切换新generation并从第一页刷新；409只重取一次summary再第一页，避免递归重试风暴；503显示“详情更新中，可重试”并保留同代已有页。
- [ ] 将原统一数据库错误文案拆为：首次快照生成中、数据更新延迟、快照暂不可用；只有有明确DB打开失败诊断时显示数据库不可用。用户主流程不展示worker/SQL等实现术语。
- [ ] 测试200并发summary GET只访问内存、最多1个refresh任务；fake worker卡住期间请求p95<1秒，历史at不被live污染；翻页不重复遗漏，快速切换不串数据。
- [ ] pnpm build后在测试临时库上短时启动本次worktree的dashboard，仅127.0.0.1且自动选择空闲端口；实际GET snapshot/history/pools验证worker产物和路由。禁止连接运行库验证本计划。

运行：`pnpm exec vitest run tests/dashboard/api-v2.test.ts tests/dashboard/server.test.ts tests/dashboard/view-model.test.ts tests/dashboard/snapshot.test.ts`。

浏览器检查若现有工具可用，检查总览、选中股票、窗口切换、翻页、历史时点、stale文案；没有浏览器工具则在实施记录标为“视觉检查未执行”，不能用server单测代替声称页面已目测通过。

## 本子计划完成门槛

D1–D3测试通过；194股票80k池summary<1 MiB；warm GET p95<1秒且GET不做核心计算；真实构建worker可运行、退出无残留；只读和旧库兼容已验证。提交 `perf: publish dashboard summaries and paginate pool details`，继续05。
