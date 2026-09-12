# P6 本机只读运行手册

## 2026-09-12 实时增量修正与独立历史回顾

实时 `follow --notify local` 已改用持久化增量协议投影、逐事件估值和分钟/五分钟贡献缓存。普通批次只解码新增或修订事件，未变时间桶复用已有结果；实时计算保留规则所需有界窗口（默认180分钟，包含60分钟基线，另读最多120秒报价上下文），过期贡献退出热路径，原始证据保留。

重复日志不重复计数，链重组/retime/登记/覆盖修订通过脏记录修复并撤回受影响的 provisional 提醒。待撤回修订持久化，不因一次独立指标读取而丢失。缺少可证明时间窗口的边界时标 incomplete，不回退扫描全部未知时间历史。首次升级或协议投影版本变化允许一次迁移重建；后续正常批次不做全历史重建。

`history --from-block N --to-block M` 是独立历史回顾入口：本地完整证据优先，仅补缺失区间，使用隔离回顾数据库，不写实时通知。见[历史回顾说明](history-review.md)。`project --rebuild` 和 `replay/study` 保留为显式离线入口，历史输入覆盖不足仍如实报告。

本次验证只运行短时离线回归、类型检查、格式检查和构建，不重新启动长时实链验收；旧P6两小时验收状态不因此改变。

本手册描述当前代码已经实现的本机有界运行方式。30 分钟冒烟已通过；前两次长观察失败并完整保留，最终构建实测于 2026-09-10 21:35:48（Asia/Shanghai）启动，约 56 分钟时按用户要求停止，完整两小时验收未完成。P6 整体验收仍为 in_progress。提醒阈值效果和 LP 收益仍未验证。处理记录见[独立复审处理记录](reviews/2026-09-10-p6-review-response.md)。

## 本机环境

在 PowerShell 中切换到仓库根目录 `E:\lp-monitor`。RPC 地址和 provider alias 只放在本机进程环境中：

```powershell
$env:RH_RPC_HTTP = '<本机设置，不要写入仓库或运行记录>'
$env:RH_PROVIDER_ALIAS = '<不含凭据的供应商别名>'
```

不要把带 token、密码或查询凭据的 RPC URL 传给 `--source-alias` 或写入配置。下列运行统一使用 `config/runtime.local.json`、`data/p6.sqlite` 和 `artifacts/p6/runs`。

## RPC 能力探测

先运行一次有界 probe，确认 chain identity、日志范围、时间戳和基础 RPC 能力：

```powershell
pnpm lp probe --config config/runtime.local.json --out artifacts/p6/capabilities.json
```

probe 只读取链数据。退出码 `0` 表示所需能力和身份检查通过；`3` 表示所需 RPC/身份失败；`4` 表示预算或数据不完整。结果中的调用量是本次测量值，不能外推为长期费率或收益。

## 当前运行参数与首次准备

`config/runtime.local.json` 当前限定 AMC/USDG 观察集，参数为：2 秒轮询等待、每批最多 1,000 块、20 块 overlap、总 RPC 上限 5 次/秒、最多 2 个并发 RPC、历史 anchor/backfill 最多 1 次/秒、单次 transport timeout 10 秒、首次 warmup 1 分钟。2 秒只是两轮之间的主动等待，完整周期还包含 RPC 与处理时间；1 RPS 历史 anchor 是保守预算。额度不足或无法追头时应报告 head lag，不能静默越限。

冷数据库可用仓库内的有界准备脚本扫描 registry，并只用最近 100 个已观测块播种 operation 数据：

```powershell
node artifacts/p6/bootstrap.mjs
```

该脚本导入 `dist/`，只能在 dist 与当前源码、配置已经对应且经过核验时使用。最终冻结前 74 文件 / 740 项测试、typecheck、lint 和 build 已通过，证据见 `artifacts/p6/offline-verification.json`；运行构建指纹保存在各阶段 code 快照中。现有 `artifacts/p6/bootstrap-result.json` 仅证明 2026-09-10 那次有界准备退出码为 0，范围为 59319202–59319301；它不是长期同步验收，较早基线仍保持 warming。

首次观察期间可执行固定链头的 10/20/100 块有界比较：

```powershell
node artifacts/p6/compare-batches.mjs --db data/p6.sqlite --out artifacts/p6
```

