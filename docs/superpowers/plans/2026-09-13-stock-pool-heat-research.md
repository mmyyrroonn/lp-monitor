# 股票池完整目录与热度研究 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本轮仅写计划；下一窗口收到实施指令后再编写代码。

**Goal:** 获得声明协议范围内的完整股票池目录，以较低存储成本构建有限历史研究数据，并用与实时一致的滚动窗口评估热度候选标准。

**Architecture:** 目录初始化、历史补采、实时跟随独立运行，共享经验证的事件、池身份与覆盖合同。内容寻址压缩减少重复写入；研究只读取固定快照并按时间拆分验证，不接实时通知。

**Tech Stack:** Windows/PowerShell；TypeScript strict ESM；现有 Node 24、pnpm、viem、better-sqlite3、zod、Vitest；压缩用 node:zlib，不新增服务。

**Spec:** [设计与全局合同](../specs/2026-09-13-stock-pool-heat-research-design.md)。执行前必须同时阅读设计与当前文件。

## Global Constraints

- 工作目录 `E:\lp-monitor`；计划基线 `main@c30048f`，执行时核对，不重置已有修改。
- 首版只覆盖配置中已核验的 Uniswap V3 Factory/V4 Manager；Pons 毕业前曲线、其他 DEX、整链归档不在首版范围。
- 默认 follow 保持 latest 启动，不自动全历史补采；实时普通批次保持增量、有界窗口。
- 不完整范围不推进 accepted cursor；缺口/未知/未计价不写零；股票共池双归因、池事件单份。
- 复用现有全局 5 RPC/s、并发 2、历史 1 RPC/s 上限；不擅自提额，不新增自动备用 RPC。
- 数据结构无损保存 bigint；哈希基于规范未压缩字节；旧证据不覆盖、不清理。
- 新格式先完成全部消费者兼容再启用；旧 readonly DB 不执行迁移。
- 研究使用滚动 `(T-duration,T]` 的 1m/5m/15m/1h；不可判断边界仍为 unknown。
- H1–H4 只要求代码与离线验收；H5 实链运行需用户在新窗口明确安排目标范围及预算。
- 不自动改线上阈值、不买第三方数据、不连接钱包、不交易、不安装常驻服务。

## 执行顺序与拆分

以下三个子计划按依赖顺序执行。它们共享上面的设计合同，每个任务均有独立测试与交付边界。

| 阶段 | 子计划                                                  | 交付                                                 | 完成状态   |
| ---- | ------------------------------------------------------- | ---------------------------------------------------- | ---------- |
| H1   | [目录与恢复](2026-09-13-stock-pool-catalogue.md)        | 版本化股票快照、独立目录命令、临时故障等待续跑       | [ ] 未实施 |
| H2   | [存储压缩与审计](2026-09-13-heat-storage.md)            | 压缩引用、兼容读取、离线紧凑副本、字节分解报告       | [ ] 未实施 |
| H3   | [历史与研究 Task 1](2026-09-13-heat-history-study.md)   | 持久、有预算、可恢复的独立历史作业                   | [ ] 未实施 |
| H4   | [历史与研究 Task 2–3](2026-09-13-heat-history-study.md) | 原生回放导出、滚动回放、可配置时间验证               | [ ] 未实施 |
| H5   | 本文有界实测流程                                        | 实际目录、一天级资源基准、14–28 天候选数据、研究报告 | [ ] 未运行 |

H1–H4 完成不改变原 P5/P6 实测验收状态。若用户仅点名 H1，则只实施 H1；若用户说“实施这份计划”，完成 H1–H4 工程并交接 H5，不自行启动多日采集。

## H0：执行窗口开始时的检查

- [ ] 读本主计划、设计和即将执行的子计划；核查当前 checkout、可能新增的 AGENTS.md、最新 migrations 编号。
- [ ] 保存已有脏文件名单，不提交 `artifacts/p1/2026-09-13T*/` 原有运行证据。
- [ ] 获取基线测试结果，并根据实际差异调整路径/接口；调整要写入计划，不能跳过设计合同。

```powershell
git status --short
git rev-parse --short HEAD
git branch --show-current
rg --files --hidden -g AGENTS.md -g '!node_modules' -g '!.git'
pnpm typecheck
pnpm test
```

基线失败先辨别原有问题与新增问题。执行阶段可按工作区规则选择隔离分支/工作树；本次文档任务没有创建分支、提交或合并。

## 文件职责总图

