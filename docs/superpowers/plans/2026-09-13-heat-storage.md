# 热度数据存储压缩与审计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 减少重复 batch/请求/评估 JSON 的磁盘开销，保持原始事件、覆盖、hash、回放和提醒语义可复核。

**Architecture:** 在 SQLite 中新增版本化内容寻址压缩对象，先统一兼容读端，再启用紧凑写入。旧库只读可用，迁移在一致 backup 的新副本上进行；审计同时统计数据库、WAL 与 artifacts。

**Tech Stack:** better-sqlite3、node:crypto、node:zlib、现有无损 JSON、Vitest。不引入远端存储或新的压缩依赖。

**Spec:** [设计](../specs/2026-09-13-stock-pool-heat-research-design.md)；[主计划](2026-09-13-stock-pool-heat-research.md)。

## Global Constraints

- 消费者兼容先于新格式写入；未知格式失败，不当作空数据。
- hash 对规范未压缩字节计算；现有逻辑 batch/manifestHash 保持等价。
- 原始事件、完整性证明、时间、历史配置和业务撤回依据不抽样。
- 不修改或清理旧源库；紧凑副本使用 SQLite backup API，包含 WAL 已提交内容。
- 第一版保留既有 raw_logs 标量/索引结构；先消除最重的大 JSON 重复，不同时重写所有事件存储。

## Task H2.1：压缩对象与统一批次读取

**Files:**

- Create: `src/storage/payload-store.ts`、`src/storage/batch-codec.ts`、下一个空闲编号的 `*-payload-store.sql`
- Modify: `src/storage/database.ts`、`src/storage/raw-store.ts`、`src/storage/manifest.ts`、`src/ops/history.ts`、`src/replay/reader.ts`
- Audit consumers: `src/storage/projection-store.ts`、`src/storage/live-projection.ts`、`src/ops/recorder.ts`、`src/dashboard/snapshot.ts`
- Test: `tests/unit/payload-store.test.ts`、`tests/integration/compact-batches.test.ts`

**Interfaces:**
Consumes: `RecordedRangeBatch`、现有 encodeJson/reviveBatch 等逻辑合同；存储接口使用 `Database.Database`。
Produces: 以下接口供新写入、H3/H4 导出使用。`readBatch` 必须支持旧格式；上层不直接 JSON.parse ingest_batches.payload_json。

```ts
import type Database from 'better-sqlite3';
import type { RecordedRangeBatch } from './manifest.js';
export interface PayloadRef {
  version: 1;
  hash: string;
  codec: 'gzip';
  rawBytes: number;
}
export function putPayload(db: Database.Database, raw: Uint8Array): PayloadRef;
export function getPayload(db: Database.Database, ref: PayloadRef): Uint8Array;
export function readBatch(db: Database.Database, batchId: string): RecordedRangeBatch;
export function writeCompactBatch(db: Database.Database, batch: RecordedRangeBatch): void;
```

- [ ] **Step 1：写往返、去重、损坏与旧格式读取测试。** :memory: 数据库经正常 migration 创建；相同内容只保存一个对象；修改一个字节后 hash 验证失败。JSON roundtrip 保留 bigint 字符串、负值、null 和日志顺序。

```ts
import { expect, test } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { putPayload, getPayload } from '../../src/storage/payload-store.js';
test('content references round-trip and deduplicate', () => {
  const db = openDatabase(':memory:');
  try {
    const bytes = new TextEncoder().encode('{"amount":"-9007199254740993","time":null}');
    const a = putPayload(db, bytes),
      b = putPayload(db, bytes);
    expect(a.hash).toBe(b.hash);
    expect([...getPayload(db, a)]).toEqual([...bytes]);
    expect(db.prepare('select count(*) n from payload_objects').get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2：实现对象表及读端，暂不改默认 writer。** 表字段见下；设置单对象未压缩大小及解压上限为 64 MiB；超出时 writer 先按有序分片切分，reader 超限返回明确格式错误，不分配无限缓冲。相同 hash 已存在时核验长度和实际内容，不覆盖。对象引用与业务行必须在同一 SQLite 事务内提交。

```sql
CREATE TABLE IF NOT EXISTS payload_objects (
  hash TEXT PRIMARY KEY,
  codec TEXT NOT NULL CHECK(codec='gzip'),
  raw_bytes INTEGER NOT NULL CHECK(raw_bytes>=0),
  payload BLOB NOT NULL
);
```

```powershell
pnpm exec vitest run tests/unit/payload-store.test.ts tests/integration/compact-batches.test.ts
rg -n 'ingest_batches|fetch_shards|payload_json|request_json' src tests
```

审计上述搜索的每个读取点，区分 runs/pools/alerts 等不同 payload_json 用途，只迁移本任务对应格式。支持旧 plain JSON 与新明确 envelope，例如 `{format:'batch-ref-v1',payload:PayloadRef}`；禁止在未改造的 SQL json_extract 路径读 envelope。

- [ ] **Step 3：实现 compact batch 展开与编码。** 持久日志仍在 raw_logs；新 batch 引用有序 raw key 列表，manifest/request 大字段按 hash 引用。重复 selector 列表抽为不可变对象，块高区间仍保留独立字段。readBatch 展开后返回原 RecordedRangeBatch，现有完整性验证复算同一 manifestHash。

```text
writeCompactBatch transaction:
  save immutable raw logs
  put normalized request selector objects
  put manifest + ordered log references + batch metadata
  save versioned batch envelope and shard references
