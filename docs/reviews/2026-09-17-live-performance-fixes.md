# 2026-09-17：实时优化分支修复与性能复测

工作区：`E:\lp-monitor\.worktrees\live-runtime-performance`；分支：`codex/live-runtime-performance`。
基于 `9fd0fb6518915e4e6645c231ee8379f414b58e21` 的未提交修复。原审查报告在主工作区 `docs/reviews/2026-09-17-live-performance-9fd0fb6-review.md`。

## 正确性修复

| 问题 | 修改 | 回归证据 |
| --- | --- | --- |
| F01：删除一条注册记录时，网页错误删除仍有其他注册记录的池 | worker 先读 RegistryCache 合并后的目录，再按池身份产生最终 before/after；维护已经发布的目录状态 | 跨 scope 删除、同 scope 多次发现、删除最后记录、旧 generation 分页 |
| F02：启动时目录与 journal 游标不一致，可能永久漏掉并发写入 | 初始化目录与 journal 位置在同一个 SQLite 读事务内读取 | 在两次目录读取后注入另一个连接的写入，首次刷新与完整目录一致 |
| F03：切换 registry scope 递归重建导致栈溢出 | scope 不匹配直接作为一次重建条件；重建前保存旧事件键，显式输出删除增量与受影响池 | 改 scope 后重建一次；同步删除内存中的旧池事件；事务回滚恢复；再次 sync 返回空增量 |

三项修复先复现失败，再运行回归。定向 2 文件 / 28 测试通过；补查发现 scope 重建后 SQL 已清空但内存仍有 79 条旧事件，同样先 RED 再修复，追加事件索引、投影、注册回归 3 文件 / 33 测试通过。

## 本轮性能修改

1. `src/metrics/windows.ts`：只缓存有事件的分钟。空分钟直接使用当前 coverage 与 birth 计算，省去哈希、SQLite 查找和反序列化。独立构建结果逐字段比较，覆盖重复调用、删除事件、coverage 缺口、时间前进和回退。稀疏夹具原先 910 次缓存访问，现在不超过 10 次。
2. `src/metrics/coverage.ts`：日志时间键只解析一次，按区块排序；每分钟二分定位自己的区间，并用声明分钟的最小/最大区块检查来自区间外的错配。错误声明、unresolved、精确秒越界和缺失归属与原始全扫描 oracle 一致。180 条日志 / 181 分钟的实际检查计数从 32,580 降为 360。复杂度包含排序和二分；正常不重叠分钟内不再重复扫描全部事件。
3. `src/ops/work-counters.ts` 增加实际检查位置的 `coverageLogVisits` 计数。没有降低覆盖校验、改成自然时间窗口、填造零值或扩大在线采集范围。
4. 修正先前 lint 的 9 个文件格式问题，以及实施记录末尾空行；这些文件中的其他格式变动不改变行为。

## 同配置 CPU 采样对照

配置：80,000 注册池、400 活跃池、194 股票、181 分钟覆盖；预热 3 轮，普通样本 5 轮；初始化和 3 个修复轮单列。两次均开启 Node inspector CPU profiler，只采普通轮。

| 项目 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 本地处理 p50 | 2,492 ms | 1,231 ms |
| 本地处理 p95 | 2,658 ms | 1,401 ms |
| windows 阶段 p50 | 1,191.031 ms | 161.382 ms |
| coverage 阶段 p50 | 225.801 ms | 76.502 ms |
| projection 阶段 p50 | 622.966 ms | 630.706 ms |

本地处理 p95 下降约 47.3%。这是同配置小样本对照，不代替 20 轮正式验收。阶段耗时存在包含关系，不相加冒充本地处理总时间。

证据：`artifacts/performance/2026-09-17-before-80k/`、`2026-09-17-after-80k-profile/` 的 `benchmark.json` 与 `normal.cpuprofile`；汇总在 `2026-09-17-profile-comparison.json`，采样入口为 `profile-normal.mjs`。

## 正式验收

