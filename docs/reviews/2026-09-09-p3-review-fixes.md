# P3 复核发现与修复任务书

日期：2026-09-09。对象：提交 `b86c2f8`（fix/p2-review，基线 `433d37d`）。本文件是给执行修复的 agent 的任务书，不是验收记录。修复完成并验证后，在文末「修复记录」填写结果。

本轮复核在既有 [独立审查](2026-09-09-p3-review.md) 和 [验收](2026-09-09-p3-acceptance.md) 之外独立进行。复核前置结论：**P3 无阻塞项，核心合同实现正确**。已逐项在代码中确认前一轮审查声称的修复真实存在：覆盖按 address/topic 分区展开且成功短分片不能借用同族覆盖（`src/metrics/coverage.ts:34-61,128-150`）、无事件登记池保留与出生前 warming（`src/metrics/windows.ts:115-116,223-227`）、安静零基线与精确分数中位数（`windows.ts:285-288`、`src/metrics/baseline.ts:8-16,39-48`）、无效当前前缀 unknown 与过期分钟排除（`windows.ts:228-245`、`src/metrics/ranking.ts:13-16`）、元数据同高度哈希冲突移除 decimals（`src/metrics/metadata.ts:50-81`）、USDG 单侧与事件位置在先的保守年龄报价（`src/metrics/notional.ts:92-131`、`src/metrics/price.ts:60-81`）、跨池 txCount 集合并（`src/metrics/rwa-aggregate.ts:52,60`）、L 观测拒绝未来块与哈希冲突（`src/metrics/liquidity.ts:74-99`）、指标持久化同事务（`src/storage/metric-store.ts:275-306`）、RWA 当前前缀无效时 `activity: null`（`metric-store.ts:137-142,163-170`）。closed 四条件（边界有效、同 scope 全块覆盖、每分区覆盖、解码与归桶无缺项）在 `coverage.ts:204-246` 全部存在；当前分钟只能是 partial/gap/warming，基线与自然 5m 桶只取 closed。

复核时全库 453 测试通过，lint/typecheck 退出 0。下面列出的都是在此基础上应修或建议修的问题。必修项全部是「今天不可达、上游约定一变就静默产出错误数字」的潜在 bug，或直接影响验收问题「哪池量大」可读性的输出问题。

## 执行约束

- 在 `fix/p2-review` 之上切一个任务分支再动手；**不要提交到 main，不要 push**。
- 允许修改：`src/metrics/`、`src/storage/metric-store.ts`、`src/storage/database.ts`、`src/ops/metrics-cli.ts`、`src/cli.ts`、`tests/unit/`、`tests/integration/metrics-*.test.ts`、`docs/superpowers/plans/2026-09-08-p3-metrics.md`、本文件。
- 禁止修改：`src/storage/migrations/*.sql`、`src/protocols/`、`src/state/`、`src/ingest/`、`src/registry/`、`artifacts/`、`data/`、`config/`、`pnpm-lock.yaml`、任何 P0–P2 已验收逻辑。不新增依赖。
- 全局约束不变：金额 bigint、持久化无损字符串、缺口不补零、未知不写零、业务结果绑定 chainId/blockHash/版本、日志不含带凭据的 URL。
- 每条修复都要有对应回归测试；已有测试不得删除或 skip，只能修正其期望值并在本文说明理由。
- 改动了 `src/metrics/**` 的归桶、基线、排名或计价语义时，必须 bump `src/storage/metric-store.ts:21` 的 `METRIC_VERSION`（本轮为 `p3-v2`），用于区分指标语义与审计证据。当前 P3 表只写不读，公开读取重新计算；不是因为现有读取路径会把旧 P3 缓存判为 fresh。
- 完成后运行全部验证命令，把真实输出贴进「修复记录」。任何一条失败先停下报告，不要为了让测试变绿改测试。

## 必修（合入前完成）

### F1. 5m 基线最小样本数无法独立配置

