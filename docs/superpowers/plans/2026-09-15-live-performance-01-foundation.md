# 01 基础测量与独立修正 Implementation Plan

> **For agentic workers:** 使用 `superpowers:executing-plans`；按A1→A4执行，每项先RED再GREEN。

**Goal:** 建立真实规模验证工具，修复限流恢复和空池窗口重复计算。
**Architecture:** 现有逻辑不重构；测试数据、计时和两个纯逻辑修正各自独立。
**Tech Stack:** Node 24、TypeScript、Vitest、SQLite。
**Spec:** `docs/superpowers/specs/2026-09-15-live-runtime-performance-design.md`。

## Global Constraints

继承Spec第4节；不读取.env、不运行真实RPC、不更改运行数据库。不要用mock替换待测核心函数；网络边界使用现有readerFixture/fake fetch。

## A1. 新增确定性规模夹具和计数器

**文件**：新增 `tests/helpers/live-scale-fixture.ts`、`tests/unit/live-scale-fixture.test.ts`、`scripts/benchmark-live-performance.mjs`。复用 `tests/helpers/alert-fixture.ts`、`tests/helpers/recorder-fixture.ts` 的合法ABI/LogRef生成方式，不改其旧默认值。

**接口**：

```ts
export type ScaleOptions = {
  poolCount: number; activePoolCount: number;
  assetCount: number; historyMinutes: number;
};
export function makeScaleData(options: ScaleOptions): {
  registrations: import('../../src/registry/pools.js').PoolRegistration[];
  events: import('../../src/metrics/windows.js').MetricEvent[];
  coverage: import('../../src/metrics/windows.js').MinuteCoverage[];
  watermark: import('../../src/domain/types.js').BlockAnchor;
};
export type WorkCounts = {
  registryRowsRead: number; registryRowsSerialized: number;
  rawBatchDecodes: number; valuationComputes: number;
  evaluatedPools: number; metadataCandidates: number;
};
```

- [ ] 创建夹具：poolId/地址/交易hash用整数转固定宽度hex；chainId固定4663。poolCount前activePoolCount个产生事件，其余只有注册。token按assetCount轮转，插入至少一个股票共池；watermark固定，所有随机性使用固定seed或不用随机。
- [ ] 使用不同但早于窗口的发现高度，不能让8万池全部共用出生高度；覆盖historyMinutes+1个分钟；旧池与出生分钟样本分开。
- [ ] 写并运行以下断言；初次应因夹具不存在失败，随后实现：

```ts
const d = makeScaleData({poolCount: 80000, activePoolCount: 400,
  assetCount: 194, historyMinutes: 180});
expect(d.registrations).toHaveLength(80000);
expect(new Set(d.registrations.map(poolRegistrationId)).size).toBe(80000);
expect(new Set(d.events.flatMap(x => x.event.pool ? [poolRegistrationId({pool:x.event.pool})] : [])).size).toBe(400);
expect(d.coverage).toHaveLength(181);
expect(makeScaleData({poolCount: 10, activePoolCount: 2,
  assetCount: 2, historyMinutes: 180})).toEqual(
  makeScaleData({poolCount: 10, activePoolCount: 2,
    assetCount: 2, historyMinutes: 180}));
```

- [ ] 新脚本仅使用离线夹具/临时库；支持 `--pools 80000 --active 400 --iterations 20 --out artifacts/performance/80k`；校验active<=pools、iterations>=1、输出目录不得已经存在。不要默认读取data/recorder.sqlite。
- [ ] 为生产入口增加可选计数回调时默认关闭；计数增量放在真实SQL读取/序列化/估值/评估发生处。不可在测试端手工写理想值。
- [ ] 脚本输出Node版本、平台、HEAD、参数、初始化时间、每轮样本、p50/p95、RSS、上述结构计数；此时允许基线失败，必须保留原结果。

运行：`pnpm exec vitest run tests/unit/live-scale-fixture.test.ts`。本任务只要求数据合法、可重复和计数真实，不要求旧实现性能达标。

## A2. 拆分每轮计时，避免重复相加

**文件**：新增 `src/ops/batch-timings.ts`、`tests/unit/batch-timings.test.ts`；修改 `src/ops/recorder.ts`、`src/ops/runtime-telemetry.ts`、`src/signals/project.ts`、`src/storage/metric-store.ts`。保留旧字段兼容。

**接口**：

```ts
export type BatchStage = 'rpcAcquisition' | 'rawPersist' | 'artifactPersist'
  | 'registry' | 'projection' | 'coverage' | 'valuation'
  | 'windows' | 'signals' | 'commitOther' | 'notify';
export class BatchTimings {
  constructor(now?: () => number);
  measure<T>(stage: BatchStage, work: () => T): T;
  measureAsync<T>(stage: BatchStage, work: () => Promise<T>): Promise<T>;
  snapshot(): Partial<Record<BatchStage, number>>;
}
```

- [ ] 写虚拟时钟测试：同步返回、异步返回、throw/reject均在finally累计；不同stage互不覆盖。
- [ ] 实现measure，以performance.now()为默认单调时钟；构造函数注入测试时钟。
- [ ] 将计时放在真实边界。嵌套函数不把子stage再记为独立总时间；新增localProcessingMs作为独立wall-clock总量，并注明它与stage breakdown的关系。
- [ ] writeLatencyMs保留旧口径，文档明确包含commit内CPU；不得与processingLatencyMs相加。
- [ ] 单批日志记录stageMs、计数、headObservedAgeMs、acceptedDataAgeMs；不输出RPC URL、凭据或8万池列表。

