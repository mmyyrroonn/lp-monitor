# P0 review 处理记录（2026-09-08）

基线：52d4072。对应 [CC 原始评审](2026-09-08-p0-review.md)。本轮先修复 P0 review；未开始 P1 SQLite 记录器、follow 或恢复流程。

## 已修复及核实结果

| 原编号 | 处理结果 |
|---|---|
| B1 | 默认 5 RPS，底层允许指定端点速率；429 指数退避、每 3 次成功逐步恢复，默认最多 2 个在途请求。统一由限流器安排重试等待。P0 CLI 仍限制最多 5 RPS；live/backfill 的任务调度属于尚未实现的 P1 follow。 |
| B2 | 通用配置/计量支持 number 或 null 配额、可变轮询/超时。计量窗口固定 1000 槽，summary 不扫描历史，剩余额度直接读取。P0 CLI 独立保留 150 次、10 秒超时、最多 2 次重试，不能通过 null 绕过单次验收预算。 |
| B3 | saveJson 支持显式根目录；capture 的文件引用相对 manifest 所在目录，probe 相对报告目录。旧归档采用 repository 基准并留存迁移前后哈希。异地临时 checkout 离线验收通过。拒绝绝对路径、目录逃逸及符号链接越界。 |
| B4 | 结构化 HTTP/code 优先，剔除 URL 对分类的影响；真实 viem 503/429/超时/CU 超限回归覆盖。-32005 按明确语义区分 range-limit、rate-limit、unknown-limit，模糊限制不再盲目二分放大。 |
| B5 | 异步写入并等待完成形成背压；full/sample/off 策略（CLI 拼写 sampled）；16 MiB × 8 个分片默认上限。full 满后明确失败并保留旧记录，sampled 才轮转淘汰。flush/close 等待在途请求与落盘。 |
| B6 | 复查 registry：@types/better-sqlite3 最新仍为 9.6.0，运行时 13.0.3 无内置类型，不能升到不存在的 v13 类型包。保留版本并补事务、pragma、safeIntegers、bind/all/iterate 的类型与运行契约测试，见兼容性证据。 |
| H1 | capture 共享可注入时间缓存，已有稀疏 anchor 缩小后续搜索；显式返回 before/at 的分钟边界。缓存及外部观察均验证时间单调性；采集前后端点仍直读 RPC 检测重组。跨运行持久化索引由 P1 建表实现。 |
| H2 | RPC 传输出口及配置地址/hash 归一为小写，topic filter、eventKey、configuredSeed 比较一致，新增混合大小写回归。 |
| H3 | 范围抓取下沉 ingest/fetch-range；身份核验移至 registry；能力探测编排移至 ops；计量实装移至 rpc。旧位置仅兼容 reexport。chainId 单一常量；提供 bigint TEXT 与安全 INTEGER 双向 codec。P1–P4 未使用合同明确标为预留。 |
| H4 | probe 与身份检查的 budget 重新抛出，最终 anchor 复查也保留 budget；capture manifest 保留明确失败原因；chainId 畸形响应为 RpcFailure。配置 strict 且给出安全字段位置；CLI 尊重 maxRangeBlocks。退出码 0/1/2/3/4 均有回归。 |
| H5 | 增加 Node 24 / pnpm 11 CI、脚本 checkJs 与语法检查、Prettier 格式检查；只构建 src，产物入口 dist/cli.js，不再输出 tests。生成 ABI 排除格式化以保留来源字节。CI 已配置，本轮未推送，未声称远端执行通过。 |
| H6 | budget/rate-limit 不再包装成 generic request-failed；并发信号量与启动间隔各司其职。原评审“并发恒为 1”不成立，新增并发上限测试。拆分中途失败时采集明确 incomplete，不能当完整零日志范围使用。 |
| M1 | 明确最终验收证据入库例外；临时运行默认忽略。 |
| M2 | 首尾样本按事件标识去重，单条日志只取样一次。 |
| M3 | sdkPreservesField 按全部成功检查样本合取，不再只保留最后一个结果。 |
| M4 | direct 分支均包含 status/kind，成功时 kind=null。 |
| L1 / L2 | V4 单次解码复用；是否需 V3 补采改为 topic/address 判断，不再全量重复分类。 |
| L3 | 支持创世块时间 0；非创世块时间 0 仍拒绝。 |
| L4 | 根据本地官方 TickMath/PoolManager 源码限定有效 tickSpacing 为 1–32767；补原生币、非零 hooks、动态费率的 SDK 对照。 |
| L5 | V3/V4 已知 topic 的解码失败使用一致的 UniswapEventDecodeError。 |
| L6 | deployment code 查询采用每次搜索独立的历史缓存，避免重复查询，不跨运行复用。 |
| L7 | reader 不再积累无人读取的 anchors；保留空 Map 接口兼容已有调用，真实时间缓存归 resolver 管理。 |
| L8 | 空 body 用 null 构造 Response，204/304 有安全失败回归。 |
| L9 | 排队前及实际获槽时检查预算，实际获槽计数；极低 RPS 下并发预算耗尽不再白等，也不预扣未发送请求。 |
| L10 | 报告保留 calls/elapsedMs；平均速率使用实际非零运行时间，0 ms 为 null。 |
| L11 | 同目录临时文件、rename 原子替换，哈希/字节数从磁盘回读。 |
| L12 | probe/identity 证据路径使用明确相对基准，历史元数据也已迁移。 |
| L13 | vendor-abis --verified 现在实际执行 ABI 测试，测试失败不写 passed。 |
| L14 | 来源/验收脚本区分处理阶段和安全错误类别，不输出可能含凭据的原始错误文本。 |
| L15 | 轮询、重叠、历史时点、WS、watchlist 及阶段合同在代码/README 标明阶段；maxRangeBlocks 已实际用于 CLI 与补采分片。 |
| L16 | 保留 templateLiteral 的 Hex 类型推导，不做会破坏类型的简化。 |
| L17 | 保留 allowBuilds。better-sqlite3 当前使用预编译包不说明该策略错误；本机加载、SQLite API 测试和构建已验证，未伪称执行过原生编译 hook。 |
| L18 | 保留已锁定版本，新增 CI/类型/语法/格式/构建检查；开发依赖新增锁定的 Prettier 3.9.6。 |
| L19 | 删除确认属于 shell 重定向事故的单个杂散文件；research/tooling/.agents/skills-lock 保留并明确忽略。 |

