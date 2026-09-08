# 连续块批量查询与追块节奏

更新：2026-09-08。本页的全块头成本问题已由[日志优先热度方案](2026-09-08-logs-first-heat.md)取代：取消每块Header，改为少量端点与分钟边界。下方原始10块查询事实保留。用户目标是及时跟上链上的机会，允许攒一小段块后处理。默认采用每 2 秒获取全部新增块的日志，保留中间所有相关事件及其顺序。

## 对应 RPC

`eth_getLogs` 原生支持 `fromBlock` / `toBlock` 的连续范围，以及 `address` / `topics` 过滤。例如 101–110 是一次查询 10 块的匹配日志，下一次从 111 继续；不需要下载这 10 块的全部交易或逐笔查 receipt。[Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/#eth_getlogs)

`eth_blockNumber` 获取当前高度；也可用 `eth_getBlockByNumber("latest", false)` 同时取得链头的 hash、时间和高度。先固定数值 head，再查询同一范围的所有分片，避免各次 `latest` 指向不同终点。

JSON-RPC batch 是把多个方法调用放进一个 HTTP 请求；可用于需要补查的块头，但其中 10 个 `eth_getBlockByNumber` 仍是 10 次方法调用。它与一次 `eth_getLogs` 覆盖 10 块不同，实际计费须按供应商规则计算。[Geth batch 文档](https://geth.ethereum.org/docs/interacting-with-geth/rpc/batch)

## 公共 RPC 小样本实测

时间：2026-09-08 03:27:05 UTC（北京时间 11:27:05 附近）。来源是[Robinhood 官方列出的公共 RPC](https://docs.robinhood.com/chain/connecting/)，没有使用用户付费凭据。以下是终端结果摘要，不是 P0 的完整原始 fixture 或性能验收。

| 探测 | 结果 |
|---|---|
| 最新块头 | 高度 57,368,468，timestamp 1,788,838,021 |
| 往前 1,000 块 | 高度 57,367,468，timestamp 1,788,837,920；平均 0.101 秒/块 |
| V4 PoolManager 的 57,368,439–57,368,448 | `eth_getLogs` 一次成功，返回 35 条日志，涉及 10 块；单次耗时约 404ms |
| 日志字段 | 包含 blockHash、blockNumber、transactionIndex、logIndex、blockTimestamp |
| `eth_getBlockRange(from, to, false)` | 返回 -32601，method does not exist/is not available；该公共端点不能依赖此方法 |

V4 查询地址为 `0x8366a39cc670b4001a1121b8f6a443a643e40951`；此次为该 Manager 的全部事件，不代表 35 笔 RWA Swap。近 1,000 块的平均值意味着 10 块约 1 秒，不能把这一小样本当长期出块速率或 RPC 延迟保证。

当前 [Execution API 文档](https://ethereum.github.io/execution-apis/api/methods/eth_getLogs/)也列出 blockTimestamp；仍需在用户实际端点、SDK格式化结果中验证字段数值。后续20块探测发现公共端点55条该字段全为0x0，因此不能直接当时间；见上述新方案与原始证据。

## 实施决策

1. 默认 `pollIntervalMs=2000`，每次查持久化 cursor 后的全部新增块；查询的初始范围上限 `maxRangeBlocks=1000`，不是必须等到 1,000 块才查。10/20/100 等范围可配置比较。
2. 若 cursor=100、head=127，预算和响应限制允许时直接查询 101–127。积压超过范围上限时连续分段处理，不在每段后额外等 2 秒。没有积压时才等下一轮；同一游标只有一个活动采集任务。
3. 大范围/结果过多时缩小范围，单块超限拆地址或 poolId；429 按限流策略退避，不能靠缩块制造更多请求。一次失败不会把 cursor 跳到链头。
4. 每段仍先发现 PoolCreated/Initialize，再取扩大后的池集合在整段内的操作日志，覆盖新池最早的加池和成交。按 blockNumber、transactionIndex、logIndex 顺序处理。
5. 查询、解析、告警不要求每到一个新块就立即执行。内部保留块身份、链上时间和必要的有序状态更新；按批收到的数据只能记录实际到达时间，不能在回放中假装提醒已经在批内早先的块上送达。
6. 观察 `headLagBlocks`、`headLagSeconds`、每秒处理块数/事件数与其趋势。短暂积压能消化且延迟符合目标才算跟得上；一次日志请求成功不足以证明持续追块。

## 成本与原方案问题（已修订）

同一个过滤条件，10 次单块 getLogs 合成 1 次范围 getLogs，会减少该部分的方法调用数量。发现分片、操作分片、块头、状态核验和重试还要单独计数；总成本不会自动降到十分之一。

原方案每块取Header，在约9.9块/秒时会超出5 RPC/s初始预算；批量日志本身不能解决。用户最新选择热度优先后，已删除此要求：每2秒少量端点读取，跨分钟才查询分钟边界，不再按块数线性请求Header。

P0/P6分别测logs、端点、分钟边界和metadata用量；范围重扫与提醒修订替代完整parentHash账本。设计与P0–P6已同步更新，应用仍未实现。
