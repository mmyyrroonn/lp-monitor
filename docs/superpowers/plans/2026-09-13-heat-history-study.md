# 有限历史补采与滚动热度研究 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用可恢复的独立历史作业构建可复核的数据集，打通原生导出与滚动窗口评估，输出候选热度标准而不改变实时规则。

**Architecture:** H1 目录提供池身份与覆盖，H2 提供紧凑存储和字节审计。H3 保存固定研究目标与缺口作业；H4 离线导出固定输入并按链时间或真实 observedAt 回放，时间拆分用于候选与验证隔离。

**Tech Stack:** 现有 TypeScript/SQLite/Vitest、replay/study/metrics/signals 模块；无新在线数据服务。

**Spec:** [设计](../specs/2026-09-13-stock-pool-heat-research-design.md)；[主计划](2026-09-13-stock-pool-heat-research.md)；前置为 [H1](2026-09-13-stock-pool-catalogue.md) 和 [H2](2026-09-13-heat-storage.md)。

## Global Constraints

- 作业目标固定，不随着 now/head 漂移；准备/状态/导出命令保持离线。
- history 作业使用独立数据库；旧 history 的“本地优先、只补缺口、源库不改”合同保留。
- 目录、操作、时间、报价、元数据覆盖分别报告；成功 HTTP 不等于完整数据。
- 预算共享且包含目录/重试/时间/元数据调用；本次耗尽可以显式续跑，累计消耗不能清零。
- 数据集纳入冷池、零活动池、期间新生及失活池；当前目录回看标 retrospective-cohort。
- 回放不连接 RPC、不发送真实通知；规则不自动写回 config/signals.initial.json。
- 1m/5m/15m/1h 是滚动 `(T-duration,T]`，缺少边界时间仍保留 unknown。

## Task H3.1：固定目标的持久历史作业

**Files:**

- Create: `src/ops/history-job.ts`、`src/ops/history-job-cli.ts`、`src/storage/history-jobs.ts`、下一个空闲编号的 `*-history-jobs.sql`
- Modify: `src/ops/history.ts`、`src/ops/history-cli.ts`、`src/cli.ts`、`src/storage/database.ts`、`src/ingest/time-index.ts`
- Test: `tests/unit/history-job-plan.test.ts`、`tests/integration/history-job.test.ts`、`tests/integration/history-job-recovery.test.ts`
- Docs: `docs/history-review.md`、`docs/runbook.md`

**Interfaces:**
Consumes: H1 CatalogueReport、H2 auditStorage、现有 missingIntervals/fetchRange/时间索引；区块在 JSON 中使用十进制字符串。
Produces: 下列 `HistoryJobSpec`/`HistoryJobState`，持久化于 study DB；H4 export 读取其冻结目标和覆盖。

```ts
export interface HistoryJobSpec {
  version: 1;
  chainId: 4663;
  assetVersion: string;
  protocolVersion: string;
  fromBlock: string;
  toBlock: string;
  targetHash: string;
  analysisStartSec: number;
  analysisEndSec: number;
  sourceDatabasePath: string;
  studyDatabasePath: string;
  watchlistPath: string;
  configPath: string;
  warmupMinutes: 180;
  outcomeMinutes: 180;
}
export interface HistoryJobState {
  id: string;
  specHash: string;
  status: 'prepared' | 'running' | 'waiting-retry' | 'paused' | 'complete' | 'failed';
  phase: 'catalogue' | 'operations' | 'time' | 'metadata' | 'finished';
  missing: Array<{ fromBlock: string; toBlock: string; reason: string }>;
  cumulativeRpcCalls: number;
  currentRunRpcCalls: number;
}
export function prepareHistoryJob(spec: HistoryJobSpec): Promise<HistoryJobState>;
export function readHistoryJob(studyDatabasePath: string, id: string): HistoryJobState;
```

fromBlock/toBlock 为含前后文的完整采集边界，targetHash 对应 toBlock；analysisStartSec/analysisEndSec 为实际研究区间。prepare 根据本地已有时间证据校验包含关系；缺证据时保留待验证状态，run 补充必要锚点后验证，不能把上下文不足标 analysisReady。所有文件输入在 prepare 时保存快照/hash，resume 检查变化而不是从今天的路径重新解释旧作业。source/study 同路径及 study 已被其他作业占用时拒绝。准备阶段不查询 RPC；targetHash 必须由已保存锚点或显式输入提供，不能在 prepare 内偷偷探测。

