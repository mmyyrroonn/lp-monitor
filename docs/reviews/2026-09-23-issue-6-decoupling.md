# 2026-09-23 Issue #6 实施记录：解耦采集、实时投影与通知

基线：`main@2c80e42`（#16、#18 已合入）。本记录对应 #6 的 PR A–E，全部在本机离线验证；未连接链上 RPC、未重放生产数据库、未启动常驻服务。

## PR A：事务与缓存提交边界

- 新增 `src/storage/commit-boundary.ts`：最小提交协调器。嵌套调用共享最外层边界；失败统一 `invalidate` 已推进的内存缓存并执行 rollback 效果，成功只执行 `afterCommit` 效果。外层是未知事务时按 rollback 保守处理，绝不提前发布。
- 修复 `commitAcceptedSignalBatch` 中 workset `commit()` 位于 `return` 之后的静态不可达代码；改为通过边界在最外层 durable commit 后发布。
- `projectSignals` 的选池改为 registry 变化集合与 liveChanges 事件影响集合的并集，不再互相覆盖。
- `commitAcceptedSignalBatch` 把批次 `PreparedRegistry` 传给信号选池，消除 acceptance 事务内回退调用 `cache.prepare()` 消费未提交 journal 的路径。
- recorder 的 recovery/metadata/startup/reconcile 事务统一使用边界；`prepared.publish()` 等提交后工作失败记录为 `post-commit-cache-failure` 并失效缓存，不伪装成 acceptance 回滚。
- 回归：`tests/integration/commit-boundary.test.ts`（watermark 发布、外层回滚、未提交 journal 失效）。

## PR B：record-only 增量快路径

- 所有 operation 批次统一使用 `registryCacheFor(...)` + `OperationFilterIndex`，record-only 不再每批读取完整 catalogue、不再全量排序重建模板。
- 回归：`tests/integration/record-only-incremental.test.ts` 用 2,000 个种子池证明冷批次读取目录、后续批次 `registryRowsRead=0` 且 `operationFilterRebuilds=0`。

## PR C：显式模式与静默监控

- CLI：`--mode record|monitor`、`--notify none|local`。默认 `follow` 为 record/none；旧 `follow --notify local` 仍映射 monitor/local；`record + local`、`ingest + monitor`、record 模式下的 `--signals` 在打开数据库前拒绝。`--metadata` 作为采集/估值输入可独立提供。
- 迁移 `018-delivery-policy.sql`：`delivery_policy(scope_id, mode, generation, enabled_at_ms, disabled_at_ms)`。
- `src/notify/delivery-policy.ts`：进入 none 时把未发送 pending/failed 置为 `superseded`/`delivery-disabled`；从 none 启用 local 时只提升“曾发送 live 身份的当前撤回”；正常重启不复活任何 silenced 普通提醒。
- `AlertOutbox.enqueue` 受策略驱动：none 下仍写账本并 supersede 旧意图，但落终态，不创建可投递 pending。`deliverPending` 发送前复核权威 revision、active、capture_mode 和数据年龄；普通机会默认 15 分钟过期，撤回使用独立规则。
- monitor-none 维护投影、信号账本与 outbox 状态，不打开 console/JSONL sink。
- 回归：`tests/integration/delivery-policy.test.ts`、`tests/integration/mode-separation.test.ts`（三模式 + record→monitor 用本地 raw 初始化）。

## PR D：投递退出采集等待链

- 新增 `src/notify/dispatcher.ts`：进程内单 owner 异步 dispatcher。提交只写意图并 `wake`；分页限量领取（默认 50），同一时刻最多一个在途 drain；空档按间隔重试（默认 5 秒）；停止时先拒新单、等待在途 sink、最后才允许关闭数据库。队列吞掉自身异常，不产生未处理拒绝。
- `recordRange` 不再 `await` sink；catch-up 批次只请求撤回，不提前发送普通积压。启动与恢复仍用 `drainNow` 同步结算撤回。
- 报告：`processingMode`/`deliveryMode`/`delivery`/`deliveryPolicy`/`pipeline`；批次 `computationMs`（每个计算轮次都有）与 `outboxDurableAtMs`（仅真正写入意图时）；异步投递不再写批次 `deliveredAtMs`。
- 回归：`tests/integration/alert-dispatcher.test.ts`（慢 sink 不阻塞提交、撤回优先、分页、失败不退化为忙循环、停止语义、重试间隔）。

## PR E：端到端与文档

- 三模式联测见 `tests/integration/mode-separation.test.ts`，只读看板继续使用已有 snapshot worker，未改只读边界。
- 新增 [运行模式](../modes.md)；更新 README、START_HERE、docs/dashboard.md 与 CLI help。

## 验证命令与结果

在最终工作树（本记录所在提交）执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 退出 0 |
| `pnpm lint`（check-scripts + prettier） | 退出 0 |
| `pnpm lint:semantic` | 退出 0 |
| `pnpm test` | 退出 0（1388 tests / 162 files） |
| `pnpm build` + `node dist/cli.js --help` | 退出 0 |

## 迁移与回滚

- 升级：打开数据库时自动应用 `018-delivery-policy.sql`；旧库没有策略行时投递路径按 `local` 处理，行为不变。旧 pending/failed 行只有在显式以 none 启动时才被抑制。
- 回滚：先停止 recorder/dispatcher（确认在途 sink 结束）并备份数据库；随后可回退代码。回退后的旧 dispatcher 会忽略 `delivery_policy`，因此回滚前必须确认没有依赖 suppressed 语义的数据；`alert_outbox` 中新增的 `superseded`/`delivery-disabled` 行对旧代码是终态，不会被重新投递。
- 支持的代码/数据库组合：本记录提交的代码 + 迁移 018；不支持“新库 + 忽略 suppressed 语义的旧 dispatcher”。

## 未完成/边界

- 多渠道 TTL/退避/租约、Telegram/Webhook、跨进程 lease 属于 #10。
- 异步 dispatcher 的取消只到“停止接单并等待在途 sink”的粒度；本地阻塞写不做超时竞速，也不声称可取消。
- 未做真实 RPC 长时运行；结构计数回归与三模式离线联测是本记录的验收范围。
