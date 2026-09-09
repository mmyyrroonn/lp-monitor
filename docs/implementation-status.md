# 实施状态与窗口交接

更新：2026-09-09。当前状态：**P0 passed；P1 passed；P2 passed；P3 passed；P4 passed**，P5/P6 未开始。下方旧记录保留为设计阶段历史证据；本轮完整验收与限制见文末。

此前13份Markdown的本地链接、代码围栏、计划头部顺序、占位符与行尾空白检查通过；并已按架构逐项核对P0–P6覆盖。批量查询补充后的文档检查另记于下方。文档验收不代表应用测试通过。

最后纳入的用户约束：只提供RPC、本机同步；成熟通用库优先；lp-terminal固定commit的只读模块可复用，其跳块状态刷新与第三方成交统计须改造。详细结论见 [lp-terminal评估](research/2026-09-08-lp-terminal-review.md)。

最新补充：允许连续多块批量查询，默认每2秒追全部新增块，积压时扩大范围并连续追赶。2026-09-08公共RPC的10块查询成功，完整P0能力验收仍pending；证据与块头成本限制见[批量查询](research/2026-09-08-batched-rpc.md)。

上一轮批量查询文档验证：14份Markdown检查通过。最新日志优先修订的验证见下方记录，应用测试仍未开始。

当前有效方案：[日志优先热度设计](research/2026-09-08-logs-first-heat.md)。已取消每块Header/parentHash账本、历史池状态初始化和LP收益模拟；默认2秒取logs，以少量端点及分钟边界计算热度。实时本分钟可随批次更新，历史minute-close评估剩余15/60/180分钟成交。

新增公开RPC证据：20块55条日志的blockTimestamp全部为0x0；抽样2个块的hash一致但时间值无效，已保存原始响应。下一窗口必须验证实际用户端点，并支持分钟时间索引；字段存在不等于时间能力通过。

本轮验证完成：15份Markdown的链接、围栏、计划头部、行尾空白、过时接口名与设计13节结构检查为0错误；时间证据55条及2个块头对照一致。Sol只读审查提出的scope水位、归桶端点、闭合条件、时间修订和恢复参数已纳入。src和根package.json仍不存在；本轮没有运行应用测试或启动监控。

| 阶段 | 状态 | 已验证证据 | 下一步 |
|---|---|---|---|
| P0 工程与能力 | passed | P0 最终修正后 188 测试通过；历史 RPC 证据保留 | 沿用既有合同 |
| P1 记录与恢复 | passed | 273 测试；5 个实时分钟边界；重启/旧段重扫退出 0；[验收](../artifacts/p1/acceptance.json) | 已完成；沿用 P1 合同 |
| P2 协议与观测 | passed | 344 测试；650 条真实历史事件 ethers 对照；[验收](../artifacts/p2/acceptance.json) | 用户安排后进入 P3 Task 3.1 |
| P3 分钟热度 | passed | 453 测试；603 笔历史 Swap、29 闭合分钟；[验收](../artifacts/p3/acceptance.json) | 用户安排 P4 Task 4.1 |
| P4 告警 | passed | 539测试；本机通知、修订撤回；[验收](reviews/2026-09-09-p4-acceptance.md) | 用户安排P5 |
| P5 历史验证 | pending | GMGN/公共 API 案例仅供参照 | P4 验收后开始 |
| P6 实时验收 | pending | 未启动服务 | P5 数据质量验收后开始 |

## 状态规则

允许 pending / in_progress / passed / blocked。passed 必须有本阶段具体命令、退出码、证据路径与限制；没有凭据、没有 archive 数据或未运行测试不能写成通过。

每个阶段结束在此追加一条记录：

~~~text
阶段与时间：
最终范围与修改文件：
执行的命令和结果：
真实链上证据与合成测试各自的路径：
仍不具备的能力及对功能的影响：
配置/ABI/依赖版本变更：
下一窗口的计划文件与起始任务：
~~~

当前目录没有 .git；本次没有提交。后续若建立版本控制，应先确认目录状态并保留已有研究与技能文件，不为完成某个提交步骤而重置或清理工作区。

## P0 验收记录 — 2026-09-08 14:13 北京时间

最终范围：P0 工程、环境配置、无损数据合同、官方 ABI/PoolId、只读 RPC 适配器、限流/计量、能力和身份核验、稀疏时间定位、真实 fixture。新增根 package/lockfile/TS/Vitest 配置、src、tests、scripts、config、README 与 artifacts/p0；原 research、tooling、.agents、.pnpm-store 保留。未实现 P1 记录器、业务热度或提醒。

### 命令与结果

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm typecheck` | 退出 0 | [verification.json](../artifacts/p0/verification.json) |
| `pnpm test --reporter=json --outputFile=artifacts/p0/tests.json` | 退出 0；13 suites、60 passed、0 failed、0 skipped | [tests.json](../artifacts/p0/tests.json) |
| `pnpm build` | 退出 0；构建后 `node dist/src/cli.js --help` 也退出 0 | 同上 verification；README 命令 |
| `pnpm lp probe --config config/robinhood.json --out artifacts/p0/capabilities.json` | 退出 0；必需能力及当前身份通过 | [capabilities.json](../artifacts/p0/capabilities.json)、[身份](../artifacts/p0/identity-evidence.json) |
| `pnpm lp capture --config config/robinhood.json --last-blocks 300 --out artifacts/p0/raw` | 退出 0；类别及全部配置 V4 种子通过 | [最终 manifest](../artifacts/p0/raw/2026-09-08T06-10-51-129Z/manifest.json) |
| `node node_modules/vitest/vitest.mjs run tests/integration/p0-fixtures.test.ts --reporter=json --outputFile=artifacts/p0/fixture-tests.json` | 退出 0；最终新增 fixture 的哈希及 ethers 独立解码通过 | [fixture-tests.json](../artifacts/p0/fixture-tests.json) |
| `node scripts/p0-acceptance.mjs artifacts/p0/raw/2026-09-08T06-10-51-129Z/manifest.json` | 退出 0；全部门槛 true | [acceptance.json](../artifacts/p0/acceptance.json) |

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