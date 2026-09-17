# 2026-09-17 活跃窗口与缓存优化

本轮承接上一份性能报告，优化持续运行中的窗口、分钟缓存和证据读取。当前实现继续复用已有的跨批持久化分钟贡献，减少无关失效和重复解码，并共享同批可证明相同的空窗口；指标公式、提醒和历史修复契约保持不变。

## CPU 采样决定的实施重点

2,000 池全部活跃，20 个普通轮，启用 Node inspector：优化前 buildRollingMetrics 累计包含时间 23,411 ms，其中 buildMinuteMetrics 为 19,705 ms、LiveMetricCache.memo 为 13,070 ms；信号 readEvidence 为 16,989 ms，解码器自身时间为 9,462 ms。阶段相互包含，不能相加。热点表明，先减少已有缓存和证据路径的重复工作，比直接新增复杂的常驻滚动累加器更值得验证。

| 同配置采样 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 本地 p50 | 5,011 ms | 3,643 ms |
| 本地 p95 | 6,424 ms | 5,134 ms |
| windows 阶段 p95 | 1,586.964 ms | 1,174.069 ms |
| coverage 阶段 p95 | 497.219 ms | 387.444 ms |
| readEvidence 累计包含时间 | 16,989 ms | 7,560 ms |

本地 p95 降低约 20.1%。这是带 profiler 的对照，正式验收使用下方无 profiler 样本。证据目录：artifacts/performance/2026-09-17-rolling-{before,after}/，含 benchmark.json 与 normal.cpuprofile。

## 已实施

1. signals/codec.ts：先正常解析 JSON，再只递归处理对象与数组。普通数字和字符串不再逐项跨越 JSON reviver 回调；bigint 标签、异常标签拒绝、额外字段、嵌套和自有 __proto__ 数据保持原契约。10,004 次解码访问的反例现限制为不超过 4 次容器访问。
2. metrics/windows.ts：分钟缓存签名只包括实际聚合依赖：交易哈希、USD/USDG/原币金额、流动性变化、coverage、当前分钟状态、计价单位和出生区块。原始池状态等无关字段变化不再更新分钟贡献；估值、交易去重、删除、流动性和覆盖修正仍重新计算。
3. metrics/rolling.ts：同一 coverage 索引复用相同窗口的覆盖结果，并只在出生条件、计价单位和覆盖一致时共享无事件窗口。有事件或未知时间事件的窗口仍独立计算。覆盖缓存和空窗口缓存均有 4,096 项上限，仅在当前构建内存活。返回的覆盖 reasons 独立复制，防止调用者追加原因污染其他窗口。
4. storage/metric-store.ts：所有股票窗口共享一份覆盖索引。正式采样中每轮 coverageIndexBuilds 从 777 降到 2。
5. storage/raw-store.ts、signals/project.ts：先对区块、声明分钟、精确时间查到的日志 id 取并集，再读取一次需要的原始字段与时间归属。信号证据不再分别读取两组完整日志和两组时间映射；同一日志键只构造一次。原始日志读取排除未使用的 payload_json 等列。
6. 时间查询拆开 minute/exact 两个范围，EXPLAIN QUERY PLAN 证明确实使用相应范围索引。旧库缺少这些时间索引时仍可读取；active family 去重、缺失时间、scope 隔离和双向时间错配继续验证。

## 正确性验证

保留独立的 tests/helpers/reference-rolling.ts，逐字段比较相同输入在时间偏移 0/1/59/60/61/300/-60 秒、历史删除、未定时间和 coverage 缺口下的结果；另覆盖出生条件不同的池。复杂度用例在明确相同出生和计价条件的池之间比较，避免把不应共享的窗口强行缓存。

新增 SQL 查询计划、旧时间索引缺失兼容，以及信号证据逐日志 SHA256 与旧 log/time/valuation 公式完全一致的检查。冻结提醒及撤回序列、大整数、事务回滚和只读库的已有测试继续保留。

首次失败证据见 artifacts/performance/2026-09-17-active-{codec,minute,rolling,evidence,stock-coverage}-red.log。早期 green 文件属于中间检查：rolling-green.log 当时仍有复杂度夹具失败，分钟用例之后也补齐了流动性类型字段；不将这些中间文件作为最终通过凭据。最终验收以全量测试、类型、格式及构建日志为准。

