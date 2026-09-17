# 股票池目录与 RPC 恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 独立、可恢复地构建已声明 V3/V4 范围内的完整股票池目录，使临时 RPC 失败不再直接结束历史目录初始化。

**Architecture:** 先规范化不可变股票名单，再抽取 recorder 中的 bootstrap 为共享目录服务。保持既有 raw/accepted 双层存储、scope 和检查点；目录固定一个目标块，成功后供 follow 与历史任务复用。

**Tech Stack:** TypeScript、zod、viem、SQLite、Vitest；复用 RequestMeter 与 ShutdownController。

**Spec:** [设计](../specs/2026-09-13-stock-pool-heat-research-design.md)；[主计划](2026-09-13-stock-pool-heat-research.md)。

## Global Constraints

- H1 的交付是代码与离线验证，不执行全历史目录扫描。
- 目录 complete 限定 chainId、assetVersion、protocolVersion 与固定 targetAnchor；保留 providerCompletenessAssumption 和 excluded。
- 不完整范围不推进 accepted cursor；现有 default follow 的 latest 模式不改变。
- 名单与合约地址是身份依据；未知精度/缺报价不阻塞 raw 保存。
- 默认 RPC 上限继续为总 5 RPS、并发 2、历史 1 RPS；底层 maxRetries=2 不改成无限重试。

## Task H1.1：不可变股票快照与可审计差异

**Files:**

- Create: `src/registry/stock-snapshot.ts`、`src/ops/stocks-cli.ts`
- Modify: `src/registry/assets.ts`、`src/cli.ts`
- Test: `tests/unit/stock-snapshot.test.ts`、`tests/integration/stocks-cli.test.ts`
- Docs: `docs/runbook.md`

**Interfaces:**
Consumes: 官方 `/rhj/assets` 原始 JSON；现有 `AssetRegistration`（`src/registry/assets.ts`）。
Produces: 下列新接口；H1.3 与 H3 使用 snapshot 的固定版本和全部状态记录。

```ts
import type { AssetRegistration } from '../registry/assets.js';
export interface StockSnapshot {
  version: string;
  chainId: 4663;
  fetchedAtSec: number;
  sourceUrl: 'https://api.robinhood.com/rhj/assets';
  sourceHash: string;
  rwa: AssetRegistration[];
  records: Array<{
    symbol: string;
    address: string;
    status: 'active' | 'inactive';
  }>;
}
export function buildStockSnapshot(raw: string, fetchedAtSec: number): StockSnapshot;
export function diffStockSnapshots(
  before: StockSnapshot,
  after: StockSnapshot,
): {
  added: string[];
  removed: string[];
  statusChanged: string[];
};
```

- [ ] **Step 1：写规范化与保留历史状态的测试。** 包含非 4663 部署、同名不同地址、相同地址矛盾状态、无效地址/响应、inactive、空 active 集。矛盾数据失败，不能以最后一条覆盖；允许原始响应包含未知附加字段。

```ts
import { expect, test } from 'vitest';
import { buildStockSnapshot } from '../../src/registry/stock-snapshot.js';
test('only active chain-4663 deployments enter the current watchlist', () => {
  const address = `0x${'12'.repeat(20)}`;
  const raw = {
    assets: [
      {
        tokenSymbol: 'AAA',
        status: 'ASSET_STATUS_ACTIVE',
        deployments: [{ chainId: 4663, contractAddress: address }],
      },
      {
        tokenSymbol: 'BBB',
        status: 'ASSET_STATUS_INACTIVE',
        deployments: [{ chainId: 4663, contractAddress: `0x${'34'.repeat(20)}` }],
      },
      {
        tokenSymbol: 'CCC',
        status: 'ASSET_STATUS_ACTIVE',
        deployments: [{ chainId: 1, contractAddress: `0x${'56'.repeat(20)}` }],
      },
    ],
  };
  const snapshot = buildStockSnapshot(JSON.stringify(raw), 1789257600);
  expect(snapshot.rwa.map((x) => x.address)).toEqual([address]);
  expect(snapshot.records).toHaveLength(2);
});
```

- [ ] **Step 2：运行新测试确认失败，再实现纯转换与 sourceHash。** 输入保留 response.text() 的原始字节串，内部解析并用项目无损 JSON/hash 工具规范化；sourceHash 对实际保存的原始字符串 UTF-8 字节计算，语义版本绑定规范化名单，另保存实际 fetchedAtSec。URL 不含凭据。

```powershell
pnpm exec vitest run tests/unit/stock-snapshot.test.ts
```

预期首次因接口未实现或断言失败；实现后通过。版本/hash 的含义写进模块注释：原始响应 hash 与规范化名单 version 不能混为同一字段。

