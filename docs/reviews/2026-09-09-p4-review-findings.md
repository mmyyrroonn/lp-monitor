# P4 独立审查发现 — 2026-09-09

审查对象：分支 `codex/p4-alerts` @ `b5e8c81`，基线 `main` = `0c2e2e1`。两位独立审查员分别覆盖规则引擎与 outbox/recorder，主控核对了 E1–E4、O1–O3 的代码位置。全程只读，未改仓库文件，未使用 RPC。

结论：**typecheck 退出 0、P4 相关 8 个测试文件 62 用例通过，但规则引擎有 1 个 blocker、多个 major；不建议按现状进入 P6。** `2026-09-09-p4-review.md` 自审声称已修的 5 项（登记恢复撤回投递、provenance 去重、异步 outbox 被替代记录、覆盖修复、升级/窗口身份）核实确实修了且有回归锁；下列问题是该自审未覆盖的。

修复顺序建议：E1 → E2/E3 → E4 → O1 → O2 → O3 → O4/O5/O6 → 其余 minor。每条修复必须附带对应的回归测试（见 C 节）。

---

## A. 规则引擎（`src/signals/engine.ts`、`src/signals/baseline.ts`、`src/notify/format.ts`）

### E1 — blocker：zero-baseline 反向屏蔽 5m 热度确认

- 位置：`src/signals/baseline.ts:63-69`（`meetsMultiple` 要求 `status === 'ready'`）；`src/signals/baseline.ts:43-50`（`medianNumerator === 0n` → `'zero-baseline'`）；`src/signals/engine.ts:88-93`（候选规则显式接受 `zero-baseline`）；`src/signals/engine.ts:94-99`（确认规则只走 `meetsMultiple`）。
- 问题：候选规则把中位数为 0 的基线视为倍数通过，5m 确认规则却因 `meetsMultiple` 只认 `ready` 而不命中。同一份基线语义，两条规则取了相反结论。设计第 10 节「>=100,000 且为前 12 桶中位数 5 倍」在中位数为 0 时数学上恒成立，应当命中。
- 触发：12 根前置自然 5m 桶中 7 根为 0（偶数样本中位数 = `(sorted[5]+sorted[6])/2` = 0），当前完整 5m = 300,000 USDG → `confirmRelative.matched = false`，`alertDraft = null`。把那 7 根改成 500–1100 USDG（更活跃、涨幅更小）反而 `hot`。RWA 稀疏池「长期冷清后爆量」正是核心场景，越安静越发不出。
- 修法：`meetsMultiple` 把 `zero-baseline` 与 `ready` 同等对待（`medianNumerator === 0n` 时返回 `value !== null`），与 `engine.ts:88-93` 一致；命中原因追加 `zero-baseline` 标注供 P5 区分。

### E2 — major：只评估恰好落在当前 5m 边界的那根桶，其余永久丢弃

- 位置：`src/signals/engine.ts:135-138`

```ts
const fresh =
  latest !== null &&
  latest.endSec === Math.floor(input.watermarkSec / 300) * 300 &&
  (next.lastFiveEndSec === null || latest.endSec > next.lastFiveEndSec);
```

- 问题：`fresh` 要求最新闭合桶的 `endSec` 正好等于当前水位所在 5m 边界。水位一旦跨过下一个边界，这根桶再也不会被 `relative`/`consecutive` 评估，没有补评估路径。
- 触发：同一份数据（12 根 10k 基线 + 一根 3600–3900 的 500k 桶），只改水位：`watermark=3900/4000 → hot`；`4200/4500/5100 → null`。重启后首批、任何 >5 分钟处理延迟、历史回放/backfill（按块推进常跨多桶）都会静默丢掉全部达标确认。
- 现状测试：`tests/unit/signals.test.ts:175-182`（"does not emit a stale last closed bucket"）把该行为固化成预期，需改写。
- 修法：`fresh` 改为「存在任何 `endSec > lastFiveEndSec` 的已闭合桶」，在 `engine.ts:141-155` 的循环里逐桶评估确认规则（不只评估 `latest`），冷却计时用桶自身 `endSec` 而非 `watermarkSec`。

### E3 — major：同级冷却永久吞掉另一根达标桶，且取决于批次落点

