# 实施状态与窗口交接

更新：2026-09-08。当前状态：**P0 passed（官方公共 RPC 端点）**，P1–P6 未开始。下一窗口执行 P1。下方旧记录保留为设计阶段历史证据；本轮完整验收与限制见文末。

此前13份Markdown的本地链接、代码围栏、计划头部顺序、占位符与行尾空白检查通过；并已按架构逐项核对P0–P6覆盖。批量查询补充后的文档检查另记于下方。文档验收不代表应用测试通过。

最后纳入的用户约束：只提供RPC、本机同步；成熟通用库优先；lp-terminal固定commit的只读模块可复用，其跳块状态刷新与第三方成交统计须改造。详细结论见 [lp-terminal评估](research/2026-09-08-lp-terminal-review.md)。

最新补充：允许连续多块批量查询，默认每2秒追全部新增块，积压时扩大范围并连续追赶。2026-09-08公共RPC的10块查询成功，完整P0能力验收仍pending；证据与块头成本限制见[批量查询](research/2026-09-08-batched-rpc.md)。

上一轮批量查询文档验证：14份Markdown检查通过。最新日志优先修订的验证见下方记录，应用测试仍未开始。

当前有效方案：[日志优先热度设计](research/2026-09-08-logs-first-heat.md)。已取消每块Header/parentHash账本、历史池状态初始化和LP收益模拟；默认2秒取logs，以少量端点及分钟边界计算热度。实时本分钟可随批次更新，历史minute-close评估剩余15/60/180分钟成交。

新增公开RPC证据：20块55条日志的blockTimestamp全部为0x0；抽样2个块的hash一致但时间值无效，已保存原始响应。下一窗口必须验证实际用户端点，并支持分钟时间索引；字段存在不等于时间能力通过。

本轮验证完成：15份Markdown的链接、围栏、计划头部、行尾空白、过时接口名与设计13节结构检查为0错误；时间证据55条及2个块头对照一致。Sol只读审查提出的scope水位、归桶端点、闭合条件、时间修订和恢复参数已纳入。src和根package.json仍不存在；本轮没有运行应用测试或启动监控。

| 阶段 | 状态 | 已验证证据 | 下一步 |
|---|---|---|---|
| P0 工程与能力 | passed | 60 测试通过；typecheck/build/probe/capture 退出 0；真实 V3/V4 与两枚 V4 种子验证；[汇总](../artifacts/p0/acceptance.json) | 下一窗口执行 P1 Task 1.1 |
| P1 记录与恢复 | pending | 尚无生产记录器 | P0 验收后开始 |
| P2 协议与观测 | pending | 官方源码已调查；尚无实现测试 | P1 验收后开始 |
| P3 分钟热度 | pending | 已有研究定义；尚无分钟热度输出 | P2 验收后开始 |
| P4 告警 | pending | 尚无运行中通知 | P3 验收后开始 |
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