```ts
let now=0;
const t=new BatchTimings(()=>now);
expect(()=>t.measure('projection',()=>{now=7;throw Error('x')})).toThrow('x');
expect(t.snapshot().projection).toBe(7);
```

运行：`pnpm exec vitest run tests/unit/batch-timings.test.ts tests/integration/follow-runtime-summary.test.ts tests/integration/runtime-recorder.test.ts`。

## A3. 修复RateLimiter恢复曲线

**文件**：修改 `src/rpc/rate-limit.ts`、`tests/unit/rate-limit.test.ts`；补测 `tests/unit/client.test.ts`。不改configured RPS/maxConcurrent/maxRetries。

**接口**：现有constructor/acquire/enter/defer/penalize/succeed保留；增加只读state()返回 `{effectiveIntervalMs,cooldownUntilMs,consecutiveSuccesses}`。

**明确算法**：

```ts
baseIntervalMs = Math.ceil(1000 / perSecond);
// 初始 effectiveIntervalMs = baseIntervalMs, cooldownDelayMs = 0
// penalize:
cooldownDelayMs = Math.min(30000, Math.max(1000, cooldownDelayMs * 2));
cooldownUntilMs = Math.max(cooldownUntilMs, now + cooldownDelayMs);
effectiveIntervalMs = Math.max(baseIntervalMs,
  Math.min(2000, effectiveIntervalMs * 2));
consecutiveSuccesses = 0;
// 每3次成功:
effectiveIntervalMs = Math.max(baseIntervalMs, Math.floor(effectiveIntervalMs / 2));
cooldownDelayMs = Math.floor(cooldownDelayMs / 2);
```

- [ ] 用fake timers写失败测试：6次429后连续成功15次，总调度时间在5RPS配置下<=45秒，末尾interval为200ms；旧实现不满足。
- [ ] acquire等待max(nextMs,cooldownUntilMs,additional.nextMs,additional.cooldownUntilMs)；实际占位后nextMs只加effectiveIntervalMs，不能再加30秒cooldownDelay。
- [ ] 连续60秒无429时，在下一次acquire/penalize前归到base并清零旧cooldownDelay；不能清除尚未到期的显式defer，也不能回退nextMs。
- [ ] defer仍只推迟可请求时刻；client未知错误仅在真的有下一次retry时defer。429即使没retry也影响同provider后续调用。
- [ ] 保留additional backfill limiter，派发同时满足两个上限；queued/inflight和budget仍在真正调用前计数。
- [ ] 补测并发占位、释放两次无副作用、追加429重新降速、perSecond<0.5不会被2秒上限加速、长idle恢复、显式defer不会被succeed绕过。

```ts
vi.useFakeTimers(); vi.setSystemTime(0);
const limiter=new RateLimiter(5);
for(let i=0;i<6;i++) limiter.penalize();
const work=(async()=>{for(let i=0;i<15;i++){
  await limiter.acquire(); limiter.succeed();
}})();
await vi.runAllTimersAsync(); await work;
expect(Date.now()).toBeLessThanOrEqual(45000);
expect(limiter.state().effectiveIntervalMs).toBe(200);
vi.useRealTimers();
```

运行：`pnpm exec vitest run tests/unit/rate-limit.test.ts tests/unit/client.test.ts tests/unit/rpc-review.test.ts`。

## A4. 修复空池rolling缓存键并共享覆盖索引

**文件**：修改 `src/metrics/rolling.ts`、`tests/unit/rolling-windows.test.ts`；新增 `tests/unit/rolling-dormant-scale.test.ts`。保持buildRollingMetrics默认签名兼容。

- [ ] 写300空池、不同旧发现高度、同rawToken、181分钟覆盖的输出等价测试，使用A1夹具。
- [ ] 每次build内，为实际scope coverage集合建立一次按分钟索引；window查询复用它，不在每次rollingCoverage调用重新new Map。公开rollingCoverage仍兼容旧调用，内部可新增prepared helper。
- [ ] 所用coverage中非null fromBlock的最小值为earliest：只有birth<=earliest时把缓存键中的birth归一化为null；没有可验证边界时保持原birth。不要修改原registration。
- [ ] key区分rawToken、scope/coverage集合及有效birth；缓存仅在本次build共享，避免未实现失效就跨批复用。
- [ ] 精确出生分钟、不同token、不同scope、unknown-time事件、gap/partial、birth处于窗口内都不能错误共享。未知时间事件不能命中完全无事件的缓存。
- [ ] 用小型旧算法参考函数（tests/helpers中，不供生产调用）逐字段深度比较；不要让新函数调用自己做expected。

```ts
const starts=cs.flatMap(c=>c.fromBlock===null?[]:[c.fromBlock]);
const earliest=starts.reduce<bigint|null>((a,b)=>a===null||b<a?b:a,null);
const birth=registration?.discoveredAtBlock ?? null;
const birthKey=birth!==null && earliest!==null && birth<=earliest
  ? null : birth?.toString() ?? null;
```

运行：`pnpm exec vitest run tests/unit/rolling-windows.test.ts tests/unit/rolling-dormant-scale.test.ts tests/integration/rolling-replay.test.ts`。结构计数要求300旧空池共享覆盖处理，不要求CI跑绝对2.58ms。

## 本子计划完成门槛

- A1–A4全部通过；写明探针是合成样本；pnpm typecheck通过。
- 只stage本子计划文件，作本地提交：`fix: bound limiter recovery and reuse dormant rolling work`。
- 继续02，不合并main、不运行真实follow。
