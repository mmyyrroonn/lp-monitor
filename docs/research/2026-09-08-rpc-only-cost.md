# 仅提供 RPC 的部署方式与成本

核查时间：2026-09-08。用户偏好：低成本，自己提供 RPC，程序可在本机同步；不依赖付费索引后台。

## 推荐

~~~text
用户提供 Robinhood HTTP RPC（可选 WS）
    → Node.js + viem，读取相关合约日志
    → 本机 SQLite，增量存储和恢复
    → RWA/池指标与本机提醒
~~~

本方案没有 Envio/GMGN/Uni 数据平台订阅费。RPC 本身可能按请求、计算单元、流量收费，本机需要磁盘、电力与运行时间；没有实测用量前不承诺“每月零元”或固定月费。免费公共 RPC 可用于 P0 探测，稳定性与历史覆盖以实测为准。

## 三种“自己同步”的区别

| 方式 | 能否只提供 RPC | 费用与运维 | 本项目选择 |
|---|---|---|---|
| 轻量日志索引器：viem + SQLite | 可以 | RPC + 本机；自己负责记录与恢复代码 | 首版默认 |
| Envio HyperIndex 本机运行 + RPC source | 可以 | 无需购买 Cloud/HyperSync；自管其运行栈，仍有机器/RPC成本 | 备选，复用已有 V4 handlers |
| Robinhood Nitro 全节点/归档节点 | 需要 L1 execution + beacon 等条件 | 全链同步、较大硬件和磁盘开销 | 首版不需要 |

Envio 官方许可文档明确允许自托管及提供 RPC 绕过 HyperSync；它的框架并非 OSI 认可的开源许可。本机自用路线可以评估，不能把框架许可与某个示例仓库许可混成一个结论。[许可说明](https://docs.envio.dev/docs/HyperIndex/licensing)

Envio V3 文档的 RPC 历史同步选择为 rpc 条目中的 for: sync；旧版 rpc_config 语法不能直接复制到新版。指定普通 fallback RPC 不等于已经禁用 HyperSync。若以后选此方案，锁定框架版本并通过网络访问清单确认只访问用户 RPC。[RPC 配置](https://docs.envio.dev/docs/HyperIndex/rpc-sync)

Envio Cloud 当前页面列出 Development 免费、Production 70–800 美元/月；免费开发部署有存储/事件及自动删除限制。此为官网报价范围，不是本项目用量报价，也不构成我们必须购买的服务。[托管价格](https://envio.dev/pricing/hosting)

Robinhood 官方全节点要求包括 8+ 核 CPU、64GB 内存（推荐128GB）、数 TB 本地 NVMe，以及 L1 execution/beacon 接口。归档节点需要更多存储；当前发布的 pruned 快照不能当作历史状态归档。[官方节点说明](https://docs.robinhood.com/chain/run-a-full-node/)

## 把费用控制写进实现

1. 先观察 AMC 的相关池，再扩展 RWA；按地址/topics 过滤，不扫描全链每笔 calldata。
2. 历史池发现从核实的 Factory/Manager 起点扫描必要事件；操作历史只回填研究区间及 warmup，避免全部操作从创世重扫。
3. 默认每2秒动态合并全部新增块查询，积压时连续分段追赶；每次eth_getLogs读取整个范围，再在本地有序处理。10块一次可配置，实测及块头成本限制见[批量查询](2026-09-08-batched-rpc.md)。
4. V3 地址分组、V4 poolId 分组；批量只读不等于供应商计费单元减少，分别计数 RPC method 调用和实际费用权重。
5. 不每Swap额外eth_call，不逐块取Header。按批端点及分钟边界归桶；只保存最近Swap观测，LP费用/仓位核验移出首版，见[日志优先方案](2026-09-08-logs-first-heat.md)。
6. live 与 backfill 共用限流预算，先服务实时；历史请求限速，遇 429 指数退避。
7. 默认不 trace 全部交易。只给少量需要解释的候选 tx 做可选核验。
8. P0/P6 报告 callsByMethod、responseBytes、retryCount、logsCount、dbGrowthBytes、headLag 与延迟，按供应商实际价格换算预算。

配置约定：maxRpcRps=5、maxConcurrentRpc=2、maxBackfillRpcRps=1 是初始软预算，P0 根据供应商限制调整。限额低于追块需求时应报告追块滞后；不能为了省请求静默漏块，也不能自动升级付费套餐。

估算方法：以一段实测稳定运行的单位时间调用量外推，再单独加首次历史回填量与峰值余量。后台托管费、本机资源、RPC 配额分列；缺供应商费率就只报告用量，不编造金额。
