# 2026-09-15 实时运行性能 Review

## 结论

当前实现存在可复现的性能缺陷。历史池目录扩大到约 8 万池后，实时采集、批次存储、元数据补全与网页快照都把全目录带进热路径。默认从最新区块开始已经生效，但这不等于本机处理只做增量。

网页本次复现为计算超时：只读数据库打开约 2.95 ms，GET /api/snapshot 超过 20 s 未返回；尚无 SQLITE_BUSY、数据库连接失败或配置不兼容的实测证据。不要据此建议重建或删除数据库。

范围：只读检查现有运行及代码，运行离线探针和已有测试；未修改业务代码、配置、运行数据库，未重启/停止用户的 follow 或 dashboard，未发起新的链上采集。

## 当前版本和运行

- Review HEAD：`6ed70d7`，分支 main。
- 运行 ID：`2026-09-15T08-41-05-341Z-8e23d43c`。
- follow 启动：2026-09-15 16:41:05 +08:00，`--env-file=.env dist/cli.js follow --config config/robinhood.json --db data/recorder.sqlite --duration 3h --notify local`。
- dashboard 启动：16:41:15，`dist/cli.js dashboard --db data/recorder.sqlite`。
- 两个进程配置计算出的 operation scope 一致。
- 证据：`artifacts/p1/2026-09-15T08-41-05-341Z-8e23d43c/requests.jsonl*`、该目录下 4 个 range JSON、`data/recorder.sqlite.health.json`、只读 SQL 和下述定向探针。运行文件会继续变化，以下均为本次读取时的样本。

## 实测摘要

| 项目 | 本次样本 |
|---|---|
| operation 目录 | V3 2,297 + V4 77,628 = 79,925 池 |
| 不同发现高度 | 75,815；以精确出生高度作为休眠池缓存键时共享空间有限 |
| 当前 run 已记录的活跃池 | 358；按 live_events 中 block_number >= 63,524,028 的池去重 |
| 上述池涉及 token | 218；token_metadata 表覆盖其中 2 个，表总计 87 个地址；合并195项seed后按地址覆盖58/218，仍有160个地址完全缺失；此计数未逐事件核验as-of高度 |
| 前 4 个批次 | 226 / 857 / 897 / 1,000 区块，178 / 773 / 842 / 772 条日志 |
| 每轮 getLogs | 85 个基础过滤分片；含重试为 85–87 次 |
| 每批完整证据 JSON | 139.7–141.3 MB（十进制） |
| 每批 poolRegistrations | 79,920–79,925 项；紧凑 JSON 约 110.2 MB |
| 每批实际 logs | 紧凑 JSON 约 0.16–0.75 MB |
| 健康侧写样本 | writeLatencyMs 34,716；processingLatencyMs 40,258；DB 2.55 GB；WAL 690.7 MB |
| headGap 样本 | 显示 56 块/6秒，但链头观测已老 144.7秒；不能当作当前实时落后量 |
| 网页打开数据库 | 2.95 ms |
| 网页 API | 20,003 ms 客户端超时 |
| 单独快照生成探针 | 30秒到期未完成；探针已停止并关闭连接 |
| 快照前段 | live projection 读取约 210 ms；events 2,516、observations 79,925；每次读取一份池目录约 0.56–0.64秒 |
| 4批覆盖核验 | 单独 acceptedMetricRanges 冷读约 7.18秒 |
| NVDA 池归属匹配 | 14,454 个 poolIds 对 79,925 个注册池，includes 13,747.5 ms；Set 56.1 ms；两者筛选数量一致 |
| 网页进程资源 | 一次采样 WorkingSet 3,438,718,976 bytes，累计 CPU 700.75秒；不能把单点采样当作峰值 |

探针直接使用当时的 dist 模块和只读运行数据库。includes / Set 是同一数据上的隔离操作比较，不是已修复网页的端到端测速。

## Findings（按修改优先级）

### R01 / P1：网页请求包含平方级池匹配，以及每次请求全量生成池明细

