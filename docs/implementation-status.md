# 实施状态与窗口交接

## 2026-09-12 实时增量修正与独立历史回顾

实时 `follow --notify local` 已改用持久化增量协议投影、逐事件估值和分钟/五分钟贡献缓存。普通批次只解码新增或修订事件，未变时间桶复用已有结果；实时计算保留规则所需有界窗口（默认180分钟，包含60分钟基线，另读最多120秒报价上下文），过期贡献退出热路径，原始证据保留。

重复日志不重复计数，链重组/retime/登记/覆盖修订通过脏记录修复并撤回受影响的 provisional 提醒。待撤回修订持久化，不因一次独立指标读取而丢失。缺少可证明时间窗口的边界时标 incomplete，不回退扫描全部未知时间历史。首次升级或协议投影版本变化允许一次迁移重建；后续正常批次不做全历史重建。

`history --from-block N --to-block M` 是独立历史回顾入口：本地完整证据优先，仅补缺失区间，使用隔离回顾数据库，不写实时通知。见[历史回顾说明](history-review.md)。`project --rebuild` 和 `replay/study` 保留为显式离线入口，历史输入覆盖不足仍如实报告。

本次 79 个文件 / 774 个离线测试通过（25.51 秒），typecheck、lint、build、diff check 通过，独立审查无剩余重要阻塞。[验收记录](reviews/2026-09-12-incremental-live-acceptance.md)。未启动真实 RPC 或长时实链验收；旧 P6 两小时验收状态不因此改变。

更新：2026-09-10。当前状态：**P0–P4 passed；P5 in_progress（Review修复检查通过；原生导出、长窗口性能与完整历史未完成）；P6 in_progress**。P6 最终冻结前 74 文件 / 740 测试及 typecheck、lint、build 均退出 0；30 分钟冒烟 passed，前两次长观察均保留为失败，21:35:48 启动的最终构建实测已按用户要求在约 56 分钟时停止，未完成完整两小时验收。下方旧记录保留为设计阶段历史证据；本轮完整验收与限制见文末。

历史优先级记录（2026-09-09；2026-09-12用户已明确追加独立历史回顾功能，以上方最新修正为准）：历史获取低优先级，已有能力/数据保留，缺失获取功能和专门研究回填暂缓。P5完整历史评估不阻塞P6；由用户安排后优先实时运行验证。阈值可来自用户额外分析，效果仍待验证。下方历史交接中的“先P5再P6”以本条及文末新记录为准。

此前13份Markdown的本地链接、代码围栏、计划头部顺序、占位符与行尾空白检查通过；并已按架构逐项核对P0–P6覆盖。批量查询补充后的文档检查另记于下方。文档验收不代表应用测试通过。

最后纳入的用户约束：只提供RPC、本机同步；成熟通用库优先；lp-terminal固定commit的只读模块可复用，其跳块状态刷新与第三方成交统计须改造。详细结论见 [lp-terminal评估](research/2026-09-08-lp-terminal-review.md)。

最新补充：允许连续多块批量查询，默认每2秒追全部新增块，积压时扩大范围并连续追赶。2026-09-08公共RPC的10块查询成功，完整P0能力验收仍pending；证据与块头成本限制见[批量查询](research/2026-09-08-batched-rpc.md)。

上一轮批量查询文档验证：14份Markdown检查通过。最新日志优先修订的验证见下方记录，应用测试仍未开始。

当前有效方案：[日志优先热度设计](research/2026-09-08-logs-first-heat.md)。已取消每块Header/parentHash账本、历史池状态初始化和LP收益模拟；默认2秒取logs，以少量端点及分钟边界计算热度。实时本分钟可随批次更新，历史minute-close评估剩余15/60/180分钟成交。

新增公开RPC证据：20块55条日志的blockTimestamp全部为0x0；抽样2个块的hash一致但时间值无效，已保存原始响应。下一窗口必须验证实际用户端点，并支持分钟时间索引；字段存在不等于时间能力通过。

本轮验证完成：15份Markdown的链接、围栏、计划头部、行尾空白、过时接口名与设计13节结构检查为0错误；时间证据55条及2个块头对照一致。Sol只读审查提出的scope水位、归桶端点、闭合条件、时间修订和恢复参数已纳入。src和根package.json仍不存在；本轮没有运行应用测试或启动监控。