- 位置：`src/metrics/windows.ts:110-111`
- 现状：`minuteMinimumSamples` 与 `fiveMinuteMinimumSamples` 都读 `options.minimumBaselineSamples`，默认值分别是 60 和 12。调用方一旦传该 option，5m 门槛就和 1m 一起被覆盖，`?? 12` 形同虚设。
- 失败场景：11 个连续 closed 分钟、传 `{ minimumBaselineSamples: 1 }`，5x1m 只有 1 个前置 5m 样本就输出倍率 2.67；不传 option 时正确为 null。生产路径 `src/storage/metric-store.ts:122` 不传该 option，所以线上仍是 60/12，`artifacts/p3/rank.json` 的 `multiplier: []` 也印证了这一点。但 `tests/unit/windows.test.ts` 用 `minimumBaselineSamples: 1/3` 断言的 5m 倍率实际上没验证合同里的 12 门槛。
- 修法：拆成两个 option（如 `minimumOneMinuteSamples` / `minimumFiveMinuteSamples`），各自保留 60 / 12 默认值；`BuildMinuteMetricOptions` 类型同步更新。
- 测试：新增「5m 前置样本不足 12 时 `recentClosed5x1m.volumeMultiplier` 与自然 5m 桶倍率均为 null，满 12 时非 null」的单测；现有用 `minimumBaselineSamples` 的测试改用新 option 名并保持期望不变。

### F2. rawToken 大小写不一致会静默丢掉安静零基线

- 位置：`src/metrics/windows.ts:287`（空分钟 `{ token: rawToken, raw: 0n }` 原样保留大小写）、`windows.ts:316`（`sumRaw` 把 token 小写化）、`windows.ts:323-328`（`sameScale` 用 `===` 比较 token）。
- 现状：空分钟与有成交分钟的 `rawNotional.token` 大小写可能不同，`sameScale` 判为不同尺度，安静零分钟被排除出原币基线。
- 失败场景：同一池，token 用校验和格式 `0xAAAA…`，一个安静分钟后一个 100 单位成交分钟，`recentClosed1m.baselineSampleCount` 为 1、倍率为 1；全小写对照组为样本 2、倍率 2。即一次真实 2 倍放量被报成 1 倍且无任何 reason。
- 今天不可达：所有生产 token 来源已小写化（`src/config/chain.ts:5-12` zod transform、`src/registry/assets.ts:33`、`src/registry/pools.ts:35-36`）。
- 修法：`windows.ts:287` 改为 `{ token: rawToken.toLowerCase(), raw: 0n }`，并在 `sameScale` 里做大小写无关比较（或在 `rawToken` 计算处统一小写，二者取一但要一致）。
- 测试：用校验和格式 token 复现上述场景，断言 `baselineSampleCount` 为 2、倍率为 2。

### F3. coverage 硬编码 chainId 4663

