# P2 协议解码与最近观测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将V3/V4 logs转为可统计事件，保存最近Swap观测。

**Architecture:** 独立协议decoder，共用纯函数；无需历史slot0、StateView或完整流动性状态初始化。

**Tech Stack:** Node.js 24、TypeScript strict ESM、pnpm、viem、SQLite；协议格式优先官方 ABI/SDK。

## Global Constraints

- 只读链数据；生产热路径不依赖 Uni API、Subgraph 服务或 GMGN。
- Node.js 24、TypeScript strict ESM、pnpm；精确版本与 lockfile 由 P0 固化。
- 原始金额 bigint；持久化用无损字符串；业务结果绑定 chainId、blockHash 与版本。
- 实时与历史共用业务核心；缺口不补零，未知估值/费用不写零。
- 同块动态发现、断点恢复、重组与告警撤回必须有测试。
- 秘钥仅从本机环境读取；日志保存 provider alias，不保存带凭据 URL。
- 现有 research/、tooling/、.agents/、.pnpm-store/ 保留，不纳入应用依赖重构。
- 每窗口只实现指定阶段；更新状态和证据，未验收不得勾成完成。
- 默认只提供 RPC、本机增量同步；无付费索引后台依赖，记录调用用量与预算。

所有相对代码路径以 E:/lp-monitor 为根。架构依据：[设计](../specs/2026-09-08-robinhood-rwa-monitor-design.md)。下列代码块定义接口、关键算法和测试输入；实际实现需围绕这些合同补齐本阶段列出的行为，不是把文档片段原样拼成生产程序。命令均为未来阶段实现后的验收入口，本次写计划没有运行它们。

## Task 2.1：官方ABI解码

**Files:** 创建 src/protocols/uniswap-v3/decode.ts、src/protocols/uniswap-v4/decode.ts、src/domain/events.ts、tests/unit/swap-direction.test.ts、tests/integration/decode-real.test.ts。

**Interfaces:** decodeV3(log: RawLog,time: LogTime,registration: PoolRegistration): PoolEvent；decodeV4同签名；normalizeCoreDeltas(version,a,b)返回inputIndex/amountIn/outputIndex/amountOut。

- [ ] 使用P0固定ABI，以下测试必须保留原始符号并正确归一化。

~~~ts
import { expect, test } from 'vitest';
import { normalizeCoreDeltas } from '../../src/domain/events.js';
test.each([
  ['v3', 100n, -90n, 0, 100n, 1, 90n],
  ['v4', -100n, 90n, 0, 100n, 1, 90n],
  ['v3', -90n, 100n, 1, 100n, 0, 90n],
  ['v4', 90n, -100n, 1, 100n, 0, 90n],
] as const)('方向 %s', (v,a,b,i,iv,o,ov) => {
  expect(normalizeCoreDeltas(v,a,b)).toEqual({
    inputIndex:i, amountIn:iv, outputIndex:o, amountOut:ov,
  });
});
~~~

- [ ] v3以raw正值侧为输入，v4先反号再统一。零/两侧同号不强造普通成交；超大int、未知topic、非法data保留错误和原文。
- [ ] V3 Mint正delta、Burn负delta；V4 ModifyLiquidity用事件有符号L变化；delta0不计新增/撤出；Collect/Donate单列。amount本金与L不混同。
- [ ] V3记录登记fee，V4记录Swap实际fee；Initialize动态flag不作费率。sender/actor不当用户人数。
- [ ] ethers作为dev-only独立fixture解码对照。运行 pnpm exec vitest run tests/unit/swap-direction.test.ts tests/integration/decode-real.test.ts。

## Task 2.2：最近Swap观测

**Files:** 创建 src/state/observations.ts、tests/unit/pool-observations.test.ts。

**Interfaces:** observePool(previous: PoolObservation,event: PoolEvent): PoolObservation。

- [ ] Swap替换lastSwap，流动性事件只替换lastLiquidityAction。保留price/tick/L及事件位置，不运行tick bitmap或修改位置本金。
- [ ] fixture：Swap报告L1000，之后Burn delta100，结果lastSwap.L仍1000但标为Burn之前观测；下次Swap报告L700后才更新为700。不能把未知当前L补成900。
- [ ] 老池没有历史state，首次Swap即可记录；只收到Burn则lastSwap=null。观测L比较仅同池，下降可能是tick跨越。
- [ ] 运行 pnpm exec vitest run tests/unit/pool-observations.test.ts。

## Task 2.3：范围投影与重建

**Files:** 创建 src/storage/migrations/002-projections.sql、src/storage/projection-store.ts、src/state/project-range.ts、tests/integration/projection-repair.test.ts；修改src/cli.ts。

**Interfaces:** projectRange(batch,activeLogs,logTimes,registry): ProjectionResult；结果含events、observations、qualityErrors，与范围处理cursor同事务提交。

- [ ] 仅active_logs进入统计。重扫移除旧Swap后，lastSwap和事件投影重新从有效日志得到；时间修正使旧桶失效。
- [ ] 实现 pnpm lp project --db data/monitor.sqlite --rebuild 与 pnpm lp inspect-pool --config config/robinhood.json --pool amc-usdg-v3，显示最后观测时间及分钟精度。
- [ ] P2测试、typecheck/build通过后保存解码对照与样本输出，更新状态，停止。

## 验收

协议方向/类型正确，真实fixture可独立解码；近期观测不会冒充完整当前池状态；重扫修正可重建。archive state、仓位feeGrowth、模拟器不作为门槛。下窗口P3。
