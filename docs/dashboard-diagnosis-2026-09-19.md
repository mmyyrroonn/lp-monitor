# 仪表盘诊断报告(2026-09-19)

本报告对应 2026-09-18 提出的四个任务:① 排行与热力图"对不上";② 分钟格子"缺少完整数据"与"0 笔"的差别、以及"边界交易时间不确定"为何连续出现;③ 排行表加列排序;④ 数据截止落后 6–7 分钟。除特别标注外,结论均已对照源码与运行中数据独立验证;agent 重建的统计数字只经抽样印证,未独立重数。

---

## 一、任务 ④:数据落后 6–7 分钟(诊断完成,已处置)

**根因:** 2026-09-18 17:08–17:16 UTC 一次 provider 故障(187 次 request-failed,期间 ~0.98 rps vs 正常 ~2.5;agent 另报 24 次超时,我在日志只数到 6 个 10s 看门狗超时,不影响结论)。其中一批被写成 `incomplete` 后整批重抓,约 17:10:37 → 17:13:44 零净进度。

**为什么不自愈:** 掉队后 `capture_mode` 转 `backfill`,而 `maxBackfillRpcRps` 默认 **1**(`src/config/chain.ts:78`;生效配置 `config/robinhood.json` 未设该键,`config/runtime.local.json` 里的显式 1 未被加载)。1 rps 与本链 ~10 块/秒 + 每 1000 块约 85 次 `eth_getLogs` **刚好打平**;phase 每批重算(`src/ops/recorder.ts:1103-1107`),要拿 5 rps 必须先追平链头 —— 迟滞,现有进程永远填不上。

**重启语义:** `follow` 不带 `--from` 时起点是启动瞬间的链头(`recorder.ts:1049-1055`),不读 cursor;**重启 = 跳过缺口,不是追平**(`README.md:5`)。量得的真实落后约 427 秒;批次表的 `observed_at_ms` 比 cursor 落库早 60–90 秒,直接拿它算会系统性偏小。

**数据质量:** 投影与采集同块同哈希、`queueDepth=0`、`outboxPending=0` —— 只是慢,没有丢、没有错。

**处置:** 该 run 已于 2026-09-19 凌晨停止。未来新 run 前建议决定:是否把 `maxBackfillRpcRps` 提到 3–5(必须 ≤ `rpcPerSecond: 5`,否则被主限流器静默吞掉;`docs/reviews/2026-09-10-p6-independent-review.md` M-6 有记录)。这是 RPC 额度取舍。

## 二、任务 ②:分钟格子的三种文案与"连续边界不确定"

**文案判据**(`read-model.ts:882-895`,`available = reasons.length === 0`):

| 你看到的 | 含义 |
|---|---|
| `N 笔` / `0 笔` | 该格数据完整,数字是真实计数。**`0 笔` 是真的没有交易,不是没数据** |
| `分钟尚未完整` | 正在走的这一分钟,右端被 watermark 截断(`partial`) |
| `缺少完整数据` | 格内有任何一个"未知",数字被整体拒绝给出 |

**"边界交易时间不确定"是什么:** 全库事件时间只有分钟精度 —— `log_times` 全表 `exact_timestamp_sec` 无一行非 NULL,唯一生产者 `minuteTime()`(`src/ingest/log-time.ts:34-40`)把采样锚点的秒主动向下取整。这是设计("never provider log timestamps",`log-time.ts:53`)。当某个分钟桶跨在窗口边界上时,交易可能在内也可能在外,代码选择**不猜**,整窗作废。

**"连续不确定"的真相:不是边界连续不确定,是那些分钟连续有交易 + 一个差一秒的 bug。**

**Bug(`src/metrics/rolling.ts:33`):** 判"整桶在窗外"写 `m + 60 <= start`,而第 34 行判"整桶在内"写 `m + 59 <= end` —— 同一个函数两个边界两套上界。按全仓约定(桶 = 闭区间 `[m, m+59]`,见 `src/metrics/price.ts:50`、`src/metrics/liquidity.ts:69`)第 33 行错。当 `start ≡ 59 (mod 60)` 时,上一分钟桶的上界正好压在 start 上(因窗口左开必在窗外),却被误判为"不确定"。热力图格子恰是 `start = minuteStartSec - 1`(`read-model.ts:878`、legacy `snapshot.ts:146`),**恒触发:某分钟有交易,它的下一格必显示"缺少完整数据"**。DB 重建 120/120 代币零反例;JNJ/AMC 抽样实测吻合。

