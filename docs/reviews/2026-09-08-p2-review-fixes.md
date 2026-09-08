# P2 复核发现与修复任务书

日期：2026-09-08。对象：提交 `ffc8b54`（feat/p2-protocol-state，基线 `e8e3b9f`）。本文件是给执行修复的 agent 的任务书，不是验收记录。修复完成并验证后，在文末「修复记录」填写结果。

本轮复核在既有 [独立审查](2026-09-08-p2-review.md) 之外独立进行。复核前置结论：**P2 无阻塞项，核心合同实现正确**（V3/V4 符号归一、fee 来源、有符号 L、Collect/Donate 单列、观测层不推算当前 L、投影与游标同事务、sourceHash 失效检测无遗漏、bigint 往返无损）。复核时全库 344 测试通过，typecheck/lint 退出 0。下面列出的都是在此基础上应修或建议修的问题。

## 执行约束

- 在 `feat/p2-protocol-state` 之上切一个任务分支再动手；**不要提交到 main，不要 push**。
- 允许修改：`src/domain/`、`src/protocols/`、`src/state/`、`src/storage/`、`src/ops/projection-cli.ts`、`src/cli.ts`、`tests/`、本文件。
- 禁止修改：`src/storage/migrations/001-raw.sql`、`scripts/vendor-abis.mjs` 生成的 ABI 文件、`artifacts/`、`data/`、`config/`、`pnpm-lock.yaml`、任何 P0/P1 已验收的 recorder/ingest 逻辑。不新增依赖。
- 全局约束不变：金额 bigint、持久化无损字符串、缺口不补零、未知不写零、业务结果绑定 chainId/blockHash/版本、日志不含带凭据的 URL。
- 每条修复都要有对应回归测试；已有测试不得删除或 skip，只能修正其期望值并在本文说明理由。
- 改动了 `src/protocols/**` 或 `src/state/**` 的解码/投影语义时，必须 bump `src/state/project-range.ts` 的 `PROJECTION_VERSION`（例如 `p2-v2`），否则旧投影会被判为 fresh。
- 完成后运行全部验证命令，把真实输出贴进「修复记录」。任何一条失败先停下报告，不要为了让测试变绿改测试。

## 必修（合入前完成）

### F1. 投影查找键硬编码 chainId

- 位置：`src/state/project-range.ts:61-62`
- 现状：`'4663:v3:' + address` / `'4663:v4:' + address + ':' + poolId` 字面量拼键；registry 侧 `src/registry/pools.ts:12-17` 的 `poolRegistrationId` 用 `pool.chainId`。
- 失败场景：`src/domain/chain.ts` 的 `CHAIN_ID` 一旦改动，所有日志查不到登记，全部走 `unregistered-pool`，投影事件为 0 且不抛错。TypeScript 查不出字符串字面量漂移。
- 修法：用 `poolRegistrationId({ pool: { chainId: CHAIN_ID, protocol: 'v3', address } })` 构造查找键，或至少改为 `` `${CHAIN_ID}:v3:` `` 模板串。全仓 grep `'4663:` 确认无其他硬编码（`src/registry/identity.ts:291` 是错误文案，不用改）。
- 测试：单元测试断言 project-range 生成的键与 `poolRegistrationId` 对同一登记项的输出相等。

### F2. 解码 catch-all 把内部错误伪装成链上脏数据

- 位置：`src/protocols/uniswap-v3/decode.ts:97-104`，`src/protocols/uniswap-v4/decode.ts:84-93`
- 现状：catch 只识别 `UnknownUniswapV3EventTopicError` / `UnknownUniswapEventTopicError` / `InvalidSwapDirectionError`（v4 另透传 `PoolEventDecodeError`），其余一律归 `invalid-data`。try 块内含 `assertCanonicalEvent`、`ancillaryFields`、按名取 args 等自有逻辑。
- 失败场景：解码器自身回归（如 ABI 生成字段名变化导致 `args[name]` 为 undefined 后 TypeError），`src/state/project-range.ts:83-85` 把每条日志记成 `invalid-data` 质量错误后继续，投影「成功」完成、事件数为 0，没有任何异常冒出。
- 修法：只对已知错误类型分类：未知 topic → `unknown-topic`；`InvalidSwapDirectionError` → `invalid-direction`；viem 解码错误、`UniswapEventDecodeError`、canonical 校验抛出的错误 → `invalid-data`。其余 `throw cause` 原样穿透，让 project-range 的非 `PoolEventDecodeError` 分支 rethrow。建议为 canonical 校验定义专门错误类而不是裸 `Error`，便于 instanceof。
- 测试：mock 一个 try 内部抛 `TypeError` 的路径，断言 decodeV3/decodeV4 抛出的就是那个 `TypeError` 而不是 `PoolEventDecodeError`；再断言 projectRange 对该日志整体抛错而不是记质量错误。原有「脏 topic / 越界字 / 多余 data → invalid-data」用例必须继续通过。