## 正式基准

固定 194 股票、181 分钟覆盖、3 轮预热，普通 20 轮为 14 fresh / 3 advance / 3 repeat，随后 3 个修复轮。三个正式配置串行运行，期间未并行测试或构建。

<!-- RESULTS -->
| 场景（总池 / 活跃池） | 上轮本地 p95 | 本轮本地 p50 / p95 / max | p95 降幅 | 普通轮 HTTP p95 |
| --- | ---: | ---: | ---: | ---: |
| 80,000 / 400 | 1,310 ms | 866 / 1,100 / 1,112 ms | 16.0% | 33 ms |
| 160,000 / 400 | 1,776 ms | 1,196 / 1,420 / 1,484 ms | 20.0% | 42 ms |
| 2,000 / 2,000 | 6,660 ms | 3,813 / 5,040 / 5,417 ms | 24.3% | 173 ms |

固定 400 活跃池的两组 p95 均低于 2 秒，总池数翻倍的耗时比例为 1.291，低于 1.5 门槛。所有 HTTP 请求返回 200；三个配置普通轮 HTTP p95 均低于 1 秒，响应最大 293,037 bytes，低于 1 MiB。包含预热及修复的全部 26 次 HTTP p95 分别为 49 / 42 / 182 ms，最大延迟分别为 236 / 509 / 191 ms。HTTP 是已发布快照的读取延迟，不代表采集到展示的端到端新鲜度。

每个配置普通轮 registryRowsRead 和 registryRowsSerialized 均为 0，三个 repeat 轮 valuationComputes 均为 0，coverageIndexBuilds 每轮均为 2。普通轮 RSS 最大值分别为 2.18 / 3.63 / 3.50 GiB；这是短样本进程内存观测，尚未证明长期内存稳定。

初始化（构造全新临时库）上轮 / 本轮分别为 55.32 / 54.44 秒、105.86 / 105.58 秒、8.21 / 8.47 秒，没有明显改善。三组最大预热本地耗时分别为 19.05 / 36.75 / 4.24 秒，未计入普通轮 p95。已有数据库的重启恢复仍需单独测量。

修复轮与普通轮分开：新池首笔 / 元数据回填 / 历史修正的本地耗时，80k 为 950 / 1,247 / 1,326 ms，160k 为 1,311 / 1,563 / 1,712 ms，全活跃为 3,851 / 5,280 / 5,611 ms。全活跃场景仍超过 2 秒，固定活跃池的门槛通过不能外推到这一场景。

完整结果：artifacts/performance/2026-09-17-active-results.json；原始样本为 2026-09-17-active-{80k,160k,all-active}/benchmark.json，对照为上轮 2026-09-17-followup-{80k,160k,all-active}/benchmark.json。两轮均为相同配置、无 profiler 串行运行；这是各一组短样本的实测差异，不是长期延迟保证。
<!-- END_RESULTS -->

使用 normal.localProcessingMs；包含 mock 获取和请求准备的 normal.p95Ms 是另一口径。HTTP 与初始化、预热分开报告，阶段不能相加。

## 最终检查与边界

<!-- VERIFICATION -->
- pnpm typecheck、pnpm lint、pnpm build 均通过，git diff --check 6ed70d7 通过。
- pnpm test：143 个测试文件、1,254 项测试全部通过，耗时 195.26 秒。
- 日志：artifacts/performance/2026-09-17-active-{typecheck,lint,build,tests}.log。依赖 SDK 的缺失 sourcemap 提示未影响退出状态。
- 基准开始后源码与测试文件没有变化；322 个文件的 SHA256 与基准身份清单一致。
<!-- END_VERIFICATION -->

基准源码身份：artifacts/performance/2026-09-17-active-source-provenance.json；已跟踪变更 patch：2026-09-17-active-changes.patch。所有改动保留在 codex/live-runtime-performance 的独立 worktree，未提交、合并或部署。

这些是 mock RPC 与临时 SQLite 的离线结果。全活跃规模仍需单独评估；已有数据库的实际重启恢复、真实 provider 和长时间链上运行不由这些样本证明。下一层逐事件增减的滚动累加器，应继续以剩余热点、独立结果对照和有界内存为依据。
