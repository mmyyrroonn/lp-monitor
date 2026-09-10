# P4 Review 修复记录（2026-09-09）

审查对象：`b5e8c81`。对应输入为 `docs/reviews/2026-09-09-p4-review-findings.md`；用户提到的 `2026-09-05` 文件在工作区不存在。本次仅处理 P4，未开展 P5/P6、联网采集或常驻运行；未提交。

## 处理结论

| ID | 处理 | 实现与验证依据 |
| --- | --- | --- |
| E1 | 不采纳将 zero-baseline 视为相对倍数通过 | 维持原 P4 计划的边界：中位数为零或样本不足时相对规则不可用；候选可按绝对值触发，并明确 absolute-only。连续两桶绝对确认独立有效。零基线的 multiplier 仍为 null，新增回归。 |
| E2 | 已修复 | 全部未消费的完整自然 5m 桶按时间顺序评估，每桶只使用此前基线。保存多条 draft 和逐桶评估；旧桶强制 backfill。交易证据严格排除桶末端以后的分钟；历史 L 无当时证据时明确 unknown。 |
| E3 | 已修复 | 5m 同级冷却使用逻辑桶结束时间；observedAtMs 保留实际到达时间。4190 才收到 3900 桶不会吞掉 4200 桶。 |
| E4 | 已修复 | 新增版本化 episodeExpiry，默认距上次符合热度条件 3600 秒后结束旧 episode。持续符合热度条件会延长活跃期，即使提醒被冷却抑制。 |
| E5 | 已修复 | 同分钟候选成交量、次数或原因变化可更新同一 ID 的 revision；相同内容不重复；跨分钟仍受冷却约束。 |
| E6 | 已修复 | medianNumerator / medianDenominator 按精确十进制格式展示，不再把半整数中位数写成 unknown。 |
| E7 | 已修复 | RuleMatch 区分 disabled、absolute-only、relative-unavailable、relative-met 和未达到阈值原因。 |
| E8 | 已修复 | 当前分钟 gap 不清空已完整历史桶的降温计数；独立完整桶继续评估，rechecking 仍不产生新提醒，真正不连续的历史桶会中断计数。 |
| E9 | 已修复 | 删除无行为作用的 alertSequence；持久化旧字段不会影响新配置重置。 |
| E10 | 已修复 | USDG 负数统一取绝对值格式化后加符号，覆盖 -0.5 / -1.5。 |
| E11 | 已修复 | 展示及重启测试使用完整类型的 AlertRecord 和 baseline，去除掩盖缺字段的强转。 |
| E12 | 已修复 | 流动性附注展示观察到的 L、tick、区块、年龄和证据限制；不直接输出内部 JSON，不推断美元深度或提款金额。 |
| O1 | 已修复 | 启动只在操作游标与新读取的 latest 高度、hash、时间一致时执行 live 评估；落后时等待追平。中间补齐批次标记 backfill，只允许发送已提交撤回，不发送普通 live 队列。 |
| O2 | 已修复 | outbox supersede 按 capture_mode 隔离；alerts 保留该 ID 曾具 live 资格的信息，保证 live → backfill → retracted 仍会发送 live 撤回并淘汰旧 live 提醒；纯历史 ID 不升级资格。 |
| O3 | 已修复当前 P4 行为 | 撤回保留消费游标、episode 和冷却状态；不变证据不会重开提醒。原始事件、估值和实际引用报价依赖用于限定受影响池；无关历史注册不撤回已有池。已消费入场桶发生实质升级时沿用 ID 形成新 revision。实际 fork 的恢复标记持久化，覆盖替代分支链头高于旧头的情况。 |
| O4 | 部分修复，明确保留成本 | 缓存 prepared statements / outbox，预建 pool、交易、RWA、注释索引，避免重复扫描和不变 snapshot 写入。没有仅凭 P2 sourceHash 在 buildMetricsReport 前跳过：覆盖边界、日志归时、元数据变化必须继续验证。完整指标和 evidence 扫描仍存在，增量化未实现。实测另见 performance.json，不能据此宣称固定实时延迟。 |
| O5 | 已缓解并提供显式维护 | 稀疏审计仅写状态变化或 draft；live pending/failed 部分索引避免全历史排序。pruneSignalDerivedHistory(db, scopeId, {evaluations, terminalDeliveries}) 提供每 scope 行数上限，仅显式调用，保留 raw、当前 alerts、snapshot、cursor、所有 pending/failed。默认不自动删除历史；审计供排障和未来离线复核。 |
| O6 | 已修复分类，保留原子边界 | signal-evaluation 错误与 RPC 失败分开记录，输出阶段信息且不泄露异常原文；exit 1 语义不变。原始响应已在事务前保存，accepted-range / P2 / signal / outbox 仍原子提交或回滚。不采用静默部分提交降级。 |
| O7 | 已修复 | 本地发送数量和失败尝试进入 alert-delivery 事件、progress、finished 和持久化 manifest 的 alertDelivery；有失败的运行标 degraded，采集状态仍独立表达。 |
| O8 | 已修复 | 一个失败只阻塞本轮相同 scope/alert ID，其他 ID 继续；保留发送前状态检查和异步返回后的条件更新，不能复活 superseded 行。 |
| O9 | 已修复 | 初始 epoch 由 scope/config 决定；episode 由规范桶时间和池/规则确定；batchId、到达时间、随机恢复 UUID 和首次批次结束点不参与初始 ID。实际分支替换使用分支 hash 区分。 |
| O10 | 已修复 | fromBlock 和受影响池控制撤回，其他池及早于该范围的状态不被全表删除。 |
| O11 | 已修复 | 新 draft 通过与存储一致的 JSON codec roundtrip 后比较，显式 undefined 不再导致虚假修订。 |
| O12 | 已修复适用项 | 删除未用 consoleSink / alertDeliveryKey；配置错误区分文件不存在、不可读、JSON 和 schema 字段位置，屏蔽输入值；--signals / --metadata 必须配合 --notify local。只读 P3 打开旧库的兼容性保留；当前没有新增 alert 专用只读命令。 |
| O13 | 已修复 | JSONL 中 bigint（区块号、定点金额等）序列化为十进制字符串，普通 number 保持数值，幂等键为 (id, revision)。alerts 的 capture_mode / active 有 CHECK；幂等触发器给现有 004 表补等效写入约束。metricInput 仅在通知配置齐全时构造。 |

