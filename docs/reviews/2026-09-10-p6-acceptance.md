# P6 本机运行验收记录（用户要求停止实测）

已实现有界采集、5/2/1 RPC 预算、运行状态与延迟计量、停止恢复、SQLite 备份及本机通知验收。最终冻结前检查为 **74 文件 / 740 测试通过、0 失败，typecheck、lint 与 build 退出 0；P6 整体仍为 in_progress**。此前 72 文件 / 713 测试及 build 是性能修复前证据。30 分钟冒烟通过；第二次长观察仅因 p95 门槛失败，最终构建实测约 56 分钟后按用户要求停止，未完成两小时验收。离线证据见[offline-verification.json](../../artifacts/p6/offline-verification.json)，修复处理见[独立复审处理记录](2026-09-10-p6-review-response.md)。

## 实现与检查边界

| 范围           | 文件与合同                                                                                                                          | 已有验证边界                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPC 配额与计量 | `src/rpc/{client,rate-limit,request-meter}.ts`；实际发请求时同时满足全局 5 RPS、最多 2 inflight、历史 1 RPS，历史分类与调用类别分开 | transport fixture 覆盖重试延迟与并发，等待不冒充 inflight；缺失预算测量不通过验收                                                                                     |
| 生命周期与健康 | `src/ingest/follow.ts`、`src/ops/{recorder,runtime-telemetry,status,shutdown}.ts`                                                   | raw 后停止、恢复不重复决策；失败状态及时写 sidecar，旧 head 保留观测时间；status 只读，backup 使用 SQLite API；到时停止新批次，当前批次有 30 秒 RPC 准入收尾期        |
| 延迟与通知     | `src/ops/report.ts`、recorder/outbox                                                                                                | 完整证据到 outbox 的本机 p95 与获取到投递延迟分开；没有成功提醒就没有送达样本；实际 DB pending/failed 通知阻止验收                                                    |
| 覆盖与验收绑定 | `src/metrics/coverage.ts`、`artifacts/p6/assess-run.mjs`                                                                            | 缓存保留成功分片、payload 与当前范围校验；验收绑定 finalized run、manifest、report 和数据库快照。未接受尝试只有整个区间被当前验证覆盖解释才可解除阻塞，失败记录不删除 |
| 原始证据       | `src/storage/raw-store.ts`、recorder                                                                                                | 仅将不可信 `rawBlockTimestamp` 附注排除出规范重复比较；首个 raw 行和每批精确附注都保留。规范字段冲突仍拒绝；本地保存错误输出脱敏的 `raw-save` 类别与阶段              |

离线故障覆盖断线 30 秒、429、重复日志、分叉、损坏 JSON、DB 写失败、通知失败恢复和清理边界；另有错误数据库、报告替换、缺失测量、覆盖缺口与失败分片的验收反例。该轮离线工程检查覆盖的 scoped review 已关闭；更广泛独立复审记录中的问题仍须单独处理。见[工程检查](../../artifacts/p6/offline-verification.json)及[740 项测试结果](../../artifacts/p6/tests.json)。这些测试不代表同类故障已在实链全部发生。

## 当前性能修复证据（不等于最终运行通过）

滚动基线、annotation 索引与 dormant-window 单次调用 memo 已分别完成语义复查。相同只读 SQLite 副本上，优化前 `buildMetricsReport` 中位数为 1,401.75 ms；组合源码版本三次为 595.2508、573.6847、494.8416 ms，中位数 573.6847 ms。组合输出的 source hash 与 1,901 条 annotation 逐项相等。profile 中 3,802 是 registry 与 operation 两个 scope 的注册行数，不是独立池数；实际为 1,901 个唯一 pool windows / annotations。测量期间可能与全量测试并发，不能当作隔离 benchmark，也不能证明冻结运行使用了这些修复。

accepted-range cache cliff 已按分钟区块范围选批并保留完整 payload、分片和 accepted-range 重验；最终源码 warm profile 在中期副本为 455.72 ms、较大终端副本为 722.43 ms，cold 3.716/5.177 秒仍保留。见 [coverage final profiles](../../artifacts/p6/performance/)。这些诊断测量不替代两小时验收。聚合器 v3 的泛化失败尝试、证据绑定与成本去重已完成 scoped review；更广泛的独立复审问题仍保留在独立复审记录中，最终 acceptance/cost 仍须等待有效的完整运行。性能证据见 [performance](../../artifacts/p6/performance/)。

