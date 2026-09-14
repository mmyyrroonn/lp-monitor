# 历史区块复盘

```powershell
pnpm lp history --from-block 22500000 --to-block 22501000 --db data/recorder.sqlite --out artifacts/history
# 可选：--config config/robinhood.json --watchlist config/watchlist.stocks.json
#       --metadata config/metric-metadata.json --max-rpc-calls 10000
```

区间为包含两端的安全整数区块号。历史复盘独立于 `follow`，不启动实时监控、不评估信号、不发送通知。每次在输出目录创建唯一的 `history-UUID` 文件夹，其中包含 `review.sqlite`、`history-report.json` 和需要补采时的请求证据。不会覆盖已有复盘目录。

## 本地优先与缺口

已有源数据库通过 SQLite backup 建立一致快照（包含 WAL 中已提交的数据），之后所有补采只写复盘数据库。源库不存在时，从空的复盘数据库开始；不会创建或修改源库。复盘输出中的 `databasePath` 可以作为下次 `--db`，复用本次补齐的历史。

只有属于当前 watch scope 的 accepted range，并且有完整的预期 shard 集合、成功状态、响应 hash、可重算一致的 manifest hash，才计入本地覆盖。不能把有原始日志、transport 成功、单一 filter 完整或已有衍生缓存视为全部覆盖。本地 operation 区间及独立 discovery 上下文均完整时不创建 RPC reader，也不需要 RPC 环境变量。报告是记录证据快照，并不额外验证当前链的 canonicality。

每次独立检查 discovery 上下文，报告 `registryMissing`。起点取同配置持久化身份记录中已验证的部署起点；无法证明时从 0 开始。注册表从 accepted discovery 日志重新解码，不把缺失的 pools 缓存视为不存在池。有任一类缺口时，RPC 先验证部署身份及区块上限。池发现需要从经验证的部署起点到请求终点的上下文，但只补这个上下文中没有 accepted coverage 的片段；随后按恢复后的注册表重新检查每个预期地址和 topic selector 的 operation 覆盖，只抓取仍缺少的片段。新发现的池会使之前较窄的 operation 请求不足以证明覆盖，必要时重新抓取包含该新 selector 的区间。池发现未完整时不以不完整注册表抓 operation 缺口。身份检查、终点和时间边界查询是必要的辅助 RPC，不能把它们算作重复 operation 区间抓取。请求预算、RPC 失败或缺失环境变量保留在 `unavailable`，operation 未完成区间保留在 `missing`，discovery 未完成区间保留在 `registryMissing`，任何一类缺口都会使 `complete` 为 false；退出码为 4。源库的实时 cursor、健康文件、缓存和通知 outbox 不受影响。

## 结果口径

- `projection.events`、`valuations` 和 `activity` 仅包含请求区间中已覆盖部分的事件。缺失片段中的旧 active log 不计入结果。
- `activity[].coveredSubset` 包含明确的已覆盖 `ranges` 及其 `activity` 汇总；完全无覆盖或注册表未知时为 null。`intervalTotal` 仅在整个 operation 区间、discovery 上下文及解码均完整时提供；缺口不会被呈现为完整区间零成交量。
- 复用实时指标的 `valueSwap`、`quoteFromRwaUsdgSwap`、`aggregateRwa`，提供 token 原始整数、USDG 原始整数及 USD micros。USD 采用 USDG=1 USD 假设，并非外部市场报价。pool activity 对跨池同交易仍保留多跳累计和交易去重原有口径。
- metadata 仅从其 observation block 向后沿用，已知 hash 冲突会排除该条目；缺少有效 decimals 或报价保留 null。非 USDG 池只使用本区间内先发生、符合时效要求的 RWA/USDG 报价。不会从未来报价补值，也不会默默扩大区间抓取报价预热数据。
- 区间边界可能落在分钟内部，不输出伪造的完整分钟窗口。任意 to-block 没有精确存储 anchor 时，顶层 `end` 为 null。为解码复用的 projection.end 可以是源库记录的 scope tip，只是投影元数据，不能用它当请求区间终点或分钟验收依据。时间无法解析仍显式保留 unresolved。
- `sourceHash` 标识本次范围日志、时间映射、注册表和缺口，不代表对当前链或盈利能力的独立证明。

股票共池按双方各自原始数量与前序报价计入各股票，池成交证据只保留一份。回顾副本读取已有 token_metadata 精度缓存；查询区块之前的成交仍不使用该精度。

## H3/H4 固定历史作业与研究

H3 的 `history-job` 使用固定目标和独立 study DB。prepare/status 不访问 RPC；首次准备从源库做一致性 SQLite backup，并保存 config、watchlist 和源数据库输入 hash。registry、operation、time、metadata/pricing 缺口分别记录，`missing` 只是汇总视图。预算/时限进入 `paused`，可重试故障进入 `waiting-retry`，输入 hash 变化或本地持久化错误进入 `failed`；resume 不清零累计 RPC。

```powershell
pnpm lp history-job prepare --spec config/history-job.json
pnpm lp history-job status --db data/history-study.sqlite --job JOB_ID
pnpm lp history-job run --db data/history-study.sqlite --job JOB_ID --duration 10m --max-rpc-calls 1000
pnpm lp history-job resume --db data/history-study.sqlite --job JOB_ID --duration 10m --max-rpc-calls 1000
```

H4 导出与 study 只读取本地原始证据和保存的输入快照。1m、5m、15m、1h 使用滚动 `(T-duration,T]`；边界、报价、元数据或分钟证据不足时保持 unknown，不把缺失当作 0，也不计算未经执行模型验证的 LP 收益。真实 RPC 目录、一天级资源基准和多日历史采集属于 H5，需由用户在新的执行窗口明确固定范围、数据库、输出目录、时长与预算后再运行。