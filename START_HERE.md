# Robinhood RWA 短时 LP 机会监控：实施入口

更新：2026-09-09。**P0、P1、P2、P3 已通过验收；下一窗口由用户安排 P4。** 当前 453 个测试通过。P3 提供离线分钟成交、Swap/tx 次数、原币/计价降级、基线与排名。[P3 验收](docs/reviews/2026-09-09-p3-acceptance.md)、[独立审查](docs/reviews/2026-09-09-p3-review.md)、[实施状态](docs/implementation-status.md)、[运行说明](README.md)。

目标：解析 Robinhood Chain 的 Uniswap V3/V4 链上事件，观察有限 RWA 集合，发现关联新 Meme、老 Meme 再次放量，以及具体 RWA/USDG 池的短时成交热度。首版以热度排名与提醒为核心，不做精确 LP 模拟。

## 新窗口从这里开始

1. 阅读[架构与数据口径](docs/superpowers/specs/2026-09-08-robinhood-rwa-monitor-design.md)。
2. 阅读[GitHub 复用调查](docs/research/2026-09-08-uniswap-code-reuse.md)与[固定源码评估](docs/research/2026-09-08-lp-terminal-review.md)，沿用已固定协议 ABI。
3. 查看[实施状态](docs/implementation-status.md)，只执行用户指定的下一阶段。
4. 按对应计划实现、验证、保存证据并更新交接记录。

| 阶段 | 状态/交付 | 计划 |
|---|---|---|
| P0 | passed；工程、依赖/ABI、RPC 报告、真实日志 | [P0](docs/superpowers/plans/2026-09-08-p0-foundation.md) |
| P1 | passed；动态池发现、范围日志、分钟索引、恢复 | [P1](docs/superpowers/plans/2026-09-08-p1-recorder.md) |
| P2 | passed；解码、最近观测、离线投影重建 | [P2](docs/superpowers/plans/2026-09-08-p2-protocol-state.md) |
| P3 | passed；分钟成交、Swap/tx、原币基线、排名与动作附注 | [P3](docs/superpowers/plans/2026-09-08-p3-metrics.md) |
| P4 | pending；短窗候选、确认、再热状态机、本机提醒 | [P4](docs/superpowers/plans/2026-09-08-p4-alerts.md) |
| P5 | pending；历史回放、完整样本、阈值评估 | [P5](docs/superpowers/plans/2026-09-08-p5-history.md) |
| P6 | pending；有时限实时观察、故障演练、运行手册 | [P6](docs/superpowers/plans/2026-09-08-p6-live-validation.md) |

技术栈：TypeScript strict、Node.js 24、viem、SQLite；精确版本保持。默认只提供 RPC、本机同步；采集按 2 秒节奏取新增块 logs，稀疏边界用于分钟计时，不逐块读取 Header。

## 本机 P3 验收入口

```powershell
pnpm lp metrics --db data/p3-acceptance.sqlite --rwa AMC --window 5m
pnpm lp rank --db data/p3-acceptance.sqlite --sort volume5mClosed
pnpm lp rank --db data/p3-acceptance.sqlite --sort volumeMultiplier
node artifacts/p3/verify-acceptance.mjs
```

P3 验收库是 P2 库的 SQLite online backup。历史输入有 603 笔 Swap、313 个不同交易、29 个闭合分钟；1827 个登记池中 29 个有 Swap/流动性动作。34 笔未计价成交保留原币量和次数。样本不足一小时，默认倍率基线尚未就绪，不填造倍率。本轮无新增 RPC。

`metrics` / `rank` 默认只读，`--out PATH` 导出 JSON，`--save` 显式保存分钟派生缓存。两者要求 P2 投影仍新鲜；录制、重扫或 retime 后先运行 `project --rebuild`。全 scope 读取和离线重建尚未接入每个录制批次。所有分钟结果保留 provisional，精确秒数未知仍为 null。

## 可复制到新窗口

~~~text
请在 E:/lp-monitor 继续 Robinhood RWA 短时 LP 机会监控项目。
先读 START_HERE.md、docs/implementation-status.md、P3 验收与独立审查。
本窗口只实现 P4，按 docs/superpowers/plans/2026-09-08-p4-alerts.md 从 Task 4.1 执行。
沿用 P0–P3 的 ABI、有效日志、P2 sourceHash 过期保护和 P3 窗口/报价/覆盖合同。
从 buildMetricsReport 的新鲜结果读取业务数据，不把 metric_windows 缓存裸表当当前数据。
只有五个连续完整分钟才有最近5m；自然5m与本分钟partial分开。
默认基线要60个完整1m或12个完整5m；不足或中位数零时倍率null，缺口不得视为降温。
已登记零成交池必须保留，不把出生前的分钟填零加入基线；无价池保留自身原币量和次数。
报价须为先前事件，分钟粒度按年龄上界60秒检查；缓存decimals只是历史沿用，已知哈希冲突须降级。
P3新池/再活跃是描述标签，P4仍需实现提醒状态机、冷却、修订/撤回与本机通知。
只读RPC，不执行交易、不接钱包、不启动永久服务；完成P4后停止。
~~~

## 历史验收与研究

- [P0 复验](docs/reviews/2026-09-08-p0-review-acceptance-resolution.md)：188 测试时点。
- [P1 验收](docs/reviews/2026-09-08-p1-acceptance.md)与[修正](docs/reviews/2026-09-08-p1-recorder-review-resolution.md)。
- [P2 验收](docs/reviews/2026-09-08-p2-acceptance.md)：历史 344 测试时点；本轮开始前实际基线为 401 个通过测试。
- [P3 机器验收](artifacts/p3/acceptance.json)、[热度](artifacts/p3/amc-heat.json)、[覆盖](artifacts/p3/coverage.json)。

历史部署起点仍未验证，公共 RPC 的限流、零时间与完整性假设继续保留。P4–P6 的提醒、完整历史和实时服务尚未实现。毛交易费估计不是账户收益。原 research、tooling、.agents 和缓存均保留。
