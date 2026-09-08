# P1 范围记录器验收 — 2026-09-08

状态：**P1 passed**。机器可读门槛全部为 true，见 [验收汇总](../../artifacts/p1/acceptance.json)。源码尚未提交，位于 feat/p1-recorder；基线 af85a228d8945fbd01d6742c17a9a3559ee4fbb6。

## 实现范围

SQLite WAL 保存不可变原始日志与批次、分片覆盖、scope 游标、有效集合、池登记、稀疏时间证据、检查点和失效记录。完整范围事务返回 added/removed/retimed；分片失败、疑似截断、冲突原始身份或旧游标写入不会假推进。

V3 PoolCreated / V4 Initialize 两侧 RWA 发现后，扫描扩大池集合的整个原范围，覆盖同块首笔操作。观察 scope 不随新增池或分片变化。历史发现另有游标；新增资产先补发现历史。操作范围默认 1000 块，发现范围 1,000,000 块；响应过大按范围及过滤值拆分，过滤值默认每维 1000 项。

分钟归桶使用实际端点与 lower_bound，相同秒多个块选第一个边界块。零日志时间保留为未知，不插值、不逐块补 Header；时间补齐可修订旧日志。恢复先核验持久化游标，再从稀疏检查点指数扩展加二分（最多 32 次）寻找匹配点；超出保留点按链时间 warmup 60 分钟，旧段明确待重核。

已提供 ingest/follow CLI、有界期限与预算、方法用量、运行 manifest、逐批原始证据。P1 的修订集合与失效范围为后续阶段提供输入；尚无 P2 业务观测、P3 热度或 P4 提醒。

## 审查与修复

独立审查发现并修正：
- 显式历史 ingest 会被更高的已有游标跳过：改为独立跟踪用户区间，重扫旧段不倒退游标。
- 同一原始日志身份的不同 payload 被去重掩盖：改为失败分片并阻止接受；响应 hash 保留去重前数据。
- 后续预算/证据失败丢失早期成功分片：P1 保留部分原始结果，但整段仍不得接受。
- 分钟查询首段缺少整分钟前边界导致可证明的旧日志 unresolved：使用真实相邻包围端点，失败仍保留。
- 恢复时边界失效影响相邻分钟、删除错误池登记、缺失时间行修复、运行初始写入异常的资源释放均已补齐。

详见 [最终独立审查](p1-final-review.md)及各 task 报告。

## 真实 RPC 失败记录

官方公共端点 alias robinhood-public。首轮请求 5 分钟，退出 4/incomplete，完成 58 个历史发现批次、0 个操作批次。1,810 个 V4 PoolId 的单次 OR topic 请求收到 -32602 / exceed max topics。历史发现游标持久化，操作游标未推进；没有将发现日志当作操作录制通过。

首轮记录、构建哈希、SQLite 快照与单次错误探测分别在 artifacts/p1/live/first-exit.json、first-build.json、after-first-db.json、filter-limit-probe.json。继续探测 1000 和 512 项请求均成功，保留 filter-shard-probe.json。本地默认 cap 1000 是这些过滤请求的已测可用值，不宣称供应商日志条数上限已知。

## 最终复验结果

273 测试、31 suites 全部通过，0 失败/跳过；pnpm typecheck / test / build / lint 均退出 0。最终源码与 dist 分别绑定 final-source.json 和 live/final-build.json；P0 原证据字节未变，历史归档审计通过。构建带 SQLite migration，node dist/cli.js 为当前入口。

| 实测 | 状态 / 退出码 | 已接受操作批次 | RPC / 重试 | 端点 / 分钟查询 | 响应体字节 |
| --- | --- | --- | --- | --- | --- |
| 首轮失败 | incomplete / 4 | 0 | 645 / 9 | 206 / 0 | 2519608 |
| 过滤修复后 5 分钟 | incomplete / 4 | 33 | 643 / 8 | 104 / 276 | 1591314 |
| 最终构建重启 2 分钟 | complete / 0 | 17 | 248 / 4 | 54 / 49 | 432896 |
| 旧区间重复 ingest | complete / 0 | 1 | 37 / 0 | 7 / 1 | 174347 |

五分钟录制达到期限时最后一段 incomplete，未误接受；已有 33 个操作批次保留。期间实际跨越 5 个分钟边界；含追赶历史在内最终共保存 30 个有效边界。最终构建重启完成并退出 0，从已有游标 57622696 的重扫起点 57622677 开始，先核对 previous anchor，再推进到 57625255。

累计 650 条有效操作日志的原始 blockTimestamp 都为 0x0，现均有基于真实证据的分钟归桶；unresolved=0，exactTimestampSec 均为 null。SQLite quick_check / foreign_key_check 通过，接受范围没有缺口。650 是多轮累计观察范围日志数，不是单轮五分钟的成交量。

在更高游标下显式重扫已录制的 57622597–57622696（100 块），确实读到指定旧区间，退出 0；added/removed/retimed 全部为 0，原始与有效日志数不增长，操作游标保持 57625255。合成测试另覆盖真实短时录制未触发的重组、错误分支失效和分钟修订。

证据：artifacts/p1/live/runs 下四轮 manifest/逐批 JSON；after-second-db.json、after-restart-db.json、final-db.json 记录各时点。请求流为 sampled。可执行 node artifacts/p1/verify-acceptance.mjs 重新核对本机保留的源码/构建/数据库快照与门槛。第二轮使用的旧构建及源码单独保留，最终修复后的构建用于重启和重复读取。

## 适用边界

- 所有链上结果仍为 provisional，依赖 RPC 按过滤合同返回完整日志；没有全链独立校验。
- maxLogsPerResponse 仍为 null；5000 是本地保护值。历史部署起点仍未证实，bootstrap 从保守下界扫描，不把 9070 候选当成事实。
- 默认轮间等待 2 秒；实际周期包括 RPC、限流和入库耗时，不能推断固定 2 秒延迟。
- SQLite /逐批 JSON 在本机保留；sampled 请求流只抽样响应，不是全量传输归档。
- 合成测试证明构造的重组、消失日志、重试与时间修订行为；短时真实录制不能替代 P5/P6 全历史和持续运行验收。
- 未新增依赖；沿用 P0 的固定 ABI 与 SDK。未执行交易、连接钱包或启动永久服务。未推送远端。

下一窗口：经用户安排后读取 P2 计划，从 Task 2.1 开始。本轮停止于 P1。

## 运行数据保留调整

逐批 range/discovery JSON 属于可再生成的运行数据，已移出 Git 跟踪并忽略，现有本地文件保留。Git 仅保留各轮 manifest、验收汇总、数据库快照、构建哈希和测试证据。node artifacts/p1/verify-acceptance.mjs 是本机复验入口，仍需要本地 SQLite、dist 及运行原始文件；仅克隆仓库不具备全量录制回放数据。

运行 stdout/stderr 同样只在本地保留，不纳入版本控制。P1 历史按代码/文档与验收数据拆为独立提交；逐轮 manifest 保留失败原因、覆盖范围和调用用量。
