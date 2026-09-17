# 2026-09-17 实时性能优化分支 Review

结论：**主要结构优化已实现，但尚未完成验收；本轮不建议直接合并。** 新增独立反例复现了 2 个 P1 网页目录一致性问题和 1 个 P2 投影恢复问题。现有 1204 项测试全部通过，不能覆盖这些反例。本地批次性能门槛仍未通过，lint 与提交范围的 diff check 也未通过。

## 审查对象与边界

- 原工作区 `E:\lp-monitor`：main / `6ed70d7d6f7bd5fecbe22f2324b3e4ffad71acfa`。
- 实际优化 worktree：`E:\lp-monitor\.worktrees\live-runtime-performance`。
- 实际优化分支：`codex/live-runtime-performance` / `9fd0fb6518915e4e6645c231ee8379f414b58e21`。
- 比较范围：`6ed70d7..9fd0fb6`，112 个文件，44,772 行新增、1,316 行删除（含大量文档与基准 JSON）。
- 已核对实际分支、源码、设计/计划、验收报告、规模汇总；重新执行全套离线测试、typecheck、build、lint、diff check，并运行下述独立反例。
- 审查结束时，优化 worktree 的 tracked 源码/测试/脚本仍与 `9fd0fb6` 完全一致。
- 仅新增本报告与 `artifacts/reviews/2026-09-17-live-performance/` 审查证据；不修改业务源码，不 merge/push，不启动 RPC 采集，不修改运行库或停止/重启现有服务。

## F01 / P1：网页把一条登记记录的删除当作整个池的删除

位置：优化 worktree 的 `src/dashboard/snapshot-worker.ts:506-519`，以及 `src/dashboard/read-model.ts:369-374`。

`#registryRows()` 将两个 scope 的 `registry_changes` 直接转换为 read-model delta，丢掉 scope 信息。journal 表达的是单条登记记录的变化，而网页索引以唯一 poolId 存储。一个池在 discovery 和 operation 两个 scope 都有登记时，删除其中一侧的行就会触发 `PoolIndex.remove(poolId)`；另一侧仍有有效登记也会从网页目录消失。同一个 scope 中存在多条发现记录时也需要遵守同一合并规则。

独立复现：临时库把同样的 12 个池登记在两个 scope；初始化 worker；只删除 registry scope 的一个池行；同步投影并刷新。`PoolRegistry` 合并后的实际目录仍为 12 个池，但股票 A 的网页 `poolCount` 从 **5 错误降为 4**。两次 worker 响应均为 summary，没有错误状态。正常生产会同时使用 discovery/operation scopes；登记修订、撤回时会经过这条路径。

建议：先按变化涉及的 poolId 重新折叠两个 scope 中仍存在的登记，向网页发布合并目录真正发生的 before/after 变化。复用 `RegistryCache` 的合并规则，不能把 journal 的单行 delete 直接当作 pool delete。补双 scope、同 scope 多行、最后一条删除三个回归。

证据：[脚本](../../artifacts/reviews/2026-09-17-live-performance/scope-and-directory.mts)、[输出](../../artifacts/reviews/2026-09-17-live-performance/scope-and-directory.txt)。

## F02 / P1：worker 启动读取目录与 journal 游标不在同一快照中

位置：优化 worktree 的 `src/dashboard/snapshot-worker.ts:259-280`。

初始化先分别读取两个 scope 的 pools、构建目录，之后才读取 `#journalPosition()`，整个过程没有只读事务。如果 follow 在两者之间提交新增或删除，worker 保存的是旧目录和新游标；首次 refresh 的 `seq > position` 查询会跳过该变化。之后正常刷新也无法补回已越过的 journal 记录。

独立复现用方法包装确定性插入一次 writer 提交：两次目录 SELECT 已返回、读取 journal 游标之前删除一个登记。这是在临时 WAL 库上模拟确切的并发交错，未声称在用户运行库观测到同样事故。数据库删除后剩 11 个唯一池；有竞态的 worker 报股票 A **5 池**，同一数据库上重新启动的 worker 正确报 **4 池**。

建议：把初始目录读取与 journal position 捕获放进同一个短只读事务；提交后再发布 ready 和初始化模型。用另一连接/可控交错覆盖新增及删除，验证不会漏消费变化。`RegistryCache.prepare()` 已使用一致读事务，可作为参照。

证据：[脚本](../../artifacts/reviews/2026-09-17-live-performance/worker-init-race.mts)、[输出](../../artifacts/reviews/2026-09-17-live-performance/worker-init-race.json)。

## F03 / P2：registry scope 改变时的强制重建分支无限递归

位置：优化 worktree 的 `src/storage/live-projection.ts:347-370`。

旧 `registry-cursor-v1` 的 scope 与本次参数不一致时，代码递归调用 `syncOnce(..., true, ...)`。递归中仍读取原来的 cursor/reference，并无条件再次进入同一 scope 不匹配分支；`forceRebuild=true` 没有阻止再次递归，实际重建和 cursor 更新永远到不了。

独立复现：已同步过 `sync('s','s','c')` 的临时库，再调用 `sync('s','r','c')`，结果为 **`RangeError: Maximum call stack size exceeded`**。这属于 scope 变更/陈旧引用恢复路径，不意味着每次普通 follow 都会崩溃。

建议：将引用 scope 不匹配并入 `rebuild` 判定，在同一调用中完成重建；或确保强制重建时不再解析/递归处理旧引用。回归应断言只重建一次、cursor 指向新 scope、后续第二次 sync 正常。

