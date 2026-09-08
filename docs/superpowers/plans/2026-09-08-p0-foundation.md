# P0 工程、RPC 能力与真实样本 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 得到可运行的只读 CLI，证实本机 RPC 能做什么，并保存有出处的最小链上样本。

**Architecture:** 根目录独立应用包，公共 RPC 适配器与协议 ABI 分开。默认使用用户 RPC + 本机存储，不安装 Envio 后台。

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

## Task 0.1：工程与无损基础类型

**Files:** 创建 package.json、pnpm-lock.yaml、tsconfig.json、vitest.config.ts、.gitignore、.env.example、src/cli.ts、src/config/env.ts、src/domain/types.ts、src/domain/json.ts；测试 tests/unit/config.test.ts、tests/unit/json.test.ts。

**Interfaces:** src/domain/types.ts 使用设计第 5 节合同。新增 loadEnv(env: NodeJS.ProcessEnv): RuntimeEnv；RuntimeEnv 含 httpRpcUrl、可选 wsRpcUrl、providerAlias、dataDir。仅 transport 能拿到 URL，报告使用 alias。

- [x] 先检查本窗口工作区与已有文件；保留并发修改。记录 node/pnpm 版本。不因缺 Git 就删除重建目录。
- [x] 创建最小 package 与 TS/Vitest 设置；生产依赖只加入 viem、better-sqlite3、zod，开发依赖 typescript、tsx、vitest、@types/node、@types/better-sqlite3。依赖用 pnpm add --save-exact 固定实际可用版本，提交 lockfile 作为版本事实；本机 native SQLite 导入失败需诊断，不换库掩盖。
- [x] scripts 定义 lp=tsx src/cli.ts、typecheck=tsc --noEmit、test=vitest run、build=tsc。所有 CLI 支持 --help；配置错误退出 2、必需 RPC 能力失败退出 3、数据不完整退出 4、内部错误退出 1、成功退出 0。
- [x] 写下面的无损整数与配置测试并先运行，确认失败点是功能尚未实现，再实现必要序列化/校验。

~~~ts
import { expect, test } from 'vitest';
import { encodeJson } from '../../src/domain/json.js';
import { loadEnv } from '../../src/config/env.js';

test('uint256 不经过 number', () => {
  const value = (1n << 256n) - 1n;
  expect(JSON.parse(encodeJson({ value })).value).toBe(value.toString());
});
test('缺 RPC 不能被默认主网替代', () => {
  expect(() => loadEnv({})).toThrow(/RH_RPC_HTTP/);
});
~~~

- [x] encodeJson 用 bigint → decimal string 的 JSON replacer；恢复由类型 schema 显式转换，不能把所有数字字符串自动变 bigint。金额不得使用 Number；tick、txIndex 等必须范围检查。
- [x] .env.example 仅列 RH_RPC_HTTP、RH_RPC_WS、RH_PROVIDER_ALIAS、LP_DATA_DIR，不放真实值。.gitignore 排除 .env、data、node_modules、大型 artifacts 和工具缓存；不改变既有 research 内容。
- [x] 执行 pnpm typecheck 与 pnpm exec vitest run tests/unit/config.test.ts tests/unit/json.test.ts；确认通过后记录版本和测试结果。

## Task 0.2：ABI 来源与链身份

优先阅读[lp-terminal模块评估](../../research/2026-09-08-lp-terminal-review.md)，将固定commit、MIT notice及StateView候选纳入依赖证据；不安装其React/钱包前端。

**Files:** 创建 src/protocols/uniswap-v3/abi.ts、src/protocols/uniswap-v4/abi.ts、src/protocols/uniswap-v4/pool-key.ts、src/rpc/client.ts、config/robinhood.json、config/watchlist.amc.json、tests/unit/abi.test.ts、artifacts/p0/dependency-evidence.json。

**Interfaces:** createChainReader(env: RuntimeEnv): ChainReader；computeV4PoolId(key: PoolKey): Hex。PoolKey 五字段与设计完全一致；ABI导出名 v3FactoryAbi、v3PoolAbi、v4ManagerAbi。

