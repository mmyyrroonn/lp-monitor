# Robinhood RWA 短时 LP 机会监控：实施入口

更新：2026-09-08。**P0、P1、P2 已通过验收；下一窗口由用户安排 P3。** 当前 344 个测试通过。P2 已提供 V3/V4 解码、最近 Swap/流动性动作观测及离线 SQLite 投影；650 条 P1 真实历史事件通过 ethers 对照。[P2 验收](docs/reviews/2026-09-08-p2-acceptance.md)、[实施状态](docs/implementation-status.md)、[运行说明](README.md)。

目标：直接解析 Robinhood Chain 的 Uniswap V3/V4 链上事件，观察有限 RWA 集合，发现关联新 Meme、老 Meme 再次放量，以及具体 RWA/USDG 池的短时成交热度。首版以热度排名与提醒为核心，不做精确 LP 模拟。

## 新窗口从这里开始

1. 阅读 [架构与数据口径](docs/superpowers/specs/2026-09-08-robinhood-rwa-monitor-design.md)。
2. 阅读 [GitHub 复用调查](docs/research/2026-09-08-uniswap-code-reuse.md)与 [lp-terminal 固定源码评估](docs/research/2026-09-08-lp-terminal-review.md)，协议解析优先使用现成组件。
3. 查看 [实施状态](docs/implementation-status.md)，只执行最早一个未通过验收的阶段。
4. 按对应阶段计划实现、验证、记录证据，再由用户安排下一窗口。

| 阶段 | 状态/交付 | 计划 |
|---|---|---|
| P0 | passed；可运行工程、依赖/ABI、RPC 报告、真实日志 | [P0](docs/superpowers/plans/2026-09-08-p0-foundation.md) |
| P1 | passed；动态池发现、范围日志、分钟索引、恢复 | [P1](docs/superpowers/plans/2026-09-08-p1-recorder.md) |
| P2 | passed；V3/V4 解码、最近观测、离线投影重建 | [P2](docs/superpowers/plans/2026-09-08-p2-protocol-state.md) |
| P3 | pending；分钟成交、Swap/tx 次数、放量与排名 | [P3](docs/superpowers/plans/2026-09-08-p3-metrics.md) |
| P4 | pending；短窗候选、放量确认、再热、本机提醒 | [P4](docs/superpowers/plans/2026-09-08-p4-alerts.md) |
| P5 | pending；历史回放、完整样本与阈值评估 | [P5](docs/superpowers/plans/2026-09-08-p5-history.md) |
| P6 | pending；有时限实时观察、故障演练、运行手册 | [P6](docs/superpowers/plans/2026-09-08-p6-live-validation.md) |

技术栈：TypeScript strict、Node.js 24、viem、SQLite，精确版本已锁定。官方 ABI/SDK 负责协议格式与数学，业务层负责关联、指标与证据。默认只提供 RPC、本机增量同步，无付费索引后台依赖；[部署成本](docs/research/2026-09-08-rpc-only-cost.md)。

采集默认每 2 秒取全部新增块的相关 logs，积压连续分段追赶。时间为零时定位分钟边界，禁止逐块补 Header；[批量查询](docs/research/2026-09-08-batched-rpc.md)、[日志优先热度设计](docs/research/2026-09-08-logs-first-heat.md)。

## 本机 P2 验收入口

```powershell
pnpm lp project --db data/p2-acceptance.sqlite --rebuild
pnpm lp inspect-pool --config config/robinhood.json --db data/p2-acceptance.sqlite --pool amc-usdg-v3
node artifacts/p2/verify-acceptance.mjs
```

该库是 P1 录制库的备份，P2 只做离线历史回放，没有新增 RPC。650 个事件涉及 29 个有观测的池；1827 是登记数。未知精确秒数继续为 null。全 scope 重建和过期检查成本随历史增长，尚未接到每个录制批次。后续采集、重扫或 retime 后需要重新 project；inspect 拒绝旧投影。下游必须通过已校验的投影读取，不直接将旧 projected_events 裸表当最新集合。

## 可直接复制到新窗口

~~~text
请在 E:/lp-monitor 继续 Robinhood RWA 短时 LP 机会监控项目。
先读 START_HERE.md、docs/implementation-status.md、架构文档与 GitHub 复用调查。
本窗口只实现 P3，按 docs/superpowers/plans/2026-09-08-p3-metrics.md 从 Task 3.1 执行。
沿用已通过的 P0/P1/P2：固定官方 ABI、viem、SQLite 原始有效集合、分钟时间、解码与观测。
先读 P2 验收报告，保留 sourceHash 过期检查、scope 隔离、重扫删除/retime 和质量错误；不得直接把旧投影裸表当最新数据。
不要重做已经完成的市场调研，不照搬第三方成交统计，用 bigint 保持金额无损。
只读 RPC；凭据只从本机环境读取，不打印带密钥的 URL。无需逐笔 eth_call 或逐块 Header。
无价事件保留原币量/次数与缺口；未知估值和费用不填零，sender/actor 不当真实用户数。
实现本阶段必要测试、更新实施状态和交接记录；完成 P3 后停止。
不执行交易、不接钱包、不启动永久服务。
~~~

## 历史验收与研究

- [P0 复验处理](docs/reviews/2026-09-08-p0-review-acceptance-resolution.md)：188 测试时点与旧实链证据。
- [P1 验收](docs/reviews/2026-09-08-p1-acceptance.md)：273 测试时点、录制/重启/重扫；[第二轮修复](docs/reviews/2026-09-08-p1-recorder-review-resolution.md)后 281 测试。
- [P2 验收汇总](artifacts/p2/acceptance.json)：当前 344 测试、源码与构建哈希、独立解码及限制。
- [AMC/MEME 案例研究](research/amc-meme/AMC与MEME案例研究.md)与 [短时机会历史验证](research/short-window-study/2026-09-07-短时机会监控-历史验证.md)保留为研究参照。

历史部署起点仍未验证，公共 RPC 存在限流与零时间问题；P3–P6 的分钟热度、通知、完整历史和实时服务尚未实现。所有链观察仍为 provisional，展示毛费强度不是账户已实现收益。原 research、tooling、.agents 和依赖缓存保留。