- 位置：`src/signals/engine.ts:151`（`next.lastFiveEndSec = b.endSec` 在冷却判定前无条件推进）；`engine.ts:190-200`（冷却抑制直接 `return noAlert()`）。
- 触发：`t=4190` 桶 3600–3900 = 120k → hot，`lastAlertSec=4190`；`t=4200` 新桶 3900–4200 = 150k → null（10s < 300s 被冷却），但 `lastFiveEndSec` 已推进到 4200；`t=4260/4400/4499` 重试全部 null。若首次告警水位是 3900 而非 4190，第二根桶会正常发出。同一条链上历史，批次落点不同 → 告警集合不同，破坏实时/回放一致性。
- 现状测试：`tests/unit/signals.test.ts:351-371` 断言到 `normal.alertDraft` 为 null 就停了，没有断言该桶从此发不出来。
- 修法：冷却计时改用桶边界（`latest.endSec`），使 300s 在 5m 尺度上等价于「跳过一根桶」；或被冷却抑制时不推进 `lastFiveEndSec`，允许下一批重试。与 E2 一起改。

### E4 — major：episode 没有终止条件，两次独立爆量塌缩成同一条告警

- 位置：`src/signals/engine.ts:202-218`。`episodeId` 只在 `null` 或 `kind === 'reheat'` 时重算；reheat 只能从 `cooling` 进入；cooling 需要连续 3 根桶低于进入阈值 25%。
- 触发：`t=3900` hot；随后 65 分钟每根 5m 桶都是 30k（>25k，永不降温）；`t=8400` 一根 500k 桶 → `kind=hot`，id 与 75 分钟前完全相同，两条 draft 的 `revision` 都是 1。
- 下游后果：`src/signals/project.ts:70-71` 的 `on conflict do update set payload_json=excluded.payload_json` 用新爆量覆盖旧记录；`src/notify/outbox.ts:21-26` 把未投递的旧 revision 标 `superseded`。若当时 `follow --notify local` 没在跑，第一次爆量永远不会展示；用户看到的是「旧告警的 revision 2」而非新事件。
- 修法：给 episode 加终止条件（连续 N 根非 hot 桶、或距上次同 episode 告警超过可配置时长即重开）；或把 `alertSequence`（见 E9）纳入 id 派生。

### E5 — major：本分钟候选不「每批可更新」，300 秒内金额定格在首次触发值

- 位置：`src/signals/engine.ts:190-200`（`sameLevel` 把 candidate 纳入同级冷却）。
- 要求：计划 Task 4.1「实时本分钟候选每批可更新，标 partial」；验收段「每批完整范围可更新本分钟候选」。
- 触发：`t=3601` 本分钟 25k → candidate（draft `partialCurrent.usdMicros = 25000000000n`）；`t=3603` 90k → null；`t=3620` 400k → null；`t=3650` 900k → null。候选提醒停在 25k 直到 300 秒后。
- 现状测试：`tests/unit/signals.test.ts:209-224` 断言的正是被抑制行为。
- 修法：`sameLevel` 只对跨分钟的新候选生效；同一 `minuteStartSec` 内金额实质变化时照常产出 draft，交由 `commitSignalDecision`（`project.ts:60-72`）深比较去重并升 revision。

### E6 — minor：偶数样本中位数为半整数时，「过去基线」显示 unknown

- 位置：`src/metrics/baseline.ts:17-22`（`medianBigInt` 在 `numerator % denominator !== 0n` 时返回 null）；`src/notify/format.ts:35-44`（`ratio()` 只用 `median`，忽略 `medianNumerator/medianDenominator`）。
- 触发：12 根前置桶为 10_000_000_001…10_000_000_012 micros，当前 300k → `status ready, median null, num/den 20000000013n/2n, multiplier 29.999999`，渲染为「过去基线：unknown；29.999999倍」。配置样本数 60 和 12 都是偶数，真实 micros 下约一半概率出现。
- 修法：`ratio()` 在 `median === null` 且 num/den 非空时用有理数渲染。

### E7 — minor：`RuleMatch.reason` 是写死常量，绝对量命中时描述错误

- 位置：`src/signals/engine.ts:110-128`。三条规则 `reason` 恒为 `'minute-absolute-and-relative'` / `'natural5m-absolute-and-relative'` / `'two-consecutive-natural5m'`，与实际命中路径无关。候选走 `zero-baseline/absolute-only` 时 `alertDraft.reasons` 正确，但 `matches[0].reason` 仍写 `and-relative`。`matches` 整条落盘 `signal_evaluations`（`project.ts:295-309`）供 P5 逐条比较，会得到误导证据。
- 修法：`reason` 按实际分支生成（absolute-only / relative-met / below-multiple / warming / zero-baseline），或补结构化 `detail` 字段。

