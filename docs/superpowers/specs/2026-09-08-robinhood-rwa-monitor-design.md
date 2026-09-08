# Robinhood RWA 短时 LP 机会监控：代码架构

日期：2026-09-08，修订为 logs 优先的热度监控。状态：供后续窗口实施的设计，不代表代码已经运行。对应入口：[START_HERE](../../../START_HERE.md)。

## 1. 要解决的问题

在 Meme 狂热的几分钟至几小时内，及时发现哪个 RWA、关联 Meme 和具体 RWA/USDG 池在放量，热度是否持续。用户最新明确：首版主要看热度，允许批量追块，不要求精确模拟 LP。

第一版从 AMC 股票代币开始，完成后扩展 NVDA、HIMS 和已核验 RWA 表。始终按 chainId + 地址识别；AMC 股票代币、AMC Meme 与 MEME 分开。

提醒回答：哪个池热、成交与交易次数是多少、比历史放大几倍、是新池还是再热、最近有哪些加减流动性动作、数据覆盖和时间粒度是什么。

首版取消全块头账本、完整 tick 状态重演、历史仓位初始化、feeGrowth/LP净费/IL/净收益模拟。身份、decimals 和稀疏时间检查仍允许只读 RPC；原始相关日志保留，历史用于评估提醒后剩余成交与热度持续时间。

## 2. 从研究保留的约束

- 新 Meme 和旧 Meme 重新放量都要发现。MEME 首次降温后再次爆发，冷却只能降低通知频率，不能永久注销池或资产。
- Meme 可以同时存在 AMC、USDG、WETH 等多个池；不能只跟踪 GMGN 主池，也不能把全部 Meme 成交都归给 AMC/USDG。
- 单根异常先出候选，短窗持续后升级；不等市值到 1M 才开始观察。
- 现有 AMC/MEME 研究里的阈值是候选规则，不能称为全历史验证后的最优参数。
- 已发现第三方代币 K 线和单池量不一致。链上账本独立建立，保留差异，不用比例强行换算。
- 日化 1%–5% 是曾观察到的展示毛费强度，不是本系统已验证的净收益目标。

研究依据：[AMC/MEME](../../../research/amc-meme/AMC与MEME案例研究.md)、[历史验证](../../../research/short-window-study/2026-09-07-短时机会监控-历史验证.md)。

## 3. 总体选择与代码复用

推荐 TypeScript strict + Node.js 24 + viem + SQLite 的单进程模块化应用。本机已核验 Node v24.19.0、pnpm 11.19.0；应用包由 P0 建立并锁定实际安装版本。当前项目只有研究与 GMGN 工具，不能把它描述成已有生产监控程序。

协议层使用官方 ABI 生成类型，用 viem 解码，用官方 SDK 的必要纯函数校验 PoolId 和价格数学。ABI 解码、Keccak、ABI encoding、TickMath 均不从零重写。

| 路线 | 适合的部分 | 本项目决定 |
|---|---|---|
| viem + 官方 ABI/SDK | RPC、严格事件解码、价格/PoolId 数学；运行组件较少 | 首版采用，自己的代码聚焦记录协议与机会业务 |
| Subsquid RPC-only | 通用EVM批次、回填、热块恢复，支持自有RPC | 若采用完整框架，优先备选；需适配原始证据合同 |
| Envio Uniswap V4 indexer | 已有 V4 handlers，配置已包含 4663；有数据库实体与多链配置 | 源码对照，不是默认运行依赖 |
| Ponder / v4-ponder | 通用 EVM 索引框架和 V4 示例 | 保留为替代方案；当前版本引入 Postgres，需验证数据导出与回放边界 |

Envio 已支持本链的配置这一点已查证，但尚未在本机运行；源码存在不等于我们的重组、延迟、原始数据保存要求已通过。若 P0 发现使用完整框架明显更省工作，可提出具体适配差异后修订设计；默认计划无需等待该可选评估。

完整调查：[GitHub 复用清单](../../research/2026-09-08-uniswap-code-reuse.md)。

用户提供的lp-terminal已做实际源码核查：已有本链V4 RPC目录和SQLite；优先参考adaptiveLogs、v4Rpc、databaseIdentity与只读PoolKey工具。其跳块状态刷新、GeckoTerminal成交统计、默认分钟轮询不符合本项目完整性/延迟口径；详见 [逐模块评估](../../research/2026-09-08-lp-terminal-review.md)。官方ABI仍是协议真源，不将应用仓库当唯一协议依据。