## 版本与使用变化

- 默认信号配置升级为 `p4-v2`，新增 `episodeExpiry: {enabled: true, threshold: 3600, version: "1"}`；配置 hash 变化会重置旧规则 snapshot 并重新校验证据。
- AlertRecord 新增可选 logicalTimeSec / historical；实际到达时间与逻辑评估时间分别展示。SignalDecision 保留 alertDraft 兼容字段，同时增加 alertDrafts / evaluations。
- outbox 投递允许在文件写入成功、确认状态前崩溃时重复同一 (id, revision)，消费者应按该键去重。alertDelivery.failed 是失败尝试累计，不是去重后的告警数；degraded 表示本轮曾发生投递失败。
- 精确重放任意旧桶并恢复每个历史修订仍属于后续历史研究能力，本次不会把历史补评估变成实时通知。
- 保留任务开始前 README、START_HERE、implementation-status、P5/P6 计划和设计文档中已有的优先级修改。

## 验证

最终命令、测试数量、源码与构建指纹见 `artifacts/p4-review/verification.json`、`tests.json`、`acceptance.json`。定向测试覆盖引擎、outbox、修订、重启、CLI、时间边界和新池；独立审查记录见 `docs/reviews/2026-09-09-p4-repair-independent-review.md`。

`node artifacts/p4-review/verify-acceptance.mjs` 使用只读 SQLite online backup，源为 `data/p3-acceptance.sqlite`，目标为独立 `data/p4-review-acceptance.sqlite`；重复运行仅重置此副本的 P4 派生状态。校验 P1 各表指纹不变、数据库完整性、历史不投递，以及合成 candidate/hot/upgrade/cooling/reheat/retracted 示例。旧 `artifacts/p4` 证据保持不变。