<!-- FINAL_RESULTS -->
20 轮普通样本固定为 14 轮 fresh、3 轮 advance、3 轮 repeat；3 轮预热、初始化和修复轮不计入普通 p95。以下为本地处理总时间；HTTP 单独统计。原门槛：本地 p95 <2,000 ms，固定 400 活跃池的 160k/80k 比值 <=1.5。

| 配置 | 本地 p50 | 本地 p95 | HTTP p95 | 初始化 | 结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| 80k / 400 活跃 | 1,603 ms | 1,778 ms | 51 ms | 76.7 s | 普通批次达标 |
| 160k / 400 活跃 | 2,333 ms | 2,581 ms | 44 ms | 167.1 s | 普通批次仍超出目标 581 ms |
| 2k / 2k 全活跃 | 6,806 ms | 7,949 ms | 195 ms | 9.4 s | 压力观察，活跃事件规模仍显著影响成本 |

扩容比为 2,581 / 1,778 = 1.452，满足 <=1.5。两组固定活跃样本的 HTTP p95 响应体约 292 KB。普通样本最大进程 RSS 分别约 3,247 / 3,323 MiB，包含基准合成数据与 worker，不能直接当作线上常驻内存。

压力样本期间并行执行过两条短定向正确性测试，故该行只作压力观察，不作为固定活跃扩容验收证据。80k / 160k 采样未并行跑测试。正式数据保存在 `artifacts/performance/2026-09-17-after-{80k,160k,all-active}/benchmark.json`，汇总为 `2026-09-17-formal-results.json`。

源码身份：`2026-09-17-source-provenance.json` 和对应 patch 记录固定活跃基准的未提交代码；`2026-09-17-final-source-provenance.json` 和 `2026-09-17-final-changes.patch` 记录最终修复。最后追加的事件删除修复只在完整重建路径执行，固定 scope 的普通批次逻辑没有再次改动；最终版本不以同一个 HEAD 冒充完全相同的源码快照。

- 最终 typecheck / lint / build / `git diff --check 6ed70d7` 已通过。
- 全量测试第一轮发现旧断言只统计缓存 UPDATE，实际新分钟改为 INSERT。已补 INSERT 触发器，仍要求只有一个变化分钟写入；相关 2 文件 / 18 测试通过。
- 最终完整 `pnpm test`：138 文件 / 1,211 测试全部通过，217.86 秒，退出码 0。日志：`artifacts/performance/2026-09-17-final-tests.log`。
<!-- END_FINAL_RESULTS -->

## 后续性能方向

- 第一优先：`src/ingest/completeness.ts::completePartitions`。16 万池 projection 阶段 p95 为 1,325 ms，8 万池为 715 ms；修改后 CPU profile 的 5 个普通轮里，`BatchCoverageStore.accept` 共约 1,428 ms，其中 `completePartitions` 共约 1,367 ms。每条分片请求已覆盖整个 batch 时，可以只验证 selector 数量上限与非空性，避免展开、字符串化和存储每个地址/topic 组合；存在任何部分范围分片时保留原算法。必须保留组合数 >100,000 的拒绝条件，并验证空数组、拆分区间、不同地址不能借用覆盖、缺失分片与篡改证明。验收仍为同样 3 轮预热 + 20 轮固定 400 活跃池的 80k/160k 样本，不预先宣称能省下多少时间。
- 覆盖读取仍从 SQLite 读取窗口内 raw logs / log times，可继续改为窄列读取或基于 dirty rows 的有界索引；必须保持双向错配检查、reorg、旧库与只读兼容。
- 初始化单独处理：全目录首次构建和首次窗口仍需要较长时间，不能拿普通批次 p95 宣称启动已经优化。
- 默认 V4 pool-ids 请求规模仍随目录增长。Manager 模式是单独实验；本轮未启用，也没有真实 provider 验证。

所有性能证据来自临时 SQLite 和 mock RPC。没有修改运行库、重启线上进程、联网采集、commit、merge 或 push；不能据此宣称长时间真实链运行已验收。