| 阶段          | 状态                                        | 已验证证据                                                                               | 下一步                                          |
| ------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| P0 工程与能力 | passed                                      | P0 最终修正后 188 测试通过；历史 RPC 证据保留                                            | 沿用既有合同                                    |
| P1 记录与恢复 | passed                                      | 273 测试；5 个实时分钟边界；重启/旧段重扫退出 0；[验收](../artifacts/p1/acceptance.json) | 已完成；沿用 P1 合同                            |
| P2 协议与观测 | passed                                      | 344 测试；650 条真实历史事件 ethers 对照；[验收](../artifacts/p2/acceptance.json)        | 用户安排后进入 P3 Task 3.1                      |
| P3 分钟热度   | passed                                      | 453 测试；603 笔历史 Swap、29 闭合分钟；[验收](../artifacts/p3/acceptance.json)          | 用户安排 P4 Task 4.1                            |
| P4 告警       | passed                                      | 539测试；本机通知、修订撤回；[验收](reviews/2026-09-09-p4-acceptance.md)                 | 用户安排后优先P6；P5按需暂缓                    |
| P5 历史验证   | in_progress；部分能力待完成，历史incomplete | Review修复与实际检查见文末；36组结果保留                                                 | 原生导出/长窗口性能待完成；不新增采集，不阻塞P6 |
| P6 实时验收   | in_progress                                 | 740 测试；30 分钟实录通过；第二次长观察 687 样本 p95 2.841s                              | 实测已按用户要求停止，长时延迟门槛与成本汇总待完成 |

## 状态规则

允许 pending / in_progress / passed / blocked。passed 必须有本阶段具体命令、退出码、证据路径与限制；没有凭据、没有 archive 数据或未运行测试不能写成通过。

每个阶段结束在此追加一条记录：

```text
阶段与时间：
最终范围与修改文件：
执行的命令和结果：
真实链上证据与合成测试各自的路径：
仍不具备的能力及对功能的影响：
配置/ABI/依赖版本变更：
下一窗口的计划文件与起始任务：
```

当前目录没有 .git；本次没有提交。后续若建立版本控制，应先确认目录状态并保留已有研究与技能文件，不为完成某个提交步骤而重置或清理工作区。

## P0 验收记录 — 2026-09-08 14:13 北京时间

最终范围：P0 工程、环境配置、无损数据合同、官方 ABI/PoolId、只读 RPC 适配器、限流/计量、能力和身份核验、稀疏时间定位、真实 fixture。新增根 package/lockfile/TS/Vitest 配置、src、tests、scripts、config、README 与 artifacts/p0；原 research、tooling、.agents、.pnpm-store 保留。未实现 P1 记录器、业务热度或提醒。

### 命令与结果