### E8 — minor：单批 `coverage='gap'` 清空已累积的降温计数

- 位置：`src/signals/engine.ts:131-134`（`lowBuckets = 0` 后早退）。`coverage` 来自 `project.ts:270-275`，只取决于当前分钟 `partialCurrent.status`；当前分钟任何非 `watermark-partial` 的 reason（如一条 `event-time-mismatch`）就变成 gap，一次瞬时抖动把攒到 2 的 `lowBuckets` 清零。
- 修法：只在被计数的 5m 桶自身不完整时打断连续性（现有 `adjacent` 判定 `engine.ts:144` 已能做到）；当前分钟瞬时 gap 只跳过本批评估，不清零。

### E9 — nit：`alertSequence` 死状态

- `src/signals/engine.ts:211` 自增、`src/signals/types.ts:36` 持久化，全仓无读取。用于 id 派生（可顺带解 E4）或删除。

### E10 — nit：负数金额格式化产生 `-1.-5 USDG`

- `src/notify/format.ts:19-25`：`whole` 与 `remainder` 都带负号。先取绝对值再拼小数。

### E11 — nit：`format.ts` 对必填字段用可选链，测试借此绕过真实记录形状

- `src/notify/format.ts:64/69` 写 `alert.baseline?.fiveMinute`，而 `AlertRecord.baseline`（`types.ts:55`）必填。`tests/unit/alert-format.test.ts:39-84` 的 fixture 不提供 `baseline`，靠 `as AlertRecord` 通过，绝大多数断言走 `metric.baselineMedian` 回退路径；只有 `alert-format.test.ts:160-180` 传了 `baseline`。

### E12 — nit：`liquidityNote` 是原始 JSON 串

- `src/signals/project.ts:210` 用 `encodeJson(annotation.lastSwap)`，人可读输出里直接打印 JSON。语义上符合「仅作附注」（`liquidity-watch` kind 引擎从不产出），只是可读性差。

---

## B. Outbox / 撤回 / recorder 集成（`src/ops/recorder.ts`、`src/notify/outbox.ts`、`src/signals/project.ts`、`004-alerts.sql`）

### O1 — major：启动核对生成的告警打成 `backfill`，永不投递

- 位置：`src/ops/recorder.ts:290-298`

```ts
projectSignals(db, metricInput, options.signalConfig!, {
  ...recoveryContext(),
  captureMode: 'backfill',
});
```

  `deliverPending` 硬过滤 `capture_mode='live'`（`src/notify/outbox.ts:42`）。
- 触发（已复现）：已有录制历史但此前没用 `--notify local` 跑过的库（无 `signal_cursors`），首次带 `--notify local` 启动。`priorTip` 锚点一致 → 对当前行情做首次评估 → `alerts`/outbox 都是 `backfill, pending`，`drain summary {sent:0}`。一条描述当前热度的 hot 被静默吞掉；snapshot 已写 `state:'hot'` 并设 `lastAlertSec`，后续要等 300s 冷却 + 新自然 5m 桶才可能以 revision 2 补发。本次 `METRIC_VERSION` 升到 `p3-v3`（`src/storage/metric-store.ts:23`），升级后首次重启也会走 configHash 变化 → 全量撤回 → 重评为 backfill 的同一条路。
- 修法：该分支只用于核对锚点 + 投递积压时，应跳过 `projectSignals` 或用 `captureMode: 'live'`；若要区分旧历史与当前状态，按 `report.at` 是否等于当前 tip 分别打标。

### O2 — major：`enqueue` 的 supersede 不区分 `capture_mode`

- 位置：`src/notify/outbox.ts:20-26`

```sql
update alert_outbox set status='superseded',last_error='newer-revision'
where scope_id=? and alert_id=? and status in ('pending','failed') and revision <
(select max(revision) from alert_outbox where scope_id=? and alert_id=?)
```

- 触发（outbox 层已复现）：`{a, rev1, live, pending}` 后 enqueue `{a, rev2, backfill}` → rev1 变 `superseded`，rev2 永不投递，`delivered: []`。崩溃前已落库待投递的 live 提醒被永不投递的 backfill 行顶掉，`last_error` 全仓无读取，无任何痕迹。recorder 端可达性未构造出（需 epoch 未变 + source_hash 变 + watermark 未推进时规则重新命中），但 O1 证明 backfill 行确实会写入同一张表。
- 修法：supersede 条件加 `and capture_mode = <新行的 capture_mode>`，只允许同 capture_mode 之间 supersede。

