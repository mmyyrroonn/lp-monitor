# Robinhood RWA 短时 LP 机会监控：实施入口

## 2026-09-12 实时增量修正与独立历史回顾

实时 `follow --notify local` 已改用持久化增量协议投影、逐事件估值和分钟/五分钟贡献缓存。普通批次只解码新增或修订事件，未变时间桶复用已有结果；实时计算保留规则所需有界窗口（默认180分钟，包含60分钟基线，另读最多120秒报价上下文），过期贡献退出热路径，原始证据保留。

重复日志不重复计数，链重组/retime/登记/覆盖修订通过脏记录修复并撤回受影响的 provisional 提醒。待撤回修订持久化，不因一次独立指标读取而丢失。缺少可证明时间窗口的边界时标 incomplete，不回退扫描全部未知时间历史。首次升级或协议投影版本变化允许一次迁移重建；后续正常批次不做全历史重建。

`history --from-block N --to-block M` 是独立历史回顾入口：本地完整证据优先，仅补缺失区间，使用隔离回顾数据库，不写实时通知。见[历史回顾说明](docs/history-review.md)。`project --rebuild` 和 `replay/study` 保留为显式离线入口，历史输入覆盖不足仍如实报告。

本次验证只运行短时离线回归、类型检查、格式检查和构建，不重新启动长时实链验收；旧P6两小时验收状态不因此改变。

更新：2026-09-10。**P0–P4 已验收；P5完整历史评估 incomplete；P6 最终冻结前 74 文件 / 740 项测试及 typecheck、lint、build 通过；30 分钟冒烟通过，前两次长观察均保留为失败，21:35:48 启动的最终构建实测已按用户要求在约 56 分钟时停止，完整 2 小时验收未完成。** P5 原生 P1 导出与长窗口性能未完成。 P4提供候选、热度确认、翻倍升级、降温、再热、修订撤回和本机通知。[P4验收](docs/reviews/2026-09-09-p4-acceptance.md)、[独立审查](docs/reviews/2026-09-09-p4-review.md)、[实施状态](docs/implementation-status.md)、[运行说明](README.md)。

目标：解析Robinhood Chain的Uniswap V3/V4链上事件，观察有限RWA集合，发现关联新Meme、老Meme再次放量，以及具体RWA/USDG池的短时成交热度。首版以热度排名与提醒为核心，不做精确LP模拟。

## 新窗口从这里开始

1. 阅读[架构与数据口径](docs/superpowers/specs/2026-09-08-robinhood-rwa-monitor-design.md)。
2. 沿用[复用调查](docs/research/2026-09-08-uniswap-code-reuse.md)、[固定源码评估](docs/research/2026-09-08-lp-terminal-review.md)与固定协议ABI。
3. 查看[实施状态](docs/implementation-status.md)，只执行用户指定的阶段。
4. 按阶段计划实现、验证、保存证据并更新交接记录。

| 阶段 | 状态/交付                                                                                                    | 计划                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| P0   | passed；工程、依赖/ABI、RPC报告、真实日志                                                                    | [P0](docs/superpowers/plans/2026-09-08-p0-foundation.md)      |
| P1   | passed；动态池发现、范围日志、分钟索引、恢复                                                                 | [P1](docs/superpowers/plans/2026-09-08-p1-recorder.md)        |
| P2   | passed；解码、最近观测、离线投影重建                                                                         | [P2](docs/superpowers/plans/2026-09-08-p2-protocol-state.md)  |
| P3   | passed；分钟成交、计价降级、基线与排名                                                                       | [P3](docs/superpowers/plans/2026-09-08-p3-metrics.md)         |
| P4   | passed；状态机、outbox、修订撤回、本机通知                                                                   | [P4](docs/superpowers/plans/2026-09-08-p4-alerts.md)          |
| P5   | 修复检查通过；历史incomplete；原生导出与长窗口性能待完成；完整评估不阻塞P6                                   | [P5](docs/superpowers/plans/2026-09-08-p5-history.md)         |
| P6   | in_progress；740 测试通过，30 分钟冒烟 passed；第二次长观察仅因 p95 2,841 ms 失败，最终构建实测已按用户要求停止，长时延迟门槛待解决 | [P6](docs/superpowers/plans/2026-09-08-p6-live-validation.md) |

P5交付与限制见 [验收说明](docs/reviews/2026-09-10-p5-acceptance.md) 和 [研究结果](artifacts/p5/report.md)。

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

2026-09-09用户调整优先级：历史数据获取有现成能力就保留，缺少的暂时不补；不为完成P5新增历史采集或专门补齐研究样本。优先实时采集、热度统计与本机提醒稳定性，P5完整历史评估不再作为P6前置条件。2026-09-10用户要求实现P5，已实现可移植输入的replay/study；独立Review修复状态见验收说明，历史效果 incomplete。2026-09-10用户要求实现P6，现已进入实录验收。

当前 P6 Task6.1–6.3 已按用户要求暂停实测与进一步优化，运行命令与边界见[本机运行手册](docs/runbook.md)。第二次长观察完整运行后仅因 687 样本本机处理 p95 2,841 ms 超过门槛而失败；最终构建验收 runId `2026-09-10T13-35-48-773Z-6ec4891a` 于 21:35:48 启动，约 56 分钟后按用户要求停止，记录见 artifacts/p6/soak-user-stopped-report.json。在完整实测和报告核验前，不将 P6 标为 passed。处理详情见[独立复审处理记录](docs/reviews/2026-09-10-p6-review-response.md)。阈值可由用户额外分析提供，核对对象、单位、窗口、条件和来源后作为候选配置；未经独立评估仍标效果未验证。已有历史与后续实时录制数据保留待用，缺样本如实披露。实时启动、池发现、恢复及数据完整性所需的既有扫描继续保留。

继承新鲜P2 sourceHash与P3覆盖/时间/报价合同，从buildMetricsReport读取数据。不能把metric_windows裸缓存当当前数据。

历史minute-close决策必须避免前视；实录按保存批次与observedAt复算，同一evaluateSignal核心可复用。保留两条确认规则独立命中结果、未计价/缺口/零基线、池出生前历史限制与右截尾。不得将离线回放接入实时通知sink。

首版提醒均为provisional。P4对历史修正采取证据失效撤回并重评当前状态，尚不是精确历史策略重演。默认follow只记录；--notify local下每批原子更新信号。2026-09-12已改为增量投影和有界窗口；2秒仍只是轮询等待，实际长时延迟验收未补跑。

不连接钱包、不执行交易、不启动永久服务；原research、tooling、.agents和缓存保留。历史部署起点、公共RPC完整性假设继续保留，毛交易费估计不是账户收益。

## 历史验收

[P0](docs/reviews/2026-09-08-p0-review-acceptance-resolution.md)、[P1](docs/reviews/2026-09-08-p1-acceptance.md)、[P2](docs/reviews/2026-09-08-p2-acceptance.md)、[P3](docs/reviews/2026-09-09-p3-acceptance.md)。P4开始前实际基线477个测试，旧文档中的344/401/453均为历史验证时点。
