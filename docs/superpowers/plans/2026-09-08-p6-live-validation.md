# P6 本机实时观察与运行交接 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 验证只提供RPC即可在本机稳定记录和提醒，量化延迟与运行费用，提供停止/恢复方法。

**Architecture:** 运行已验收管线，先30分钟冒烟再2小时有界观察；只读模式。计划不自动创建永久后台或定时任务。

**Tech Stack:** Node.js 24、TypeScript strict ESM、pnpm、viem、SQLite；协议格式优先官方 ABI/SDK。

## 当前前置条件 — 2026-09-09用户调整

基于已验收P0–P4，用户明确安排后可进入本阶段；不要求先完成P5历史采集、完整样本或阈值评估。历史获取已有能力保留，缺少的先不增加。实时启动、动态发现、恢复与完整性所需的既有扫描继续保留。

优先验证实时采集、热度统计与本机提醒稳定性。阈值可以采用用户额外分析提供的候选配置，注明口径和来源；运行验收通过不代表阈值效果通过。P5回放入口已于2026-09-10实现；实录缺少配置快照或修订顺序时仍不得声称对照已通过，保存完整输入供后续使用。本计划仍为pending，本次文档调整不启动运行。

## Global Constraints

- 只读链数据；生产热路径不依赖 Uni API、Subgraph 服务或 GMGN。
- Node.js 24、TypeScript strict ESM、pnpm；精确版本与 lockfile 由 P0 固化。
- 原始金额 bigint；持久化用无损字符串；业务结果绑定 chainId、blockHash 与版本。
- 实时与历史共用业务核心；缺口不补零，未知估值/费用不写零。
- 同块动态发现、断点恢复、重组与告警撤回必须有测试。
- 秘钥仅从本机环境读取；日志保存 provider alias，不保存带凭据 URL。
- 现有 research/、tooling/、.agents/、.pnpm-store/ 保留，不纳入应用依赖重构。
- 每窗口只实现指定阶段；更新状态和证据，未验收不得勾成完成。
- 默认只提供 RPC、本机增量同步；无付费索引后台依赖，记录调用用量与预算。

所有相对代码路径以 E:/lp-monitor 为根。架构依据：[设计](../specs/2026-09-08-robinhood-rwa-monitor-design.md)。下列代码块定义接口、关键算法和测试输入；实际实现需围绕这些合同补齐本阶段列出的行为，不是把文档片段原样拼成生产程序。命令均为未来阶段实现后的验收入口，本次写计划没有运行它们。

## Task 6.1：运行配置、健康与预算

**Files:** 创建 config/runtime.local.json、src/ops/status.ts、src/ops/report.ts、src/ops/shutdown.ts、tests/integration/shutdown.test.ts、tests/unit/budget.test.ts、docs/runbook.md；修改src/cli.ts。

**Interfaces:** healthSnapshot(): HealthSnapshot，包含head/scanned/raw/projected水位、lastHeadAt、gap、queueDepth、RPC各方法次数、写入/处理延迟、dbBytes。状态与行情信息分列。

- [ ] 测试SIGINT在raw已写/事务未提交时退出，再启动按cursor补处理，不重复业务决策；所有待写flush后关闭SQLite。
- [ ] 配置先限定AMC三类观察池及动态关联发现。扩展NVDA/HIMS前核验registry/decimals并先补其池登记。
- [ ] 初始maxRpcRps=5、maxConcurrentRpc=2、maxBackfillRpcRps=1；根据P0实测方法额度调整。额度不足即报告head lag，禁止静默越限或自动购买套餐。
- [ ] 累计RPC元素数；分别统计logs、端点anchor、分钟边界和metadata calls。正常流程无逐块Header/receipt/state请求；实测2秒批次的调用预算与分钟边界额外成本。
- [ ] 使用默认2秒轮询记录主动等待、RPC耗时、处理耗时及headLagBlocks/headLagSeconds趋势；短暂积压需能消化。把10/20/100块范围的有界比较纳入首次30分钟观察，不额外启动长期进程，不把1,000块小样本平均速率当作长期保证。
- [ ] 默认HTTP轮询；StateView/历史state/trace/WS不作门槛。日志时间为0时启用分钟索引，并测每分钟新增anchor请求，不能退回全块头循环。
- [ ] 运行 pnpm exec vitest run tests/integration/shutdown.test.ts tests/unit/budget.test.ts。

