# 运行模式：采集、监控与本地通知（#6）

`follow` 现在有三种明确的组合。默认组合与旧脚本兼容，不需要改配置：

| 组合 | 原始证据 / accepted | 增量登记 + 请求模板 | 实时投影 / 指标 / 信号账本 | 新消息 |
| --- | --- | --- | --- | --- |
| `follow --mode record --notify none`（默认） | 是 | 是 | 不运行新的计算轮次 | 不发送 |
| `follow --mode monitor --notify none` | 是 | 是 | 是 | 不发送、不积压普通提醒 |
| `follow --mode monitor --notify local` | 是 | 是 | 是 | 合格 live 意图进入本地 outbox |

## 命令示例

```powershell
# 终端 1：有时限、latest-only、无消息监控
pnpm lp follow --config config/robinhood.json --db data/recorder.sqlite --duration 30m --mode monitor --notify none

# 终端 2：只读看板（页面不写库、不发消息）
pnpm lp dashboard --db data/recorder.sqlite

# 需要消息时
pnpm lp follow --config config/robinhood.json --db data/recorder.sqlite --duration 30m --mode monitor --notify local
```

兼容性：

- 无新参数的 `follow` 仍是 record-only，不改变既有脚本行为。
- 旧 `follow --notify local` 映射为 monitor/local；`--signals` 与 `--metadata` 照旧可用。
- 显式 `--mode record --notify local` 在打开数据库前拒绝。
- `ingest` 不接受 monitor；`--signals` 只在 monitor 模式加载。`--metadata` 是采集/估值输入，可独立提供。
- monitor 模式独立加载 `config/signals.initial.json`，不再以通知开关作为加载许可。

## 静默语义

`--notify none` 只是不发送，不是暂停后补发：

- 信号账本（`alerts` / `signal_cursors` / `signal_snapshots` / `signal_evaluations`）照常维护；只有 outbox 意图不同。
- 进入 none 时，未发送的普通 pending/failed 意图被置为终态 `superseded`，原因 `delivery-disabled`；不删除、不伪装成 sent。
- silent 期间新 revision 仍写入账本并让旧意图失去资格，但不创建可投递的普通 pending。
- 曾以 live 身份发送过的提醒后来被撤回：撤回事实会保存；none 期间不发送。重新启用 local 时，只有这些身份的当前撤回会被补发，silent 期间的普通机会不会复活。
- 正常重启（已经是 local）只重试仍有效的 pending/failed；启用代次只用于区分 none → local。

发送前复核权威 revision、`active`、`CaptureMode` 与数据年龄：普通机会超过 15 分钟过期终止；撤回使用独立资格规则（只要求它是该身份的当前 revision）。

投递是**至少一次**语义：sink 写成功但 `sent` 状态未落盘时，同一 id/revision 会重试；本地版仍是 console + JSONL 一个逻辑 sink，不声称每渠道 exactly-once，消费者按 id/revision 去重。

## 投递退出采集等待链

- 每个完整批次提交后只写入意图并唤醒进程内的单 owner dispatcher，不再 `await` sink。
- dispatcher 每次分页限量领取（默认 50 条），同一时刻最多一个在途 drain；失败只降低 delivery 健康，不撤销已提交采集。
- 除提交唤醒外，轮询空档会按间隔重试（默认 5 秒），因此无新块、metadata-only 或临时 sink 故障后仍能推进。
- 停止顺序：先停止接单，等待在途 sink（本地 sink 不可取消，不做超时竞速），最后关闭数据库。SIGINT 时不强跑新 drain。

## 报告字段

manifest/ops-report 现在区分：

- `processingMode`: `record` | `monitor`
- `deliveryMode`: `none` | `local`
- `delivery`: `{ sent, failed, status: 'ok'|'degraded'|'disabled', lastDeliveredAtMs }`
- `deliveryPolicy`: scope 的模式、启用代次、enabled/disabled 边界
- `pipeline`: `projectedRounds` / `signalRounds` / `outboxDurableRounds`

批次时间线中：

- `computationMs` 与 `localProcessingMs`：证据完整到提交落盘的本地计算窗口，monitor 每个计算轮次都有。
- `outboxDurableAtMs`：仅当该轮真正写入意图时记录；没有写入时不伪造。
- `deliveredAtMs`：异步投递后不再属于批次；用 `delivery` 汇总。

## 看板

monitor-none 持续维护只读看板需要的增量投影，因此无需发送消息即可生成新版看板数据。record 模式不运行新计算轮次，页面会区分“记录模式未启用计算”“monitor 首次生成投影”和“来源已变化、投影过期”，不会把旧投影伪装成新鲜数据，也不会偷偷写库。