证据：F01 的同一脚本先独立记录此异常，再仅在临时库清除旧游标，以运行不受该异常影响的 F01 反例。

## 优化完成度与尚未达到的验收

以下数字来自分支附带的 2026-09-16 离线规模报告，本次读取核对，**未重新跑 80k/160k 基准，不是新测量或线上数据**。原始 benchmark 的 gitHead 标记为 `7c3c39b`，实现者在该基线加 E3 工作树改动时生成样本，随后提交到本次审查分支。

| 项目 | 已有证据/本次判断 |
|---|---|
| 目录增量、批次相关登记、热池 workset、估值缓存 | 实际实现存在，相关离线测试本次通过；不是只有计划文档 |
| metadata 后台队列、限流恢复 | 实际实现存在，相关离线测试本次通过 |
| 网页 worker、首页汇总、详情分页 | 实际实现存在；已有 HTTP p95 46/48 ms，约 292 KB；仍需修复 F01/F02 |
| 80k 池 / 400 活跃池 / 20 普通批次 | localProcessing p95 **4,204 ms**，目标 `<2,000 ms`，未达标 |
| 160k 池 / 400 活跃池 / 20 普通批次 | localProcessing p95 **4,506 ms**，未达标 |
| 固定活跃量，目录翻倍 | 已有本地 p95 比值约 1.07，符合 `<=1.5`，不能抵消绝对耗时未达标 |
| 2,000 池全部活跃 | 已有 localProcessing p95 18,765 ms；压力成本报告，不是恒定耗时承诺 |
| V4 Manager 读取 | 仅默认关闭的离线实验；正常采集仍按 pool-id 分片，真实 provider 验证和生产接线未做 |
| main 与部署 | 优化尚未合并到 main；不能据此认定原工作目录正在运行优化版 |

规模汇总：优化 worktree 的 `artifacts/performance/80k/summary.json`、`artifacts/performance/160k/summary.json`。实施者报告定位最慢阶段为 windows，其次 projection/coverage。下一步应保持窗口/信号语义，继续剖析和减少重复工作；不应把“不能改变公式”解释成“无法继续优化实现”，也无需放宽既定 2 秒门槛。

## 本次重新执行的检查

| 检查 | 结果 |
|---|---|
| `pnpm test --reporter=dot` | **138 文件 / 1204 测试通过**，354.85 秒，exit 0 |
| `pnpm typecheck` | 通过，exit 0 |
| `pnpm build` | 通过，exit 0；仅优化 worktree 的 dist |
| `pnpm lint` | **失败，exit 1**；9 个文件格式不符合 Prettier |
| `git diff --check 6ed70d7..HEAD` | **失败，exit 2**；implementation.md 第 2911 行新增 EOF 空行 |
| F01/F02/F03 独立反例 | 均复现；现有绿测未覆盖 |

lint 文件：`src/metrics/coverage.ts`、`src/replay/export.ts`、`src/replay/reader.ts`、`src/replay/runner.ts`、`src/storage/batch-coverage.ts`、`tests/dashboard/read-model.test.ts`、`tests/integration/batch-coverage-cache.test.ts`、`tests/integration/referenced-batch-replay.test.ts`、`tests/unit/operation-filter-index.test.ts`。至少五个是本分支新文件；这些应在既定范围内定向格式化，不需要做全仓无关改动，也不应仅为保持报告行号而留下红检查。

## 补充观察：inline coverage 证明仍扫描文本，不能归因到全部实时批次

`src/storage/batch-coverage.ts:175-181` 使用 `length(payload_json)`，注释认为其直接读取值头。针对本机 SQLite 的纯内存隔离探针，50 次 6 MB/12 MB TEXT 的 length 查询分别约 92.7/200.8 ms，而 octet_length 分别约 0.030/0.021 ms。因此大 inline batch 的证明读取仍存在随文本长度增长的成本。

**限定范围**：正常 recorder 先 `saveRaw(...,{compact:true})`，payload_json 是较短的 ref envelope。不能把这个微基准当作当前 compact follow 的主要瓶颈，也不能据此解释完整系统的 4.2 秒。建议对 inline 兼容路径使用无需读取完整文本的元信息；注意字符长度与字节长度的契约区别及旧 proof 兼容。此项仅作定向优化线索，不计入上面三个正确性阻断问题。

证据：[脚本](../../artifacts/reviews/2026-09-17-live-performance/sqlite-length.mjs)、[输出](../../artifacts/reviews/2026-09-17-live-performance/sqlite-length.jsonl)。

## 复现与后续验收

脚本使用本机 worktree 的绝对 file URL，全部只创建临时夹具库，不接触 data/recorder.sqlite。脚本以输出反例为目的，exit 0 表示探针执行完毕，不表示业务断言通过。

```powershell
Set-Location E:\lp-monitor\.worktrees\live-runtime-performance
pnpm exec tsx E:\lp-monitor\artifacts\reviews\2026-09-17-live-performance\scope-and-directory.mts
pnpm exec tsx E:\lp-monitor\artifacts\reviews\2026-09-17-live-performance\worker-init-race.mts
```

建议修复顺序：F01/F02 网页目录一致性 → F03 恢复路径 → 清理定向 lint/diff 问题 → 剖析并重测本地批次性能。修复时把三个反例转成正式回归，保留已有全套测试，并在最终提交上重新生成规模报告。R05 的实链验证和生产切换继续单列，不能从离线测试推导为已完成。