- [ ] **Step 1：先测试缺口计划与状态持久化。** 复用现有 missingIntervals；分别保存 registryMissing/operationMissing/timeUnknown/unpriced，不用单一列表替代各类证明。新 HistoryJobState.missing 为汇总视图，实际存储保留分类字段和来源。

```ts
import { expect, test } from 'vitest';
import { missingIntervals } from '../../src/ops/history.js';
test('resume schedules only uncovered inclusive block ranges', () => {
  expect(
    missingIntervals(100n, 399n, [
      [100n, 199n],
      [300n, 399n],
    ]),
  ).toEqual([[200n, 299n]]);
});
```

增加状态集成用例：prepare 后关闭重开 DB，specHash 与 missing 相同；修改 watchlist/config 内容后 resume 失败；冲突 job writer 拒绝。使用临时目录和 recorderFixture，不连接真实 RPC。

- [ ] **Step 2：实现命令与可恢复队列。** 从 reviewHistory 提取“在已存在的独立 study DB 上补缺口”的内部函数，避免每个 resume 再复制整库。首次 prepare 使用 SQLite 一致 backup；后续 resume 原 study DB。保留现有 history 命令行为。

```text
history-job prepare --spec PATH                 # offline, creates study DB once
history-job status --db STUDY --job ID           # readonly, no RPC
history-job run --db STUDY --job ID --duration 10m --max-rpc-calls 1000
history-job resume --db STUDY --job ID --duration 10m --max-rpc-calls 1000
```

run/resume 的数值是接口示例，不在实施时自动运行。实际作业固定目标；每次执行结束写本次与累计预算、原始新增事件、字节增量和 completed coverage。

- [ ] **Step 3：接入 H1 恢复与共享预算。** 一个 job run 使用一套 RequestMeter/限速器，目录、操作与时间阶段不得分别重置预算。checkpoint 在证据持久化且 accept 成功后提交；临时失败进入 waiting-retry。budget/duration/停止为 paused，fatal 保留失败原因，状态查询不触网。重复分片不重复事件。

```text
prepared/paused → running → waiting-retry → running
running → complete       only if range + registry + required time context proven
running → paused         budget / duration / user stop
running → failed         identity / corruption / local durable write failure
```

报价/精度可缺失且原始采集完整：报告 rawComplete 与 analysisReady 分开，不能因少量 unpriced 无限重抓所有日志。

- [ ] **Step 4：降低历史查询开销但维持限速。** 历史范围从现有 1000 块上限起步，在专用 job 中允许自适应扩大到 100000 块；成功且响应 < guard/4 连续 3 次后翻倍，range/filter-limit 拆分，超时持续时先按 H1 恢复后才缩小区间。每次决策有下界 1 块、上界、原因和实际吞吐记录；不修改实时 maxRangeBlocks。时间索引查询缓存按有效锚点复用，只补必要分钟与事件块时间，不每块请求 header。

```powershell
pnpm exec vitest run tests/unit/history-job-plan.test.ts tests/integration/history-job.test.ts tests/integration/history-job-recovery.test.ts tests/integration/history-review.test.ts tests/integration/catalogue-recovery.test.ts
pnpm typecheck
```

**H3 完成：** mock 网络下在预算/退出/重组后按正确缺口续跑，源实时库及 outbox 不变。一天级资源估算在 H5 才执行。

## Task H4.1：原生数据集导出与来源分级

**Files:**

- Create: `src/replay/export.ts`、`src/replay/export-cli.ts`
- Modify: `src/replay/reader.ts`、`src/replay/integrity.ts`、`src/ops/recorder.ts`、`src/cli.ts`
- Test: `tests/integration/replay-export.test.ts`、`tests/integration/replay-export-integrity.test.ts`
- Docs: `docs/history-review.md`、`README.md`

**Interfaces:**
Consumes: H2 readBatch、现有 ReplayInputSnapshot/ReplayManifest、H3 冻结作业与原生录制顺序。
Produces: `exportReplayDataset(options: ExportReplayOptions): Promise<{manifestPath:string;complete:boolean;issues:string[]}>`。字段定义如下；不足时输出 issue，不制造历史事实。