**为什么测试没抓到:** 只有 `start ≡ 59 (mod 60)` 才咬人;常规滚动窗口 start 都是整分钟,新旧判据数学等价。两个"独立"参考实现(`tests/helpers/reference-rolling.ts:34`、`tests/helpers/rolling-reference.ts:29`)**逐字复制了同一行**,等价性测试把错误锁死。

## 三、任务 ①:排行"突然升温"看不到热力图有量的代币

与任务 ② 同源,是它的第三个面孔:

- 排行窗口是滑动窗口 `(wm−duration, wm]`,start 落在分钟**中间**;含 start 的分钟桶真跨边界 → `boundary-time-unknown` → 整窗 `available=false` → 该列显示 `—`。
- 排序放大:`view-model.ts:29` 任一为 null 即 `unknown`(「数据不足」),`:39-40` null 恒排最后。实测 5 分钟交易数**前 12 名 12/12** 全是 `—`;越活跃越看不到(30 分钟 ≥200 笔组灰格占比 52%,0 笔组 0%)。
- 热力图"有量"与排行"无量"不矛盾:热力图按整分钟格子(m 格有颜色 ⟺ m 有成交且 m−1 没有),排行按滑动窗口,粒度不同。
- 用户观察 AMZN"五六分钟前有量"完全吻合(6 格前、6 笔)。**GLD 未复现**(诊断时整行全灰、排行 111/194),可能只是观察时刻已滚动过去,未确认。

**其他发现:** 此前 1h 列 194/194 `coverage-missing` 是 run 太年轻(仅 35 分钟历史),非 bug,数据满 1 小时后自愈。

## 四、任务 ③:排序列排序(已完成并合并)

表头(1分钟交易数 / USDG等值量 / 池子 / 名字)可点击排序:数字列默认降序、名字默认升序,再点反向;未知窗口恒排最后、不分方向;USDG 复选框与列排序状态双向同步;未点任何表头时保持原热度排序。view-model 单测 21/21(含 BigInt 精度、null 恒末尾、中文名排序、tie 稳定),构建通过,浏览器人工验收通过。已 ff 合并 main(commit `8ad3b58`)。

## 五、现有状态

- **main**:已含列排序(8ad3b58)。
- **task/fix-minute-boundary-off-by-one**:任务中止,**保留未合并**。分支内含:一行修复(`m + 60` → `m + 59`)+ 两个测试参考实现同步 + 一条 ≡59 回归用例;`rolling-windows` 7/7、等价性 18/18 全绿。丢弃或合并,由你决定。注意:此修复治的是热力图假 gap 与历史回看假 `—`,**治不了 live 排行的 `—`**(那个是正当保守拒答)。
- **进程**:recorder 已停(run 结束);dashboard 由我重新拉起,8787 端口服务中(数据为停采时的旧数据)。
- **记忆文件**:`memory/backfill-1rps-break-even-lag.md`、`memory/rolling-minute-bucket-off-by-one.md`。
- **数据库**:分钟覆盖约 5.4 天;`recorder.sqlite` 约 5.5 GiB。

## 六、未决事项

1. **live 排行 `—` 的修法二选一**(要动语义,需单独决策):
   - (b) 窗口对齐到最后一个完整分钟:`end' = floor((wm−59)/60)×60 + 59`(对齐到 ≡59;天真的 `floor(wm/60)×60−1` 每分钟错 1 秒,对齐到 ≡0 会原样复犯跨边界)。代价:1m 视图最多滞后 59 秒。
   - (d) 给事件写精确秒:只有恰好落在采样块上的日志能拿到;全量需采纳 provider 区块时间戳并交叉验证 —— 信任管道工程,且只对新数据生效。