- [ ] **Step 3：增加显式刷新命令。** `stocks refresh --out DIR` 写入唯一目录中的 `source.json`、`watchlist.json`、`diff.json`；离线输入 `--input PATH` 用于测试/重建。输出存在时拒绝覆盖。默认不改 `config/watchlist.stocks.json`，follow 启动也不自动访问资产 API；调用方显式传新 watchlist。输出打印新名单路径和覆盖需要重核的地址。

```text
stocks refresh --input saved-assets.json --out artifacts/stocks/snapshot-A
result: source.json + watchlist.json + diff.json
follow --watchlist artifacts/stocks/snapshot-A/watchlist.json
```

- [ ] **Step 4：集成测试和文档。** mock fetch，验证失败不留下可用的半份名单、旧名单 hash 不变、输出路径安全、CLI 参数错误退出 2；离线输入不得访问网络。

```powershell
pnpm exec vitest run tests/unit/stock-snapshot.test.ts tests/integration/stocks-cli.test.ts tests/unit/config.test.ts
```

**交付门槛：** 固定输入生成稳定身份/版本；inactive 保留但不冒充当前 active；名单更新后的覆盖未被自动标 complete。

## Task H1.2：批次失败分类与可中断恢复

**Files:**

- Create: `src/ingest/discovery-recovery.ts`
- Modify: `src/ingest/record-range.ts`、`src/ingest/fetch-range.ts`、`src/ops/recorder.ts`
- Test: `tests/unit/discovery-recovery.test.ts`、`tests/integration/catalogue-recovery.test.ts`
- Reuse: `src/rpc/errors.ts`、`src/ops/shutdown.ts`、`tests/helpers/recorder-fixture.ts`

**Interfaces:**
Consumes: `RangeRecordingBatch.recordingErrors`、分片失败与 `RpcFailure`。保留结构化失败类别；不从完整凭据/原始错误字符串匹配。
Produces: `classifyDiscoveryFailures(kinds: readonly string[]): 'retry' | 'stop' | 'fatal'` 与 `discoveryRetryDelayMs(consecutiveFailures: number): number`。零/非整数次数为参数错误。

- [ ] **Step 1：先写临时/永久/停止错误测试及真实失败序列回归。** 允许 retry 的明确类别是 timeout-or-network、rate-limit、http-transient、anchor-changed、anchor-conflict；budget/deadline/用户停止为 stop；未知或混合 fatal 类别优先 fatal。anchor 变化重试前必须走既有检查点重核，不能对旧锚点盲目重取。

```ts
import { expect, test } from 'vitest';
import {
  classifyDiscoveryFailures,
  discoveryRetryDelayMs,
} from '../../src/ingest/discovery-recovery.js';
test('only classified transient failures retry', () => {
  expect(classifyDiscoveryFailures(['timeout-or-network', 'rate-limit'])).toBe('retry');
  expect(classifyDiscoveryFailures(['timeout-or-network', 'conflicting-log-identity'])).toBe(
    'fatal',
  );
  expect(classifyDiscoveryFailures(['deadline'])).toBe('stop');
  expect([1, 2, 3, 4, 5, 6].map(discoveryRetryDelayMs)).toEqual([
    2000, 4000, 8000, 16000, 30000, 30000,
  ]);
});
```

- [ ] **Step 2：确认测试失败后实现决策函数，并确保 fetchRange 不丢失可恢复性。** 不只保留最后一个笼统 `incomplete` 字符串。证据失败/DB 失败优先级继承当前实现，不能变成网络重试。不要更改方法预算计数或 viem 内部 retryCount=0。

```ts
// discoveryRetryDelayMs 内的确定性退避；测试使用虚拟时钟。
return Math.min(30_000, 2_000 * 2 ** Math.min(consecutiveFailures - 1, 4));
```

```powershell
pnpm exec vitest run tests/unit/discovery-recovery.test.ts tests/unit/client.test.ts tests/unit/rpc-review.test.ts
```

- [ ] **Step 3：把临时失败接回目录循环。** 保存不完整 raw 后等待，再从最后 accepted checkpoint 继续同一失败区间；成功一段才清零 consecutiveFailures。检查请求预算/截止/用户停止后才能等待和再派发。用 `shutdown.wait()`，不写无法中断的 sleep。持久错误停止并保存明确原因。

```text
fetch → saveRaw → complete?
  yes: flush evidence → acceptRange → next interval
  no + retryable: publish waiting-retry → interruptible wait → same missing interval
  no + stop: publish resumable/incomplete → return
  no + fatal: publish failed → throw original classified failure
```

- [ ] **Step 4：补集成用例。** 夹具先成功区间 A，再模拟 B 底层三次错误 timeout/429/timeout，下一轮 B 成功；断言 A 未重抓、B 在完成前无 accepted cursor、最终目录完成。再覆盖等待中停止、截止、预算、write failure、永久格式错误、重组导致 A 失效。计量必须包括每次真实尝试。

