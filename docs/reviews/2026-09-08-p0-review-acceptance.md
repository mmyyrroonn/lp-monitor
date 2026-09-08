# P0 review 修复验收（2026-09-08）

- 验收对象：commit `be8d44f`（基线 `52d4072`），对应 [处理记录](2026-09-08-p0-review-resolution.md) 与 [原始评审](2026-09-08-p0-review.md)
- 验收方式：主评审亲自实跑验证命令并核对阻塞项核心文件；Opus sub agent 对照 H / M / L 组与测试缺口逐条比对 diff；下列每条行号均已核对为真实
- 结论：**可以作为 P1 的地基接受。** 下面 R1、R2 两条应在 P1 Task 1.1 之前修，其余可并入 P1

## 验证结果（本机实跑，commit be8d44f）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0（含 `tsc -p tsconfig.scripts.json`） |
| `pnpm test` | 17 文件 149 用例全部通过，5.84 s |
| `pnpm build` | exit 0，产物 `dist/cli.js`，不再包含 tests |
| `node scripts/check-scripts.mjs` | exit 0 |
| `pnpm format:check` | All matched files use Prettier code style |
| `pnpm lint` | 本机失败，原因是脚本内部再调 `pnpm` 而本机 PATH 上没有 pnpm；两个子步骤单独执行均通过。CI 环境不受影响 |

## 逐条判定

### 阻塞项 B1 到 B6：全部落地

| 编号 | 判定 | 核对依据 |
|---|---|---|
| B1 | 已修复 | `src/rpc/rate-limit.ts:17-30` 指数惩罚（×2，封顶 30 s），每 3 次成功衰减 250 ms；`:12-15` 去掉 5 RPS 硬上限；`:43-55` 并发信号量 |
| B2 | 已修复 | `src/rpc/request-meter.ts:8-11` 1000 槽环形缓冲，`:12` 配额可为 null，`:16-18` 剩余额度直读；`src/config/chain.ts:31,35-37` 上限解除；P0 CLI 仍在 `src/cli.ts:90-92` 夹到 150 / 5 / 10 s |
| B3 | 已修复 | `src/ops/files.ts:42-64` 返回相对 POSIX 路径，tmp + rename，哈希回读；manifest 路径已是 `artifacts/p0/raw/...`；原始 8 个日志与请求文件零 diff，只有 manifest 变了 |
| B4 | 已修复 | `src/rpc/errors.ts:18-32` 先收集 code / status 并剥离 URL，`:33` 429 只看 status，`:34-35` 5xx 与 408 可重试，`:47` `-32005` 兜底为 `unknown-limit`；`src/ingest/fetch-range.ts:25-26` budget 与 rate-limit 直接上抛，只对 range-limit 拆分 |
| B5 | 已修复 | `src/rpc/evidence-writer.ts` 异步写入、full / sampled / off、16 MiB × 8 分片，full 满后失败不淘汰 |
| B6 | 合理拒绝 | 本机 `node_modules/@types/better-sqlite3` 为 9.6.0，`better-sqlite3` 13.0.3 无 types 字段、无 .d.ts。"registry 最新仍是 9.6.0"未离线核实。补了 `tests/unit/sqlite.test.ts:15-48` 合同测试 |

### 高优先 H1 到 H6

| 编号 | 判定 | 核对依据 |
|---|---|---|
| H1 | **部分修复** | 共享缓存与 `before` 已做（`src/ops/fixture-capture.ts:123-124`，`src/rpc/resolve-time.ts:140`）。但 seed hint 定位仍不传 bounds（`fixture-capture.ts:229`），仍是对全链的二分；见 R3 |
| H2 | 已修复 | `src/rpc/client.ts:41` 出口统一小写；`src/config/chain.ts:8,12` schema transform 小写；回归 `tests/unit/rpc-review.test.ts:48-83`、`tests/unit/config.test.ts:56-68` |
| H3 | 已修复（1 处瑕疵） | 旧位置 `src/rpc/identity.ts`、`src/rpc/capabilities.ts`、`src/ops/request-meter.ts` 各只剩 2 行 reexport；`src/rpc/` 下不再 import `../ops/`；chainId 收敛到 `src/domain/chain.ts:1`；新增 `src/domain/codec.ts`。瑕疵见 R5 |
| H4 | 已修复 | budget 重抛 `src/ops/capabilities.ts:87`、`src/cli.ts:110`；chainId 畸形走 RpcFailure（`fixture-capture.ts:108`）；`.strict()` 与字段路径 `chain.ts:18,66-73`；maxRangeBlocks 生效 `cli.ts:74-79`；退出码映射 `cli.ts:191-200` |
| H5 | 已修复 | `.github/workflows/ci.yml`；`tsconfig.build.json` 只含 src；`tsconfig.scripts.json` checkJs；Prettier。CI 未远端执行，处理记录如实说明 |
| H6 | 已修复，且 Codex 的反驳成立 | 见下节"原评审的错误" |