### F3. 零侧 Swap 连 post-state 一起丢弃

- 位置：`src/domain/events.ts:36-40`（`normalizeCoreDeltas` 抛 `InvalidSwapDirectionError`），`src/protocols/uniswap-v3/decode.ts:58`、`src/protocols/uniswap-v4/decode.ts:44` 调用处，`src/state/project-range.ts:83-85` 丢弃处。
- 现状：零/同号 Swap 整条进 `qualityErrors`（code `invalid-direction`），不进 `events`，不进 `observePool`。
- 真实样本：`artifacts/p0/raw/2026-09-08T06-10-51-129Z/logs.json` 中 block 57465603 / logIndex 3 的 V4 Swap，`amount0=-1, amount1=0, fee=0`，但 `sqrtPriceX96`、`liquidity`、`tick` 均有效。P0 归档 531 条 V4 Swap 中占 1 条。
- 失败场景：某池最新一条链上事件是这种舍入到 0 的 Swap，该池 `lastSwap` 停留在更早的价格/L，且事件流里没有任何「这里有过一次状态变化」的痕迹；质量错误里的 `invalid-direction` 语义等同于「数据非法」，与事实不符。
- 修法（二选一，选前者）：
  1. 保留 `normalizeCoreDeltas` 的抛错行为和现有测试。在 decodeV3/decodeV4 里捕获 `InvalidSwapDirectionError`，把该日志降级为 `AncillaryEvent`，`kind` 使用新增的 `'swap-nontrade'`（在 `src/domain/types.ts:93` 的联合类型上加），`decoded` 保留 `amount0/amount1/sqrtPriceX96/liquidity/tick/fee` 的十进制字符串；不产出 `tokenIn/amountIn/tokenOut/amountOut`。`observePool` 对该 kind 走 ancillary 分支（不替换 lastSwap，也不推算 L）。`invalid-direction` 错误码保留给 `normalizeCoreDeltas` 直接调用方，decode 层不再产生它。
  2. 若决定维持丢弃，则不改代码，改为在 `docs/superpowers/plans/2026-09-08-p2-protocol-state.md` Task 2.1 写明「零侧/同号 Swap 的 post-state 一并丢弃」，并把质量错误码拆为 `invalid-direction`（真正无法解释）与 `nontrade-swap`。
- 测试：用上述真实样本（可从 `tests/integration/decode-real.test.ts` 的 fixture 加载）断言 decodeV4 返回 `kind: 'swap-nontrade'` 且 `decoded.sqrtPriceX96` 等字段无损；断言 projectRange 后该日志在 `events` 中、不在 `qualityErrors` 中、对应池 `lastSwap` 未被它替换。同时更新 `tests/integration/decode-real.test.ts` 中「1 条 invalid-direction」的计数期望，并在本文说明。`artifacts/p2/*` 的历史计数不要改。

### F4. 离线只读命令实际写库

- 位置：`src/storage/database.ts:19-32`（`openDatabase`），`src/ops/projection-cli.ts:54` 调用处。
- 现状：`project` 与 `inspect-pool` 都走 `openDatabase`，每次打开都 `mkdirSync` 父目录、`journal_mode = WAL`、执行 001+002 全量 DDL、探测并 `alter table pools`、`update pools set protocol = ...`。
- 失败场景：对只读文件/只读挂载/只读快照跑 `inspect-pool` 直接 `SQLITE_READONLY: attempt to write a readonly database`，且被归为 internal error 退出码 1；与并发 recorder 抢写锁，只靠 `busy_timeout = 5000` 兜底；README 和 help 里「offline」给用户的心智是不写库。
- 修法：给 `openDatabase(path, options?: { readonly?: boolean })` 增加只读模式：`new Database(path, { readonly: true })`，跳过 mkdir、WAL 切换、migration 与 protocol backfill。`inspect-pool` 走只读模式；`project` 保持读写。只读模式下若缺表（未 migration 的旧库），应抛 `ConfigError` 而非裸 Error。
- 测试：把临时库文件设为只读后跑 `inspect-pool`，断言不抛错且返回 0/4；断言只读打开前后不产生 `-wal`/`-shm` 文件；`project` 路径行为不变。

