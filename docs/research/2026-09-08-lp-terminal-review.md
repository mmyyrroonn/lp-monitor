# lp-terminal：可借鉴模块与接入边界

核查：2026-09-08。仓库：[labrinyang/lp-terminal](https://github.com/labrinyang/lp-terminal)。本次通过GitHub页面与公开raw/API读取实际代码，未运行上游程序。

固定阅读基线：**c127e70a2a21ca40f5668d155587e36e80049277**，GitHub commit时间2026-08-15T07:12:25Z。以下链接固定到此基线；接入时保留上游版权与MIT notice，逐文件检查额外声明。[LICENSE](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/LICENSE)

## 结论

**值得借鉴，而且比泛用的V4展示示例更贴近本项目。** 它已有Robinhood 4663配置、V4 RPC目录、股票代币识别及SQLite存储，使用viem。可以抽取只读模块和测试，但它服务于池列表/仓位前端，不直接满足我们的逐块成交账本和短时异常提醒。

采用方式：viem与官方Uni ABI/SDK继续作为基础；lp-terminal成为Robinhood适配和RPC扫描的优先应用参考。按模块移植，保留本项目当前RangeBatch、原始日志、分钟索引、范围修正和热度告警合同。

## 已核实的适配情况

[robinhood.ts](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/src/config/chains/robinhood.ts)实际配置包括V3 Factory、V4 PoolManager/StateView及rpcDirectory。Robinhood的poolSubgraph和positionSubgraph均为null；V4目录走RPC分支。因此不能只看README开头就判断“只有BSC支持V4”。

其StateView候选地址为0xF3334192D15450CdD385c8B70e03f9A6bD9E673b；本项目P0仍需与官方部署和链上poolManager()/getCode复核。配置注释中的历史测量、费率档位、发行器与起始高度只是上游当时记录，不替代本项目的当前证据。

[package.json](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/package.json)固定viem 2.55.2；indexer使用Node内置SQLite，前端还有React/wagmi等。我们不需要为了复用扫描器安装完整前端依赖，也不因其版本号而跳过本机兼容性测试。

## 具体借哪些文件

| 上游模块 | 实际功能 | 本项目落点/修改 |
|---|---|---|
| [adaptiveLogs.ts](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/indexer/adaptiveLogs.ts) | 范围超限减半、先探测后并行、按顺序提交成功范围 | P1 fetch-range；补总预算、429分类、返回截断与blockHash验证 |
| [v4Rpc.ts](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/indexer/v4Rpc.ts) | RPC回填/追踪Initialize；新增token后补它的历史池 | P1 V4 discover；保留双方向topics与补历史思想，加入同块全部操作 |
| [v4Scope.ts](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/indexer/v4Scope.ts) | 已识别发行代币/股票任一侧，或核心token双侧，限定目录范围 | 改成官方RWA版本表驱动；RWA相关任意fee/hooks先记录，再分级分析 |
| [databaseIdentity.ts](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/indexer/databaseIdentity.ts) | 数据库绑定chainKey/chainId，拒绝混链与无依据旧库接管 | P1 SQLite启动校验，适配better-sqlite3接口 |
| [stockToken.ts](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/src/lib/stockToken.ts) | 读取proxy codehash与anchor slot，失败不冒充匹配成功 | P0/P1身份辅助证据；官方资产表仍是主登记，不永久缓存可升级状态 |
| [stockOrigin.ts](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/indexer/stockOrigin.ts) | 后台识别股票、识别后扩展历史V4目录 | 借鉴“身份新增要向后补池”；补持久化重试，避免一次失败后永远漏历史 |
| [uniV4.ts](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/src/lib/uniV4.ts) | PoolKey/PoolId、int24与仓位标识、StateView相关工具 | P2协议对照；优先SDK现成函数，必要轻量只读逻辑独立抽取 |
| [uniV4Positions.ts](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/src/lib/uniV4Positions.ts) | RPC重读仓位/当前状态，以range feeGrowth计算未领费 | 指定仓位扩展参考；不作为首版热点提醒前提 |

## 必须改造的边界

### 1. 事件刷新不是完整成交记录

[logtail.ts](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/indexer/logtail.ts)取V2 Sync、V3 Swap/Mint/Burn的地址集合，标记变化池再读当前状态；它没有把这些raw日志保存成逐笔成交历史。该文件的topic集合也不包含V4 Swap/ModifyLiquidity。

logtailWindow会在落后超过maxBlocks时从较新范围开始，并报告dropped。这个取舍适合有后续状态刷新补救的页面，但丢掉的Swap无法由当前state恢复。我们的P1必须保存并补齐范围，不能继承这个跳块策略。

### 2. 轮询频率与最终性不同

[config.ts](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/indexer/config.ts)默认V4目录追踪60秒、logtail60秒、普通factory tail300秒。我们的候选需要随完整块/小块段更新，不能照搬这些周期。

它的Robinhood默认finality blocks=12。该数量及目录重读120块可以减少部分问题，但不能等同Robinhood最终确认或完整分叉回滚。本项目使用原始日志键、active有效集合、稀疏检查点与outbox修订；按最新热度设计实现，已取消全块头canonical账本。

### 3. 页面成交量有第三方来源

[stats.ts](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/indexer/stats.ts)从GeckoTerminal取volume_usd.h24、交易数、储备与价格种子，再写入池统计。自托管indexer并不自动意味着页面所有成交统计都来自自己逐块计算。

本项目不能直接沿用这个stats数据入口作为异常放量或历史收益依据；P3自己累计已保存Swap。第三方数据可作为分列参考。

### 4. 仓位未领费不能直接拿来当热池收益

V4仓位代码通过当前range feeGrowth与position checkpoint之差，按模2^256处理后乘仓位L并除2^128。这可参考，但需要真实仓位和对应状态，不能代表任意后来加入LP的收益。

该模块在没有positionSubgraph配置时直接返回空，Robinhood配置正是null，因此不能把其V4仓位界面当成已覆盖Robinhood仓位发现。未来可以用自己记录的PositionManager事件/明确tokenId替代候选来源。

[usePositions.ts](https://github.com/labrinyang/lp-terminal/blob/c127e70a2a21ca40f5668d155587e36e80049277/src/hooks/usePositions.ts)的V3读取路径把positions()中的tokensOwed填入fees字段；尚未更新checkpoint的新增费用不能仅凭这个字段完整得到。P3继续区分gross费估计、LP分配核验与仓位收益。

### 5. 身份筛选不能影响原始数据完整性

上游股票探测以显示深度为优先级，并缓存部分身份结果。我们的官方RWA名单可直接作为观察输入，不要求新Meme先达到展示TVL才开始记录；身份未知、RPC失败与确定非RWA分开保存。

proxy/anchor匹配可作辅助检查，不能独立证明官方发行或经济权利。升级、拆股显示倍率和资产名单变动需要版本与时点，不能把“当前匹配”永久应用到所有历史。

## 纳入计划的具体动作

- P0：依赖证据表加入上述固定commit、MIT notice、官方合约交叉核验和StateView候选。
- P1：优先评估adaptiveLogs、databaseIdentity、v4Rpc的只读模块；继承对应测试思路，新增不跳块/同块新池/重组完整性测试。
- P2：用uniV4工具与官方SDK对照PoolId、int24、StateView字段；代码保持脱离React/钱包。
- P3：独立计算Swap量与费口径，不继承GeckoTerminal stats；明确V3 tokensOwed及V4仓位feeGrowth的适用边界。
- P4–P6：使用本项目自己的短窗状态机、完整raw回放与本机通知。

本次没有执行该仓库测试或部署，因此结论是“这些模块有明确复用价值”，不是宣布上游已经满足本项目验收。