### 中低发现 M1 到 M4、L1 到 L19

| 编号 | 判定 | 核对依据 |
|---|---|---|
| M1 | 已修复 | `.gitignore:12-17` 反向规则精确开洞；`git check-ignore` 实测已跟踪 run 不忽略、新 run 忽略 |
| M2 | 已修复 | `src/ops/capabilities.ts:220-233` 按 blockHash:txHash:logIndex 去重 |
| M3 | 已修复 | `src/ops/capabilities.ts:242-243` 合取累积 |
| M4 | 已修复 | `src/ops/capabilities.ts:126,141` 形状一致 |
| L1 | 已修复 | `fixture-capture.ts:50-51` |
| L2 | 已修复 | `fixture-capture.ts:245-251` |
| L3 | 已修复 | `fixture-capture.ts:150-151` |
| L4 | 已修复 | `pool-key.ts:50`，上界 32767 来源 `@uniswap/v4-core/src/libraries/TickMath.sol:28` |
| L5 | 已修复 | `protocols/uniswap-v3/decode.ts:29` |
| L6 | 已修复 | `registry/identity.ts:215-224` |
| L7 | **描述掩盖** | `client.ts:51,150` 的 `anchors` Map 永不写入却作为公开字段返回，成了恒空死接口。原建议是删除或接进 resolver，两者都没选。见 R6 |
| L8 | 已修复 | `client.ts:67` |
| L9 | 已修复 | `client.ts:80-87`，`rate-limit.ts:38,44` |
| L10 | 已修复 | `request-meter.ts:53,56` |
| L11 | 已修复 | `files.ts:56-61` |
| L12 | 已修复 | `cli.ts:118-143` |
| L13 | 已修复 | `scripts/vendor-abis.mjs:92,131-142` 真的 spawn vitest |
| L14 | 已修复 | `scripts/evidence-paths.mjs:34-47` |
| L15 | 已修复 | `chain.ts:30`、`env.ts:21` 注释 |
| L16 | 合理拒绝 | 保留 templateLiteral，符合原评审要求 |
| L17 | 合理拒绝 | 原评审即注明"未核实，仅记录" |
| L18 | 已修复 | 版本保留，补 CI；`pnpm-lock.yaml` 只加 prettier 3.9.6 |
| L19 | 已修复 | 杂散文件已删；research / tooling / .agents / skills-lock.json 已忽略 |

### 测试缺口 1 到 11

| # | 判定 | 核对依据 |
|---|---|---|
| 1 退出码矩阵 | **部分** | 0/1/2/3/4 都有断言（`cli.test.ts:8-15,16-32,95-153`），但退出码 0 只由 `--help` 覆盖，没有成功完成 probe 或 capture 的用例。见 R7 |
| 2 真实 viem 错误 | 已修复 | `rpc-review.test.ts:169-211` 从 viem import HttpRequestError / TimeoutError / RpcRequestError，8 个用例 |
| 3 集成可移植性 | 已修复 | `tests/integration/evidence-portability.test.ts:6-31` cpSync 到临时目录后跑验收脚本 |
| 4 预算耗尽路径 | 已修复 | `fixture-capture.test.ts:126-163`，`cli.test.ts:131-142` |
| 5 hooks / 动态费率 | **部分** | `abi.test.ts:105-116` 覆盖 hooks 非零与 fee=0x800000，未覆盖 currency0 为原生币的排序边界 |
| 6 getLogs 校验 | 已修复 | `rpc-review.test.ts:113-148` 六个用例 |
| 7 429 降速与衰减 | **部分** | 衰减已测（`rpc-review.test.ts:30-47`）；`rate-limit.test.ts` 仍只有 1 个用例，没有断言 client 在 429 时真的调用 penalize。见 R7 |
| 8 大小写 | 已修复 | `config.test.ts:56-68`，`fixture-capture.test.ts:108-111` |
| 9 zod 未知字段 | 已修复 | `config.test.ts:42-55` |
| 10 v3 decode 负值 | **未修复，处理记录声明不实** | `tests/unit/abi.test.ts` 没有任何 int256 amount0 为负或 int24 tick 为负的解码断言，唯一的 `decodeV3PoolEvent` 调用（`:100`）是断言畸形 data 抛错。见 R8 |
| 11 fetchBoundedLogs 上界 | **部分** | 断言了拆分序列与 rate-limit 只调 1 次，没有"不超预算"的显式上界断言。递归在结构上由 `fromBlock < toBlock` 终止，风险低 |