### O3 — major：恢复撤回后同一份未变数据立刻以新 id 重发 hot，且无冷却

- 位置：`src/signals/project.ts:121-122`（无条件 `delete from signal_snapshots/signal_cursors where scope_id=?`）；`src/ops/recorder.ts:98-113`（`recover`，对 discovery scope 的 reorg 也执行 `retractSignals(scopeId, ..., 0n)`）。
- 触发（已复现）：数据不变，调一次 `retractSignals` 再投影 → `[002e9ba9 hot rev1]`、`[002e9ba9 retracted rev2]`、`[c932bf42 hot rev1]`。snapshot 整体删除 → `lastAlertSec=null` → `engine.ts:193-200` 冷却失效；epoch 变 → `episodeId` 变 → 新 id，消费者按 id/revision 去重拦不住。`repairedFrom`（`project.ts:153-178`）对 `pools` 组判定「出现 `block <= tip` 的新登记池即修复」，新池发现在 follow 中是常态，会让所有仍火热的池各产生一对「撤回 + 重复新提醒」。
- 修法：撤回时保留 `lastAlertSec`（或让新 epoch 继承冷却窗口）；snapshot 删除范围与 `fromBlock` 一致（只清受影响池）；未受影响池保留 `episodeId` 以便 revision 递增而非新 id。

### O4 — major：`--notify local` 每批同步开销约 1.3s，占 2 秒轮询预算 65%

- 位置：`src/signals/project.ts:213-343`（主循环）、`126-152`（`readEvidence`）、`179-212`（`presentation`）、`344-367`（`commitAcceptedSignalBatch`）。
- 实测（`data/p3-acceptance.sqlite` 副本，1827 池 / 603 Swap / 30 覆盖分钟）：`buildMetricsReport` 701ms；`projectSignals` cold 1117ms、cursor 短路 633ms；P2 rebuild 176ms。`follow` 的 `overlapBlocks=20 / pollIntervalMs=2000` 使 `src/ingest/follow.ts:127-134` 每轮都重录重叠区间并调 `recordRange`，即使链头未前进，所以约 1.3s 是每 2 秒一次的常态开销，全部在一个 `BEGIN IMMEDIATE` 写事务内持锁（`busy_timeout=5000`，`src/storage/database.ts:36`）。
- 热点：`project.ts:221` 的 `buildMetricsReport` 在 `232` 的 cursor 短路之前执行；`readEvidence` 对每条 active log 和每个登记池做 sha256 并把整张 evidence map 写进 `signal_cursors.evidence_json`（实测 586,741 字节/批）；`presentation` 每池 `report.rwa.find(r => r.poolIds.includes(...))` + `annotations.find` + `valuations.filter`，O(池²) + O(池×计价)，`project.ts:317-324` 的 `evidenceEventIds` 又重复一遍；每池 7 次 `db.prepare`（`265, 291, 295`、`commitSignalDecision:61`、`saveRecord:81`、enqueue 2 次），约 12800 次/批。
- 修法：cursor 短路移到 `buildMetricsReport` 之前（用 `projection_cursors` 的 sourceHash 先判）；`presentation` 先建 `Map<poolId, ...>`；prepared statement 提到循环外；evidence 改增量。

### O5 — major：`signal_evaluations` 只写不读，`alert_outbox` 无索引且永不清理

- 位置：`src/storage/migrations/004-alerts.sql:10-14, 20-27`；`src/signals/project.ts:295-309`；`src/notify/outbox.ts:39-52`。
- `signal_evaluations` 全仓只有一处 INSERT，无读取；实测每批 1827 行 / 911,673 字节，每 2 秒一批约 2.7 GB/小时，无 TTL、无 prune。
- `alert_outbox` 无 delete/prune；drain 查询计划 `SEARCH ... USING INDEX sqlite_autoindex_alert_outbox_1 (scope_id=?) / USE TEMP B-TREE FOR ORDER BY`，`status`/`capture_mode` 无索引，每 2 秒扫描该 scope 全部历史行并临时排序。单条告警 payload 34–47 KB（`artifacts/p4/alerts.jsonl`，`AlertRecord.metrics` 内嵌完整分钟序列），`alerts` 与 `alert_outbox` 各存一份。
- 修法：`alert_outbox` 加 `INDEX(scope_id, status, sequence)`；`signal_evaluations` 若 P5 不需要则删，否则加保留窗口并明确消费者；drain 后清理 `sent`/`superseded` 行。