位置：[snapshot.ts:140](../../src/dashboard/snapshot.ts#L140)、[snapshot.ts:187](../../src/dashboard/snapshot.ts#L187)、[snapshot.ts:249](../../src/dashboard/snapshot.ts#L249)、[app.ts:575](../../src/dashboard/web/app.ts#L575)。

`registrations.filter(p => r.poolIds.includes(poolRegistrationId(p)))` 对每只股票遍历所有注册池，每次再线性查找该股票的池列表。仅 NVDA 这一步就实测 13.75秒。随后每个股票/池还计算多组窗口，首页响应包含全部约8万池的明细；前端只展示20条不降低后端计算量。

同时，普通实时 reader 每次请求新开数据库连接；coverage 缓存按连接保存，每次都丢失，4批覆盖核验冷读已达7.18秒。同步计算期间没有可供 HTTP 快速返回的已发布快照，20秒前端超时不会取消正在执行的同步计算。

修改：先建 poolId→registration、asset→poolIds 索引，去掉嵌套 includes；首页只读已生成的股票聚合快照，池详情独立接口按需分页。快照构建和 HTTP 服务解耦，使用短读事务，快照携带 source revision / watermark / coverage；失败或滞后时返回上次结果和明确状态。持久连接/缓存只能配合 revision 失效，不能把旧结果伪装成新数据。

### R02 / P1：限流惩罚被用作每次正常调用间隔，成功后恢复极慢

位置：[rate-limit.ts:17](../../src/rpc/rate-limit.ts#L17)、[rate-limit.ts:25](../../src/rpc/rate-limit.ts#L25)、[rate-limit.ts:44](../../src/rpc/rate-limit.ts#L44)。

每次限流使 penalty 翻倍，最高30秒；每3次成功仅减250毫秒，而每个后续请求都继续等待 penalty。08:51:14 → 08:51:37 → 08:52:00 UTC 的成功请求间隔约23秒，单次 RPC 响应只需约0.54–0.72秒。

对截至08:55:00 UTC的本次日志离线重放，惩罚仍为22秒。假设之后全部成功、请求持续排队，仅调度等待恢复到基础间隔约需264次成功、48.95分钟；这是调度模型计算，不是实际等待测量。离线调用真实 RateLimiter：连续6次 penalize 再 succeed 3次，penalty 仍29,750毫秒。

修改：区分一次性 cooldown 和稳态速率，尊重已知限流约束；连续成功或一段无429时间后按比例恢复，并限制全局慢速驻留时间。保留请求速率上限和重试次数上限。不能只把最大重试次数或并发调大。

### R03 / P1：每个实时批次重复携带、压缩和核验整份历史池目录

位置：[record-range.ts:286](../../src/ingest/record-range.ts#L286)、[record-range.ts:394](../../src/ingest/record-range.ts#L394)、[payload-store.ts:345](../../src/storage/payload-store.ts#L345)、[raw-store.ts:866](../../src/storage/raw-store.ts#L866)、[recorder.ts:1009](../../src/ops/recorder.ts#L1009)、[coverage.ts:165](../../src/metrics/coverage.ts#L165)。

`candidateRegistrations` 是已有目录和新发现池的合并结果，整个数组作为 `poolRegistrations` 放进每批。compact 存储把这个完整对象作为逻辑 payload 压缩；后续 accepted/coverage 路径又 readBatch 解压复原，原始 range 文件还额外写出约140 MB JSON。接受阶段还遍历所有 registrations 进行 rawId 查询和 insert-or-ignore。

实测第一批仅178条日志，却携带79,920个注册池；后续新增0–3个池仍继续复制约110 MB目录。压缩降低磁盘字节并没有消除序列化、解压、解析和全池遍历成本。近期 compact/readBatch 接入让原有全目录批次在更多热路径中产生代价。

修改：目录使用稳定的版本/哈希引用，批次只存新增及修订注册记录、事件和覆盖证明；已有目录只在首次加载/版本变化时读取。接受成功后保存可独立校验的小型 coverage certificate，普通窗口读取不要反复解压原始批次。保留旧 inline/ref-v1/ref-v2 reader，以及显式离线完整核验/导出；不可为了提速省略断档和重组验证。

### R04 / P1：metadata 队列按全目录补全，阻塞采集提交，优先级与当前交易无关

位置：[recorder.ts:1022](../../src/ops/recorder.ts#L1022)、[recorder.ts:1030](../../src/ops/recorder.ts#L1030)、[token-metadata.ts:119](../../src/storage/token-metadata.ts#L119)、[token-metadata.ts:146](../../src/storage/token-metadata.ts#L146)、[metadata.ts:31](../../src/metrics/metadata.ts#L31)。

`attempted:16,resolved:16,failed:0,deferred:62552` 表示本轮额度16个已用完，剩余62,552个目标等待，并不代表62,552次请求失败。目标来自所有已登记池；缓存缺失时顺序偏向历史目录，当前活跃池及RWA没有统一优先调度。`await refreshMetadata(targets)` 在 accepted batch 提交之前，额外18个或更多串行请求会延迟原始采集进度、投影和提醒。

每轮还遍历/排序全体目标；`decimalsAt` 每次线性过滤缓存 entries，缓存增长后会进一步放大全队列检查成本。

修改：USDG/观察名单RWA优先，其次当前新事件实际用到的代币和必要报价路径；后台有界队列承接历史补全。按 address→有序锚点做查找索引，保留失败退避与公平性。以事件所需高度作为 as-of 条件，不能用后来读到的 decimals 填回更早历史。元数据未知时事件正常落盘、估值显式 unpriced，补齐后只修复受影响估值。

### R05 / P1：V4实时请求数量与历史池总数线性增长

位置：[filter-plan.ts:193](../../src/ingest/filter-plan.ts#L193)、[record-range.ts:155](../../src/ingest/record-range.ts#L155)。

77,628个V4 poolId按每组1,000拆成78个分片，加V3地址3片和发现4片，每轮至少85次getLogs，并逐片await。即使只扫76个区块也使用同一套全目录分片。前4轮尚未持续限流时，getLogs阶段已约30秒；后续惩罚把这一结构放大到分钟。

修改方向：为V4评估按Manager+事件topic读取短范围协议日志，再通过常驻poolId索引本地筛选，使RPC分片主要受新区间实际日志量约束。必须先用有界实链样本验证该provider的总返回量、截断/分片、费用和语义等价；本次未发起该采样，不能承诺固定1次请求。V3保留地址分片或另做独立比较。不要仅停采不活跃池，否则会漏掉重新活跃。

## 最近改动的归因

- 最新 `6ed70d7` 是归档审计测试范围修正，无证据表明是本次运行卡顿来源。
- `0857a65` 修改未知provider错误重试和无后续重试时的 defer；现有指数限流 penalty / 线性恢复规则并未修复。
- `acfafeb` 调整 discoveryMaxRangeBlocks 与配置版本；本次 follow 从最新区块开始，不能把慢直接归因于正在重新扫描25万历史区块。
- 新 catalogue 的大规模历史目录暴露了原有 follow/dashboard/metadata 对小目录的假设；compact payload 与 coverage reader 的接入又增加了大对象读取成本。因此本Review包含新接入导致的规模回归及被其触发的存量设计缺陷，不把所有问题归咎于最后一个commit。

## 下一步实施顺序和验收建议

1. **止住网页超时与长期限速（R01/R02）**：索引匹配、首页聚合/详情分页、服务读取快照；重写并测试限流恢复曲线。网页不要依赖 live 批次运行完成才响应。
2. **真正拆出增量数据流（R03/R04）**：目录快照引用+注册增量、覆盖摘要、元数据后台按需队列；新事件只处理一次，修订时只修复受影响部分。
3. **降低V4 RPC分片（R05）**：先验证provider短范围manager日志行为，再实施可退回的过滤策略；与旧过滤结果逐条核对。
4. **补上规模验收**：使用至少8万历史池、约400活跃池、194股票、180分钟上下文；包含新增池、重复区块、reorg、retime、metadata补齐、断档、休眠再激活。历史增加到16万池时，固定活跃事件量的普通批次不得重新读写全目录或近似翻倍扫描。

建议性能目标（待实现后的实际测量验收，不是目前能力承诺）：首页已发布快照p95<1秒，冷启动可立即返回warming；正常批次本地处理p95<2秒；零新增注册批次的目录增量大小与历史池总数无关。限流测试使用虚拟时钟，明确cooldown上界和连续成功恢复时间，不能只验证“被429后确实变慢”。先做离线规模验收，再短时在线核对，不以两小时空跑替代定位。

同时增加可观测性：每阶段wall time、snapshot计算时间/年龄、registry count、active pool count、metadata active/historical queue、当前cooldown/有效RPS、最近接受时间和链头观测年龄。健康日志中的旧head gap不能解释成当前延迟。

## 验证与限制

执行：`pnpm exec vitest run tests/unit/rate-limit.test.ts tests/dashboard/snapshot.test.ts tests/dashboard/server.test.ts tests/integration/token-metadata.test.ts tests/integration/catalogue-follow.test.ts`。

结果：5个测试文件、25项测试全部通过，4.12秒。未运行整套测试、build、长时采集；没有业务代码改动。当前dashboard fixtures没有约8万池规模；rate-limit测试只检查429后降速；现有storage benchmark使用合成事件而非本次全目录真实热路径。这些绿测不构成性能验收。

本次未捕获实际SQLite锁异常、OOM退出或数据库损坏；不得把上述风险写成已发生事实。临时快照/coverage探针均已退出，不保留后台诊断任务。

## 补充：网页之外，每轮工作量的审查

用户追问：每轮工作量是否合理、哪里可优化。

结论：当前只有事件解码/受影响 observation 等局部已经增量；目录比较、目录证据、窗口组装、信号评估仍存在随总池数增长的全量循环。优化应先消除重复工作，再判断是否需要并发或新的进程架构。

### R06 / P1：增量投影和信号证据仍反复扫描整份目录

- `src/storage/live-projection.ts:82` 每次 source revision 变化后重新读取两个 scope 的 pools，并解析旧 registry_json。
- `src/storage/live-projection.ts:126` 对 prior/current 全部池逐项 encodeJson 比较；即使无新增注册，普通批次仍走这段逻辑。
- `src/storage/live-projection.ts:331` 每次再次 encodeJson(registrations) 存入 cursor。
- `src/signals/project.ts:255` 又读取两个 scope 的全部池，为每条记录重算 digest；后面比较和保存完整 evidence。
- `src/signals/project.ts:493` 对 report.windows 中全部池查询 signal snapshot 并调用 evaluateSignal。代码已有“状态变化才写快照、实质变化才写审计”的优化，因此不能描述成每轮无条件重写8万份信号快照；但全池读取与评估成本仍然存在。

修改：利用独立 registry revision、注册变更日志和已知 affectedPoolIds；无注册变化时复用目录对象与目录证据哈希。信号调度集合应包含新事件池、修订池、覆盖状态变化池、窗口贡献到期池，以及冷却/确认等定时条件到期池。没有交易也可能需要状态转换，不能简单只评估“本轮有交易”的池。

### R07 / P1：滑动窗口空池缓存使用精确出生高度，重复计算相同输出

`src/metrics/rolling.ts:199` 将 rawToken 和完整 discoveredAtBlock 作为空池缓存键；对窗口开始之前已经存在的池，出生高度常常不再影响任何覆盖判断，但不同高度仍使缓存分裂。相比之下，`src/metrics/windows.ts:178` 已有“早于所有覆盖区间的出生高度归一化”的实现，可以借鉴并验证滑动窗口的完整依赖范围。

纯离线合成探针：300个空池、每池不同但远早于窗口的出生高度、同一rawToken、181分钟完整覆盖、0事件。调用当前 dist 的 buildRollingMetrics；第二组仅将这些已证明不影响窗口语义的出生高度归一化为null。

| 指标 | 原始键 | 归一化键 |
|---|---:|---:|
| 耗时 | 296.50 ms | 2.58 ms |
| coverage.map 调用次数 | 66,603 | 524 |
| 完整输出深度比较 | 两组完全一致 | 两组完全一致 |

这是孤立子路径的合成结果，不是全系统提速倍数。真实目录有79,925池、75,815个发现高度，适用面值得优先验证。出生分钟、未覆盖历史、unknown-time、跨scope、不同rawToken等情况仍须保留不同状态。

后续进一步优化：持久化事件贡献与窗口状态，新事件加入、过期贡献移除；历史修订定向修复；避免每轮为所有池重建完整1m/5m历史数组。txCount需要按交易标识维护引用计数，不能直接把事件数量相加；跨池股票聚合继续保留交易去重和共享池归属语义。

### 一轮合理的主要成本

1. 固定范围的新链头/旧锚点校验，加有界重叠窗口。
2. 拉取新区间日志，发现新增池并覆盖同区间操作；稀疏时间锚点补齐必要时间证据。
3. 增量落盘：新日志、注册增量、覆盖证据和游标；原始证据先持久化的恢复语义应保留。
4. 新增/修订事件解码，更新受影响池和股票的贡献。
5. 按链上watermark过期窗口贡献，处理有事件/修订/到期条件的信号；元数据在独立有界队列补齐。

希望成本主要随“新增事件 + 注册变更 + 到期贡献 + 受影响状态”增长。历史总池数扩大，而当轮事件和变更不变时，正常批次不应复制全目录或近似同比增加本地计算成本。新池发现、重组检查、时间覆盖与缺失状态都仍需保留。

时间口径澄清：现有 writeLatencyMs = saveRaw耗时 + commitAcceptedSignalBatch总耗时，后者包含投影、指标和信号CPU计算；此前34.7秒不能全部归因于磁盘写入。processingLatencyMs与它有重叠，不能相加声称75秒处理耗时。应拆分 rawPersist、registryDelta、projection、valuation、rolling、signals、commit 等计时后再比较。

网页之外的优先顺序：R03/R06去全目录复制比较 → R07及信号按变更/到期调度 → R04元数据按需异步化 → R05有界验证采集过滤方式。R02限流恢复可以并行作为独立修复。现有前4批的数据量为178–842条日志，不能用这点新事件为重复处理8万池辩护。

本次补充仍未修改源码或运行配置，也未新增真实RPC请求。