- 位置：`src/metrics/coverage.ts:226-228`
- 现状：`times.get(\`4663:${blockHash}:${txHash}:${logIndex}\`)` 字面量拼键。`times` 的 key 来自 `src/storage/manifest.ts:80-82` 的 `rawLogKey`，它用 `src/domain/chain.ts` 的 `CHAIN_ID`。与 P2 任务书 F1 同一类问题。
- 失败场景：`CHAIN_ID` 改动后所有 `times.get()` 返回 undefined，每个含日志的分钟被打上 `event-time-mismatch`，全部退化为 gap、指标整体为 null，不抛错。现有测试全部用 4663，抓不到。
- 修法：直接调用 `rawLogKey({ blockHash, transactionHash, logIndex })`；全仓 grep `'4663:` 与 `` `4663: `` 确认 `src/metrics/` 无其他硬编码。
- 测试：mock `CHAIN_ID` 为其他值（参照 `tests/` 里 P2 F1 的 project-keys 做法），断言含日志分钟仍能 closed。

### F4. 一个池含两个受监控 RWA 时计价侧按地址字典序任选，且交叉计入

- 位置：`src/storage/metric-store.ts:76-80`（`related[0]?.address` 选侧）、`metric-store.ts:101-105`（同一 valuation push 进每个相关资产的桶）。
- 现状：`input.assets.assets` 在 `src/registry/assets.ts:34` 按地址排序，`related[0]` 是地址最小的资产，不是任何语义选择。同一笔 valuation 会计入所有相关资产，资产 B 的 `blockRangeActivity.nativeTotals` 里出现以资产 A 计价的原币量。
- 今天不可达：`config/watchlist.amc.json` 只有 AMC 一个 rwa。
- 原建议的两种方案（复核后本轮采用方案 2；计价归属不能替代资产参与关系）：
  1. valuation 显式携带 `pricedAsset` 字段，聚合时只归入该资产；池含多个受监控资产时按固定规则选侧（建议：USDG 对手方优先，否则拒绝计价并记 `ambiguous-rwa-side` 原因，不写零）。
  2. 若决定不支持多 RWA 池，在 `metric-store.ts` 显式检测 `related.length > 1` 抛 `ConfigError`，并在 plan Task 3.1 写明限制。
- 测试：两个受监控资产共池，有成交及无成交时都在报告生成前抛 ConfigError；多资产 watchlist 未出现共池时继续正常输出。

### F5. rank 输出被零成交池淹没

- 位置：`src/metrics/ranking.ts:9-13`（只要求 `usdMicros !== null`）、`src/metrics/windows.ts:309-313`（`sumValued([])` 返回 `0n`）。
- 现状：完全 closed 但零成交的分钟 `usdMicros` 是 `0n`（这本身正确），后果是每个已登记但没动过的池都进入 `volume5mClosed` 排名。`artifacts/p3/rank.json`：1824 行 closed5m 中 1814 行 `usdMicros: "0"`、`swapCount: 0`。数字没错，但「哪池量大」的答案被 99.5% 填充行埋住。
- 修法：`rankPools` 对 `volume5mClosed` 额外要求 `recentClosed5x1m.swapCount > 0`。**不要**改成过滤 `usdMicros === 0n`，那会误杀真实成交但金额向下取整为 0 的池。倍率榜维持现有条件。
- 测试：一个有成交池 + 一个零成交 closed 池，断言后者不在 `volume5mClosed` 榜内；金额取整为 0 但 swapCount 为 1 的池仍在榜内。

### F6. `blockRangeActivity` 无覆盖门禁、无 `available` 标记

- 位置：`src/storage/metric-store.ts:156`
- 现状：`aggregateRwa(swaps)` 把保留区间内全部 valuation 求和，包括落在 gap 分钟的成交与 `minuteStartSec === null` 的成交；同一对象里 `closed5m`（157-162）和 `partialCurrent`（163-170）都有门禁和 `available` 标记，唯独它没有。验收文档里「603 笔 Swap、313 个不同交易」就是它，「属于历史录制区间、未经覆盖认证」只写在文档里，payload 消费者看不到。
- 修法：给该对象加 `fromBlock` / `toBlock` / `coverageVerified: false`（或改名为 `retainedRangeActivity`），让语义进入 payload 本身。不改计算逻辑。
- 测试：断言 CLI 输出与持久化报告里该字段带块区间与标记；`tests/integration/metrics-cli.test.ts` 相应期望更新。

### F7. `multiplierUnit` 的 null 判断写错

- 位置：`src/ops/metrics-cli.ts:140-143`
- 现状：`w.recentClosed1m?.usdMicros !== null` 在 `recentClosed1m` 为 null 时是 `undefined !== null`，为 true，会宣称单位是 `'usdMicros'`。目前不可达（`recentClosed5x1m` 非 null 蕴含 `recentClosed1m` 非 null），且这段逻辑重复了 `windows.ts:347` 已算好的 `baselineUnit`。
- 修法：改为 `w.recentClosed1m?.baselineUnit ?? null`。
- 测试：`recentClosed1m` 为 null 的池，断言 `multiplierUnit` 为 null。

## 建议修（可与必修同批，也可留到 P4 前）

### S1. `quoteFromRwaUsdgSwap` 接受 USDG 侧为 0

`src/metrics/price.ts:105-111` 只拒绝 `usdgAmount < 0n`，`price.ts:72` 只跳过负数、`77-78` 选最新报价。一条价格为 0 的退化报价会覆盖之前的正常报价，让后续 60 秒内成交全部得到 `usdMicros: 0n` 且 `quality: 'usd-estimate'`。今天不可达（解码层把零侧 Swap 归为 `swap-nontrade`，`metric-store.ts:73` 只处理 `kind === 'swap'`）。建议 `usdgAmount <= 0n` 抛错，`findPrecedingQuote` 跳过 `numerator === 0n`，补一条单测。

### S2. txCount 交易哈希集合未小写化

`src/metrics/windows.ts:290,368` 直接用 `transactionHash` 建 Set，`src/metrics/rwa-aggregate.ts:52,60` 则小写化。今天安全（`src/registry/pools.ts:24-30` 已归一），但与 F2 同类不对称，建议统一。

### S3. 基线回溯无时间上界且 O(m²)

`src/metrics/windows.ts:329-351` 每个分钟重新 `slice(0, index).filter(...).slice(-limit)`，1827 池 × 181 分钟约 6000 万次过滤步。`.slice(-limit)` 只限数量不限时间，跨长 gap 后 60 样本的 1m 基线可能来自 3 小时前；`buildNaturalBuckets`（400-403）同样无时间上界；只有 `recentFive`（439）限制在 `limit * 300` 秒内。三处策略不一致。当前 180 分钟视野兜得住，扩大视野前应统一为「数量 + 时间」双上界并线性化。

### S4. `src/metrics/format.ts` 是死代码

全仓只有 `tests/unit/metric-labels.test.ts:10` 引用，`src/ops/metrics-cli.ts` 全走 `encodeJson`。要么接进 CLI 可读输出，要么删除并把 plan Task 3.3 对应勾选项据实调整。

### S5. 出生分钟永远 warming

`src/metrics/windows.ts:223-227` 的 `beforeBirth` 条件 `coverage.fromBlock < discoveredAtBlock` 把跨越发现块的那一分钟（`fromBlock < discoveredAt <= toBlock`）也判成 warming，该分钟真实成交只在 `blockRangeActivity` 里以未分钟化形式存在。对「新池热度」目标而言这恰恰是最该看的一分钟。建议给出生分钟一个 `partial-since-birth` 状态（可展示、不入基线）。

### S6. 只读 schema 校验白名单未跟上 P3 新读表

`src/storage/database.ts:40-51` 白名单不含 P3 新读的 `ingest_batches`、`fetch_shards`（`coverage.ts:90-111`）、`minute_boundaries`、`anchors`（`coverage.ts:191-198`）。schema 不匹配时抛原始 `SqliteError` 而非 `ConfigError`。这几张表与 `raw_logs` 同属 migration 001，今天不可达。

### S7. `metric_windows` / `metric_cursors` 只写不读

`src/storage/metric-store.ts:275-306` 是唯一触碰点，全仓无读回路径，`003-metrics.sql:5` 的 `source_hash` 列不起门禁作用；真正的新鲜度门禁是 `src/storage/projection-store.ts:150-152`。与 `projection-store.ts:24-27` 注释的已知待办一致，P4 若要读派生缓存必须先补新鲜度校验。表结构与写入代码逐列一致。

### S8. plan 措辞与代码不一致

`docs/superpowers/plans/2026-09-08-p3-metrics.md` Task 3.2 写「最后 5 个完整 1m 合计」，字面可理解为不要求相邻；代码 `windows.ts:435-436` 实现的是「紧邻当前分钟的连续 5 个且全部 closed，否则 null」；验收文档写「连续五个完整 1m」。代码的严格解释是对的，改 plan 措辞为「紧邻当前分钟的连续 5 个 closed 1m」，避免下个窗口按字面重做。

### S9. 测试覆盖缺口

- CLI 快乐路径无自动化测试：`tests/integration/metrics-cli.test.ts` 只测退出 4 与参数校验。补一条：有数据库时 `metrics` / `rank` 退出 0、`status: 'observed'`、排名顺序符合 volume 再 txCount 再 poolId 的 tie-break。
- 「自然 5m 第五分钟是当前 partial 时不生成桶」无测试（`windows.test.ts:135-144` 只测中间 gap）。探针确认行为正确，补测试钉住。
- `selectCoverage`（`windows.ts:203-213`）多 scope 时返回 `[]`、整池 warming，无测试也无 reason。补测试，并考虑输出 `multi-scope-unsupported` reason。
- `coverage.ts:230-236` 的 `exactTimestampSec` 越界分支无测试；且因 `src/ingest/log-time.ts:36-38` 永远写 `exactTimestampSec: null`，它对落库数据是死分支。补测试或加注释说明它是防御性代码。

## 验证命令（全部退出 0，把真实输出贴到修复记录）

```
pnpm lint
pnpm typecheck
pnpm test
pnpm build
# 以下命令仅在隔离验收副本的根目录执行，禁止在主工作区直接运行
node artifacts/p3/verify-acceptance.mjs
```

`pnpm test` 当前基线：42 文件 / 453 用例通过。修复后用例数只能增加。若 `METRIC_VERSION` 已 bump，主工作区 `artifacts/p3/*.json` 中历史 `version: 'p3-v1'` 保持不变。原验收脚本会覆盖输出并写验收数据库，且不检查版本差异；本轮在隔离副本运行，再显式检查新输出为 p3-v2。

## 停止条件

- F4 若发现必须改 `src/registry/assets.ts` 或 `config/` 才能表达计价资产，停下报告，不要自行扩大范围。
- 任何修复导致现有测试期望需要改动时，先在本文「修复记录」写明理由再改。
- 需要新依赖、需要改 migration、或 plan 与代码矛盾无法用 S8 的方式解决时，停下报告。

## 修复记录

修复日期：2026-09-09。分支：`fix/p3-review`。基线：`f1f267c`。完整验证通过，集成范围审查及最终整体独立审查均 PASS，无待修复发现。

### 已确认执行口径（2026-09-09）

用户确认按 Codex 复核结论修复；基线 f1f267c，任务分支 fix/p3-review。
- 本轮完成 F1–F7、S1/S2/S6/S8；S9 补与修复相关的集成成功路径和窗口边界测试。S3/S4/S5/S7 的扩展不在本轮。
- F4 采用方案 2：任何登记池同时含两个受监控资产时，在生成报告前抛 ConfigError（含无成交池）。不按地址任选计价侧，也不以仅归一个资产的方式丢弃参与关系。支持多 RWA watchlist，但暂不支持共池。
- F3 同时统一 metadata schema 和报告 chainId，均取 CHAIN_ID。
- 升级 p3-v2 用于区分指标语义和审计材料。当前 P3 派生表只写不读，公开读取重新计算；升级原因不是当前代码会误读旧 P3 缓存。
- 原验收脚本会写 artifacts/p3 和 data/p3-acceptance.sqlite，且不拒绝新版本。仅在隔离副本中执行原脚本，主工作区历史证据保持字节不变。
- 测试期望变化：现有 minimumBaselineSamples 参数改为 minimumOneMinuteSamples，原断言保持不变；新增测试分别控制两个门槛。其余现有断言不计划修改。
- TDD 阶段新增回归的预期失败属于修复证据；完整验收中的意外失败须先定位真实原因，不为通过验收削弱断言。
### 实现与验证结果

| 项目 | 状态 | 实现与回归证据 |
| --- | --- | --- |
| F1 | 已修复 | 1m / 5m 参数独立，默认 60 / 12；11 个前置 5m 样本保持 null，12 个可用；单独调低 5m 不降低 1m 门槛。 |
| F2 | 已修复 | 安静分钟 rawToken 归一为小写，尺度比较忽略大小写；校验和地址的零样本不再丢失。 |
| F3 | 已修复 | coverage 复用 rawLogKey，metadata schema / 报告复用 CHAIN_ID；mock 9999 三条回归覆盖三处。 |
| F4 | 已修复 | 报告生成前扫描所有登记池，共池包含两个 watched RWA 则抛 ConfigError，包括无成交池；普通多资产 watchlist 保持可用。 |
| F5 | 已修复 | 成交量榜要求 swapCount > 0；真实成交取整为 0 保留；量相同时按 txCount / poolId 排序。 |
| F6 | 已修复 | blockRangeActivity 增加 fromBlock / toBlock / coverageVerified:false。范围为保留 accepted 区间和仍保留的投影事件的包络，不保证区间连续；CLI / 持久化无损字符串均验证。 |
| F7 | 已修复 | CLI 排名行复用 baselineUnit；无完整分钟时单位为 null。序列化提取为 summarizeRankedPool 以直接检验该防御分支。 |
| S1 | 已修复 | 零 USDG 侧无法生成报价，零分子候选不会替换有效先前报价；无有效报价保持 null。 |
| S2 | 已修复 | 分钟、5m、未知时间块计数均按小写 tx hash 去重。 |
| S6 | 已修复 | 只读 schema 检查补齐 ingest_batches / fetch_shards / minute_boundaries / anchors 的读取列。 |
| S8 | 已修复 | plan 明确紧邻当前分钟的连续 5 个 closed 1m；多 RWA 共池限制也已写入。 |
| S9 | 已补测 | 离线 metrics / rank 成功路径、排名 tie-break、自然 5m 第五分钟 partial、多 scope warming、exactTimestampSec 越界。未扩展多 scope 状态语义。 |
| S3 / S4 / S5 / S7 | 后续事项 | 分别为回溯性能与时间策略、格式化 helper 接入、出生分钟单独展示、派生缓存读取门禁；本轮保持现有行为。 |

回归新增 24 条，原有 453 条未删除或 skip；现有断言保持不变，仅将旧 minimumBaselineSamples 调用迁移为 minimumOneMinuteSamples。窗口新增断言在原始实现上验证了 5 个预期失败，恢复修复后 19/19 通过。零报价、多 RWA 拒绝、区间标记、缺表、链标识、倍率单位均记录过旧实现的失败，再确认修复后通过。新增夹具最初因发现事件未落库、出生分钟 warming 失败，修正了夹具，未放宽生产约束。

完整验证命令及关键输出（原文节选，所有命令 exit 0）：

```text
pnpm lint
$ node scripts/check-scripts.mjs && prettier --check "src/**/*.ts" "tests/**/*.ts" "scripts/**/*.mjs"
Checking formatting...
All matched files use Prettier code style!