| 区域        | 现有入口                                                | 计划新增职责                                                     |
| ----------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| 资产/池目录 | `src/registry/assets.ts`、`pools.ts`                    | `stock-snapshot.ts`；不可变资产版本及差异                        |
| 目录任务    | `src/ops/recorder.ts` 内 bootstrap                      | `src/ops/catalogue.ts`、`catalogue-cli.ts`；固定 head 目录与恢复 |
| 失败恢复    | `src/rpc/errors.ts`、`src/ingest/fetch-range.ts`        | `src/ingest/discovery-recovery.ts`；保留失败类别、批次退避       |
| 存储        | `src/storage/raw-store.ts`、`manifest.ts`               | `payload-store.ts`、`batch-codec.ts`；压缩对象与兼容解码         |
| 磁盘证据    | `src/ops/report.ts`、`runtime-telemetry.ts`             | `storage-audit.ts`；DB/WAL/artifacts 分类计量                    |
| 历史任务    | `src/ops/history.ts`                                    | `history-job.ts`、`src/storage/history-jobs.ts`；持久队列及续跑  |
| 数据集导出  | `src/replay/reader.ts`                                  | `src/replay/export.ts`、`export-cli.ts`；源快照与批次证明        |
| 研究        | `src/replay/runner.ts`、`experiments.ts`、`outcomes.ts` | `study-config.ts`、`rolling-replay.ts`；新口径与时间隔离         |

新 migration 按执行时下一个空闲编号创建。现有 `src/storage/database.ts` 使用显式 migration 清单，新增 SQL 时同步接入；构建复制也要核查。

## H5：代码完成后的有界实测流程

本节是后续运行说明，不是本窗口或 H1–H4 的自动命令。每次实链运行固定 DB/output、from/to 或 target anchor、duration、maxRpcCalls，先展示清单。用户在执行窗口给出运行安排后，不为同一已授权运行重复确认。

### H5.1 目录范围与资源基准

- [ ] 核查官方股票列表、V3/V4 部署和 RPC 能力，保存响应、时间与 hash；协议/名单范围写入 catalogue 报告。
- [ ] 固定一个 targetAnchor 执行目录任务；若预算耗尽，保留 job/progress，不能标 complete。
- [ ] 目录覆盖到 target 后列出每只股票的登记池数、协议分布、unknown/excluded；已有池数不是活跃池数。
- [ ] 先计划一个 UTC 日的历史范围及前后文，用完整区间测资源；若单次预算不能完成，续跑同作业，不按部分结果外推整日。
- [ ] 输出实际 RPC/覆盖小时、原始事件 bytes、DB 增量、WAL、索引、外部文件、耗时、峰值内存、失败与重试。比较早期/近期、忙/闲区间，不只选空区间。

退出条件：目录与至少一个代表性时间段覆盖可证明，或明确列出阻断缺口。未覆盖完整一天时资源预测必须带 coveredSubset，不能给“全天平均”。

### H5.2 研究数据集

- [ ] 初版建议最近 14 天，按需扩展至 28 天；具体 UTC/区块界限在执行时冻结，禁止配置里写相对 now 后不断移动。
- [ ] 纳入该协议/资产范围内的全部池，包括冷池、零活动池、期间新生和已冷却池；若抽样，先固定分层与随机种子，并保存入选概率/偏差说明。
- [ ] 保留 180 分钟前文及 180 分钟结果上下文，检查跨拆分边界时的前视隔离。
- [ ] 生成数据集 manifest 和缺口/报价/时间质量报告；缺失当时名单时显式 retrospective-cohort。
- [ ] 训练区只生成候选阈值；冻结候选后在验证区和保留测试区评估。最后另安排前向观察，不自动投递真实提醒。

### H5.3 研究验收

- [ ] 报告每个分层的池数、独立热点 episode 数、有效覆盖、未计价和右截尾比例。
- [ ] 给出候选规则的提醒数/日、同热点重复率、持续活跃情况、后续 15/60/180 分钟结果分布。
- [ ] 比较简单绝对量、相对倍数、量与持续性组合；小网格优先，测试集不用于反复选参。
- [ ] 将置信/不确定性按池或股票、日期聚类说明；不能把相邻滚动窗口当独立样本凑数量。
- [ ] 输出“候选有效 / 尚无充分证据 / 样本不足”，不输出 LP 收益证明；默认线上阈值保持原值。

## 全阶段验证与报告

每个实现任务先写具体回归，再做最小实现。阶段末运行相应子计划的定向测试；H1–H4 集成完成后执行下面检查，实际结果写入 `docs/reviews/2026-09-13-stock-pool-heat-research-acceptance.md`（执行日期变化时使用真实日期）。

```powershell
pnpm typecheck
pnpm test
pnpm lint
pnpm build
git diff --check
```

预期全部退出 0。报告必须分开列代码验证、离线等价性、存储效果、目录实测、历史实测和阈值效果；没有运行的项写“未运行”。每个子阶段可形成单独提交；提交/合并遵循执行窗口的用户指令，不把计划中的分阶段边界当作自动合并授权。

## 新窗口可直接使用的提示

```text
在 E:\lp-monitor 阅读 START_HERE.md 顶部的 2026-09-13 新计划入口，以及
docs/superpowers/plans/2026-09-13-stock-pool-heat-research.md
和它引用的设计、子计划。
按 H1 → H2 → H3 → H4 顺序实施代码和离线验证，每阶段更新状态。
保留已有数据与未提交文件，不启动 H5 长时间实链采集、不安装服务、不改线上阈值。
完成后汇报代码/测试/存储效果，并给出 H5 的具体范围和预算安排。
```

若只想先完成目录与 RPC 恢复，把上面的阶段范围改为“只实施 H1”。
