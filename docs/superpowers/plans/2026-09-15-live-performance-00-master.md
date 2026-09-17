# 实时性能修正 Implementation Plan（总入口）

> **For agentic workers:** 按 `superpowers:executing-plans` 逐任务执行；用户指定由DeepSeek实施。没有该技能时直接遵守本文清单，不安装技能、不因此停工；不要自动派子代理。

**Goal:** 修复R01–R07，让约8万历史池下的采集计算和网页可用，并提交可复核的离线证据。
**Architecture:** 目录增量索引、批次相关依赖、覆盖摘要、有界热池计算、后台metadata、worker网页快照。指标公式和通知边界保持不变。
**Tech Stack:** Node 24 / pnpm 11.19.0 / TypeScript / better-sqlite3 / viem / Vitest。
**Spec:** `docs/superpowers/specs/2026-09-15-live-runtime-performance-design.md`。

## Global Constraints

完整继承Spec第4节；必须先读Spec和Review，不能只读任务标题。用户授权本轮生成计划；以后DeepSeek收到实施指令才写代码。本轮交付没有已实施的任务。

可直接复制的实施提示词：[DeepSeek交接指令](2026-09-15-live-performance-deepseek-handoff.md)。

## 0. 执行规则

- 一次只做一个任务，按01→02→03→04→05顺序。每项先写失败回归、确认失败原因、最小修改、定向验证；通过后才勾选。每项列出的运行命令至少执行RED/GREEN两次（纯新增夹具的RED允许为模块缺失）；实现前保存RED输出，实现后保存GREEN输出。
- 每个子计划通过后作一次本地提交；不merge main、不push、不删除分支。原工作区不干净的文件全部保留。
- 一个子计划有失败先修这一部分，不同时修改别的子系统。遇到真实契约矛盾，记录文件/行号/反例和建议；不要凭感觉删校验。
- 禁止“把循环并行化”作为第一步；禁止提高timeout来掩盖慢；禁止只把测试变绿而跳过端到端路径。
- 任务未完成就如实列剩余项。不要把R05的离线实验实现写成已通过线上验收。

## 1. 工作区与基线（实施时执行）

原仓库：`E:\lp-monitor`，预期起点`6ed70d7`。先执行：

```powershell
Set-Location E:\lp-monitor
git status --short
git rev-parse HEAD
git branch --show-current
```

HEAD变化不自动回退：读新增diff，将兼容影响写入实施记录；若修改了本计划接口，先把具体冲突列出来。禁止reset/clean。

在独立worktree实施，避免build改写用户运行中的dist。推荐目录 `E:\lp-monitor\.worktrees\live-runtime-performance`，分支 `codex/live-runtime-performance`：

```powershell
git worktree list
git check-ignore .worktrees/live-runtime-performance
```

若worktree或分支已经存在，检查内容再复用，不覆盖。若`.worktrees/`未忽略，在原仓库本地`.git/info/exclude`追加`/.worktrees/`，随后：

```powershell
git worktree add .worktrees/live-runtime-performance -b codex/live-runtime-performance HEAD
```

本计划/Spec/Review当前是未提交文件，新worktree不会自动带入。只复制以下文档至worktree相同相对目录：本系列00–05文件、deepseek-handoff、对应Spec、对应Review。不要复制.env、运行数据库或整个artifacts。根据每个文件的绝对源/目标调用`Copy-Item -LiteralPath`，目标必须位于该worktree中。

```powershell
Set-Location E:\lp-monitor\.worktrees\live-runtime-performance
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
```

基线失败记录下来，区分与本改动关联；不得顺便大改旧问题。测试使用tmpdir生成库，已有tracked fixtures随git复制。

## 2. 子计划与依赖

| 顺序 | 文档 | 任务 | 产出 |
|---|---|---|---|
| 01 | [基础与小修](2026-09-15-live-performance-01-foundation.md) | A1–A4 | 尺度夹具、阶段计时、限流恢复、空池缓存修正 |
| 02 | [目录与存储](2026-09-15-live-performance-02-registry-storage.md) | B1–B6 | 注册增量、批次减重、覆盖摘要、旧格式兼容 |
| 03 | [实时计算与元数据](2026-09-15-live-performance-03-live-pipeline.md) | C1–C5 | 有界事件索引、热池评估、metadata单飞后台队列 |
| 04 | [网页读取](2026-09-15-live-performance-04-dashboard.md) | D1–D3 | 汇总与分页、只读worker、HTTP响应解耦 |
| 05 | [采集实验与最终验收](2026-09-15-live-performance-05-capture-acceptance.md) | E1–E3 | 默认关闭的Manager策略、离线等价与交接证据 |

共21个任务。任务内部包含更小步骤；不要把一个子计划当一个“大任务”直接重写。

## 3. Findings覆盖

| Review问题 | 实施任务 |
|---|---|
| R01网页 | D1–D3；B6覆盖读取；C1–C3限制计算输入 |
| R02限流恢复 | A3 |
| R03批次全目录 | B1–B6 |
| R04metadata | C4–C5 |
| R05全池RPC分片 | E1–E2；真实provider验证保留未执行状态 |
| R06目录比较/信号全池 | B1–B3、C1–C3 |
| R07滑动空池缓存 | A4、C1–C3 |
| 计时误导/规模缺口 | A1–A2、E3 |

## 4. 每项完成记录格式

实施者创建 `docs/reviews/2026-09-15-live-performance-implementation.md`，每项追加：

```markdown
### A1
- 状态：完成 / 未完成 / 有具体阻塞
- 修改文件：完整相对路径
- RED：命令、失败断言、为什么是原问题
- GREEN：命令、通过数量、退出码
- 行为差异：数值/状态/输出契约变化
- 性能：样本规模、预热、次数、p50/p95、结构计数
- 兼容性与未执行项：明确写出
- Commit：本子计划完成后补实际hash
```

不需要每项都跑整套测试。子计划结束跑相关回归；E3再跑全套及build/lint/typecheck。

## 5. 最终交给原审查者的材料

1. 分支名、基线和最终commit、每个子计划commit列表、`git diff --stat`。
2. A1–E3完成表，R01–R07解决位置。
3. 固定小样本的原实现与新实现逐批差异文件；不得只写“逻辑一致”。
4. 80k/160k规模报告，包括raw bytes、directory reads/serializations、估值次数、评估池数、阶段p95和内存。
5. 新旧库、崩溃恢复、reorg、metadata补齐、HTTP stale/分页版本一致性证据。
6. 明确未做：运行库迁移、现有进程重启、线上Manager切换、新RPC采样、两小时soak、merge/push。

完成后停在功能分支，等用户让原审查者Review；不要自行推进线上切换。