脚本同样依赖已核验的 `dist/`。现有证据在 `artifacts/p6/comparison-2026-09-10T10-15-17-902Z/report.json`：三个范围均记录为 complete、无时间解析失败，每个范围 9 次调用；但三个样本来自同一个固定链头且日志数均为 0，只能作为该次空样本的范围/额外分钟边界成本比较，不能证明持续吞吐、活跃事件负载或独立链覆盖。

## 30 分钟冒烟

```powershell
pnpm lp follow --config config/runtime.local.json --db data/p6.sqlite --out artifacts/p6/runs --duration 30m --notify local
```

`follow` 默认每 2 秒轮询，但 2 秒不是链上事件到可见提醒的保证。它把数据库写到 `data/p6.sqlite`，把最新观测状态写到 `data/p6.sqlite.health.json`，每次运行的 manifest、请求证据和 `ops-report.json` 写入 `artifacts/p6/runs/<run-id>/`。本机提醒同时写控制台和 `data/p6.sqlite.alerts.jsonl`。

本轮 30 分钟观察于 2026-09-10 18:17:21（Asia/Shanghai）启动，实际运行 1,832,495 ms；177 个本机处理样本的 p95 为 1,592 ms，冒烟通过，证据见 [smoke-report.json](../artifacts/p6/smoke-report.json)。两个未接受尝试的完整区间已被后续当前有效覆盖解释，原始失败记录仍保留。没有出现热点也可以评估运行完整性，不要为了展示提醒而降低阈值。