## Task 6.2：有界实录与故障演练

**Files:** 创建 tests/integration/live-faults.test.ts、artifacts/p6/soak-report.json、artifacts/p6/cost-report.json；修改docs/runbook.md。

- [ ] 使用fixture transport模拟断线30秒、429、重复块、分叉、JSON响应损坏、DB写失败；所有数据完整性不变量仍成立，失败通知仅在状态变化时产生。
- [ ] 先运行 pnpm lp follow --config config/runtime.local.json --duration 30m --notify local。没有热门行情也能通过运行验收，不为展示强制降低阈值制造热点。
- [ ] 核验无密钥日志、本机告警字段、RPC用量、磁盘增长与同级重复率；核心完整性无误后再运行 --duration 2h。
- [ ] 目标：无未解释的范围缺口/重复决策；在所测负载下，从完整范围及必要分钟时间可用到outbox落盘的本地p95处理延迟<=2秒。另报链头到获取、RPC回填与最终显示总延迟；这个2秒不是保证链上成交后2秒一定可见。
- [ ] 若无法追上链速，报告每秒新块数、RPC瓶颈、事件数与CPU/磁盘占用；优先调批次/过滤/cache。只有测出瓶颈再考虑Subsquid等框架或更高RPC额度。
- [ ] 从观察时段导出含分钟索引和批次时间的manifest并保存窗口/告警证据。已有recorded-observed离线replay能力时进行对照；尚未实现则明确标暂缓，留待P5，不为此新增历史获取或阻塞本阶段。可见真实reorg则保存，未发生不能声称实链reorg验证，只能说故障fixture通过。

## Task 6.3：成本与下一窗口交接

**Files:** 修改docs/runbook.md、docs/implementation-status.md、START_HERE.md。

- [ ] 运行手册给出已实现的probe、follow、status、停止、恢复、既有范围补采及升级前备份的准确命令；backfill/replay仅在实际具备对应入口时列为可运行命令，否则明确标未实现/暂缓，不为补全手册新增功能。数据备份用SQLite backup API，不只复制运行中的主文件漏掉WAL。
- [ ] 成本报告列首轮回填和稳态每小时的方法调用/字节/磁盘增长，按用户RPC供应商实际费率换算；费率未给只报用量。
- [ ] 给出停止后补历史不会向用户重发所有旧机会的模式说明；实时数据质量恢复、告警撤回与新热点仍正常发送。
- [ ] 写最终能力表：V3/V4发现/Swap/liquidity动作、历史logs/分钟时间、估值覆盖、通知、分钟历史评估与未具备部分。
- [ ] 更新状态为实际验收结果，保留所有raw与报告。阶段结束停止有界进程，不自动安装开机启动或安排循环任务。

## 完成标准与后续扩展

当前交付路径为P0–P4及P6适用工程门槛通过，交付“本机只读机会监控器”；P5及依赖它的离线回放对照可保持pending/暂缓，并在能力表中明确披露。P6的数据完整性、故障恢复、通知及运行成本门槛继续适用。阈值效果与历史未支持的收益结论保持未知。

后续独立扩展按用户需要：Pons曲线前置发现；更多RWA/其他DEX；远端通知；Subsquid RPC-only替换摄取；指定区间feeGrowth验证与假想仓位研究。自动交易/加减池是另一项任务，需要独立设计和明确授权，不能从监控任务自然开启。