用户补充的成本约束：默认只要求用户提供 RPC，在本机增量同步，不引入付费托管依赖。Envio 本身也支持 self-host + RPC，可作为备选；详见 [部署与成本](../../research/2026-09-08-rpc-only-cost.md)。主流程按范围取logs、按事件顺序处理；少量范围端点和分钟边界查询替代每块Header。

## 4. 数据流与模块边界

~~~mermaid
flowchart TD
  RPC[HTTP RPC] --> Reader[每2秒连续范围 logs / 两遍发现]
  Reader --> Raw[SQLite 原始日志与扫描范围]
  Anchor[少量端点 / 分钟边界查询] --> Time[分钟归桶与检查点]
  Raw --> Accepted[有效日志集合 / 重扫修正]
  Time --> Accepted
  Registry[RWA与池登记] --> Reader
  Accepted --> Decode[官方 ABI + viem]
  Decode --> Metrics[成交 / 次数 / 放量 / 流动性动作]
  Metrics --> Alerts[热度排名 / 新池 / 再热 / 本机提醒]
  Raw --> History[分钟历史评估]
  History --> Metrics
~~~

单进程、SQLite 单写者；主数据来自 eth_getLogs，不扫描所有交易，不逐笔查 receipt/trace，不持续读取每池 slot0。WS仅为可选唤醒，不是必需条件。[RPC连接](https://docs.robinhood.com/chain/connecting/)

~~~text
src/
  cli.ts                         命令与退出码
  config/                        环境与版本配置
  domain/                        日志、范围、分钟时间、池、告警合同
  rpc/                           viem、能力、限流、稀疏anchor读取
  registry/                      RWA身份与V3/V4池登记
  protocols/uniswap-v3/           ABI、发现与解码
  protocols/uniswap-v4/           ABI、PoolKey与解码
  ingest/                        范围查询、分钟边界、重扫、恢复
  storage/                       原始输入、有效集合、投影、outbox
  state/                         最近Swap观测；无完整AMM模拟
  metrics/                       分钟成交、次数、报价与放量
  signals/                       热度、冷却、再热
  replay/                        实录复算和分钟历史评估
  notify/                        控制台与JSONL
  ops/                           用量、延迟、覆盖与交接
~~~

config/ 保存无密钥配置；tests/ 保存有意义的纯逻辑/范围恢复测试及小型fixture；data/ 为运行DB；artifacts/ 为验收证据。无需部署后台或安装全节点。

## 5. 核心数据合同

所有 bigint 无损持久化为十进制字符串；地址/hash统一小写。原始响应保留；有效日志与其时间归桶可修订，不覆盖原始证据。

~~~ts
import type { Address, Hex } from 'viem';
type PoolRef =
  | { chainId: 4663; protocol: 'v3'; address: Address }
  | { chainId: 4663; protocol: 'v4'; manager: Address; poolId: Hex };
type PoolKey = { currency0: Address; currency1: Address; fee: number;
  tickSpacing: number; hooks: Address };
type LogRef = { blockHash: Hex; blockNumber: bigint; transactionHash: Hex;
  transactionIndex: number; logIndex: number };
type BlockAnchor = { number: bigint; hash: Hex; timestampSec: number };
type WatchScopeId = string;
type RawLog = LogRef & { address: Address; topics: readonly Hex[]; data: Hex;
  rawBlockTimestamp: Hex | null };
type LogTime = { minuteStartSec: number | null; exactTimestampSec: number | null;
  source: 'log-verified' | 'minute-boundary' | 'unresolved' };
type MinuteBoundary = { timestampSec: number; firstBlock: bigint;
  before: BlockAnchor; at: BlockAnchor };
type RangeBatch = { id: string; scopeId: WatchScopeId; fromBlock: bigint; toBlock: bigint;
  end: BlockAnchor; previous: BlockAnchor | null;
  logs: readonly RawLog[]; observedAtMs: number;
  captureMode: 'live' | 'backfill' | 'synthetic';
  filterPlanHash: string; manifestHash: string;
  completeness: 'complete' | 'incomplete' };
type RangeChangeSet = { added: readonly LogRef[]; removed: readonly LogRef[];
  retimed: readonly LogRef[]; affectedFromBlock: bigint };
type Quality = { coverage: 'complete' | 'gap' | 'warming' | 'rechecking';
  timing: 'second' | 'minute' | 'unresolved';
  valuation: 'usd-estimate' | 'usdg-only' | 'unpriced' };
type Swap = { kind: 'swap'; ref: LogRef; time: LogTime; pool: PoolRef;
  rawAmount0: bigint; rawAmount1: bigint;
  tokenIn: Address; amountIn: bigint; tokenOut: Address; amountOut: bigint;
  sqrtPriceX96After: bigint; liquidityAfter: bigint; tickAfter: number;
  effectiveSwapFeePips: number | null };
type LiquidityChange = { kind: 'liquidity'; ref: LogRef; time: LogTime; pool: PoolRef;
  tickLower: number; tickUpper: number; delta: bigint; actor: Address;
  salt: Hex | null };
type AncillaryEvent = { kind: 'initialize' | 'collect' | 'donate' | 'other';
  ref: LogRef; time: LogTime; pool: PoolRef | null;
  decoded: Readonly<Record<string, string | number | boolean>> };
type PoolEvent = Swap | LiquidityChange | AncillaryEvent;
type PoolObservation = { pool: PoolRef; lastSwap: Swap | null;
  lastLiquidityAction: LiquidityChange | null };
type QuoteObservation = { token: Address; quote: Address;
  numerator: bigint; denominator: bigint; effectiveAt: LogRef;
  time: LogTime; source: string; maxAgeSec: number };
type Alert = { id: string; revision: number; pool: PoolRef;
  kind: 'candidate' | 'hot' | 'reheat' | 'cooling' | 'liquidity-watch' | 'retracted';
  atBatchId: string; atBlockHash: Hex; atBlockNumber: bigint;
  observedAtMs: number; windowStartSec: number; windowEndSec: number;
  finality: 'provisional'; quality: Quality; reasonCodes: readonly string[];
  evidenceEventIds: readonly string[];
  metrics: Readonly<Record<string, string | null>> };
interface ChainReader {
  getAnchor(block: bigint | 'latest'): Promise<BlockAnchor>;
  getLogs(filter: { fromBlock: bigint; toBlock: bigint;
    address: readonly Address[];
    topics: readonly (Hex | readonly Hex[] | null)[] }): Promise<readonly RawLog[]>;
}
interface RangeStore {
  saveRaw(batch: RangeBatch): void;
  acceptedTip(scopeId: WatchScopeId): BlockAnchor | null;
  acceptRange(batch: RangeBatch): RangeChangeSet;
  invalidateAfter(scopeId: WatchScopeId, anchor: BlockAnchor): void;
}
interface PoolDecoder { decode(log: RawLog, time: LogTime, pool: PoolRef): PoolEvent }
interface Clock { nowMs(): number }
~~~

MinuteBoundary 的 before.number=firstBlock-1、before.timestampSec<T<=at.timestampSec；仅需保存实际查询的少量 anchors，不建每块Header/parentHash表。分钟边界查不到则时段标unresolved。完整性指指定过滤范围的RPC扫描完成，不是独立验证全链正确性。

scopeId由chainId、观察RWA集合版本、协议和事件族确定，各scope独立水位；filterPlanHash描述该批池集合与实际分片，manifestHash描述输入证据，二者不能作为每轮重新开始的scopeId。新增池属于原观察scope，两遍发现更新该批计划；改变RWA集合/事件族则新scope先回填后启用。RangeStore实例和查询必须隔离scope。

业务核心不访问RPC或墙钟。单次接收时间、分钟索引、资产与配置作为显式输入；未知事件/关键解码失败保留原文并降低相关指标质量。

## 6. 范围扫描、发现与时间

默认 pollIntervalMs=2000、maxRangeBlocks=1000、overlapBlocks=20。每轮先读取最新anchor，检查上次成功cursor的hash，再取连续范围；正常追上时只有每批少量端点读取。积压立即连续补段，不额外等2秒，不限制永远只能取10块。

每段先读V3 Factory PoolCreated与V4 PoolManager Initialize，按RWA位于token0/1或currency0/1的两侧合并；再取扩大后的池集合在整段内的Swap和流动性日志。同块建池、加池、首Swap全部覆盖。V4按manager+poolId过滤，不把poolId当地址。初次和新增观察资产都先补必要发现历史，旧冷池保留。

所有分片共用固定数值终点。超大响应缩范围，单块超限拆地址/topic；429走退避而不是不断拆块重试。任何分片失败不推进完成cursor，也不删除旧有效日志。

初始logResponseGuard=5000条；P0记录provider的maxLogsPerResponse为已知值或null。返回条数达到两者已知最小值、明确截断提示或范围错误时继续拆分；单块单过滤仍疑似截断则gap。未知供应商上限不伪装成已知，P0用有界范围与其子范围并集核对捕捉截断；正常成功的覆盖仍以RPC方法契约为前提。

### 时间不需要逐块补

公共RPC新实测55条日志的blockTimestamp全为0；不能因为字段存在就启用。证据与取舍见[日志优先方案](../../research/2026-09-08-logs-first-heat.md)。若实际端点返回可核验时间，优先使用。

默认降级为分钟归桶：利用稀疏anchor夹住UTC分钟边界T，二分找第一个timestamp>=T的块B，并检查B-1和B。timestamp允许多个块同秒；采用lower_bound，不能任意取一个同秒块。若某批两端在同一分钟，直接将其中日志归该分钟；跨分钟才补边界查询。5m/15m由1m桶合成，不逐条查时间。

用于归桶的anchors必须包围相应日志的块号。previous是上一完成cursor，不自动代表含overlap的扫描左端；旧日志沿用有效分钟索引，重扫中首次出现的较早日志须查其自身的包围端点。不得把旧日志按本轮end时间归入当前分钟。时间补齐/修正产生retimed集合，触发对应指标重算。

要求本链时间非递减，P0采样核查、运行时对新anchors核查；发现矛盾则相关时间窗口不可用，不以插值掩盖。历史同样按分钟边界分段，绝不把回填到达时间当成交时间。少量按需事件块查询可作异常核对，不变成每块必读。

保留exactTimestampSec=null和timing=minute；本分钟累计可以每批更新，但不声称拥有精确滚动60秒或精确的逐笔触发秒数。

## 7. 范围账本、修正与恢复

SQLite WAL单写者。原始大整数用TEXT；高度用经安全范围检查的INTEGER；原始响应与有效集合分开。

| 表 | 用途 |
|---|---|
| runs / config_versions | 代码、ABI、规则、资产版本 |
| ingest_batches / fetch_shards | 过滤版本、区间、预期/成功分片、原始响应、到达时间 |
| raw_logs | chainId+blockHash+txHash+logIndex唯一；保留旧分支原文 |
| accepted_ranges / active_logs | 当前已接受覆盖及参与统计的日志 |
| anchors / minute_boundaries / log_times | 稀疏hash检查点、分钟边界及归桶证据 |
| asset_versions / pools / pool_versions | 资产身份、发现证据、完整PoolKey、有效状态 |
| normalized_events / pool_observations | 可重算解码与最近Swap观测 |
| quote_observations / metric_windows | 计价、分钟聚合及质量 |
| signal_transitions / alert_outbox | 提醒修订与投递 |
| checkpoints / replay_runs | 范围处理水位、输入manifest和实验 |

raw先持久化，完整范围的有效日志集合替换、投影、outbox与cursor在一个事务提交。空日志只表示该过滤范围无匹配事件；成功覆盖才允许零成交桶，失败/疑似截断为gap。

重扫采用集合对账：在确实完整扫描且过滤范围一致的区间内，旧日志若消失，就退出active集合，并重算受影响分钟、排名、基线和提醒。仅upsert新日志会留下假热度。过滤版本/观察资产变化需单独回填和水位，不能跨范围删除。

每轮核对上次cursor anchor；不匹配时向后查已有稀疏checkpoints，恢复最后匹配点后重新扫日志，不逐块找parentHash。恢复时使后续分钟索引、池发现和派生数据失效；超过保留检查点范围，从配置warmup起点重建，受影响旧历史标待核对。近期20块重扫用于重复/短期修正，不是最终性保证。

初始warmupMinutes=60、checkpointRetentionMinutes=180。向后定位采用指数扩展加二分已有检查点，最多32次anchor查询；预算不足或无匹配点就暂停受影响提醒并走warmup重建，不逐个扫描数千检查点。分钟边界任一证据anchor落入失效区间，该边界及依赖归桶都失效。

每个已接受范围保存一个end检查点。启动时warmup起点由链头时间向前60分钟的分钟边界确定，且不早于已核验协议部署起点；首次恢复点不足时允许warming，不假造更早覆盖。

每批先固定end anchor，再验证旧cursor；日志与已有观测同高度hash冲突时重取，不拼接不同分支。所有已出提醒均可修订/撤回，默认provisional。此为面向热度的RPC信任与修正方案，不宣称独立证明全链一致性，不将固定块数称finalized。

断线、切换provider、进程重启先检查cursor并补齐；回填不作为当前放量输入，也不把过去机会重新全量推送。

## 8. 协议语义与观测

V3 Swap输入为正、输出为负；V4核心Swap输入为负、输出为正。保留原始符号，统一tokenIn/amountIn/tokenOut/amountOut。[V3事件](https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolEvents.sol)、[V4实现](https://github.com/Uniswap/v4-core/blob/main/src/libraries/Pool.sol)

V3 Mint/Burn与V4 ModifyLiquidity记录次数、delta及tick范围。delta=0不算新增/撤出；Collect单列，V3 Burn不等于已提款；V4的liquidityDelta是L变化，不等于美元本金。Donate不计Swap热度。[V4接口](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol)

只保存最近Swap报告的price/tick/L与观测位置；流动性动作不会把该观测冒充为已验证的当前状态。两次Swap的L变化可作附注，可能来自tick跨越，不能自动定性为资金撤逃。不同池的raw L不可直接排名。

无历史slot0或StateView不妨碍成交热度。完整区间状态、历史仓位快照、协议分成、hook结算核验均移为可选扩展。sender/actor常为router或manager，不能作为真实交易者人数。

## 9. 热度指标与计价

首版核心：本分钟成交累计、最近完整1m/5m成交、Swap次数、不同tx数、相对历史中位数倍数、持续活跃分钟数、新池/再热、加减流动性动作次数。分别提供按5m量和按放量倍率排序；基线0/样本不足不显示Infinity。

分钟桶为UTC半开区间，5m确认用自然闭合5m桶；最近完整5m也可由最后五个完整1m桶合成，字段分别命名。排名每批刷新，本分钟partial明确显示。取消首版精确滚动60s的承诺。

一分钟M只有在两侧分钟边界已核验、同一scope的有效扫描完整覆盖[firstBlock(M),firstBlock(M+60)-1]，且相关事件均解码/归桶成功时才closed；5m须五个自然分钟均closed。尚未扫到分钟末为partial，起始历史不足为warming，失败区间为gap。时间跃迁造成两边firstBlock相等时，需同一有效边界证据确认该分钟无区块才可记零。

同一Swap只计一个计价侧。RWA/USDG直接统计USDG侧；Meme/RWA保留RWA原币量，再用本笔之前RWA/USDG的已知报价作可选估值。decimals来自缓存身份读取；无价不作零。USDG近似美元是显示假设。

报价用事件顺序约束as-of。分钟粒度时间按区间上界保守检查maxQuoteAgeSec=60；无法证实时效则unpriced。跨RWA不可用原币数量直接比较美元热度；未计价池仍可展示交易次数和自身放量倍数。

单池swapCount与不同transactionHash的txCount分开；跨池不同tx数重新求集合，不能相加各池人数。多个池的成交之和仅为poolActivity，多跳不等于多名用户。Meme/RWA与RWA/USDG分列，并列放量或同tx共现只能作为关联线索。

可选显示amountIn×实际fee/1e6的毛交易费近似，V4用Swap.fee，V3用已知池fee；未知时不输出。LP净费、TVL收益率、真实参与者、资金净流入、完整路线归因都不是MVP交付或告警门槛。

## 10. 起始提醒规则

以下只是待历史比较的工程初值；按用户新目标改为分钟统计，不能沿用旧滚动60s规则的验证结论。

| 层级 | 初始定义 |
|---|---|
| 新池观察 | 新有效RWA配对及首次流动性；进入watch |
| 候选 | 本分钟累计>=20,000 USDG等值，且至少为前60个完整1m桶中位数5倍；无基线只走绝对量并标warming |
| 确认 | 已闭合自然5m>=100,000且为前12个完整5m桶中位数5倍；另比较连续两桶>=50,000规则 |
| 再热/升级 | 冷却池再次达标；或已热池达到上次同口径提醒量的2倍 |
| 降温 | 连续3个完整5m桶低于进入阈值25%；gap期间不判降温 |

同级冷却300秒；新等级/再热绕过冷却。流动性动作作为独立附注，首版不把L下降30%解释成确定撤资信号。unpriced池先按原币量/次数展示，不套美元阈值。

每次完整范围投影后评估提醒，可在分钟尚未闭合时发候选；记录实际批次到达时间和partial状态。告警ID按池、规则、episode、kind稳定生成；重扫后条件消失生成修订。默认控制台/JSONL，不自动连接外部通知。

## 11. 历史如何验证热度

历史目标是提醒后是否仍有成交、持续多久、多少候选很快冷掉；不模拟LP成交、费分配或仓位收益。保留全出生队列、死亡币、旧池再热、缺口与右截尾。

只有分钟时间时用minute-close回放：整分钟数据在该分钟结束后才可用于决定，后续15/60/180分钟统计从下一分钟开始，排除触发分钟。输出分钟级发现时间；不能据此声称实际提前了几秒。实录则按保存的批次/observedAt复算；文件读取chunk变化不改变批次，但改变轮询周期可以改变告警。

保留AMC首发、MEME早期/再热、弱样本，以及2026-09-03至09-07的AMC相关池出生队列；历史表版本/as-of身份说明沿用研究证据。GMGN作为对照，不强行对齐代币总量与单池量。

比较本分钟绝对量10k/20k/50k、倍率3/5/10、5m确认50k/100k、1/2桶确认及通知数量；历史minute-close结果是保守分钟基准，不能直接等同实时本分钟候选的最早时点。另比较1/5分钟人工反应延迟。

保留raw/hash/过滤范围/分钟索引/配置，即可复算上述分钟指标；不需要全量Header、完整AMM状态或archive eth_call。历史logs及历史稀疏块读取仍需端点实际支持。

## 12. 首批身份种子与能力门槛

以下为现有研究种子，P0 必须再次用 RPC 和官方来源核验 code、身份、PoolKey 与起始高度，不把字符串写入配置就算验证。

| 对象 | 候选标识 |
|---|---|
| chainId | 4663 |
| 公共 HTTP RPC | https://rpc.mainnet.chain.robinhood.com |
| V3 Factory | 0x1f7d7550b1b028f7571e69a784071f0205fd2efa |
| V4 PoolManager | 0x8366a39cc670b4001a1121b8f6a443a643e40951 |
| AMC 股票代币 | 0x05a3d1cd21d0c88145e82600e62e7e496e0f222b |
| USDG | 0x5fc5360d0400a0fd4f2af552add042d716f1d168 |
| AMC/USDG V3 | 0xaa34fea710a1a737840329051d81d3b0b7c564d5 |
| AMC/USDG V4 poolId | 0x7499938c352d5b5b8f0c648722aca5ee964ef9b85c3a3041f1ec379726291d9d |
| MEME/AMC V4 poolId | 0x27ccf0a6d1ee74840220715bcca7d3b01e0d33aa30d0259b47ae1585b3f4c071 |

合约来源：[Uniswap 4663 部署](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md)。RWA 来源：[Robinhood Stock Token APIs](https://docs.robinhood.com/chain/stock-token-apis/)及已保存的 research/short-window-study/rwa-registry.json。

能力分层：必需chainId、范围getLogs、少量getAnchor与身份/decimals只读call；历史logs和稀疏历史anchor用于P5。历史state、StateView、trace、WS均非首版门槛。时间字段存在但为0按不可用处理；既无有效时间又无法建立分钟索引时只展示块范围计数，分钟热度标unavailable。

## 13. 全局实施约束与完成标准

- G1：只读链数据；生产热路径不依赖 Uni API、Subgraph 服务或 GMGN。
- G2：Node.js 24、TypeScript strict ESM、pnpm；精确版本与 lockfile 由 P0 固化。
- G3：原始金额 bigint；持久化用无损字符串；业务结果绑定 chainId、blockHash 与版本。
- G4：实时与历史共用业务核心；缺口不补零，未知估值/费用不写零。
- G5：同块动态发现、断点恢复、重组与告警撤回必须有测试。
- G6：秘钥仅从本机环境读取；日志保存 provider alias，不保存带凭据 URL。
- G7：现有 research/、tooling/、.agents/、.pnpm-store/ 保留，不纳入应用依赖重构。
- G8：每窗口只实现指定阶段；更新状态和证据，未验收不得勾成完成。
- G9：默认只提供 RPC、本机增量同步；无付费索引后台依赖，记录调用用量与预算。

阶段映射：G1/G2/G6/G7=P0；范围记录/时间索引/修正=P1；协议解码与观测=P2；分钟热度=P3；提醒与再热=P4；历史热度评估=P5；本机运行=P6。完成首版指 P0–P6 通过各自工程验收，预测能力以 P5 实际结果为准。