| 命令                                                                                                                                         | 结果                                                  | 证据                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`                                                                                                                             | 退出 0                                                | [verification.json](../artifacts/p0/verification.json)                                                 |
| `pnpm test --reporter=json --outputFile=artifacts/p0/tests.json`                                                                             | 退出 0；13 suites、60 passed、0 failed、0 skipped     | [tests.json](../artifacts/p0/tests.json)                                                               |
| `pnpm build`                                                                                                                                 | 退出 0；构建后 `node dist/src/cli.js --help` 也退出 0 | 同上 verification；README 命令                                                                         |
| `pnpm lp probe --config config/robinhood.json --out artifacts/p0/capabilities.json`                                                          | 退出 0；必需能力及当前身份通过                        | [capabilities.json](../artifacts/p0/capabilities.json)、[身份](../artifacts/p0/identity-evidence.json) |
| `pnpm lp capture --config config/robinhood.json --last-blocks 300 --out artifacts/p0/raw`                                                    | 退出 0；类别及全部配置 V4 种子通过                    | [最终 manifest](../artifacts/p0/raw/2026-09-08T06-10-51-129Z/manifest.json)                            |
| `node node_modules/vitest/vitest.mjs run tests/integration/p0-fixtures.test.ts --reporter=json --outputFile=artifacts/p0/fixture-tests.json` | 退出 0；最终新增 fixture 的哈希及 ethers 独立解码通过 | [fixture-tests.json](../artifacts/p0/fixture-tests.json)                                               |
| `node scripts/p0-acceptance.mjs artifacts/p0/raw/2026-09-08T06-10-51-129Z/manifest.json`                                                     | 退出 0；全部门槛 true                                 | [acceptance.json](../artifacts/p0/acceptance.json)                                                     |

每个 probe/capture 的请求证据在相应时间戳目录内；报告只使用 `robinhood-public` alias。本机没有 RH_* 配置，因此本轮显式设置官方公共端点，不代表任何用户付费端点已验收。没有自动默认主网配置。

### 真实证据与用量

- chainId 4663；Factory、Manager、StateView 地址匹配官方部署清单；AMC 地址及 decimals=18 匹配官方当前资产表；USDG 链上 decimals=6。V3 池 factory/token0/token1/fee=3000/getPool 一致，StateView.poolManager 一致，代码哈希及验证 anchor 已保存。
- 10/20/100 块查询分别返回 21/44/200 条 Manager 日志；20 块完整查询与两个子区间并集一致。仅证明这些实际区间的 RPC 合同一致性，不推断供应商上限。
- 日志时间抽样两条：一条 zero、一条 valid；viem 保留字段。故不把字段普遍当作有效成交时间，P1 继续实现分钟边界索引。创世块 timestamp=0 的独立特例已测试。
- 最终 fixture：V3 Swap 1；V4 Swap 531、Initialize 3、ModifyLiquidity 27、Transfer 15。两个配置 V4 PoolId 均取得匹配的真实 Initialize，五字段哈希一致。Manager 范围含观察表外的池，数量不是 AMC 成交量。
- probe：34 方法调用、0 重试、688,992 响应体字节、峰值 4 RPC/s。capture：86 调用、3 重试、744,674 响应体字节、峰值 4 RPC/s；耗时约 83.69 秒，触发 429 后已降速。低于单次 150 调用及 5 RPC/s 软预算。
- 首次 capture 缺 V3 Swap/创世块时间处理失败、首次 probe 范围查询触发 429 的记录均保留。缺失与失败未填零、未改成合成真实样本；合成输入只在 tests/unit 内。

### 尚未具备的能力与后果

- Factory/Manager 的历史 code 查询未成功，**实际部署起点 unverified / null**；9070 仍仅是候选，不得当作已证实部署块。当前身份通过与历史部署证据明确分离；历史 state 不是本阶段门槛。
- `maxLogsPerResponse=null`；5000 是本地 guard。历史 logs/anchor 仅抽样与两个种子区间通过，P5 全历史覆盖尚未具备。WS/trace 未探测；历史 eth_call 未探测。
- GitHub commit API 返回 403，官方部署页面保留读取时点和 SHA256，commit 为 null；协议 ABI 自身来自固定 package version，未使用浮动 ABI。lp-terminal MIT notice 已保留，未复制其应用代码。
- 没有 Git 仓库，因此未提交，也无法执行通常的仓库 `git diff --check`；使用新文件范围的空白检查与文档本地链接检查。没有永久服务、钱包连接或交易。

### 版本与审查

Node v24.19.0、pnpm 11.19.0；生产 viem 2.56.3 / better-sqlite3 13.0.3 / zod 4.5.4。开发 TypeScript 7.0.2 / tsx 4.23.13 / Vitest 5.0.0；官方 v3-core 1.0.1 / v4-core 1.0.2 / v4-sdk 2.3.3 / sdk-core 7.19.2 / ethers 6.17.0。其余精确依赖见 package.json 和 lockfile；ABI/license/hash 见 [依赖证据](../artifacts/p0/dependency-evidence.json)。Vitest 有上游 SDK 缺 source-map 源文件提示，未影响测试；没有抑制这些提示。

[独立审查](p0-review.md)提出的四项问题均已修复并复查关闭；测试覆盖大区间缩分、时间查询后的分叉变化、可选部署预算预留和 V4 种子缺失。配置、ABI 哈希已绑定能力报告和最终 fixture。

### 下一窗口

读取 [P1 计划](superpowers/plans/2026-09-08-p1-recorder.md)，从 **Task 1.1** 开始。沿用 P0 ChainReader、原始日志合同、分钟 lower_bound、限流计量及官方 ABI；新增 SQLite 范围存储与恢复时保留 scope 隔离、同块发现、不跳块和重扫修正测试。不要把 P0 单次捕获当作已实现实时记录器；历史部署候选、时间质量与公共端点限制须继续显式处理。

## 版本控制补记 — 2026-09-08

P0 验收结束后，按用户明确要求初始化本地 Git 并提交 P0 工程、设计文档、验收报告及最终通过的 capture/probe 原始证据。前述无 Git、未提交是验收当时的历史状态。原 research、tooling、.agents、skills-lock.json 与依赖缓存未纳入本次提交；早期失败实测的大体积原始日志保留在本地。P1 尚未开始，未推送远端。

## P0 review 修正 — 2026-09-08

用户确认先修完 CC review 再进入 P1。本轮已处理所有确认的问题，并记录 B6 类型版本、H6 并发原判断等不成立或需要限定的意见，见 [逐项处理记录](reviews/2026-09-08-p0-review-resolution.md)。

最终本地验证：149 个测试通过、0 失败，lint（脚本语法与格式）/typecheck（含 scripts）/build/git diff --check 均退出 0，见 [新验证汇总](../artifacts/p0/review-validation.json)。生产入口为 dist/cli.js；CI 已配置，未推送、未执行远端 CI。开发依赖新增 Prettier 3.9.6，其余锁定主版本保持。

验证使用本地 HTTP 模拟及归档真实 fixtures，包含跨目录离线验收；本轮没有重新调用公共 RPC。8 个已跟踪 raw/request 原始证据字节保持不变，历史元数据相对路径迁移有前后哈希记录。原 P0 单次实链验收仍作为历史证据，不代表 P1 长期运行或多分钟实链归桶通过。

P1 尚未开始：下一步按 docs/superpowers/plans/2026-09-08-p1-recorder.md Task 1.1 建 SQLite store。已有 ingest/fetch-range、registry/identity、双向 codec 和共享时间解析可复用；仍需实现持久化分钟索引、follow 调度、重扫恢复，实链验收显式跨至少 3–5 个分钟边界。

## P0 复验遗留修正 — 2026-09-08

本轮依据 CC 的修复验收，完成 R1–R9 和其他小项，详见 [复验处理记录](reviews/2026-09-08-p0-review-acceptance-resolution.md)。修复 RPC/证据/关闭异常优先级、anchor 增量去重、可信提示界限，删除恒空接口，补完整 CLI 成功路径、429 恢复、V3 负值等测试。上一轮负值覆盖陈述已明确更正。

本轮 18 文件、188 测试通过，lint/typecheck/build/历史审计/diff 检查均退出 0；当前结果绑定源码 SHA256 快照，见 [验证记录](../artifacts/p0/acceptance-followup-validation.json)。历史归档审计另立入口并明确不验证当前源码，不覆盖原验收。配置版本升为 2026-09-08.p0-review2，为两枚 seed 加入归档真实相邻块提示；每次运行仍强制 RPC 验证这些界限。无新依赖，无本轮公共 RPC 采集。

P1 未开始，仍从 Task 1.1 开始；未实现 store/follow/恢复，未执行远端 CI。

## P1 验收记录 — 2026-09-08

最终范围：SQLite 范围/有效集合、同块动态发现、分钟边界、重扫恢复、ingest/follow CLI 与预算/证据。273 个测试通过，typecheck/test/build/lint 退出 0；源码与构建 hash 绑定见 [验收汇总](../artifacts/p1/acceptance.json)。详细命令、失败历史、用量与限制见 [P1 报告](reviews/2026-09-08-p1-acceptance.md)。

真实录制与重启：五分钟运行跨 5 个当时分钟边界；最终累计 650 条操作日志、30 个边界，全部操作日志的原始时间为 0x0，分钟已归桶、精确秒数保持 null。最终构建同 DB 重启退出 0，旧 100 块显式重扫退出 0且 added/removed/retimed 均为 0。首轮 max topics 失败和第二轮期限末段 incomplete 均保留；未误推进失败范围。P0 原证据未改。

无新依赖，增加默认 maxFilterValues=1000 及 P1 专用预算/恢复配置；生产部署起点仍未验证，日志上限仍为 null，结果依赖 RPC 一致性且为 provisional。P2–P6 未开始；未启动永久服务、连接钱包或交易。当前改动在 feat/p1-recorder，尚未提交或推送。下一窗口经用户安排后读 P2 计划，从 Task 2.1 开始。

## P1 第二轮 recorder 审查修正 — 2026-09-08

修复 manifest 最终落盘失败分类、bootstrap hash 大小写比较、getLogs 接收对象及 rawLogKey 复用。新增 8 个回归用例，当前全库 281 测试通过；typecheck/build/lint 均通过。详见 [处理与验证记录](reviews/2026-09-08-p1-recorder-review-resolution.md)。原实链验收保留，本轮没有新 RPC 采集；临时运行输出不纳入 Git。

## P2 验收记录 — 2026-09-08

最终范围：V3/V4 官方 ABI 业务解码、最近 Swap/流动性动作观测、SQLite 投影与原子游标、离线 project/inspect-pool。基线 e8e3b9f，当前 feat/p2-protocol-state；改动未提交、未推送。

验证命令与结果：typecheck/test/build/lint 全部退出 0，32 文件、344 测试通过、0 失败/跳过；git diff --check 退出 0。具体命令、源码及构建哈希见 [验收汇总](../artifacts/p2/acceptance.json)；范围、数据与限制见 [P2 报告](reviews/2026-09-08-p2-acceptance.md)。[独立审查](reviews/2026-09-08-p2-review.md)通过，AMC 别名与 V4 跨 scope 回归已关闭。

真实证据：只读备份 P1 录制库到 data/p2-acceptance.sqlite 后投影，650 条有效日志生成 650 事件（V4 Swap 556、V3 Swap 47、V4 L 动作 37、V3 Burn 5、Collect 5），ethers 对照一致、质量错误 0。29 个池有实际观测；1827 是登记数。全部沿用分钟归桶，精确秒数仍 null；没有新增 RPC 调用，源 P1 表及 P0 固定归档未变。P0 广域归档中的一条零侧 V4 Swap 保留为 invalid-direction，其余缺失历史登记用合成 metadata 的测试有明确标注。

能力边界：显式全 scope 离线重建，未挂入每个 recorder 批次；时间或有效集合变化后必须重建，过期 inspect 返回 4。没有当前完整 AMM 状态、分钟排名、告警或 LP 收益。本轮无依赖/ABI/配置版本变更，没有永久服务或交易。

下一窗口：用户安排后读取 docs/superpowers/plans/2026-09-08-p3-metrics.md，从 **Task 3.1** 开始。P3–P6 保持 pending。

## P2 复核修复 — 2026-09-08

原 P2 验收中的“改动未提交”是当时时点，后已提交为 `ffc8b54`。本批基于 `484079c`，在 `fix/p2-review` 完成 F1–F6，并处理多数建议项，详见 [逐项修复与验证记录](reviews/2026-09-08-p2-review-fixes.md#修复记录)。

投影版本升至 p2-v2，旧投影须显式 project --rebuild。零侧 Swap 保留为 swap-nontrade，原始后状态无损且不替换 lastSwap；非零同号仍为质量错误。inspect 使用真实只读连接，并分列池级与 scope 级错误；空 accepted scope 返回可操作的状态和退出码 4。

最终 34 文件、401 测试通过，typecheck/build/lint/diff 检查通过，独立复核无开放问题。原 P2 验收库经只读 online backup 后在临时副本重放，仍为 650 事件、0 质量错误、29 个有观测池；分钟已知、精确秒数仍 null。源库与副本的 P1 表未改，历史 artifacts 未改，无新增 RPC。

P3 查询改造、稀疏观测、自动版本门槛和 V3 fee 来源建模继续待办。P3 尚未开始；本批不推送远端。

## P3 验收记录 — 2026-09-09

最终范围：分钟计价、池/RWA 聚合、分钟闭合、基线/排名、流动性/毛费附注、离线 metrics/rank CLI 与派生 SQLite 缓存。新增 src/metrics、metric-store、metrics-cli、003-metrics 迁移、历史 decimals 缓存及专项测试；更新 README、START_HERE 和阶段计划。P4–P6 尚未开始。

命令结果：`pnpm lint`、`pnpm typecheck`、`pnpm test --reporter=json --outputFile=artifacts/p3/tests.json`、`pnpm build` 均退出0；453个测试通过、0失败、0跳过。[逐项退出码](../artifacts/p3/verification.json)、[测试结果](../artifacts/p3/tests.json)。本轮开始前实际基线为401个测试；P2原344时点记录保留。

真实历史验证：`node artifacts/p3/verify-acceptance.mjs` 退出0；从P2验收库备份到 `data/p3-acceptance.sqlite`，逐表确认源P1内容不变。650个事件中603笔Swap、313个不同交易、34笔未计价，1827个登记池全部保留，其中29个有Swap/流动性动作；29个闭合分钟、当前分钟partial。两条构建后CLI命令退出0。没有新RPC；[源库保护](../artifacts/p3/source-db.json)、[热度](../artifacts/p3/amc-heat.json)、[覆盖](../artifacts/p3/coverage.json)、[排名](../artifacts/p3/rank.json)。

独立审查发现的分片短扫、原币静默基线、零事件池、L观测锚点、筛选证据、metadata哈希及RWA当前前缀问题均已修复并回归；[最终审查PASS](reviews/2026-09-09-p3-review.md)、[完整验收与限制](reviews/2026-09-09-p3-acceptance.md)。

无依赖/ABI/原链配置版本变更。新增 metric version=p3-v1、metadata version=2026-09-08.p3-metadata1。金额保持bigint，默认基线需要60个完整1m或12个完整5m，现有约半小时样本不足，倍率为null。decimals是带历史锚点的沿用缓存，遇到已知同高度哈希冲突即停用；USDG兑美元仅显示假设。

默认只读CLI，显式 `--save` 保存派生缓存；录制/重扫/retime后仍需先project，P3不是持续后台服务。窗口分钟证据最多取末端180分钟；完整读取、分片复核和缓存重建随历史增长。原研究与技能保留。未交易、连接钱包、启动永久服务、提交或推送。

下一窗口读取 `docs/superpowers/plans/2026-09-08-p4-alerts.md` 从Task4.1开始；从新鲜P3业务结果实现提醒、冷却、修订/撤回，禁止直接消费旧缓存。由用户安排。

## P4 验收记录 — 2026-09-09

状态：**passed**，仅完成P4。基线main的0c2e2e1、477个测试；当前codex/p4-alerts，未提交或推送。

最终交付：本分钟候选、两条独立自然5m确认规则、300秒同级冷却、同口径翻倍升级、降温和再热；持久快照、稳定id/revision、事务outbox及修订撤回；follow --notify local、本机JSONL与人可读控制台。默认follow只记录。新池出生分钟可使用已观测partial量，闭合出生分钟和出生前历史仍不补零；metric version升至p3-v3以绑定这一适配，其余依赖/ABI/链配置未变。

验证：539个测试通过，0失败/跳过；pnpm lint/typecheck/build、全库test、node artifacts/p4/verify-acceptance.mjs、git diff --check均退出0。[命令记录](../artifacts/p4/verification.json)、[测试结果](../artifacts/p4/tests.json)、[验收报告](reviews/2026-09-09-p4-acceptance.md)、[独立审查PASS](reviews/2026-09-09-p4-review.md)。

历史：只读online backup复制P3验收库到data/p4-acceptance.sqlite，逐表核对P1记录及源库不变。1827登记池、603 Swap、34未计价、29闭合分钟，本轮历史提醒0；没有新增RPC。[原库保护](../artifacts/p4/source-db.json)、[历史报告](../artifacts/p4/historical-alerts.json)。合成序列展示候选、确认、10秒冷却内升级、降温、再热与撤回；liquidity-watch只有明确标注的格式示例。[JSONL](../artifacts/p4/alerts.jsonl)、[可读示例](../artifacts/p4/rendered.txt)。

审查修复已覆盖：独立升级不再被初次确认条件屏蔽；历史缺口修复与当前前缀变缺口会重检旧提醒；含来源provenance的重复决策不新建修订；异步投递期间被替代的记录不会复活；登记重扫失败/无下一批时仍投递已提交撤回。范围/P2/P3/信号事务一致性、重启及分叉均有离线回归。

限制：提醒仍为provisional，修订采取保守证据失效撤回并重评当前条件，未实现P5完整历史策略重演。JSONL写后sent前崩溃可能重复id/revision；普通backfill/synthetic不进live sink。全scope每批重建仍有处理开销，2秒仅是轮询配置；未做P6实链持续运行或延迟验收，无交易/钱包/永久服务。

P4完成后停止。P5/P6保持pending；下一窗口由用户明确安排后再按P5计划Task5.1继续。

## 历史功能优先级调整 — 2026-09-09

用户确认：历史数据获取的重要性较低，已有功能保留，没有的先不增加。本条取代此前先完成P5再进入P6的交接顺序；P5保持pending，不因暂缓而标passed。

执行范围：不新增历史采集能力、不为研究专门补齐固定案例或完整出生队列；已有历史与实时录制数据保留，后续按需评估。优先实时采集、热度统计和本机提醒稳定性，用户明确安排后可直接进入P6 Task6.1。实时启动、发现、重组恢复及数据完整性所需的既有扫描不取消。P5 replay尚未实现时，P6保留实录manifest并将回放对照列为暂缓项，不虚报通过。

阈值可由用户额外分析提供，需明确适用池、单位、时间窗口、条件和来源；作为候选规则使用，未独立验证的效果继续标未知。P6运行验收与阈值效果评估分开。

本次仅同步入口、README、架构口径和P5/P6计划；未改代码或阈值配置，未启动采集、回放或下一阶段。

## P5 独立 Review 修复记录 — 2026-09-10

范围：离线 replay、出生队列与 15/60/180 分钟结局、36 组阈值比较。前轮 623 项测试通过未发现独立 Review 中的 C1/I1–I4 等问题，原有“P5 通过”结论已撤回。

本轮修复：缺口异常返回 incomplete、告警身份去重与 revision、原生产物交叉校验、发现与操作分钟完整性、单根确认 reason、逐池 historyComplete、时间区间外统计排除和预热状态保留。删除伪分块读取参数，并修正文档口径；具体见 [更新验收](reviews/2026-09-10-p5-acceptance.md)。

实际命令：typecheck、lint、全套 649 测试、build 均 exit 0；构建后 5 项 CLI 检查通过。默认 study exit 4：7 个案例 unavailable、4 份原生 manifest 无评估帧、36 组参数未产生告警/结局窗口/首告警比较记录，非空路径仅有合成 fixture 证据。[机器验收](../artifacts/p5/acceptance.json)、[测试结果](../artifacts/p5/tests.json)、[研究报告](../artifacts/p5/report.md)。

P5 仍有未完成能力：原生 P1 未保存 replay.input，且没有从库和运行摘要生成快照的导出入口；1M/500k 事后标签尚未实现；minute-close 尚未增量化。本机 480 分钟单池单日志/分钟样本耗时 80347 ms，未验证多天完整队列性能；[性能基准](../artifacts/p5/benchmark.json)。对应计划复选框已退回，不再以代码检查通过代替整阶段通过。

默认实时信号配置、链配置、ABI、依赖与 lockfile 未改。无新 RPC、交易、通知、部署或 P6；保留此前六份文档修改，验收时位于 codex/p5-history，尚未提交；后续提交合并状态以 Git 记录为准。下一阶段仍由用户安排；P5 完整历史评估不是 P6 前置。

## P6 中期实施记录 — 2026-09-10

当前为工程检查与冒烟通过、最终构建实测按用户要求停止；不是 P6 最终通过记录。运行配置、RPC 预算/计量、状态/延迟报告、协作式停止恢复、SQLite 备份、本机通知、离线故障与验收绑定已实现。主要代码在 `src/rpc/{client,rate-limit,request-meter}.ts`、`src/ingest/follow.ts`、`src/ops/{recorder,runtime-telemetry,report,status,shutdown}.ts`、`src/metrics/coverage.ts` 和 `src/storage/raw-store.ts`；配置与操作入口见[运行手册](runbook.md)。

当前验证：最终冻结前全套 74 文件 / 740 测试、typecheck、lint、build 均退出 0；离线结果保存于 `artifacts/p6/offline-verification.json`。独立复审及逐项处理见[原始复审](reviews/2026-09-10-p6-independent-review.md)和[处理记录](reviews/2026-09-10-p6-review-response.md)。离线覆盖包含真实 transport 预算、30 秒断线/429/损坏响应、范围完整性、重组、raw 后停止恢复、通知失败恢复及验收报告与数据库绑定。证据见 [offline-verification.json](../artifacts/p6/offline-verification.json) 和 [tests.json](../artifacts/p6/tests.json)；fixture 通过不等于对应实链事件已发生。

30 分钟冒烟运行 1,832,495 ms，通过；177 个完整证据到 outbox 样本的 p95 为 1,592 ms。两个未接受尝试由当前已验证 accepted coverage 对整个失败区间的无缺口覆盖解释，失败记录与计数未删除。见 [smoke-report.json](../artifacts/p6/smoke-report.json)、[构建指纹](../artifacts/p6/smoke-code.json)和[资源采样](../artifacts/p6/smoke-resources.jsonl)。固定链头 10/20/100 块比较已完成，但均为空日志，只证明该次范围/成本结果，不能外推活跃负载吞吐。

首次 2 小时尝试运行 1,144,254 ms 后退出 1，未通过。对复制数据库和 6 条真实返回日志的回归复现了同一 raw identity 的 `rawBlockTimestamp` 非零值变为 `0x0` 导致原始 payload 冲突。修复仅从规范重复比较中排除这个不可信 RPC 附注，保留首个 raw 行及每个批次的精确原始附注；规范字段变化仍失败。另将 discovery/operations 原始保存异常分类为脱敏的 `raw-save`，保持退出 1、无假 RPC 重试及清理边界。见[失败报告](../artifacts/p6/soak-failed-1-report.json)、[失败构建指纹](../artifacts/p6/soak-failed-1-code.json)、[失败资源记录](../artifacts/p6/soak-failed-1-resources.jsonl)与[真实日志复制库回归](../artifacts/p6/save-raw-reproduction/fix-verification.json)。

第二次长观察完整运行 7,203,375 ms、正常退出，但唯一失败门槛是 687 个本机处理样本的 p95 2,841 ms；共 8,624 次调用、64 次 retry。证据归档为 `artifacts/p6/soak-failed-2-*` 与 `data/p6-soak-failed-2.sqlite`。最终源码 profile 的 warm 路径在中期副本为 455.72 ms、较大终端副本为 722.43 ms，cold 路径 3.716/5.177 秒仍保留；见 `artifacts/p6/performance/coverage-final-*.json`。

最终构建 2 小时验收于 UTC 13:35:48.773 / Asia/Shanghai 21:35:48 启动，runId `2026-09-10T13-35-48-773Z-6ec4891a`，recorder PID 5500，main session 44586，sampler session 47225，原计划窗口到 23:35:48；实际约 56 分钟时按用户要求中断。main session 退出 1，sampler 退出 0，已确认 follow 进程不存在。没有生成 finalized manifest；末次 healthy 只是历史采样，不能作终端通过结论。保存 data/p6-soak-user-stopped.sqlite 与 artifacts/p6/soak-user-stopped-report.json。

限制：未安装永久服务、未交易或操作钱包；缺失供应商 billing units/费率时货币成本保持 null。尚无合格原生 portable 输入与跨流修订顺序，不声称 recorded-observed 回放对照通过；阈值效果、独立全链覆盖与 LP 净收益仍未验证。保留首次失败和所有 raw/批次证据，重试不能替代或抹去失败记录。


## P6 提交与本地合并检查 — 2026-09-10

用户要求 commit、merge。当前 P6 实现重新完成离线检查：74 文件 / 740 测试通过、0 失败、0 pending；typecheck、lint、build 均退出 0。重新构建的全部 98 个清单文件与最近实测前冻结指纹相同。证据见 [commit-verification.json](../artifacts/p6/commit-verification.json)。这次仅做离线集成检查，实链观察保持停止；P6 长时验收状态仍为 in_progress，后期处理耗时问题未标为解决。大型数据库、原始运行输入与未实施优化草稿留在本机，保留政策见 [P6 证据说明](../artifacts/p6/README.md)。