```ts
export interface ExportReplayOptions {
  databasePath: string;
  outputDirectory: string;
  scopeId: string;
  fromBlock: bigint;
  toBlock: bigint;
  mode: 'chain-time' | 'recorded-observed';
  cohortMode: 'as-of' | 'retrospective-cohort';
}
```

- [ ] **Step 1：建立导出可独立离线读取测试。** fixture 原生数据库 → 新导出目录 → 关闭/移走临时源库 → replay reader 仅凭目录读入。断言事件/覆盖/名单版本、顺序和 hash 一致；未计价/时间未知保持原值。旧源无快照时返回 input-snapshot-missing，不能加载当前 config 充当历史输入。

```text
case A: saved input snapshot + accepted batches + observedAt order → recorded-observed eligible
case B: historical logs + current reconstructed directory → chain-time / retrospective only
case C: missing manifest shard / hash corruption / missing object → incomplete or failure
case D: missing historical decimals or quote → raw retained, valuation remains null
```

- [ ] **Step 2：使新 recorder/job 从现在起保存所需输入。** 保存实际使用的资产/配置/metadata 的 hash、observedAt/availableAt、代码/ABI/规则版本、接受/修订顺序。补采发生于今天的 raw 不能把 availableAt 写成历史交易时间；研究 chain-time 可使用历史事件发生顺序，但必须标 simulated-acquisition，不声称真实到达延迟。

```powershell
pnpm exec vitest run tests/integration/replay-export.test.ts tests/integration/replay-export-integrity.test.ts tests/integration/replay-independent-review.test.ts
```

- [ ] **Step 3：实现流式导出。** `replay-export --db PATH --scope ID --from-block N --to-block M --out DIR --mode chain-time|recorded-observed --cohort-mode as-of|retrospective-cohort`；输入全部本地，不读 .env/RPC。按范围分页读取和有界 gzip segment 写出，不将多日原始事件一次放入数组。外部对象 hash 用未压缩规范内容，文件另有压缩字节 SHA256；reader 验证两者。

```text
dataset manifest v2:
  input snapshots + availability + mode + fixed range
  ordered segments: path / compressed sha256 / logical content hash
  accepted coverage / revisions / time quality / missing / excluded
  source provenance; no absolute dependency on original DB
```

在 `src/replay/reader.ts` 定义 v1/v2 判别联合，保留 v1 reader；无法满足新模式要求的旧数据只能使用较弱模式。输出目录路径逃逸、覆盖和损坏均拒绝。

- [ ] **Step 4：证明源库未改与内存有界。** 只读源库、记录源逻辑 hash；用于测试的 SQLite backup 包含 WAL，不能仅复制主文件。合成多 segment 测试断言 reader/exporter 的页缓冲不随历史总事件数线性累积。

```powershell
pnpm exec vitest run tests/integration/replay-export.test.ts tests/integration/replay-export-integrity.test.ts tests/integration/replay-equivalence.test.ts tests/integration/replay-quality.test.ts tests/integration/storage-equivalence.test.ts
```

**交付门槛：** 导出可迁移、可校验、来源等级真实；旧数据不被“补齐快照”伪装成当时实录。

## Task H4.2：当前滚动规则、时间拆分和候选报告

**Files:**

- Create: `src/replay/study-config.ts`、`src/replay/rolling-replay.ts`、`config/study.template.json`
- Modify: `src/replay/experiments.ts`、`src/replay/study.ts`、`src/replay/study-cli.ts`、`src/replay/runner.ts`、`src/replay/outcomes.ts`、`src/replay/report.ts`、`src/replay/cohort.ts`
- Test: `tests/unit/study-config.test.ts`、`tests/integration/rolling-replay.test.ts`、`tests/integration/study-time-split.test.ts`
- Reuse: `src/metrics/rolling.ts`、`src/signals/engine.ts`、`src/signals/config.ts`

**Interfaces:**
Consumes: H4.1 v2 数据集、MetricEvent/coverage、现有 evaluateSignal。
Produces: `StudyPeriods` 与纯 `studySplitAt`；新 rolling replay 将同一事件前缀交给当前指标/规则，不复制第二套热度实现。

```ts
export interface StudyPeriods {
  train: { startSec: number; endSec: number };
  validation: { startSec: number; endSec: number };
  test: { startSec: number; endSec: number };
}
export function studySplitAt(
  sec: number,
  periods: StudyPeriods,
): 'train' | 'validation' | 'test' | 'outside';
export function validateStudyPeriods(periods: StudyPeriods): void;
```