pnpm typecheck
$ tsc --noEmit && tsc -p tsconfig.scripts.json

pnpm test
$ vitest run
 Test Files  44 passed (44)
      Tests  477 passed (477)
   Start at  11:12:37
   Duration  9.13s (tests 58%, import 30%, transform 12%)

pnpm build
$ node scripts/clean-build.mjs && tsc -p tsconfig.build.json && node scripts/copy-build-assets.mjs
```

全量测试仍有既有 Uniswap SDK sourcemap 指向未打包源码的警告，未出现失败或跳过。

隔离验收实际入口：`node .superpowers/sdd/run-p3-review-acceptance.mjs`（exit 0）。该本地脚本先复制当前 src / dist / config 与原验收脚本，再将 P2 数据库通过 SQLite backup 复制至 `.superpowers/sdd/p3-review-acceptance/data/`；随后以 `.superpowers/sdd/p3-review-acceptance` 为 cwd 执行原命令 `node artifacts/p3/verify-acceptance.mjs`。不修改原验收脚本、历史输出、迁移或依赖。可复验方式是按相同目录结构建立隔离副本，再在副本根目录运行该原命令。派生输出保留在本地隔离目录，不替换已提交的 p3-v1 材料。

实际验收结果节选：

```json
{
  "version": "p3-v2",
  "sourceHash": "e5806b32b831b46affcc810bb18b4d2804619ba31054961015b8cb2d7068b768",
  "projectionSourceHash": "e0c4fcca4b4331e479ec7b8144b6f4bc2bdf4c7accd4bd7d8f850721398464d6",
  "eventsValued": 603,
  "unpriced": 34,
  "quotes": 219,
  "metricPools": 1827,
  "closedMinutes": 29,
  "nonClosedMinutes": 1,
  "baselineReadyPools": 0,
  "blockRangeActivity": { "swapCount": 603, "txCount": 313 },
  "rpcCalls": 0,
  "rankRows": 10,
  "historicalFilesVerified": 17,
  "historicalBytesUnchanged": true
}
```

metrics / rank CLI 均 exit 0、status observed。锚点仍为 block 57625255 / hash 0xc03ff86009711d4f95cd2dd255ef54e79dae617873a745221d1e7a70e390dfba。历史原榜 1824 行中的 1814 个零成交池被过滤，10 个有成交池保留；登记池 roster 仍为 1827。历史样本不足以形成倍率基线，倍率继续保持 null。

主工作区历史保护检查覆盖 `artifacts/p3/` 全部文件及 `data/` 中除 SQLite 临时共享内存 `-shm` 外的文件，共 17 个，前后 SHA256 均一致。
最终审查：集成修复审查与整体 source/test 审查均无 actionable findings；审查基线 f1f267c。修复保留在 fix/p3-review 工作区，未提交、未 push。