### F5. `project` 无 accepted scope 时退出码 1

- 位置：`src/storage/projection-store.ts:62`（裸 `throw new Error('No accepted scope to project')`），`src/cli.ts:245-247` else 分支。
- 现状：对存在但该 scope 没有 accepted range 的库跑 `lp project`，打印 `Internal error; no provider details emitted`，退出码 1。同一个库上 `inspect-pool` 返回 4 并输出结构化 `projection-stale-or-missing`；`src/cli.ts:29` 的 help 约定 4 = incomplete data。
- 修法：`SqliteProjectionStore.rebuild` 前先查 `acceptedTip`，为空时由 `src/ops/projection-cli.ts` 输出 `encodeJson({ status: 'no-accepted-scope', scopeId, next: 'Run ingest/follow with the same config first' })` 并 `return 4`。store 层可改为返回 `null` 或抛专门错误类，由 CLI 层映射。
- 测试：对新建空库跑 `project`，断言退出码 4 且 stdout 是上述 JSON。

### F6. `observePool` 重组守卫只覆盖一半方向

- 位置：`src/state/observations.ts:17-25`
- 现状：第 17 行「事件排序更早则早退」在第 18-25 行 blockHash 冲突检查之前。同 blockNumber、不同 blockHash、但 `comparePosition < 0` 的替换事件会静默被忽略；只有排序更晚或相等时才抛 `Conflicting history`。现有测试 `tests/unit/pool-observations.test.ts:68-73` 用同一 logIndex，恰好落在会抛错的一侧。
- 缓解事实：`src/state/project-range.ts:38-55` 每次从空观测全量重放并先按位置排序，生产路径不会触发。但函数对外承诺的保护只做了一半。
- 修法：把 blockHash 冲突循环移到顺序早退之前。
- 测试：在现有用例旁加一条「同块不同 hash、logIndex 更小」的用例，断言抛 `Conflicting history`。

## 建议修（可与必修同批，也可留到 P3 前）

### S1. `--rebuild` 是装饰性 flag
`src/ops/projection-cli.ts:57-59`：`project` 无论带不带 `--rebuild` 都全量重建。要么真强制（不带则 `ConfigError`），要么从 `src/cli.ts:15` help 与 options 表移除。选前者，因为 README 已把 `--rebuild` 写成命令的一部分。

### S2. 三张明细表只写不读
`projected_events` / `pool_observations` / `projection_quality_errors` 除 `rebuild` 的 delete/insert 外没有任何 select；`read()` 只读 `projection_cursors.payload_json`。`src/storage/migrations/002-projections.sql:35` 的 `projected_events_minute` 索引不服务任何查询。P3 要按池/分钟读事件，届时应让 `read()` 或新的查询接口走这三张表，并考虑 cursor payload 只存 sourceHash 与计数、不再重复存完整结果。本轮至少在 `src/storage/projection-store.ts` 顶部注释写明这一现状与 P3 意图。

### S3. 每个注册池种一条全 null 观测
`src/state/project-range.ts:40-45` 为 `registry.snapshot()` 每一项 set 空观测；验收数据 1827 个池只有 29 个有观测，payload 与 `pool_observations` 放大约 3 倍。只物化有观测的池；`inspect-pool` 对「已登记但无观测」的池应返回 `status: 'registered-no-observation'`，而不是 `Pool is not registered in this projection`。

### S4. `inspect-pool` 把全局质量错误算进单池
`src/ops/projection-cli.ts:115`：`e.poolId === id || e.poolId === null`。scope 内任一条 `unregistered-pool` 都让每个池报 `quality-errors` + 退出码 4。拆成 `poolQualityErrors` 与 `scopeQualityErrors` 两个字段；退出码仍按两者之和判定（保守），但输出里能看出本池是否干净。