## 原评审的错误（记录在案）

原评审 H6 写"RateLimiter.acquire 是单条 Promise 链，并发度恒为 1"，**这句话是错的。** 旧实现（`git show 52d4072:src/rpc/rate-limit.ts:13-19`）的 tail 链里只有 delay，不含调用方的 RPC；调用方在 acquire resolve 之后才发请求，且请求不回接到链上。串行化的是发牌而不是在途请求，只要单次请求耗时长于发牌间隔，并发就无上限。原评审"已查无误"一节又写"tail 链严格串行"，与 H6 自相矛盾。H6 后半句"maxConcurrentRpc=2 无法表达"仍然成立，Codex 补的 `enter()` 信号量正是缺的那一半，并有并发上限回归（`rpc-review.test.ts:93-112`）。

## 越界与回归检查：全部通过

- 验收证据文件（`artifacts/p0/tests.json` 等）的改动只是压缩 JSON 转缩进与路径分隔符替换，60/60 与时间戳逐一对应，`source-snapshot.json` 的 70 处 sha256 未动。本轮结果单独放在 `review-validation.json` 与 `review-tests.json`。"保留为历史、不冒充本轮结果"属实。
- `src/domain/types.ts` 增量全部是类型声明与格式展开，零运行时代码，无 SQLite schema、无 follow、无 store 实现。
- `src/registry/identity.ts` 函数集合与旧文件完全一致，多出的行来自 Prettier 展开与三处评审要求的改动。
- `src/cli.ts` 子命令仍只有 probe 与 capture，唯一新增参数是 `--evidence`。
- 新依赖只有 Prettier 3.9.6。
- 处理记录写的 `sample` 策略名不存在，代码与 README 都是 `sampled`，一致；仅记录本身噪音。

---

## 遗留事项 R1 到 R9

### R1 证据写失败会吞掉真正的 RPC 错误 [P1 前修]

- 位置：`src/rpc/client.ts:98-106`
- 问题：错误分支里 `await writer.write({...error})` 没有包 try。writer 一旦满容或失败（`evidence-writer.ts:33-34,68,71` 都会抛），抛出的是 `evidence-capacity` / `evidence-write`，第 107 行的 `throw failure` 与 `retryable` 重试判断整个被跳过。
- 后果：可重试的瞬时网络故障变成硬失败，且真实故障类型丢失。
- 修法：错误路径的证据写入包一层 catch，保证原 failure 优先抛出；证据写入失败另行记入 failures。
- 测试：writer 满容后触发一次 timeout，断言抛出的是 `timeout-or-network` 且重试次数正确。

### R2 anchor 记录随区间数重复膨胀 [P1 前修]

- 位置：`src/ops/fixture-capture.ts:126,190,231`，`src/rpc/resolve-time.ts:132-136`
- 问题：resolver 现在共享全局 `anchorByBlock`，`queriedAnchors` getter 返回整个累计缓存；每个 captureRange 与每个 seed 都把它全量 push 进 `observedAnchors`，并对全表跑一遍 `validateTimeAnchor`。条目数从唯一 anchor 数变成区间数 × anchor 数，校验开销 O(n²)。旧代码产出的 anchors.json 已是 78 条 / 69 唯一，新代码比例会恶化，P1 接持久化索引后放大。
- 修法：resolver 记录本次新增的 anchor（或 `queriedAnchors` 改名为 `cachedAnchors` 并另提供增量接口）；`observeAnchor` 对已存在且一致的 anchor 不重复 push。
- 测试：两个区间共享缓存后，断言 `anchors.json` 条目数等于唯一块号数。

