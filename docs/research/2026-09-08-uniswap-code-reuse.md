# Uniswap 现成解析代码：复用调查

核查日期：2026-09-08。仅查看官方/项目源码与配置；没有 clone、安装或运行这些索引项目。main 链接是阅读入口，P0 接入时必须锁定 commit/package version 与 ABI hash。

## 结论

有现成代码，尤其 Envio 的 V4 indexer 已含 Robinhood Chain 4663。首版复用官方 ABI + viem 解码 + 必要 SDK 数学，并对照已有索引器处理。我们需要新增的是围绕 RWA 的发现、记录完整性、短窗规则与通知，不是重写通用 ABI 解析器。

## 扩大调查：使用基础与 RPC 自托管

用户进一步要求避开依赖使用者很少的单一项目。以下为2026-09-08 GitHub页面可见的约数，代表关注量而非实际用户数，也不作为兼容性验证。

| 项目 | stars约数 | 仅自有RPC | 能直接复用的层 | 本项目定位 |
|---|---:|---|---|---|
| [ethers.js](https://github.com/ethers-io/ethers.js) | 8.7k | 是 | Provider/getLogs、Interface.parseLog，MIT | 独立解码对照；也可替代viem作为RPC库 |
| [viem](https://github.com/wevm/viem) | 3.6k | 是 | ABI类型推导、原生bigint、公共RPC，MIT | 默认生产基础库 |
| [Graph Node](https://github.com/graphprotocol/graph-node) | 3.1k | 是，部分handler需archive/trace | 索引、实体回滚、官方Uni subgraph mappings | 完整服务候选，Postgres/IPFS/Graph工具链较重 |
| [Ethereum ETL](https://github.com/blockchain-etl/ethereum-etl) | 3.1k | 是 | Python原始blocks/receipts/logs导出，MIT | 历史导出备选；不能把lag当自动分叉回滚 |
| [Subsquid squid-sdk](https://github.com/subsquid/squid-sdk) | 1.3k | 是 | EVM批次、RPC datasource、hot-block恢复，Apache-2.0 | 如果采用完整索引框架，优先评估 |
| [Ponder](https://github.com/ponder-sh/ponder) | 1.1k | 是 | TS索引与Postgres，MIT | 次选完整框架，需适配原始证据输出 |
| [Envio V4示例](https://github.com/enviodev/uniswap-v4-indexer) | 56 | 框架支持 | Uni V4应用handlers与本链配置 | 参考，不是默认运行依赖 |

ethers 的 Interface.parseLog 可以直接解析 topics/data；它与viem都无需专门的Robinhood插件，EVM链ID、RPC与合约ABI配置正确即可。两者均是通用底层库，不能仅安装就自动获得本项目的历史记录、重组outbox与热度规则。[ethers ABI 文档](https://docs.ethers.org/v6/api/abi/)

Subsquid的当前release提供独立RPC数据源，可不使用其Gateway；持久化通常搭配TypeORM/Postgres，热块回滚仍需要正确的finality设置。接入时固定所用API版本，避免混用旧EvmBatchProcessor和新的data source接口。[SDK releases](https://github.com/subsquid/squid-sdk/releases)

Graph Node自托管支持按provider声明archive/traces等能力；这与购买The Graph线上数据是不同选择。若只是本机机会提醒，完整运行栈的投入较大；若日后需要多消费者GraphQL查询，再评估。[Graph Node配置](https://github.com/graphprotocol/graph-node/blob/master/docs/config.md)

**最终默认不依赖Envio示例。** 使用viem + 官方Uni ABI/SDK；P2开发测试用ethers交叉解码。如果P1测得自维护摄取复杂度超过收益，优先比较Subsquid RPC-only适配器，保留当前RangeBatch/分钟索引/范围修正/告警合同。

| 来源 | 查到的具体能力 | 本项目使用方式 |
|---|---|---|
| [wevm/viem](https://github.com/wevm/viem) | PublicClient、getLogs、decodeEventLog；MIT | 直接包依赖，严格 topics/data 解码；无 WalletClient |
| [Uniswap/sdks](https://github.com/Uniswap/sdks) | V3 computePoolAddress、V4 Pool.getPoolId、TickMath 等；MIT SDK | 只使用纯函数；按需要安装包，不引入交易构建器 |
| [Uniswap/v3-core](https://github.com/Uniswap/v3-core) | Factory/Pool 接口、事件与状态定义 | 官方 artifact/最小 ABI 真源，锁版本和文件许可 |
| [Uniswap/v4-core](https://github.com/Uniswap/v4-core) | IPoolManager、PoolKey/PoolId、StateLibrary | ABI、poolId、状态语义；接口与实现逐文件区分许可 |
| [enviodev/uniswap-v4-indexer](https://github.com/enviodev/uniswap-v4-indexer) | Initialize、Swap、ModifyLiquidity 的独立 handlers，多链实体和配置 | 事件映射对照；完整框架是候选采集后端 |
| [Uniswap/v3-subgraph](https://github.com/Uniswap/v3-subgraph)、[v4-subgraph](https://github.com/Uniswap/v4-subgraph) | 已有事件到实体、池状态/统计的实现 | 阅读源码作语义对照，不调用其在线数据服务 |
| [ponder-sh/ponder](https://github.com/ponder-sh/ponder)、[marktoda/v4-ponder](https://github.com/marktoda/v4-ponder) | EVM 索引框架、V4 创建/Swap 示例 | 备选；Ponder 当前 README 明确 Postgres，不能当成零依赖 SQLite 包 |

SDK monorepo 是当前优先入口；不要围绕旧的独立 v3-sdk 仓库搭新工程。[V3 纯函数目录](https://github.com/Uniswap/sdks/tree/main/sdks/v3-sdk/src/utils)、[V4 Pool 实现](https://github.com/Uniswap/sdks/blob/main/sdks/v4-sdk/src/entities/pool.ts)

## Envio：已经有本链配置

[config.yaml](https://github.com/enviodev/uniswap-v4-indexer/blob/main/config.yaml)当前包含 chain 4663，start_block 为 9070，PoolManager 为 0x8366a39cc670b4001a1121b8f6a443a643e40951。9070 是该项目的配置起点，不能未经链上验证就称为官方部署块。

其源码按动作分文件：

- [initialize-handler.ts](https://github.com/enviodev/uniswap-v4-indexer/blob/main/src/handlers/initialize-handler.ts)：PoolKey/资产与池实体建立。
- [swap-handler.ts](https://github.com/enviodev/uniswap-v4-indexer/blob/main/src/handlers/swap-handler.ts)：Swap 后状态与统计更新。
- [modifyLiquidity-handler.ts](https://github.com/enviodev/uniswap-v4-indexer/blob/main/src/handlers/modifyLiquidity-handler.ts)：区间流动性变更。

配置还包含 Donate、ProtocolFeeUpdated 等事件；不能仅因列在配置就假定每类业务统计均已实现。README 指向 Envio HyperIndex/HyperSync；配置启用 Postgres、ClickHouse，运行还涉及 Docker。已含本链配置不代表已在本机验证 RPC-only 路径、历史覆盖、吞吐或延迟。

可参考 handlers 的责任划分与事件字段，不直接采用其所有 USD 定价、TVL、用户计数和累计费口径。本项目关心小时内的 RWA 收费窗口，且要求 raw 输入可重放。

本次根目录和 package.json 未确认到该 indexer 的明确许可证声明，因此先作阅读与对照，不把整段实现复制进本项目。若后续直接 fork/复制，先记录实际 LICENSE；这个限制不影响用官方 ABI 和已明示许可的 SDK/viem 完成解析。

## ABI 与 SDK 具体落点

| 本项目文件（P0/P2 创建） | 上游真源 | 验收 |
|---|---|---|
| src/protocols/uniswap-v3/abi.ts | IUniswapV3Factory、IUniswapV3PoolEvents 与读取接口 | PoolCreated、Swap、Mint、Burn、Collect topic 与类型一致 |
| src/protocols/uniswap-v4/abi.ts | IPoolManager/IProtocolFees、状态读取 ABI | Initialize、Swap、ModifyLiquidity、Donate、ProtocolFeeUpdated |
| src/protocols/uniswap-v4/pool-key.ts | PoolKey.sol、PoolId.sol；SDK Pool.getPoolId | 完整五字段 hash 与真实 Initialize.id 一致 |
| src/metrics/price.ts | SDK 价格/TickMath；Q64.96 公式 | token0/token1 顺序、decimals 不同与极端 tick 无浮点丢失 |
| src/protocols/uniswap-v3/decode.ts | 官方 ABI + viem.decodeEventLog | 输入正/输出负，保留 raw amount |
| src/protocols/uniswap-v4/decode.ts | 官方 ABI + viem.decodeEventLog | 输入负/输出正，保留 raw amount 与实际 fee |

ABI 文件可从固定版本的官方 artifact 生成，保留来源与 notice；生成后 runtime 不访问 GitHub。若只声明必要事件签名，仍须与官方 artifact 做机器比对，避免手打字段类型出错。不要根据项目根 LICENSE 推断所有 Solidity 文件同一许可；V3 接口、V4 MIT 接口与 BUSL 核心实现存在区别。

## 两个已核实的语义差异

V3 Swap amount 是池余额 delta。V4 的核心返回 delta 对应调用方需 settle/可 take 的金额：输入负、输出正。V4 的 Pool.swap 构造 delta 后，PoolManager 原样发事件，测试 Router 以负输入的相反数进行支付。实现时必须以真实日志和上下游测试对照，不能直接套同一符号函数。[V3 事件](https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolEvents.sol)、[V4 测试 Router](https://github.com/Uniswap/v4-core/blob/main/src/test/SwapRouterNoChecks.sol)

V4 Swap.fee 是 effective swap fee，含协议费与 LP 费的组合。hook 的 afterSwap 还可能改变最终结算，核心 Swap 量与最终用户收支不能强行等同。[PoolManager](https://github.com/Uniswap/v4-core/blob/main/src/PoolManager.sol)、[Pool.sol](https://github.com/Uniswap/v4-core/blob/main/src/libraries/Pool.sol)、[ProtocolFeeLibrary](https://github.com/Uniswap/v4-core/blob/main/src/libraries/ProtocolFeeLibrary.sol)

## 复用后仍需自己实现什么

| 层 | 现成组件能做 | 本项目必须增加 |
|---|---|---|
| ABI/RPC | typed logs、无损整数、地址/哈希 | provider 能力与限流、原始响应证据 |
| Uni 事件 | 池与动作定义、纯数学 | RWA 双方向发现、同块新池补取、带版本登记 |
| 索引 | 框架通常已有事件处理/数据库能力 | 验证本项目要求的分叉原始数据、离线导出与恢复语义 |
| 机会 | 没有针对本需求的已验证规则 | 60s 候选、5m 确认、再热、活跃 L 竞争、费用可信度 |
| 研究 | 基础池统计与查询 | 完整出生队列、失败样本、后续 15/60/180m 机会窗口 |

## P0 的依赖验收材料

生成 artifacts/p0/dependency-evidence.json，记录 repo URL、commit、包名/版本、artifact 路径、ABI hash、许可标识和本机导入测试结果；未知字段不能编造。当前调查没有把 main HEAD 固定成不可变版本，这是正式接入时的必做项。

验收既要有合成极端值，也要有本链真实日志：V3 与 V4 至少各一组 Swap，V4 Initialize 的真实 poolId，至少一类实际流动性变更。缺少某类真实事件要保留空缺状态，不能用构造 fixture 冒充捕获证据。