### O6 — major：信号层异常回滚已接受范围，并被当成采集失败

- 位置：`src/signals/project.ts:344-367`；`src/ops/recorder.ts:399-403`；`src/ingest/follow.ts:166-176`；`src/ops/recorder.ts:425-431`。
- `commitAcceptedSignalBatch` 把 `acceptRange` 与 `projectSignals` 放同一事务是对的（`alert-reorg.test.ts:66-77` 有锁），但 `buildMetricsReport` 或引擎的任何异常（如 `metric-store.ts:127` 的 `ConfigError('Multiple watched RWA assets in pool ...')`、`metric-store.ts:100` 的 `Error('Projected swap lacks registration')`、`checkedNumber` 的 `RangeError`）会连带回滚本来有效的原始数据；`follow.ts:167-173` 非 `RpcFailure` 直接 rethrow，`recorder.ts:428-431` 记进 `result.failures` 并 exit 1。`--notify local` 下变成崩溃循环（每次重启重抓、重抛、零进度），对外表现为「采集失败」；不开 notify 时同一批正常接受。
- 修法：信号层异常单独归类（`result.failures.push('signal-evaluation')`，不改 exitCode 语义）；考虑退化为「接受范围但跳过本批信号 + 标 rechecking」。

### O7 — minor：本机投递失败完全静默

- `src/ops/recorder.ts:82-92` 的 `drain` 丢弃 `DeliverySummary`；`last_error='local-delivery-failed'` 全仓无读取；无日志、不进 `result.failures`、不影响 exit code。建议 drain 后输出一行 `{event:'alert-delivery', sent, failed}`。

### O8 — minor：单条投递失败无限期阻塞整个队列

- `src/notify/outbox.ts:77-78` 的 `break`。控制台 sink 走 `console.log`，stdout 断管（EPIPE）抛异常 → 该行 failed → 后续所有 pending 永不投递，且因 O7 无人知晓。

### O9 — minor：告警 id 间接依赖墙钟

- `engine.ts:202-218` 的 `episodeId` 输入含 `input.batchId`，而 `src/ingest/record-range.ts:338-349` 的 `batch.id = digest({..., observedAtMs, ...})`；`recorder.ts:93-97` 的 `recoveryContext()` 用 `randomUUID()`。同输入重放 100 次一条已验证，但「同一区间被重新抓取」会产出不同 episode/id，P5 回放需注意不可复现性。

### O10 — minor：`retractSignals` 的 `fromBlock` 过滤与快照删除不对称

- `project.ts:106` vs `121-122`：`endAnchor.number < fromBlock` 的旧告警保持 `active=1`，但其所属池状态机被整体清空 → 同一池可能同时存在两条 active 告警 id。

### O11 — minor：`commitSignalDecision` 去重比较跨 JSON 往返

- `project.ts:64-69`：`old` 来自 `decodeSignalState`（丢失显式 `undefined` 属性），`proposed` 是活对象，`isDeepStrictEqual` 可能判为不同而多推 revision。方向安全（只多发不漏发），但 100 次重放的保证实际主要靠 `project.ts:232` 的 cursor 短路。

### O12 — minor：死代码与错误信息

- `src/notify/jsonl.ts:6-8` `alertDeliveryKey`、`src/notify/console.ts:10` `consoleSink` 全仓无引用；README 要求消费者按 id/revision 去重，但官方 helper 既没用也没导出。
- `src/ops/recorder-cli.ts:88-96`：文件不存在 / JSON 语法错 / zod 校验失败统一成 `ConfigError('Invalid signal configuration')`，丢掉字段级信息。
- `recorder-cli.ts:88, 97-100` 解析 `--signals`/`--metadata`，但 `106-110` 只在 `--notify local` 时才传下去，写错路径也「校验通过」然后什么都不做。
- `src/storage/database.ts:40-56` readonly schema 校验未覆盖 004 表。

### O13 — nit

- `src/notify/jsonl.ts:10-14` `losslessJson` 把 bigint 序列化成字符串而 number 保持数字，JSONL 里 `usdMicros`/`endAnchor.number` 是字符串、`watermarkSec` 是数字，README 未说明。
- `004-alerts.sql:15-19` `alerts` 表无 `capture_mode`/`active` CHECK 约束，`alert_outbox` 有。
- `src/ops/recorder.ts:71-78` 在 `notify` 未开启时也用 `options.metricMetadata!` 非空断言。

---

