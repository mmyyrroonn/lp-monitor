# Robinhood RWA 短时 LP 机会监控：实施入口

更新：2026-09-08。**P0 已通过官方公共 RPC 验收，下一窗口只实现 P1。** P0 review 修正已完成，149 个测试通过；[逐项处理](docs/reviews/2026-09-08-p0-review-resolution.md)。已有可运行只读 CLI、官方 ABI、能力/身份报告及真实样本；细节与限制见 [实施状态](docs/implementation-status.md)和 [运行说明](README.md)。

目标：直接解析 Robinhood Chain 的 Uniswap V3/V4 链上事件，持续观察有限的 RWA 集合，发现关联新 Meme、老 Meme 再次放量，以及具体 RWA/USDG 池的短时成交热度。首版以热度排名与提醒为核心，不做精确 LP 模拟。通知要及时，机会可以只持续几个小时。

## 新窗口从这里开始

1. 阅读 [架构与数据口径](docs/superpowers/specs/2026-09-08-robinhood-rwa-monitor-design.md)。
2. 阅读 [GitHub 复用调查](docs/research/2026-09-08-uniswap-code-reuse.md)，协议解析优先使用现成组件。
   用户提供的 [lp-terminal 逐模块评估](docs/research/2026-09-08-lp-terminal-review.md)是Robinhood适配的重点参考。
3. 查看 [实施状态](docs/implementation-status.md)，只执行最早一个未通过验收的阶段。
4. 按对应阶段计划实现、验证、记录证据，再由用户安排下一窗口。

| 阶段 | 交付 | 计划 |
|---|---|---|
| P0 | 可运行工程、依赖与 ABI 真源、RPC 能力报告、真实日志样本 | [P0](docs/superpowers/plans/2026-09-08-p0-foundation.md) |
| P1 | 动态池发现、范围日志、分钟索引、重扫恢复 | [P1](docs/superpowers/plans/2026-09-08-p1-recorder.md) |
| P2 | V3/V4 事件解码、最近Swap与流动性动作观测 | [P2](docs/superpowers/plans/2026-09-08-p2-protocol-state.md) |
| P3 | 分钟成交、Swap/tx次数、放量倍率与热度排名 | [P3](docs/superpowers/plans/2026-09-08-p3-metrics.md) |
| P4 | 短窗候选、放量确认、再热升级、本机提醒 | [P4](docs/superpowers/plans/2026-09-08-p4-alerts.md) |
| P5 | AMC/MEME 等历史回放、完整样本与阈值评估 | [P5](docs/superpowers/plans/2026-09-08-p5-history.md) |
| P6 | 有时限的实时观察、故障演练、运行手册 | [P6](docs/superpowers/plans/2026-09-08-p6-live-validation.md) |

推荐栈：TypeScript strict、Node.js 24、viem、SQLite。先做单进程模块化程序。官方 ABI/SDK 负责协议格式与数学，业务层负责 RWA 关联、短窗机会和证据记录。

部署基线已按用户补充明确为“只提供 RPC，本机增量同步”。无需 Envio Cloud 或 HyperSync 订阅；详见 [成本与自托管选择](docs/research/2026-09-08-rpc-only-cost.md)。

采集默认每 2 秒用 eth_getLogs 拉取全部新增块的相关日志，积压时连续分段追赶；不要求每出一块就单独请求或提醒。参见 [批量查询实测与设置](docs/research/2026-09-08-batched-rpc.md)。已取消每块Header读取，改用稀疏端点和分钟边界。公共RPC日志时间实测为0，降级方案见[日志优先的热度设计](docs/research/2026-09-08-logs-first-heat.md)。

已比较 ethers、viem、Subsquid、Graph Node、Ponder、Ethereum ETL 和 Envio。默认采用 viem + 官方 Uni ABI/SDK，ethers 用于独立解码测试；完整框架优先备选 Subsquid RPC-only。Envio 的 V4 示例已有 Robinhood 4663 配置，但只作源码对照，不设为运行依赖。

## 可直接复制到新窗口

~~~text
请在 E:/lp-monitor 继续 Robinhood RWA 短时 LP 机会监控项目。
先读 START_HERE.md、docs/implementation-status.md、架构文档与 GitHub 复用调查。
本窗口只实现 P1，按 docs/superpowers/plans/2026-09-08-p1-recorder.md 从 Task 1.1 执行。
不要重做已经完成的市场调研；用现成 Uniswap ABI、viem 和官方 SDK，避免手写通用协议解析。
沿用 TypeScript + Node.js 24 + SQLite。凭据仅从本机环境读取，不打印 RPC URL 中的密钥。
参考 docs/research/2026-09-08-lp-terminal-review.md 中固定commit的只读模块，不照搬其跳块刷新或第三方成交统计。
使用只读 RPC；沿用已通过的 P0 工程、官方 ABI、能力报告与真实样本，实现 P1 范围记录/发现/恢复并完成必要测试，更新实施状态与交接记录。
按 docs/research/2026-09-08-batched-rpc.md 验证连续范围 getLogs；默认每2秒追新增logs，时间为0时定位分钟边界，禁止逐块补Header；先读docs/research/2026-09-08-logs-first-heat.md。
遇到 RPC 不支持某项能力，要保留证据、继续不依赖它的工作，不能假造历史数据或填零。
不执行交易、不接钱包、不启动永久服务。完成 P1 后停止，说明下一窗口入口。
需要独立子任务时可按需使用 Sol/Terra，不要所有子任务都用 Astra。
~~~

后续窗口按状态表选择最早未通过阶段。每个窗口结束更新状态，留下可直接执行的下一步。

## 本次已完成与已有资料

- 已完成：设计、复用调查、分阶段计划，以及 P0 工程、60 个测试、只读 CLI、官方 ABI/SDK 对照、公共 RPC 能力与当前身份验证、真实 V3/V4 样本；[验收汇总](artifacts/p0/acceptance.json)。
- 尚未完成：P1 范围记录器与恢复、后续协议业务层、分钟热度/告警和完整历史回填。历史部署起点仍未验证，日志时间混有零值，公共端点会限流；这些限制已写入交接。
- 已建立本地 Git，P0 工程、设计文档与最终验收样本纳入版本控制。原 research、GMGN tooling、.agents、.pnpm-store 保留；没有启动永久服务。
- [AMC/MEME 案例研究](research/amc-meme/AMC与MEME案例研究.md)解释了为何必须监控重新放量，不能首次降温后永久删币。
- [历史验证](research/short-window-study/2026-09-07-短时机会监控-历史验证.md)包含初始阈值实验与失败样本。

现有 GMGN/公共池 API 资料是研究参照。未来分钟历史评估独立核验热度和持续时间，不把第三方成交额差异强行对齐，不把展示日化写成账户收益。