## 验证与证据边界

- 回归先复现了配置静默 strip、大小写差异、重复样本、RPC 分类、429 永久降速、身份预算吞掉、并发额度白等和异地证据失败，再实施修复。
- 测试涵盖 review 的退出码矩阵、真实 viem 错误、预算/限流不分裂放大、解码负值、hooks/动态费率、过滤校验、缓存/reorg 与 SQLite 合同。
- 本轮最终检查记录见 [review 验证汇总](../../artifacts/p0/review-validation.json)。原 P0 tests/fixture-tests 的运行时间及结果保留为历史，不冒充本轮执行结果。
- 8 个已跟踪原始日志/请求文件保持字节一致；元数据迁移记录见 [path migration](../../artifacts/p0/path-migration-2026-09-08.json)。类型核实见 [SQLite compatibility](../../artifacts/p0/sqlite-type-compatibility.json)。
- 本轮使用本地模拟 HTTP、单元测试和原有真实链上 fixtures，未重新采集公共 RPC，也未启动常驻程序。既有真实证据只有一条分钟边界，不能作为 P1 分钟索引的实链验收。
- P1 从 Task 1.1 开始，仍须实现 SQLite 存储、跨运行 anchor/minute 索引、follow 任务预算与 live/backfill 调度、重扫恢复；验收需明确覆盖至少 3–5 个真实分钟边界。未用 P0 的短跑测试代替这些交付。