2. 未来新 run 前:`maxBackfillRpcRps` 是否提至 3–5(额度取舍)。
3. GLD 对不上:下次观察时留意是否复现。
4. `task/fix-minute-boundary-off-by-one`:丢弃还是合并。

## 七、未验证/口径标注

- 影响面数字(491 假 gap 格、730 格预测、12/12 前 12 名)来自 agent 的 DB 重建;我只独立印证机制与抽样,未独立重数。
- "24 次超时":agent 报告 24,我在日志数到 6;不影响结论。
- 排序列的 DOM 行为由用户浏览器人工验收,无自动化 e2e。
- 修复分支的测试是我亲自跑的三处文件(7/7、18/18),未跑全量套件。

---

## 八、复核与处置(2026-09-19 完成)

按第七节口径逐条复核后,第六节剩余问题均已修复并验证。复现均在停止采集的同一个 `data/recorder.sqlite` 上进行。

### 1. 分钟桶 off-by-one:已合并(commit `806ff0e`)

在运行中的旧构建上直接复现:watermark 秒数 ≡35,GLD 5m `reasons: ["boundary-time-unknown"]`,GLD 热力图可见格全为 `gap`;直接调用 `inRollingWindow` 也复现“前一分钟有交易 → 下一格被误判为未知”。先前中止的 `task/fix-minute-boundary-off-by-one` 未被丢弃:rebase 后合并,`m + 60` → `m + 59`,两个测试参考实现同步,≡59 回归用例锁定契约。

### 2. live 排行 `—`:采用方案 (b)(commit `8c836fd`)

选择 (b) 而非 (d):实时窗口结束点取最后一个完整分钟 `lastCompleteMinuteEnd(wm) = floor((wm−59)/60)×60+59`;不足一个完整分钟的新 run 回退到 watermark,保持旧保守行为。worker 与 legacy snapshot 两条路径共用同一 helper,不再各自为政;热力图照旧展示当前未完整分钟。代价为 1m 视图最多滞后 59 秒,已在 `docs/dashboard.md` 指标口径注明。

### 3. `maxBackfillRpcRps`:设为 3 并加校验(commit `fed5784`)

- `config/robinhood.json` 显式 `maxBackfillRpcRps: 3`(高于 ~0.85 rps 平衡线,低于 `rpcPerSecond: 5`),`config/runtime.local.json` 同步为 3。
- `src/config/chain.ts` 新增 `maxBackfillRpcRps ≤ rpcPerSecond` 校验(补上 P6 review M-6 的静默吞限流),超限在加载时直接拒绝。
- `tests/unit/config.test.ts` 固定发行配置必须高于 1 rps 平衡线,防止悄悄回退。

### 4. GLD:确认与结案

新构建在同一库上端到端复测:

| 指标 | 修复前(旧构建) | 修复后 |
|---|---|---|
| watermark / selectedEndSec | 1789757555 (≡35) / 同 | 1789757555 (≡35) / 1789757519 (≡59) |
| 194 个代币中 5m `boundary-time-unknown` | 35 | **0** |
| GLD 5m | `null`,`boundary-time-unknown` | **90 笔**,available |
| GLD 热力图 8 格 | 全 `gap` | 7 个 closed(26/20/18/17/18/13/24)+ 最后 1 个 partial(19) |
| GLD 排行 1m | `—` | 24,等于热力图最后一个完整格 |

GLD 5m 的 90 与直接 SQL 统计该对齐窗口内不同交易数(90)一致。AMZN/SPY/AMC 修复后仍为 `pool-lifetime-incomplete`,是池出生晚于窗口的真实 warming,不属于时间边界问题。

### 5. 验证状态

- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过。
- 全量测试 146 文件 / 1288 用例通过(修复前基线 1281,新增 7 条)。
- 端到端:新构建在 8799 复测通过;8787 已用同一构建重启。
- 未做:方案 (d)(为事件写精确秒)未采纳;`metric-store` 的滚动窗口(信号/提醒/CLI)仍以 watermark 为结束点,保持原有保守语义,属另行决策。