readBatch:
  decode legacy JSON OR resolve envelope
  load referenced logs/requests → reconstruct → verify logical manifest
```

- [ ] **Step 4：全消费者兼容通过后启用新运行的 compact writer。** 新 DB 格式记录明确版本；旧二进制不保证能读新写法，升级说明明确该边界，旧副本保持用于回退。保留旧格式读测试与混合库测试，失败对象不推进游标。

```powershell
pnpm exec vitest run tests/unit/payload-store.test.ts tests/integration/compact-batches.test.ts tests/integration/raw-store.test.ts tests/integration/raw-incremental.test.ts tests/integration/history-review.test.ts tests/integration/replay-equivalence.test.ts tests/dashboard/snapshot.test.ts
```

**交付门槛：** 新旧格式展开后事件、池登记、覆盖和 sourceHash 语义等价；旧 readonly DB 零迁移；缺对象/坏 hash/未知版本均明确失败。

## Task H2.2：评估与外部证据去重、紧凑副本和容量报告

**Files:**

- Create: `src/ops/storage-audit.ts`、`src/ops/storage-cli.ts`、`scripts/benchmark-heat-storage.mjs`
- Modify: `src/signals/project.ts`、`src/ops/recorder.ts`、`src/rpc/evidence-writer.ts`、`src/ops/report.ts`、`src/cli.ts`
- Test: `tests/integration/storage-compact.test.ts`、`tests/integration/storage-equivalence.test.ts`、`tests/unit/storage-audit.test.ts`
- Docs: `docs/runbook.md`、`docs/reviews/2026-09-13-heat-storage-baseline.md`

**Interfaces:**
Consumes: H2.1 的 PayloadRef/putPayload/getPayload；现有信号持久化与 SQLite backup。
Produces: `auditStorage(databasePath: string, artifactDirectory?: string): StorageAudit`；类型定义如下。compact CLI 只写新目标；H3 资源报告复用该统计。

```ts
export interface StorageAudit {
  sampledAtMs: number;
  databaseBytes: number;
  walBytes: number;
  artifactBytes: number;
  tables: Array<{ name: string; bytes: number | null; rows: number }>;
  rawPayloadBytes: number;
  compressedObjectBytes: number;
  coverageHours: number | null;
  notes: string[];
}
```

- [ ] **Step 1：构造两份逻辑相同的录制夹具。** 多池、冷池、两个股票共池、重复 overlap、重组/撤回、零事件范围及连续评估。分别用旧兼容 writer 与 compact writer 保存，比较展开后的业务结果。旧 writer 只作为测试基准，不引入用户需要选择的第二套业务语义。

```text
required equality:
  canonical raw keys + complete selector ranges + pool registrations
  rolling values including null/gap/warming + alert ids/revisions/outbox order
  replay inputs and actual observedAt order
required difference:
  bytes occupied by repeated selector/batch/evaluation JSON
```

- [ ] **Step 2：复用内容引用压缩信号评估及外部批次大字段。** 保留每次评估所需时点、状态/证据变更和撤回因果；第一轮只改编码，不减少业务评估次数或丢弃无变化记录。外部 portable 文件使用分片 gzip + hash 清单；每个请求仅记录 selectorRef 及本次区间，原始 selector 在本运行对象清单可解析。未改格式的 full/sampled/off 数据继续能读。

```text
directory layout for new compact artifacts:
  manifest.json       # version, ordered segments, hashes, coverage, mode
  objects/*.json.gz   # immutable shared selector/metadata objects
  segments/*.jsonl.gz # bounded sequence of batch/observation references
```

必须采用临时文件写完、关闭、校验后再发布 final manifest；半文件不列为 accepted evidence。目录内引用防止路径逃逸；不修改既有 evidence 文件或旧 manifest。

- [ ] **Step 3：增加只读 audit 与离线 compact。** `storage audit --db PATH [--artifacts DIR]` 无 RPC；`storage compact --source PATH --out NEW_PATH` 源只读一致 backup 后转换。源与目标相同、目标已存在、hash 损坏时拒绝。逐表/manifest 等价性报告生成后才标成功，失败保留独立副本并明确失败。

```powershell
pnpm exec vitest run tests/unit/storage-audit.test.ts tests/integration/storage-compact.test.ts tests/integration/storage-equivalence.test.ts tests/unit/evidence-writer.test.ts tests/integration/alert-outbox.test.ts
```

- [ ] **Step 4：生成离线容量报告。** benchmark 使用保存的夹具和明确新输出目录，不访问 RPC，不全量复制大库进入测试。测试夹具不少于 10,000 事件和 100 次重复 selector/评估场景；报告事件数、池数、覆盖时间、各类 bytes、压缩耗时、峰值内存。另可只读 audit 本地 recorder.sqlite，不能将其比例外推全链。

```powershell
node scripts/benchmark-heat-storage.mjs --out artifacts/benchmarks/heat-storage
pnpm typecheck
git diff --check
```

脚本须拒绝覆盖已有输出，或在给定目录内创建唯一 run 子目录。验收目标：同夹具 DB+外部文件合计至少减少 50%，业务等价检查通过；保留绝对字节及源版本，不只输出百分比。

**H2 完成：** 容量降低有离线证据，旧数据未修改；不声称已验证每月真实增量或全股票池容量。