## C. 测试缺口（修复时必须补）

1. 5m `zero-baseline` 用例：`signals-baseline.test.ts:18` 只断言 status，没断言 `meetsMultiple` 行为（E1）。
2. 「被冷却抑制的桶后续能否补发」断言（E3）；「水位跨过多个 5m 边界后达标桶仍被评估」断言（E2）。
3. `signals.test.ts:175-182` 与 `209-224` 是断言实现现状型测试，把 E2、E5 与计划冲突的行为固化，需按计划要求改写。
4. 偶数样本中位数在格式化层的用例（E6）。
5. 跨 episode 的 id 独立性用例：`signals.test.ts:183-196` 只验证同 episode 内 id 稳定与 epoch 变更后 id 不同（E4）。
6. 首次 `--notify local` 启动时当前热度能投递（O1）；backfill 修订不作废 pending live 修订（O2）；撤回后未变数据不重发新 id、冷却保留（O3）。
7. 单条投递失败不阻塞队列（O8）；投递失败有可观测输出（O7）。

## D. 已确认正确的合同（无需改动）

- 阈值单位与精度：`config/signals.initial.json` 的 micros 表示正确；全部比较走 bigint 交叉相乘（`baseline.ts:68`），float 只用于展示。
- 边界方向：候选/确认/连续/升级 `>=`，降温严格 `<`，冷却 `elapsed < 300` 才抑制。
- 两条确认规则独立命中（`engine.ts:110-129`、`174-175`），未 OR 合并。
- baseline 只读当前窗口之前的同尺度完整桶（`baseline.ts:22-37`），无 Infinity/NaN，样本不足禁用倍数保留绝对量候选。
- 升级绕过冷却；reheat 不依赖市值；gap/rechecking 不降温、不填 0、不移除池；候选期间保留 cooling 再热资格（`engine.ts:225`）。
- 出生分钟适配无泄漏（`windows.ts:237-244`、`419`）。
- codec `{$bigint}` 往返无损且校验 `/^-?\d+$/`。
- format 未知值不显示 0，小数不丢精度，revision 有标注。
- 配置 schema `.strict()`，无 webhook/email/聊天地址；`--notify` 只接受 `local` 且只允许 `follow`。
- 事务边界：`commitAcceptedSignalBatch` 在一个 `BEGIN IMMEDIATE` 内完成 acceptRange → P2 rebuild → buildMetricsReport → 快照/评估 → commitSignalDecision → enqueue，全链路无 `await`；投递在提交之后（`recorder.ts:403`，`outbox.ts:34` 事务内禁止投递）。
- id 稳定性：`hash([chainId, poolRegistrationId, ruleVersion, episodeId, kind])`，`atBatchId`/`observedAtMs` 只进 payload；100 次重放一条由 `alert-reorg.test.ts:32-39`、`143-159` 双重锁住。
- outbox 状态机 CHECK 约束、attempts 递增、失败可重试、新 revision 替代旧 pending、投递中被替代前重查、失败写回带 `status in ('pending','failed')` 守卫不覆盖 superseded。
- 撤回/重组主路径：`recover()` 与 `retractSignals` 同事务；`onRecovery` 首行 `drain(true)`；`alert-recorder.test.ts` 的 `{fork:true, outage:true}` 真实覆盖登记恢复撤回 + discovery 503 失败仍投递撤回。
- provisional-only，无 finalized；backfill/synthetic 不进 live sink，live 撤回保持 live 资格。
- 迁移 004 幂等（`CREATE TABLE IF NOT EXISTS`，P3 旧库可写打开自动补表）。
- 资源：`recorder.ts:515-517` `finally { db.close() }`；JSONL sink 每次 open→writeFile→sync→finally close 并串行化。

## E. 验证记录

```
$ pnpm exec tsc --noEmit
exit=0

$ pnpm exec vitest run tests/unit/signals.test.ts tests/unit/signals-baseline.test.ts tests/unit/alert-format.test.ts tests/unit/alert-recorder-cli.test.ts tests/integration/alert-outbox.test.ts tests/integration/alert-reorg.test.ts tests/integration/alert-recorder.test.ts tests/integration/alert-new-pool.test.ts
 Test Files  8 passed (8)
      Tests  62 passed (62)
```

探针脚本（引擎 probe1–4、outbox probe1–5）位于会话 scratchpad，未纳入仓库；关键输出已内联在各条 finding 的「触发」段。全量 539 测试沿用 `artifacts/p4/tests.json`，本轮未重跑。