### S5. `PROJECTION_VERSION` 是 sourceHash 里唯一的代码版本输入
`src/state/project-range.ts:9`。改解码器忘 bump 会返回旧投影且判 fresh。在 `scripts/check-scripts.mjs` 或新增的 lint 步骤里加门槛：`src/protocols/**`、`src/state/**` 相对上一次 tag/commit 有变更时 `PROJECTION_VERSION` 必须变；或把这些文件内容哈希并入 sourceHash（更稳但每次代码格式化都会失效投影，自行权衡后二选一）。

### S6. decode 透传 registration 字段无校验
`src/protocols/uniswap-v3/decode.ts:55-67`、`src/protocols/uniswap-v4/decode.ts:25-53`：`tokenIn/tokenOut/pool` 直接引用 registration，`actor` 却 `.toLowerCase()`。registration 缺 `token1` 时 `tokenOut` 为 undefined 不报错；`feePips` 为字符串也照收。生产路径经 `normalizePoolRegistration` 已小写，但 decode 是公开入口。在 emitter/poolId 校验旁补 token0/token1/feePips 存在性与形态校验，并统一小写。

### S7. `effectiveSwapFeePips` 可空却永不为 null
`src/domain/types.ts:79` 声明 `number | null`，V3 永远写 `registration.feePips`。`src/registry/pools.ts:78` 已预留 `source === 'seed-config'`；一旦从配置播种 V3 池，人写的 fee 会被当成链上值。按 `registration.source` 决定：`PoolCreated` 来源写值，其他来源写 `null`。V4 `args.fee` 加范围检查（`0x800000` 动态标志位不应出现在 Swap 事件 fee 中，出现则归 `invalid-data`）。

### S8. `observePool` 对 `pool === null` 的 ancillary 事件抛错
`src/state/observations.ts:11-15`：判空在 `field` 判断之前，V4 manager-wide 事件喂进来直接 `Observation pool mismatch`。目前靠 `project-range:82` 的 `if (event.pool)` 兜底。把 `if (!field) return previous` 提到 pool 判断之前。顺手把末尾三元（26-30 行）简化为 `{ ...previous, [field]: event }`，`: previous` 分支不可达。

### S9. `assertCanonicalEvent` 按事件名查 ABI
`src/protocols/event-log.ts:18`：`abi.find(e => e.type === 'event' && e.name === eventName)`。当前事件名唯一，无问题；ABI 由脚本生成，将来同名重载会取到第一个签名。改为用 `toEventSelector` 匹配 `log.topics[0]`。

### S10. V3 `Collect` 与 `CollectProtocol` 同一 kind
`src/protocols/uniswap-v3/decode.ts:92-93`。LP 提取与协议金库提取语义不同。`CollectProtocol` 归 `'other'`，或在 `src/domain/types.ts` 的 `kind` 注释写明必须再看 `decoded.eventName`。

### S11. `actor` 跨协议语义不对称
V3 `Mint/Burn` 用 `owner`，V4 `ModifyLiquidity` 用 `sender`（V4 事件无 owner）。在 `src/domain/types.ts` 的 `LiquidityChange.actor` 加注释说明，P4 做参与地址类指标时不得跨协议混算。

### S12. `UniswapEventDecodeError` 归属错误
`src/protocols/uniswap-v3/decode.ts:10` 从 `../uniswap-v4/pool-key.js` 导入协议无关的错误类。移到 `src/protocols/event-log.ts`，两侧改 import。

### S13. tick 无合法性检查
`tickLower >= tickUpper` 或超出 MIN_TICK/MAX_TICK 的 ModifyLiquidity 会被接受为正常 `LiquidityChange`。链上合约会 revert，属加固：加检查后归 `invalid-data`。

### S14. 极值下 `amountIn/amountOut` 超出原类型范围
`src/domain/events.ts:37,39`：`-2^255` 取反得 `2^255`，超 int256 上界；V4 同理超 int128。bigint 无损、持久化无损，`tests/unit/protocol-decode.test.ts:123-130` 已固化为契约。只需在 `normalizeCoreDeltas` 加注释：下游不得把这两个字段重新编码回 int256/int128。

