# P2 协议解码与最近观测验收

时点补记：本报告记录原 P2 验收当时状态，后已提交为 `ffc8b54`。后续 p2-v2 修复、零侧 Swap 新行为及当前测试结果见 [复核修复记录](2026-09-08-p2-review-fixes.md#修复记录)；下文历史计数和 artifacts 不追溯改写。

日期：2026-09-08。结论：**P2 passed**。当前分支 `feat/p2-protocol-state`，基线为 P1 审查修复提交 `e8e3b9f`；本轮改动未提交、未推送。

## 已交付

- 官方固定 ABI + viem 的 V3/V4 业务解码，金额全程 bigint。V3 正值为输入，V4 反号后归一化；非法编码、未知 topic、零侧/同号 Swap 保留原始日志与错误类别。
- V3 Mint/Burn 和 V4 ModifyLiquidity 保留有符号 L 变化。Collect/Donate 单独记录；本金金额不会被当作 L。V3 fee 取登记值，V4 fee 取 Swap 实际字段。
- 最近 Swap 与最近流动性动作独立保存。Burn 不会推算新的当前 L；价格、tick、L 保留上次 Swap 的事件位置、时间粒度，以及是否早于最近流动性动作。
- 仅使用指定 scope 的 active_logs、有效时间及池登记投影。重建在同一 SQLite 事务中替换事件、观测、错误及处理游标。sourceHash 同时覆盖日志、时间、登记、范围与版本，重扫/时间修订/登记回滚后拒绝返回旧投影。
- 离线 `project` 与 `inspect-pool`，无需 RPC 环境。AMC/USDG 别名按已登记代币匹配，配置池顺序变化不会换成别的交易对。新 migration 随构建复制。

## 命令及结果

| 命令 | 结果 |
|---|---|
| `pnpm run typecheck` | 退出 0 |
| `pnpm test --reporter=json --outputFile=artifacts/p2/tests.json` | 退出 0；32 文件、344 passed、0 failed、0 skipped |
| `pnpm run build` | 退出 0 |
| `pnpm run lint` | 退出 0 |
| `node dist/cli.js project --db data/p2-acceptance.sqlite --rebuild` | 退出 0；650 事件，质量错误 0 |
| `node dist/cli.js inspect-pool --db data/p2-acceptance.sqlite --config config/robinhood.json --pool amc-usdg-v3` | 退出 0；分钟精度，精确秒数 null |
| `node artifacts/p2/verify-acceptance.mjs` | 退出 0；ethers 独立对照、源表未变、源码/构建 SHA256 |
| `git diff --check` | 退出 0 |

完整验证及最终源码/构建哈希：[acceptance.json](../../artifacts/p2/acceptance.json)。测试报告：[tests.json](../../artifacts/p2/tests.json)。沿用 SDK 缺失 source-map 源文件提示；测试未跳过或屏蔽这些提示。

## 真实数据与合成测试分别说明

P1 已验收录制库 `data/p1-acceptance.sqlite` 通过只读连接的 SQLite online backup 生成 `data/p2-acceptance.sqlite`，投影只修改副本。[来源记录](../../artifacts/p2/source-db.json)。验收脚本逐表比较原始日志、有效集合、登记、时间、范围与游标，源内容与副本中的 P1 表一致。

本轮没有新 RPC 调用。对既有历史录制，ethers 与本轮生产投影独立解码对照：

| 事件 | 数量 |
|---|---|
| V4 Swap | 556 |
| V3 Swap | 47 |
| V4 ModifyLiquidity | 37 |
| V3 Burn | 5 |
| V3 Collect | 5 |

650 个有效事件全部保持分钟归桶，exactTimestampSec=null。1827 是已登记池数，其中 29 个池在本段有 Swap/流动性动作，不代表 1827 个活跃池。[解码对照](../../artifacts/p2/decode-comparison.json)、[实际有观测的池](../../artifacts/p2/observed-pools.json)、[AMC 查询](../../artifacts/p2/inspect-amc-usdg-v3.json)。

P0 固定归档哈希不变。另有真实 V3 Swap 1 条、V4 Swap 531 条的回归：V4 530 条普通成交，1 条 `(-1,0)` 保留 invalid-direction；另核对 27 条 ModifyLiquidity。P0 Manager 广域归档缺多数对应 Initialize，这部分测试使用明确标注的合成登记参数，只验证原始事件格式、符号、Swap fee 和后状态，不声称核实了那些历史池的币种或登记 fee。

合成测试覆盖四种方向、超大整数、非规范编码、动态 fee flag、零 L、Burn 后旧观测、跨池拒绝、移除/retime/事务失败、scope 隔离、失败原始批次排除、V4 同块 Initialize+Swap、独立发现 scope 撤回，以及 CLI 无 RPC 路径。

## 审查与限制

[独立审查](2026-09-08-p2-review.md)最终 spec compliance/code quality 均 PASS。发现的 AMC 别名依赖数组顺序已修正；V4 跨 scope 回归已补充并复核。

P2 使用全 scope 重建，复杂度和内存随保留日志/池数量增长；inspect 的过期校验也读取该 scope。它是离线显式投影，尚未挂到每个 recorder 批次，不能称为持续热度服务。重新采集后应再执行 `project --rebuild`；`inspect-pool` 发现过期返回 4。下游 P3 必须通过校验后的投影或显式重建读取，不能把旧 projected_events 裸表当最新集合。

未实现分钟成交排名、告警、完整历史评估、当前完整池状态、feeGrowth 或 LP 收益。历史部署起点仍未核实，沿用 P1 的 RPC 完整性假设与 provisional 状态。未新增依赖、未改变 ABI/配置版本、未连接钱包、交易或启动永久服务。

## 下一窗口

由用户安排 P3，读取 [P3 计划](../superpowers/plans/2026-09-08-p3-metrics.md)，从 **Task 3.1 成交计价与统计单位** 开始。复用本阶段事件/观测、raw 有效集合与分钟时间；保留未知估值和覆盖缺口，不以登记池数或 actor 数代替活跃池/用户数。
