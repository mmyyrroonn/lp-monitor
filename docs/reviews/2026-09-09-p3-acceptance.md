# P3 分钟成交与热度验收

状态：**passed**。完成范围为 P3；P4 尚未开始。

## 实现范围

- `metrics` / `rank` 离线读取已通过 sourceHash 校验的 P2 投影；数据库读取事务涵盖分钟证据与资产登记，默认只读，`--save` 显式保存派生缓存。
- 每笔 Swap 只选一个计价侧；USDG 直接计量，Meme/RWA 只使用事件位置在先、保守年龄上界不超过 60 秒的 RWA/USDG Swap 报价。所有金额以 bigint 计算、十进制字符串保存。
- 原币量、Swap 数和 tx 集合独立保留；RWA 汇总重新去重交易，成交之和标作 poolActivity；同交易共现不冒充完整交易路线或人数。
- 本分钟、最近完整 1m、连续五个完整 1m、自然闭合 5m 分列。边界、同 scope 块范围、每个地址/topic 分区和投影质量均通过才能闭合；当前分钟单独验证已扫描前缀。
- 前置 60 个完整 1m／12 个完整 5m 为默认最小基线；不足或中位数为零时倍率为空。缺口、未计价成交、无精确秒数不补零。
- 流动性动作仅提供次数、方向与 tick 区间；L 取最近 Swap 观测及年龄区间；费用仅是 tokenIn 原币单位的毛交易费估计。

## 历史输入与证据

以 SQLite online backup 将 `data/p2-acceptance.sqlite` 复制到 `data/p3-acceptance.sqlite`，只在副本中重建投影和派生缓存。验证脚本逐表核对 P1 内容哈希并检查源库未改变。

已有历史输入包括 650 个有效事件，其中 603 笔 Swap，交易哈希去重为 313。29 个池有 Swap／流动性动作，不能与登记池数混淆。本轮无新增 RPC，金额属于该历史录制区间。

当前缓存来自 P0 的 AMC decimals=18、USDG decimals=6 身份快照。只从其记录区块向后沿用；与本地已知同高度哈希冲突时移除对应计价条目。缺少同高度证据时明确保留为历史沿用假设，不称为已重新核验。USDG 等同美元同样只是显示假设。

证据入口：

- [热度报告](../../artifacts/p3/amc-heat.json)
- [分钟覆盖](../../artifacts/p3/coverage.json)
- [排名](../../artifacts/p3/rank.json)
- [源库保护](../../artifacts/p3/source-db.json)
- [验收脚本](../../artifacts/p3/verify-acceptance.mjs)
- [验收汇总](../../artifacts/p3/acceptance.json)

## 审查与交接限制

独立审查发现并要求修复：成功但扫描过短的地址分片被同族其他地址掩盖；无价池安静分钟遗漏于原币基线；无事件登记池遗漏；L 观测锚点不一致；RWA 筛选证据未同步；缓存 decimals 与已知锚点冲突。全部修复已回归，最终独立审查 [PASS](2026-09-09-p3-review.md)。另修复 RWA 当前前缀不完整时仍汇总为零的问题，统一降级为 unavailable/null。

本阶段仍是显式离线计算。P2 全 scope 读取和 sourceHash 复核、P3 范围证据复核与派生缓存重建随保留数据增长；不是已运行的持续服务。CLI 当前只支持 `--window 5m`。分钟列表取末端最多 180 分钟的证据范围，未知时间事件另有块范围次数。

样本只有约半小时，不能验证默认一小时历史基线或判断阈值预测能力。新池／观察到的再活跃只是描述标签，未实现 P4 提醒状态机、通知、冷却或告警撤回。未实现完整历史队列、LP 净收益、交易或钱包连接。

下一窗口从 [P4 计划 Task 4.1](../superpowers/plans/2026-09-08-p4-alerts.md) 开始，由用户安排。

## 最终命令与结果

| 验证 | 结果 |
|---|---|
| pnpm lint | 退出0，脚本静态检查与格式通过 |
| pnpm typecheck | 退出0，含 scripts 类型检查 |
| pnpm test --reporter=json --outputFile=artifacts/p3/tests.json | 退出0，453通过/0失败/0跳过 |
| pnpm build | 退出0 |
| node artifacts/p3/verify-acceptance.mjs | 退出0，历史输入与源库保护断言通过 |
| 构建后 metrics / rank CLI | 两条命令退出0；具体参数见 acceptance.json |

[逐项退出码](../../artifacts/p3/verification.json)、[全量测试](../../artifacts/p3/tests.json)。原有上游 SDK 的 source-map 缺源文件提示仍存在，未隐藏，不影响检查结果。

最终历史报告：1827个登记池保留窗口；603笔Swap、313个不同交易；34笔未计价；29个完整分钟、1个当前partial；默认基线未就绪的状态明确保留。`amc-heat.json`与CLI展示摘要，不重复输出每池历史分钟数组；完整分钟行已存入副本的metric_windows，验收脚本可复算。`baselineMedianNumerator/Denominator`表达精确中位数，避免先取整扭曲倍率。

本轮用合成测试覆盖范围缺块/缺分片/成功但短扫、空分钟与时间跃迁、同交易跨池和跨分钟去重、先前/过期/未知报价、出生前历史、旧Swap移除/retime、元数据分叉冲突、RWA筛选与当前前缀、持久化事务失败及无RPC命令。真实历史与合成测试证据分开，不将历史样本当作现在的热度。