### S15. `--db` 未校验空串/目录
`src/ops/projection-cli.ts:50-53`：`values.db ?? default` 对 `""` 不生效，`resolve("")` 为 cwd，`existsSync` 通过后 `openDatabase` 在 `mkdir 'E:\'` 上 EPERM 退出码 1。拒绝空白串，并 `statSync(dbPath).isFile()`。

### S16. `projection-store.ts` 位置化 INSERT
`src/storage/projection-store.ts:81,92,96` 用 `insert into T values (?,...)` 不写列名。002 将来加列时老库不会迁移且会错位。显式写列名。

### S17. 真实 fixture 测试的覆盖与分类
`tests/integration/decode-real.test.ts:36-38`：只按 V3 Swap 的 topic 判协议，其余全走 `v4.parseLog(...)!`；fixture 中 V3 只有 1 条 Swap，V3 Mint/Burn/Collect、V4 Donate 零覆盖。`:108-114` 的方向断言是生产逻辑的镜像实现，不是独立 oracle。改为「topic 命中 v3PoolAbi 事件集 → 走 v3」；显式统计各 kind 计数并把当前分布写成期望值（V3 非 Swap 目前为 0，日后扩充 fixture 会自然失败提醒）；对那 1 条 V3 Swap 和至少 3 条代表性 V4 Swap 写硬编码方向期望。`:99-112` 的 malformed 用例用改写前的深拷贝做期望值。

### S18. 文档时点
`docs/reviews/2026-09-08-p2-acceptance.md` 与 `docs/implementation-status.md` 的 P2 段写「改动未提交、未推送」，现已提交为 `ffc8b54`。补一句「后已提交为 ffc8b54」。本轮修复完成后在 `docs/implementation-status.md` 追加一段「P2 复核修复」并链接本文。

## 验证命令（全部退出 0，把真实输出贴到修复记录）

```powershell
pnpm run typecheck
pnpm test
pnpm run build
pnpm run lint
git diff --check
```

针对性回归（必修项各自的新用例都应在这几个文件里）：

```powershell
pnpm exec vitest run tests/unit/protocol-decode.test.ts tests/unit/swap-direction.test.ts tests/unit/pool-observations.test.ts tests/integration/decode-real.test.ts tests/integration/projection-repair.test.ts
```

离线 CLI 复核（`data/p2-acceptance.sqlite` 只读，不要改它；先复制到临时路径）：

```powershell
$p2FixDb = @'
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const target = join(mkdtempSync(join(tmpdir(), 'p2-fix-')), 'copy.sqlite');
const source = new Database('data/p2-acceptance.sqlite', { readonly: true, fileMustExist: true });
try { await source.backup(target); } finally { source.close(); }
console.log(target);
'@ | node --input-type=module
pnpm lp project --db $p2FixDb --rebuild
pnpm lp inspect-pool --config config/robinhood.json --db $p2FixDb --pool amc-usdg-v3
```

F3 选方案 1 时，如实记录 `project` 输出的事件数与质量错误数相对验收值（650 / 0）的变化并解释。那条真实零侧样本来自 P0 归档，是否落在 P1 录制段内需实测；不在段内则数字不变。

## 停止条件

- 必修 F1–F6 完成并验证即为一批可交付；建议项按上面顺序做，做不完的在修复记录里列出未做项。
- 遇到以下情况停下来报告，不要自行扩大范围：需要改 P1 的 `SqliteRangeStore` 接口；需要改 001 migration；F3 的方案 1 导致 `PoolEvent` 联合类型变化波及 `src/ops/recorder.ts` 之外的 P1 代码；任一既有测试在不改期望值的前提下失败；需要新依赖。

## 修复记录

修复日期：2026-09-08；分支：`fix/p2-review`；修复基线：`484079c`。原 P2 已于验收后提交为 `ffc8b54`。本批在任务分支提交，不合入 main、不 push。按 S18 的明确要求，除上述代码/测试/本文范围，另仅对原 P2 验收报告和 implementation-status 补充时点说明及本批链接。

### 必修结果