首次 2 小时观察于 18:50:46 启动，运行 1,144,254 ms 后提前失败，未通过。复制数据库和 6 条真实日志的回归确认：同一链上日志的 RPC 附加 `rawBlockTimestamp` 从非零值变为 `0x0`，触发了原始 payload 不可变检查。修复只从规范日志重复比较中排除这项不可信附注；首个 raw 行及每个批次的原始附注均保留，其他规范字段冲突仍拒绝。raw 保存异常现在只报告不含凭据的 `raw-save` 类别与 discovery/operations 阶段。失败报告、构建指纹、资源采样和复现证据分别保留于 `soak-failed-1-*` 与 `save-raw-reproduction/`，见[中期实施记录](implementation-status.md#p6-中期实施记录--2026-09-10)。

## 2 小时有界观察

只有 30 分钟冒烟的完整性检查没有未解释问题时再运行：

```powershell
pnpm lp follow --config config/runtime.local.json --db data/p6.sqlite --out artifacts/p6/runs --duration 2h --notify local
```

第二次 2 小时观察完整运行 7,203,375 ms 并正常退出，但唯一失败门槛是本机处理 p95：687 个样本的 p95 为 2,841 ms，高于 2 秒；8,624 次调用含 64 次 retry。它已归档为 `artifacts/p6/soak-failed-2-*` 与 `data/p6-soak-failed-2.sqlite`，不能计作通过。

最终源码的只读 profile 在中期副本 warm 路径为 455.72 ms，在较大终端副本为 722.43 ms；cold 路径 3.716/5.177 秒仍保留披露。它们是诊断测量，不替代长观察。最终冻结构建的 2 小时验收于 UTC 13:35:48.773 / Asia/Shanghai 21:35:48 启动，runId `2026-09-10T13-35-48-773Z-6ec4891a`，recorder PID 5500，main session 44586，sampler session 47225；原计划窗口到 23:35:48，实际约 56 分钟时按用户要求中断。上述 PID/session 均为历史记录：follow 与 sampler 已结束。中断记录见 artifacts/p6/soak-user-stopped-report.json，SQLite backup 快照为 data/p6-soak-user-stopped.sqlite；未生成 finalized manifest。

这仍是有界进程，命令不会安装服务、开机启动或循环任务。本次中断不计作完整两小时通过；后期处理样本超过 2 秒，持续性能仍待解决。后续实测需用户重新安排。

## 查看状态

正常情况下，`follow` 生成的默认 sidecar 含数据库绝对路径和 scope，状态命令可安全推断 scope：

```powershell
pnpm lp status --db data/p6.sqlite
```

也可显式指定 scope：

```powershell
pnpm lp status --db data/p6.sqlite --scope <scope-id>
```

省略 `--scope` 时只读取默认的 `data/p6.sqlite.health.json`，且仅在其中的 `databasePath` 与目标数据库一致、`scopeId` 非空时使用。文件缺失、损坏或指向其他数据库时命令拒绝猜测 scope。状态以只读方式打开 SQLite，不执行迁移。`head` 是 sidecar 最后保存的 observed head，不是一次新的远端链头查询。状态同时报告 `sidecarSampledAtMs`、`sidecarAgeMs`、`sidecarFreshness` 和 `observedRuntimeState`；默认 60 秒后活动态 `starting`/`healthy`/`degraded` 显示为 `stale`，未来或无效时间也不冒充当前存活。`complete`/`failed`/`stopped`/`incomplete` 作为历史终态保留，并明确显示年龄。

水位含义：

- `head`：最后一次 RPC 观测到的链头。
- `scanned`：已经完整接受并推进 cursor 的扫描水位。
- `rawSaved`：已有原始批次证据的最高水位，不等于已经接受或投影。
- `projected`：只有 cursor 和 source freshness 都通过核验时才出现，否则为 `null`。
- `gap`：由运行管线明确报告的范围缺口状态；高度相等本身不能证明无缺口，未知为 `null`。

`dbBytes` 与 `walBytes` 分开报告，`outboxPending` 只统计待发送或发送失败的 live 通知。

## Ctrl+C、停止与恢复

在前台运行时按一次 `Ctrl+C` 请求协作式停止。进程停止接收新范围，保留已经写入的 raw 证据，完成允许提交的事务和清理，再关闭 SQLite；不要用任务管理器强杀来代替正常停止。

自然到时后不再开始新批次；当前批次有 30 秒 RPC 准入收尾期，已发出的请求还受配置中的 transport timeout 约束。每次 anchor/log/身份核验请求前都重新检查停机；异常和 SIGINT 路径也会发布部分 follow 统计，避免丢失此前批次与失败尝试。manifest 保存原定停止时间、准入截止时间和实际结束时间；到时仍有积压则保持 incomplete/非零退出。

本机配置的首次 warmup 为 1 分钟，优先验证实时链路；基线尚未形成时保持 warming，不降低热点阈值。已有数据库按持久化 cursor 恢复。

恢复时重新执行原 `follow` 命令即可：

```powershell
pnpm lp follow --config config/runtime.local.json --db data/p6.sqlite --out artifacts/p6/runs --duration 30m --notify local
```

恢复从持久化 cursor 和 checkpoint 重新核验，尚未提交的批次会重新处理；稳定 id/revision 和事务边界用于避免重复业务决策。重组或质量恢复产生的 live 撤回仍会进入本机通知。

## 补采旧范围

已知缺失区间可运行一次有界 ingest：

```powershell
pnpm lp ingest --config config/runtime.local.json --db data/p6.sqlite --out artifacts/p6/runs --from-block <起始块> --to-block <结束块>
```

`ingest` 要求有序且落在安全整数范围内的块高，不接受 `--notify local`。旧范围按 backfill 保存，不会把历史热点重新发送给用户。补采后重新启动 `follow --notify local` 时，实时数据质量恢复、新热点和需要撤回的 live 状态仍按正常路径发送。

## 升级前 SQLite 备份

停止或协作式退出当前运行后执行：

```powershell
pnpm lp backup --db data/p6.sqlite --out data/p6-before-upgrade.sqlite
```

该命令调用 SQLite backup API，会纳入已提交的 WAL 状态。目标文件必须不存在，源和目标不能相同；命令不会覆盖已有备份。不要直接复制正在运行的主 `.sqlite` 文件来代替此命令。

## 离线 replay 的输入边界

当前 replay 入口要求明确的 portable manifest 和 rules：

```powershell
pnpm lp replay --manifest <portable-manifest.json> --rules <rules.json> --mode minute-close --out <输出目录>
```

原生 P1 recorder 数据库和逐范围记录目前没有自动导出成 replay 所需 portable manifest 的入口。没有经过配置快照、修订顺序和输入对应核验的实录，不得声称 recorded-observed 对照通过。不要为 P6 验收临时扩大历史采集；保留 raw、分钟索引和运行报告，等具备合格输入后再回放。

## 资源与延迟报告口径

每次有界运行的 `ops-report.json` 使用以下口径：

- `localProcessingMs`：完整范围及所需分钟证据已经可用，到 outbox 落盘的本机处理时间。
- `rpcAcquisitionMs`：明确测得的 RPC 获取耗时。
- `totalDeliveryMs`：本轮获取链头开始，到一次已确认成功的本机 delivery 完成的时间，包含 RPC 获取及分钟证据解析；失败或没有提醒的 drain 不产生送达样本。它仍不是链上事件发生到显示的全程时间。
- `acquisitionToNotifyAttemptMs`：本轮获取开始到本机通知尝试结束的时间；没有产生提醒时也可记录，与实际送达样本分开。
- `headLagBlocks` / `headLagSeconds`：观测链头与已接受扫描水位的差值趋势。
- `sampleSize` / `p95`：完整测量样本数及 full-sample nearest-rank p95；缺样本为 `null`。
- `usage.startup`、`usage.backfill`、`usage.steady`：各阶段累计方法调用、响应字节及按实际测量时长归一的每小时用量。阶段切换不会把另一阶段夹在中间的时间算进去。
- `disk.*`：SQLite 主文件加 WAL 的 `growthBytes` 是有符号净变化；`positiveGrowthBytes` 另计各区间正增量，避免 WAL checkpoint/收缩被误报为净增长。健康状态仍分别显示主文件和 WAL。
- `monetaryCost`：只有提供经过核验的供应商费率和明确 billing units 时才计算；否则为 `null`。RPC 次数本身不等于实际费用。

30 分钟冒烟的调用、字节、磁盘、缺口与延迟已有实测报告；两次长观察失败记录均保留。最终构建的 2 小时验收尚在运行，整体验收和最终成本汇总待其结束。缺少供应商 billing units/费率时金额继续为 `null`；阈值效果与 LP 收益不由运行验收证明。

## 本地证据保留边界

`data/` 下数据库、alerts JSONL，以及 `artifacts/p6/runs/` 下逐请求、raw 和运行目录被 Git 忽略但保留在本机磁盘。阶段报告中的 hash/链接依赖这些本地产物；只克隆仓库不能复核完整实录，交接时须同时复制对应运行目录和数据库快照。历史冒烟的 code inventory 在运行期间采集，且当时存在不同 `dist` 版本，不能作为最终可执行代码证明；最终运行使用单独的启动前冻结指纹。

## 当前能力边界

| 能力                         | 当前实现状态                                                                     | 运行解释                                                        |
| ---------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| V3/V4 pool 发现              | 已实现 registry 扫描和同范围动态关联发现                                         | 仍受本次 RPC 返回、配置观察集和完整性证据约束                   |
| V3/V4 Swap                   | 已实现解码、投影、分钟聚合与信号输入                                             | 未观测到事件不能写成成交量为零之外的长期结论                    |
| V3/V4 liquidity 动作         | 已实现相关动作解码和 latest observation                                          | last Swap 的 L 不是当前美元流动性或 LP 收益证明                 |
| 历史 logs 与分钟时间         | 已实现指定范围 ingest、anchor/minute-boundary 时间解析和缺口保留                 | 原生 P1 数据尚无 portable replay manifest 自动导出              |
| 估值覆盖                     | AMC/USDG 已配置直接或既有证据支持的估值路径；未知保持 null                       | 不把缺失报价、费用或池流动性补成零                              |
| 本机通知                     | live follow 可写控制台和 `data/p6.sqlite.alerts.jsonl`，支持 revision/retraction | backfill 不重发旧热点；阈值效果尚未通过实录验证                 |
| 分钟历史评估                 | 引擎支持 minute-close，P5 replay/study 入口已实现                                | 实录缺少合格 portable 输入时不得声称 recorded-observed 对照通过 |
| 远端通知、自动交易、永久服务 | 未实现且不在 P6 范围                                                             | 不自动安装服务，不发交易或钱包操作                              |

## 实时滚动窗口（2026-09-12）

实时指标为过去 1 分钟、5 分钟、15 分钟、1 小时，区间统一为 (T-duration,T]，T 是已采集链上时间，并非电脑当前时间。不再输出自然五分钟和本分钟累计。

`metrics --window 1m|5m|15m|1h` 选择窗口，省略时输出四种；`rank --sort volume5m` 按过去五分钟排序（旧参数 volume5mClosed 仅作兼容别名）。新池不足完整窗口、覆盖缺口或边界交易只有分钟精度时显示不可用；完整且没有交易才为零。15m/1h 暂不计算相对基线；1m/5m 使用前置、不重叠同长度区间的中位数。

候选/确认使用滚动1m/5m，连续确认和降温仍要求不重叠区间，轮询次数不能代替持续时长。历史补评仅进入 backfill，不发送实时通知。指标/信号语义版本已变化，旧状态会重新核对；显式 minute-close 历史回放保留旧窗口口径，不代表新实时统计。
