# Robinhood RWA monitor — P0

只读、单次执行的工程与数据验收工具。阶段入口为 [START_HERE.md](START_HERE.md)，验收状态见 [实施状态](docs/implementation-status.md)。P1 记录器、分钟热度与提醒尚未实现。

## 环境与命令

要求 Node.js 24、pnpm 11.19.0。依赖版本由 package.json 与 pnpm-lock.yaml 固定。

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm lp --help
```

`better-sqlite3` 的原生构建在 pnpm-workspace.yaml 中明确允许；`pnpm test` 包含真实 SQLite 导入和 uint256 TEXT 往返测试。开发依赖里的官方 Uniswap 包用于生成 ABI、SDK 与 ethers 对照；生产依赖为 viem、better-sqlite3、zod。

在本机终端设置进程环境变量。下例只使用不带凭据的公共端点；更换供应商时从本机环境注入，避免把凭据放入命令参数、聊天或配置 JSON。

```powershell
$env:RH_RPC_HTTP = 'https://rpc.mainnet.chain.robinhood.com'
$env:RH_PROVIDER_ALIAS = 'robinhood-public'
pnpm lp probe --config config/robinhood.json --out artifacts/p0/capabilities.json
pnpm lp capture --config config/robinhood.json --last-blocks 300 --out artifacts/p0/raw
```

也可显式指定 `--from-block N --to-block N`，与 `--last-blocks` 互斥；单次主区间最多 10,000 块，RPC 预算仍生效。`.env.example` 仅列出变量名，应用不会自动读取 `.env`。`RH_RPC_WS` 可配置，但 P0 不连接 WS。`LP_DATA_DIR` 为未传 `--out` 时的 capture 输出根目录。

每次 capture 新建时间戳目录，保存查询过滤条件、原始日志、稀疏 anchors、分钟边界、请求证据、SHA256 与 manifest。默认有界补采配置种子的历史 Initialize；补采区间和实时主区间分别标记。V4 Manager 级协议样本可能含观察名单以外的池，不能把样本总量当作 AMC 成交量。

退出码：0 成功；1 内部错误；2 配置错误；3 必需 RPC/身份失败；4 数据不完整。pnpm 遇到子程序非零码时自身可能返回 1，终端会显示子程序原始退出码；需要原始码时使用 `node --import tsx src/cli.ts ...` 或构建后的 `node dist/cli.js ...`。

## 数据与预算

- 单次运行最多 150 次方法调用；每次请求 10 秒超时、最多两次退避重试。重试计入预算。初始软上限 5 RPC/s；遇到 429 后降速。请求字节统计是读取到的解压响应体字节，排除 HTTP headers；不等同供应商 CU 或费用。
- `maxLogsPerResponse: null` 表示供应商最大返回条数未知。5000 是本地响应防护值，不是已测供应商上限。范围与子范围对照只验证已测区间。
- 日志 `blockTimestamp=0` 不用作成交时间；跨分钟使用稀疏二分边界，允许多个块同秒，创世块时间 0 单独处理。P0 保存时间证据，持久化分钟索引由 P1 实现。
- 可选历史 state、StateView、WS、trace 失败单独报告；当前身份不因缺失部署历史而被冒充已验证部署。历史样本只证明已取到的区间，不能代表 P5 历史覆盖完成。
- 错误只保存分类，供应商 URL、headers 和原始错误正文不进入证据。成功 RPC 返回的链上公开数据保留原文。

## 依赖与证据再生成

```powershell
node scripts/vendor-abis.mjs
node node_modules/vitest/vitest.mjs run tests/unit/abi.test.ts
node scripts/source-evidence.mjs
```

ABI 来自固定版本的官方 artifacts，文件许可、哈希与上游版本记录在 `artifacts/p0/dependency-evidence.json`。官方部署地址与 AMC 当前资产表另见 `artifacts/p0/official-source-evidence.json`。GitHub commit API 不可用时该报告的 commit 为 null，保留所读取页面的时间与 SHA256，不虚构 commit。lp-terminal 仅作固定 commit 的只读设计参照，未引入其前端或钱包代码。

`pnpm test` 的真实 fixture 测试在本地已有捕获目录时执行，没有样本时明确 skip；测试通过不替代运行 probe/capture。真实样本与合成单测分离，首次未通过的实测也保留在 artifacts。

本目录原先没有 Git；P0 验收后按用户要求建立本地仓库，提交工程、设计文档与最终验收样本。已有 research、tooling、.agents、.pnpm-store 保留在本地，不纳入首次 P0 提交。较早失败实测的大体积原始日志也保留在本地。

构建只包含 src；CI 固定 Node.js 24 与 pnpm 11.19.0，执行冻结锁文件安装、脚本静态检查、typecheck、测试和构建。`node scripts/vendor-abis.mjs --verified` 会实际执行 ABI 测试，失败则不写 passed 证据。历史最终样本明确列入版本控制，其余采集默认忽略。证据路径的基准由 pathBase 声明，使用 POSIX 相对路径；历史迁移记录见 artifacts/p0/path-migration-2026-09-08.json。

### Review 修正后的运行策略

P0 `probe`/`capture` 仍为单次运行，最多 150 次 RPC、5 RPS、10 秒超时、2 次重试；通用配置允许较大值或 `maxRpcCalls: null`，但 P0 CLI 会保留这些验收上限。较小额度仍生效。`maxRangeBlocks` 限制主采集范围及补采分片；默认主采集取 min(300, maxRangeBlocks) 块。

`--evidence full|sampled|off` 默认 full。full 保留每条响应，默认每片 16 MiB、最多 8 片，满后明确失败而不覆盖旧证据；sampled 每 100 条保留一个完整响应，其余记录哈希，并滚动保留最近分片；off 不写请求证据。CLI 退出会等待异步落盘。sampled/off 不应被当作全量请求归档。

`pollIntervalMs`、`overlapBlocks` 为 P1 预留；`historyTimestampSec` 为后续历史范围入口预留；P0 使用逐池 `v4PoolHistoryHints`。`RH_RPC_WS` 尚不发起 WS 请求，`config/watchlist.amc.json` 留待 P1 动态池发现使用。底层 ReaderOptions 可配置并发和证据容量，P1 长跑策略尚未实现。

本轮 review 的全部编号、处理依据及验证边界见 [处理记录](docs/reviews/2026-09-08-p0-review-resolution.md)。

### 历史归档与当前源码

`node scripts/audit-p0-archive.mjs artifacts/p0/raw/2026-09-08T06-10-51-129Z/manifest.json` 只审计历史证据哈希，另写 `archive-audit.json`，不验证当前源码或当前链状态。旧 `p0-acceptance.mjs` 仅为兼容入口，不再覆盖历史 `acceptance.json`。当前源码用 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 独立验证；本轮结果与源码哈希见 `artifacts/p0/acceptance-followup-validation.json`。

新证据的路径基准统一为 `repository` 或 `artifact-directory`；读取保留旧别名兼容。`v4PoolHistoryHints` 可给出成对十进制 `fromBlock` / `toBlock` 提示，采集时会重新读取两端并验证第一个匹配块；无效提示输出 incomplete。当前配置中的两组紧界限来自已有真实归档，不把部署候选块当可靠下界。