| 项目 | 状态与关键改动 | 回归证据 |
|---|---|---|
| F1 | 完成。通过 CHAIN_ID + poolRegistrationId 生成 V3/V4 查找键。 | project-keys 将 CHAIN_ID mock 为 9999，两协议仍成功投影。 |
| F2 | 完成。仅明确的 topic/方向/ABI/canonical 错误归入质量错误；自有逻辑或底层帮助函数的任意 TypeError 原样抛出。共享错误类保留旧导出兼容。 | 解码错误对象身份测试；投影中注入内部异常，旧游标和事件行保留。 |
| F3 | 完成，采用保留事件方案，但仅适用于至少一侧为零。增加 swap-nontrade，原始金额和价格/L/tick/fee 为十进制字符串，不产生规范成交字段，不替换 lastSwap。非零同号仍是 invalid-direction。 | 真实 block 57465603 / logIndex 3 解码、完整投影和 SQLite 往返；直接 normalizeCoreDeltas 原有严格测试不变。 |
| F4 | 完成。inspect 使用真实 readonly/fileMustExist 连接；不建目录、不切 WAL、不迁移、不 backfill；失败关闭连接。只有缺表/缺列映射 ConfigError，临时锁错误原样抛出。 | 只读属性拒绝写入；并发 WAL writer；只读 DELETE 快照字节/sidecar 检查；旧 schema 不迁移；真实排他锁保留 SQLITE_BUSY。 |
| F5 | 完成。store 在事务内抛 NoAcceptedScopeError，CLI 仅捕获该类型并输出 no-accepted-scope 和 ingest/follow 提示，退出 4。 | 空 scope 的离线 CLI JSON/退出码回归。 |
| F6 | 完成。相同块高度不同 hash 的检查移至排序早退之前。 | 较早 logIndex 的分叉事件同样拒绝；正常倒序和 ancillary 行为保留。 |

F3 对原任务书的语义修正：不能把所有 InvalidSwapDirectionError 都降级为正常事件；非零同号没有普通 Swap 的成交方向，仍保留质量错误。V3 的 nontrade fee 沿用调用方登记的 fee 契约，V4 fee 来自 Swap 本身。

F4 对原测试要求的限定：SQLite 只读连接读取 WAL 库时仍可能创建/访问 -wal/-shm。因此“无 sidecar”仅在关闭写连接、稳定的 DELETE-journal 只读快照上验证；实时 WAL 库验证无业务写入和并发可读，不使用 immutable 绕过 recorder 的 WAL。离线验收采用 SQLite online backup，而不是仅复制主库文件。

### 建议项与延后项

| 项目 | 处理结果 |
|---|---|
| S1 | 完成：project 必须显式 --rebuild。 |
| S2 | 完成本轮要求的代码注释：read 读取 cursor JSON，三张明细表目前只写。实际按池/分钟查询与消除重复 payload 留 P3。 |
| S3 | 留 P3：稀疏观测及 registered-no-observation 输出要随查询接口一同调整，本批保持登记池查询合同。 |
| S4 | 完成：inspect 分列 poolQualityErrors/scopeQualityErrors，任一非空仍返回 4。 |
| S5 | 本批显式升至 p2-v2，并新增旧版本拒绝回归；自动版本门槛/源码哈希机制留 P3。 |
| S6 | 完成：解码公开入口验证登记形态、chain/emitter/PoolId、币种地址、整数 fee，并规范化副本地址小写，不修改输入。 |
| S7 | 部分完成：V4 实际 Swap fee 限定 0..1,000,000，先校验再判断 nontrade。V3 来源建模留 P3：现有 source 是字符串，不靠单一文案白名单推定可信度，保留登记 fee 合同。 |
| S8 | 完成：pool=null 的 manager ancillary 和其他 ancillary 均不更改观测。 |
| S9 | 完成：canonical ABI 按 topic selector 匹配，含同名重载回归。 |
| S10 | 完成：CollectProtocol 归 other，LP Collect 保留 collect。 |
| S11 | 完成：actor 注明 V3 owner / V4 sender，不能混算用户数。 |
| S12 | 完成：共享 UniswapEventDecodeError 移至 event-log，旧 V4 路径 re-export 保持构造器身份。 |
| S13 | 完成：V3 Mint/Burn、V4 ModifyLiquidity 要求 tickLower < tickUpper 且位于合法界限内。 |
| S14 | 完成：说明规范金额是无符号大小，不能重编码回原 signed 类型。 |
| S15 | 完成：--db 拒绝空白和目录；缺文件仍为配置错误。 |
| S16 | 完成：四张投影表 INSERT 显式列名，新增 nullable 列回归。 |
| S17 | 完成：真实 fixture 使用 V3 完整事件 selector 集分类；固定完整 kind 计数；1 条 V3 和 3 条 V4 用固定方向 oracle；异常测试保留深拷贝 raw 期望。 |
| S18 | 完成：原验收补 ffc8b54 提交时点，implementation-status 追加本批结果并链接本文。 |