### R3 H1 的另一半：seed hint 仍是全链二分

- 位置：`src/ops/fixture-capture.ts:229`
- 问题：`resolver.resolveBlockAtOrAfter(hint.timestampSec)` 不传 bounds，走 `query('latest')` + `query(0n)` 的 0 到 5700 万块二分。共享缓存只对第二个 seed 有收窄作用。原评审"82/86 次调用花在块头"的成本结构基本没变。
- 修法：给 hint 加 `deploymentCandidateBlock` 到 head 的 bounds；或在 P1 建 anchors 表后先查持久化索引。

### R4 稀疏收窄是覆盖赋值而非取更紧的界

- 位置：`src/rpc/resolve-time.ts:104-108`
- 问题：`low = sampled.number + 1n` / `high = sampled.number` 随 Map 迭代顺序覆盖，先遍历到块 100 再遍历到块 50 时 low 会退回 51。结果正确，但收窄效果波动，白多几次 RPC。
- 修法：`low = max(low, n+1n)`，`high = min(high, n)`。

### R5 新的层级倒置

- 位置：`src/domain/hex.ts:1`
- 问题：`import { RpcFailure } from '../rpc/errors.js'`，domain 层反向依赖 rpc 层。
- 修法：`parseRpcQuantity` 移到 rpc 层，或 domain 抛自有错误类型由 rpc 层包装。

### R6 恒空的 anchors 死接口

- 位置：`src/rpc/client.ts:51,150`
- 修法：删除该字段及 `tests/unit/rpc-review.test.ts:224` 对 `size===0` 的断言；调用方改用 resolver 的缓存。

### R7 测试补齐

1. 退出码 0：一条成功完成 probe、一条成功完成 capture 的用例（fake reader）。
2. `rate-limit.test.ts` 补：429 后 `client` 确实调用 `penalize`；连续成功后间隔恢复到基线。
3. `computeV4PoolId` 补 currency0 为原生币（0x0）的排序边界与 SDK 对照。
4. `fetchBoundedLogs` 补显式断言：给定 maxCalls，拆分总调用数不超过预算。

### R8 v3 decode 负值断言（处理记录声明不实）

- 位置：`tests/unit/abi.test.ts`
- 要求：用真实 fixture 中的一条 V3 Swap log（或按 ABI 手工编码），断言 `amount0` 为负的 int256 与 `tick` 为负的 int24 解码值正确，并与 ethers Interface 独立解码结果一致。

### R9 验收闸门已与当前源码脱钩 [P1 前决定]

- 位置：`scripts/p0-acceptance.mjs:26,32`
- 问题：`tests` 与 `engineering` 闸门读的是冻结的历史 `tests.json` / `verification.json` / `source-snapshot.json`。通过只证明历史证据自洽，对当前源码零约束。`evidence-portability.test.ts` 因此也只是在自证历史。
- 决定项：要么让闸门读 `review-tests.json` 这类本轮实跑结果并在每次验收时重新生成，要么把 P0 验收脚本明确标为历史封存，P1 另立验收入口。

### 其他小项

- `scripts/migrate-p0-paths.mjs:38-39` 只给 manifest.json 与 capabilities.json 打 `pathBase`，历史 `identity-evidence.json` 没有；`pathBase` 词表有 `repository` / `manifest-directory` / `report-directory` 三种，`p0-acceptance.mjs:23` 只认前两种。目前无人消费第三种，建议统一词表。
- `src/rpc/evidence-writer.ts:37` 短路求值让 `count++` 对无 result 的错误条目也执行，sampled 的采样节奏被错误记录打乱。不影响正确性。
- `src/ops/capabilities.ts:109,149,201` 在链高度小于 100 时会算出负块号。遗留问题，正常链不触发。

---

## 给 Codex 的执行建议

1. 先修 R1、R2，各补一条回归测试。
2. R7、R8 补测试，R5、R6 顺手清理。
3. R3、R4 可并入 P1 Task 1.3 分钟索引的实现。
4. R9 由用户决定后执行。
5. 完成后更新处理记录，删掉"解码负值"与 `sample` 两处不实措辞。
6. 仍然不要开始 P1 的 SQLite store、follow 或恢复流程。