```powershell
pnpm exec vitest run tests/unit/discovery-recovery.test.ts tests/integration/catalogue-recovery.test.ts tests/integration/discovery.test.ts tests/unit/recorder-deadline.test.ts tests/integration/raw-save-failure.test.ts
```

**交付门槛：** 临时 RPC 故障恢复后无需重启进程即可继续；持续故障可被预算和停止打断；永久错误不被隐藏。

## Task H1.3：独立目录命令与固定目标覆盖

**Files:**

- Create: `src/ops/catalogue.ts`、`src/ops/catalogue-cli.ts`
- Modify: `src/ops/recorder.ts`、`src/cli.ts`、`src/ops/history.ts`、`src/registry/pools.ts`
- Test: `tests/integration/catalogue.test.ts`、`tests/integration/catalogue-follow.test.ts`
- Docs: `README.md`、`START_HERE.md`、`docs/runbook.md`

**Interfaces:**
Consumes: 现有 `RecorderOptions`、`BlockAnchor`、`PoolRegistration`、SqliteRangeStore 和 H1.2 恢复策略。
Produces: `runCatalogue(options: CatalogueOptions): Promise<CatalogueReport>`；新类型放 `src/ops/catalogue.ts`，下游 H3 直接导入。

```ts
import type { RecorderOptions } from './recorder.js';
import type { BlockAnchor } from '../domain/types.js';
export type CatalogueOptions = Pick<
  RecorderOptions,
  | 'config'
  | 'env'
  | 'watchlistPath'
  | 'databasePath'
  | 'outputDirectory'
  | 'maxCalls'
  | 'evidenceMode'
  | 'readerFactory'
  | 'shutdown'
> & {
  durationMs: number;
  targetBlock?: bigint;
};
export interface CatalogueReport {
  version: 1;
  scopeId: string;
  assetVersion: string;
  protocolVersion: string;
  targetAnchor: BlockAnchor | null;
  acceptedTip: BlockAnchor | null;
  status: 'complete' | 'incomplete' | 'failed' | 'stopped';
  missing: Array<{ fromBlock: bigint; toBlock: bigint; reason: string }>;
  poolCount: number;
  excluded: string[];
  sourceHash: string;
  providerCompletenessAssumption: string;
}
```

- [ ] **Step 1：先写端到端 CLI 用例。** `catalogue --duration 10m --max-rpc-calls 1000 --db PATH --out DIR [--to-block N] [--watchlist PATH]`。数值为示例参数，不是本计划的实链运行授权。默认 target 为本次 head，输入不合法在打开 DB 前退出 2。

```text
fixture: V3 股票在 token1；V4 股票在 token0；同池含两只股票；冷池零 Swap
expect: 目录记录全部目标池，共池 poolId 仅一条，归因有两项
expect: 全过程只有建池相关 getLogs，无 Swap/liquidity 操作扫描
expect: requested target 固定，后续 head 变高不改变已声明目标
```

- [ ] **Step 2：抽取共享目录服务并接入命令。** recorder 的 historical 分支使用同一服务；default latest 分支保持跳过 bootstrap。服务记录 run、raw、accepted、manifest 和每次恢复状态。最终 target recheck 失败时撤销受影响完成标记；历史协议范围不完整时不得启用基于完整目录的 operation backfill。

```powershell
pnpm exec vitest run tests/integration/catalogue.test.ts tests/integration/recorder.test.ts tests/integration/history-review.test.ts
```

- [ ] **Step 3：验证复用与版本隔离。** 完整目录后 default follow 能复用已登记旧池并发现新池；重启 catalogue 从 accepted tip+1 开始；名单新增地址不能继承旧 complete；cold pool 不删除。只有经验证覆盖完全相同请求 selector 的旧分片才可跨名单复用；不能以缓存池数证明覆盖。

```text
catalogue output: target/accepted/missing/excluded/sourceHash
follow output: known-pools-only 或 verified-catalogue-through-block，明确截止高度
不能输出：all-chain-pools-complete
```

- [ ] **Step 4：定向回归并更新入口文档。** 修正文档中“所有 follow 启动均先扫历史”的旧表述；保留既有默认命令。输出说明目录 complete 不等于每池有流动性或历史交易完整。

```powershell
pnpm exec vitest run tests/integration/catalogue.test.ts tests/integration/catalogue-follow.test.ts tests/integration/catalogue-recovery.test.ts tests/integration/history-review.test.ts tests/integration/recorder.test.ts
pnpm typecheck
git diff --check
```

**H1 完成：** mock 网络下建池目录可恢复、可复用、有范围证明；真实完整目录仍标“未运行”。