- [x] 从 GitHub 复用调查所列官方 package/artifact 固化 ABI，记录 source URL、commit/version、SPDX/notice 与 hash。使用已锁定的官方 SDK pure helper 交叉验证 PoolId；不 clone 完整交易前端。
- [x] 用 viem 的 decodeEventLog 严格模式生成 typed args；签名与官方 ABI 比较。未知 topic 返回明确错误/分类，不静默丢弃相关日志。
- [x] client 使用 createPublicClient/http；增加公共请求记录外壳，拦截并记录无密钥的方法/参数/响应。禁止创建 WalletClient 或发送交易方法。
- [x] 配置设计第 12 节的身份种子，逐一查询 chainId、getCode、token decimals、V3 factory/token0/token1/fee/getPool；V4 用 Initialize 校验 PoolKey hash。不用 SDK 的默认 mainnet 地址推算本链池。
- [x] 将实际部署起点、code hash、decimals 与验证块写入 artifacts/p0/identity-evidence.json。外部示例的 start_block=9070 仅是候选，必须核验。
- [x] 运行 pnpm exec vitest run tests/unit/abi.test.ts；输出真实身份核验报告，失败身份留为 unverified，不进入可交易机会分类。

## Task 0.3：RPC 能力、用量与真实 fixture

**Files:** 创建 src/rpc/capabilities.ts、src/rpc/rate-limit.ts、src/rpc/resolve-time.ts、src/ops/request-meter.ts、src/ops/fixture-capture.ts、tests/unit/capabilities.test.ts、tests/integration/p0-fixtures.test.ts；修改 src/cli.ts。

**Interfaces:** probeCapabilities(reader, options): Promise<CapabilityReport>；resolveBlockAtOrAfter(timestampSec): Promise<BlockAnchor>；captureFixture(range, filters): Promise<FixtureManifest>。报告每项含 supported/unsupported/unknown、时间、证据文件；不支持不同于一次超时。

- [x] 写能力响应为“成功、method not found、429、超时、旧状态缺失”的表驱动测试；只有必需方法失败导致阶段外部能力未通过，可选 WS/trace 失败不阻塞只读 HTTP 工作。
- [x] 探测范围getLogs、少量getAnchor、身份/decimals当前call及历史logs/稀疏anchor。历史state、WS、trace均非首版门槛，不为可选能力扫描大范围。单项10s超时和最多2次退避重试，probe上限150个方法调用；日志+端点+分钟边界合计检验5 RPC/s软预算。
- [x] 参考[日志优先方案](../../research/2026-09-08-logs-first-heat.md)核对blockTimestamp值和单位：公共端点55条真实样本均为0x0，不能只检查字段存在。支持分为valid/missing/zero/mismatch，抽样与anchor核对且检查SDK是否保留。不可用时启用分钟边界索引，不逐块补Header。
- [x] 最小 read-only probe 支持命令：pnpm lp probe --config config/robinhood.json --out artifacts/p0/capabilities.json。
- [x] capture支持--last-blocks 300与显式区间，保存原始logs、topics/data、tx索引及实际查询的少量端点/分钟时间anchors；无需每块headers或receipt。探测10/20/100块范围和响应大小，超限缩小，费用预算耗尽返回incomplete。
- [x] 每份 fixture 保存 chainId=4663、captureMode=live/backfill、过滤条件、block/hash 范围、完整性、SHA256 与 source alias。合成样本必须标 synthetic，不能填写虚构真实 tx。
- [x] 至少真实捕获 V3/V4 Swap、V4 Initialize 和一类 liquidity 事件；相关类别缺失时做有界历史查找，仍未获得就报告缺项，不用随机生成值替代。
- [x] 统计 method 调用数、响应字节、重试与数据量；供后续预算估算。不打印 provider 完整 URL 或 headers。
- [x] 能力报告保存maxLogsPerResponse:number|null；未知不得填成无限或自定5000。5000仅是本地logResponseGuard初值；在总probe预算内比较一个范围和两子范围日志并集，明显不等则记录截断/一致性问题。
- [x] 执行 pnpm typecheck、pnpm test、pnpm build；再执行上述 probe 与 pnpm lp capture --config config/robinhood.json --last-blocks 300 --out artifacts/p0/raw。
- [x] 更新 docs/implementation-status.md，分别标“代码测试”和“外部能力/真实样本”结果；本窗口完成 P0 后停止。

## 验收与移交

工程离线测试通过；chain 4663 与目标合约身份有真证据；必需 RPC 能力已验证；真实 fixture 与生成样本明确区分；无密钥泄漏；无付费后台依赖。

历史state/WS/trace可不探测或unsupported；近期logs和稀疏anchor可用即可继续。时间字段无效时走P1分钟边界，不把0当1970年成交；历史logs或稀疏历史anchor缺失时P5覆盖仍未具备。下窗口P1。

## 执行说明（2026-09-08）

本窗口 P0 已通过，证据见 ../../implementation-status.md 与 artifacts/p0/acceptance.json。勾选表示相应实现/验证步骤已执行；历史部署起点仍为 unverified/null，9070 不是已确认部署块。历史 state/WS/trace 按本计划可选门槛单独保留未知。目录无 Git，lockfile 已保存在本机，未创建提交。P1 未开始。
