# Robinhood RWA 短时 LP 机会监控：实施入口

更新：2026-09-09。**P0–P4 已通过验收；539个测试通过。** P4提供候选、热度确认、翻倍升级、降温、再热、修订撤回和本机通知。[P4验收](docs/reviews/2026-09-09-p4-acceptance.md)、[独立审查](docs/reviews/2026-09-09-p4-review.md)、[实施状态](docs/implementation-status.md)、[运行说明](README.md)。

目标：解析Robinhood Chain的Uniswap V3/V4链上事件，观察有限RWA集合，发现关联新Meme、老Meme再次放量，以及具体RWA/USDG池的短时成交热度。首版以热度排名与提醒为核心，不做精确LP模拟。

## 新窗口从这里开始

1. 阅读[架构与数据口径](docs/superpowers/specs/2026-09-08-robinhood-rwa-monitor-design.md)。
2. 沿用[复用调查](docs/research/2026-09-08-uniswap-code-reuse.md)、[固定源码评估](docs/research/2026-09-08-lp-terminal-review.md)与固定协议ABI。
3. 查看[实施状态](docs/implementation-status.md)，只执行用户指定的阶段。
4. 按阶段计划实现、验证、保存证据并更新交接记录。

| 阶段 | 状态/交付 | 计划 |
|---|---|---|
| P0 | passed；工程、依赖/ABI、RPC报告、真实日志 | [P0](docs/superpowers/plans/2026-09-08-p0-foundation.md) |
| P1 | passed；动态池发现、范围日志、分钟索引、恢复 | [P1](docs/superpowers/plans/2026-09-08-p1-recorder.md) |
| P2 | passed；解码、最近观测、离线投影重建 | [P2](docs/superpowers/plans/2026-09-08-p2-protocol-state.md) |
| P3 | passed；分钟成交、计价降级、基线与排名 | [P3](docs/superpowers/plans/2026-09-08-p3-metrics.md) |
| P4 | passed；状态机、outbox、修订撤回、本机通知 | [P4](docs/superpowers/plans/2026-09-08-p4-alerts.md) |
| P5 | pending；历史回放、完整样本、阈值评估 | [P5](docs/superpowers/plans/2026-09-08-p5-history.md) |
| P6 | pending；有时限实时观察、故障演练、运行手册 | [P6](docs/superpowers/plans/2026-09-08-p6-live-validation.md) |

## 本机入口

```powershell
# 默认只记录；启用提醒必须显式指定本机渠道
pnpm lp follow --config config/robinhood.json --duration 10m --notify local
# 离线历史与合成验收，不连接RPC
pnpm build
node artifacts/p4/verify-acceptance.mjs
pnpm lp metrics --db data/p4-acceptance.sqlite --rwa AMC --window 5m
```

JSONL写入数据库路径加.alerts.jsonl。配置见config/signals.initial.json，金额阈值以USDG估值的micro单位表达。每条规则有enabled/threshold/version；默认60个完整1m或12个完整5m基线；不足/零中位数保留null。自然5m、最近五个完整1m和当前partial分开。

P4历史输入有603笔Swap、34笔未计价、29个闭合分钟、1827个登记池；该样本提醒为0。本轮无新RPC。合成提醒示例与真实历史结果分开，liquidity-watch只有格式示例。阈值未经过P5效果验证。

## 下一窗口交接

由用户明确安排后进入P5 Task5.1，P4完成后停止。继承新鲜P2 sourceHash与P3覆盖/时间/报价合同，从buildMetricsReport读取数据。不能把metric_windows裸缓存当当前数据。

历史minute-close决策必须避免前视；实录按保存批次与observedAt复算，同一evaluateSignal核心可复用。保留两条确认规则独立命中结果、未计价/缺口/零基线、池出生前历史限制与右截尾。不得将离线回放接入实时通知sink。

首版提醒均为provisional。P4对历史修正采取证据失效撤回并重评当前状态，尚不是精确历史策略重演。默认follow只记录；--notify local下每批原子更新信号。全scope重建开销仍在，2秒是轮询配置，实际延迟和持续运行留给P6验证。

不连接钱包、不执行交易、不启动永久服务；原research、tooling、.agents和缓存保留。历史部署起点、公共RPC完整性假设继续保留，毛交易费估计不是账户收益。

## 历史验收

[P0](docs/reviews/2026-09-08-p0-review-acceptance-resolution.md)、[P1](docs/reviews/2026-09-08-p1-acceptance.md)、[P2](docs/reviews/2026-09-08-p2-acceptance.md)、[P3](docs/reviews/2026-09-09-p3-acceptance.md)。P4开始前实际基线477个测试，旧文档中的344/401/453均为历史验证时点。