### 测试期望变化与真实数据

原有零侧 decode 期望由 invalid-direction 改为 swap-nontrade；非零同号、直接 normalizeCoreDeltas 的拒绝期望不变。P0 fixture 从 V4 530 条普通 Swap + 1 条被拒绝，改为 530 条普通 Swap + 1 条 nontrade。完整分布：V3 swap 1；V4 swap 530、swap-nontrade 1、liquidity 27、initialize 3、other 15；其余 kind 为 0。历史 artifacts/p2 的 344 测试/计数原样保留。

真实零侧样本逐字段固定：amount0=-1、amount1=0、sqrtPriceX96=6723590767295199506134079760391、liquidity=242871927514263989673、tick=88825、fee=0。投影往返测试中的前一条成交、登记与分钟时间是明确标注的合成输入；该零侧 raw 日志本身未改，不声称补齐其历史登记或精确秒数。

最终构建通过只读源连接 online backup 到唯一临时目录，先验证旧 p2-v1 inspect 返回 4，再执行：

```text
node dist/cli.js project --db <temporary-backup> --rebuild
exit 0: status=projected, version=p2-v2, events=650, pools=1827, qualityErrors=[]
node dist/cli.js inspect-pool --config config/robinhood.json --db <temporary-backup> --pool amc-usdg-v3
exit 0: status=observed, timing=minute, poolQualityErrors=[], scopeQualityErrors=[]
```

650 事件分布仍为 V4 Swap 556、V3 Swap 47、V4 liquidity 37、V3 liquidity 5、V3 Collect 5；29 个池有观测。该 P0 零侧事件不在 P1 录制范围，所以本段数量不变。全部事件 minuteStartSec 已知、exactTimestampSec=null，finality 仍为 provisional。副本中 14 张 P1 表逐表内容哈希未变；源 data/p2-acceptance.sqlite 的逐表内容及主库/WAL 字节哈希前后相同。临时目录已清理，没有覆盖历史 artifacts 或采集新 RPC。

### 最终验证与独立复核

以下是最终运行的实际结果，全部退出 0：

```text
pnpm run typecheck
$ tsc --noEmit && tsc -p tsconfig.scripts.json

pnpm test
Test Files  34 passed (34)
     Tests  401 passed (401)
  Start at  22:56:50
  Duration  8.88s (tests 70%, import 19%, transform 10%)

pnpm run build
$ node scripts/clean-build.mjs && tsc -p tsconfig.build.json && node scripts/copy-build-assets.mjs

pnpm run lint
$ node scripts/check-scripts.mjs && prettier --check "src/**/*.ts" "tests/**/*.ts" "scripts/**/*.mjs"
Checking formatting...
All matched files use Prettier code style!

git diff --check
(no output)
```

没有删除/skip 既有测试；全量从 344 增至 401。现有 Uniswap SDK 缺失 source-map 源文件提示保留，未屏蔽。先运行新增用例复现缺陷，再实现并确认通过；其中独立复核补出的真实锁回归也先复现 ConfigError 误分类，再验证返回 SQLITE_BUSY。

独立复核最终结论：F1–F6 与代码质量 PASS，无开放的本批正确性问题。初审 23 项专项通过；唯一发现是 readonly schema catch-all 误报锁错误，修复后独立重跑 readonly 6 项通过并关闭。完整日志、解码报告、独立复核和离线复验 JSON 存于本地 .superpowers/sdd/p2-fix-*，作为临时工作证据，不改写历史验收 artifacts。

P3 仍未开始。上述明确延后的查询/稀疏观测/自动版本门槛/V3 费率来源事项，不属于本批已完成范围。