## 实际运行证据

| 运行                           | 结果                                                                 | 证据与限制                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 30 分钟冒烟，18:17:21 启动     | passed；1,832,495 ms，177 个本机处理样本，p95 1,592 ms               | [报告](../../artifacts/p6/smoke-report.json)、[资源](../../artifacts/p6/smoke-resources.jsonl)。两个失败尝试已有完整覆盖恢复证明，原记录保留                               |
| 首次 2 小时尝试，18:50:46 启动 | failed；1,144,254 ms 后退出 1，不能计作 2 小时通过                   | [失败报告](../../artifacts/p6/soak-failed-1-report.json)、[资源](../../artifacts/p6/soak-failed-1-resources.jsonl)、[代码快照](../../artifacts/p6/soak-failed-1-code.json) |
| 第二次长观察，19:26:39 启动    | failed；完整运行 7,203,375 ms，687 样本 p95 2,841 ms，是唯一失败门槛 | 8,624 次调用、64 次 retry；归档 `soak-failed-2-*` 与 `data/p6-soak-failed-2.sqlite`，不覆盖失败历史                                                                        |
| 最终构建实测，21:35:48 启动 | interrupted-by-user；约 56 分钟时停止，不计作两小时通过 | runId `2026-09-10T13-35-48-773Z-6ec4891a`；[停止记录](../../artifacts/p6/soak-user-stopped-report.json)。follow 与 sampler 已结束；无 finalized manifest，快照 data/p6-soak-user-stopped.sqlite 已保存 |

以上时间为 2026-09-10、Asia/Shanghai。**冒烟代码归属有证据限制**：[smoke-code.json](../../artifacts/p6/smoke-code.json) 在 18:32 采集，冒烟开始后曾于 18:27 build，因此它只是运行期间的工作区文件清单，不能证明整个冒烟进程实际加载的所有模块版本。重试的 [soak-code.json](../../artifacts/p6/soak-code.json) 于 19:26:20、进程启动前冻结；重试结果仍须单独验收，不能用冒烟替代。

首次长观察的根因由复制数据库与 6 条重新取得的真实日志复现：同一 identity 的附加时间戳由非零值变为 `0x0`，触发原来的 `Raw log payload is immutable`。窄修复后重复保存幂等、首批 raw 行逐字节不变、6 条批次附注保留；见[真实数据回归](../../artifacts/p6/save-raw-reproduction/fix-verification.json)。首次失败与修复证据不因重试而覆盖。

覆盖校验缓存有独立只读测量：[优化前](../../artifacts/p6/performance-before.json)的 72 个 accepted batches，三次范围校验约 373–404 ms；[优化后](../../artifacts/p6/performance-after.json)的 128 个 batches，约 38–40 ms。数据规模不同，不能视为同输入严格对照或长期吞吐保证；完整长观察已按用户要求暂停。

## 尚未完成与不作结论的部分

用户明确要求先不继续跑，实测和进一步优化均已停止。前 40 分钟采集、写库持续推进，RPC 限流后恢复；后期处理样本超过 2 秒，最后一次健康采样为 2,431 ms、pending 0，这不是完整 p95。停止时未生成 finalized manifest，不补造终端验收；2 小时验收和成本汇总仍未完成。ABI 缓存只有测试草稿，已移出 tests 保存到 .superpowers/sdd/p6/canonical-decode-cache.test.ts.draft，生产代码未实施该优化。已有报告保留调用、响应字节与磁盘用量；未提供可核验 billing units/费率，货币成本保持 `null`，不把调用数直接换算成费用。

P5 原生 portable 输入导出与跨流修订顺序仍未完成，不声称 recorded-observed 回放对照通过。没有真实 reorg 验收结论；RPC 过滤完整性也不是独立全链证明。提醒保持 provisional，阈值效果和 LP 净收益未验证。未安装永久服务、操作钱包或执行交易；使用与恢复步骤见[运行手册](../runbook.md)。