- [ ] **Step 1：先测试日期参数与滚动边界。** 日期必须 UTC 可解析、安全整数且 start < end；三个时间段有序不重叠。下例纯函数可直接实现，不依赖数据库。再用滚动窗口夹具验证 `(T-300,T]` 左开右闭、unknown 边界不能补零。

```ts
import { expect, test } from 'vitest';
import { studySplitAt, validateStudyPeriods } from '../../src/replay/study-config.js';
test('split boundaries are explicit and half-open', () => {
  const periods = {
    train: { startSec: 100, endSec: 200 },
    validation: { startSec: 200, endSec: 300 },
    test: { startSec: 300, endSec: 400 },
  };
  validateStudyPeriods(periods);
  expect([99, 100, 199, 200, 300, 400].map((t) => studySplitAt(t, periods))).toEqual([
    'outside',
    'train',
    'train',
    'validation',
    'test',
    'outside',
  ]);
});
```

- [ ] **Step 2：替换新研究入口的硬编码日期。** 保留旧固定案例为显式 legacy 对照，新 `study --study-config PATH` 必须配置 periods、dataset manifest 路径、cohortMode、ruleVersion、grid、warmup/outcome 时长、evaluation cadence。`config/study.template.json` 使用固定示例日期并标 example，不自动解析最近 now 或运行采集。训练结局裁剪于 train.end，验证/测试同理；预热只读取此前历史，不允许未来报价参与。

```powershell
pnpm exec vitest run tests/unit/study-config.test.ts tests/integration/study-time-split.test.ts tests/integration/study.test.ts
```

- [ ] **Step 3：实现滚动回放并明确观察模式。** chain-time 默认每 10 链上秒评估一次，使用已接受/已证明的事件前缀与滚动窗口；cadence 写入报告，不能当实时测得延迟。recorded-observed 使用保存批次与 observedAt/修订序列，数据不具备就拒绝此模式。保留旧 minute-close 模式并明确 legacyWindows；新增模式禁止意外走 legacy 分支。回放内核有界滚动缓存，历史数据分页读取。

```text
for each ordered chain-time or observed-at evaluation point:
  ingest only events/metadata available to this mode at that point
  apply reorg/retime/registry revisions supported by source
  build current rolling metrics → existing evaluateSignal → record candidate
  expire bounded contributions; keep only result aggregates outside horizon
```

结果窗口使用触发之后的 15/60/180 分钟；精确触发时间未知时沿用保守分钟排除并标精度，不能把触发前成交算作发现后的持续热度。冷池入组依靠完整覆盖，缺数据不能当冷池。行情归一化只用当时可用报价与单位。

- [ ] **Step 4：实现候选比较与验证报告。** 初始网格最多 64 组，比较绝对量、相对倍数和持续性；约束来自研究配置，不改线上文件。按训练选少量候选并保存 hash，再在验证/测试区输出全部候选结果。覆盖不足、未计价、右截尾分开计数。指标至少含提醒/日、独立 episode、重复率、后续成交分布、活跃持续/衰减及日期/股票分层；不计算未经交易执行模型验证的收益。

```text
study output:
  frozen-inputs.json + candidates.json + coverage.json
  train.json + validation.json + test.json + report.md
  conclusion: candidate-supported | insufficient-evidence | insufficient-data
  onlineRuleChanged: false
```

- [ ] **Step 5：端到端等价与隔离回归。** 同一份带精确时间事件，在固定链上评价点比较 live rolling 与 replay 的值/信号；覆盖共池去重、零基线、新池出生、报价过期、边界未知、重组撤回和样本尾部裁剪。断言回放期间 fetch 被禁止、源 DB/hash 与 signal 配置不变、无实时 outbox 写入。

```powershell
pnpm exec vitest run tests/unit/study-config.test.ts tests/unit/rolling-windows.test.ts tests/integration/rolling-replay.test.ts tests/integration/study-time-split.test.ts tests/integration/study.test.ts tests/integration/replay-quality.test.ts
pnpm typecheck
pnpm test
pnpm lint
pnpm build
git diff --check
```

**H4 完成：** 能用真实来源分级的数据集运行当前滚动规则，并按配置日期输出隔离研究报告；没有足够真实样本时结论保持 insufficient-data。转到主计划 H5 准备具体范围与预算，等待用户安排运行。
