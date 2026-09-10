# P5 离线回放与热度研究验收 — 2026-09-10

结论：**本轮正确性修复与回归检查通过；P5 仍有未完成能力，完整历史评估 incomplete，阈值有效性未验证。** 原生 P1 导出入口和长窗口增量处理尚未实现，不能将本次结果概括为 P5 全部通过。

## 独立 Review 处理

原始意见保留在 [独立 Review](2026-09-10-p5-independent-review.md)，前轮 [审查记录](2026-09-10-p5-review.md) 的通过结论已明确撤回。

| 意见 | 本轮处理 |
|---|---|
| C1 | 按异常类型识别可恢复的投影缺口；中间未接纳批次和区块缺口返回 incomplete，保留 projection-input-incomplete 和合并缺片问题 |
| I1 | minute-close 复用告警提交语义；同 payload 忽略、变化递增 revision。replay.alerts 保留每个 id 的最新记录，alertRevisions 保留修订；实验按 id 的首次告警计身份数和结局 |
| I2(a) | 校验原生摘要 manifestHash、日志数、区块范围和 completeness；缺 SHA256 显式 artifact-hash-unavailable，导出再回放不补成完整证据 |
| I2(b) | 采用 Review 允许的文档处理：标明原生 manifest 不能直接评估，退回对应 Task 5.1 验收复选框；导出入口未实现 |
| I3 | 采用 Review 允许的限制披露：保留可复现基准和实际耗时；增量投影/计价未实现，多天完整队列性能未验收 |
| I4 | 单根确认未达标使用 no-complete-above-threshold；省略 buckets 时仍保持原有双根逻辑 |
| M1 / M4 | 明确真实产物为零条告警/结局/首告警对比；未实现的 1M/500k 事后标签退回未完成 |
| M2 | delay=0 含发报当分钟，最多计入发报前 59 秒；delay=1/5 为主分析，0 仅作敏感性对照 |
| M3 / M5 | 删除 readChunkSize 和恒等切片断言；补缺失产物、哈希、未接纳、投影缺口、重叠范围及覆盖上限回归 |
| M6 / M10 | 队列增加逐池 historyComplete，并与实际覆盖求交；统一 as-of / retrospective-cohort；快照可用时间不晚于队列起点才可标 as-of，晚到快照回退 retrospective；保留发现分母、死亡池与 censored 状态 |
| M7 / M11 | 按目标分钟判断 coverage；发现 scope 也检查分钟索引，缺口不能显示完整 |
| M8 | 区间外告警不计入探索/验证计数与结局，暴露时间使用评估区间的交集 |
| M9 / M12 | README 区分离线数据不完整与在线 RPC 预算退出码 4；注明显式 buckets=2 会改变配置 hash、状态与告警身份 |

## 实际验证

| 命令 | 退出码 | 证据 |
|---|---:|---|
| pnpm typecheck | 0 | [typecheck.log](../../artifacts/p5/typecheck.log) |
| pnpm lint | 0 | [lint.log](../../artifacts/p5/lint.log) |
| pnpm exec vitest run --reporter=json --outputFile=artifacts/p5/tests.json | 0 | [649/649 测试](../../artifacts/p5/tests.json) |
| pnpm build | 0 | [build.log](../../artifacts/p5/build.log) |
| pnpm lp study --cases config/history.cases.json --grid config/signals.grid.json --out artifacts/p5 | 4（预期数据不完整） | [研究报告](../../artifacts/p5/report.md)、[results.json](../../artifacts/p5/results.json) |
| node artifacts/p5/verify-acceptance.mjs | 0 | [acceptance.json](../../artifacts/p5/acceptance.json) |
| node artifacts/p5/benchmark.mjs | 0 | [benchmark.json](../../artifacts/p5/benchmark.json) |
| git diff --check | 0 | [verification.json](../../artifacts/p5/verification.json) |

本轮共 649 项通过，0 失败、0 跳过。前轮为 623 项；测试数量本身不代表功能验收。已有第三方 sourcemap 警告和故障注入测试 stderr 保留于日志。构建后 CLI 验收使用合成输入检查实录原批次、可移植再次回放与分钟关闭模式；实际 businessHash 一致性属于工程证据，不是历史实录或策略收益证明。reader 整份读取 JSON，没有实现流式读取。

## 真实运行结果

默认 study 只读四份本机 P1 manifest，全部是 2026-09-08 的短录制，与七个案例的 09-03 至 09-07 核心区间不重叠。它们还缺少 replay.input 历史快照，因此原生回放产生 0 个评估帧。部分源存在未接纳尝试或修订顺序不足，缺失证据全部保留。

**本次运行未产生任何告警、结局窗口或首告警对比记录，这些能力仅由合成 fixture 测试覆盖。** 七个案例均 unavailable；四份 cohort 的 observedBirthCount 均为 0，完整分母为 null。36 组参数全部披露，告警率和结局不填零，不选冠军。MEME 同币跨期成员身份仍单列；命名案例不进入出生队列总体分母。没有完整成本、历史仓位和无常损失模型，不输出 LP 净收益。

## 尚未完成与性能限制

原生 P1 manifest 当前不可直接评估，需要包含历史资产/配置/metadata 及可用时间的导出步骤；仓库尚无从 P1 库与运行摘要生成 replay.input 的入口。不能以今天登记表或元数据冒充过去已知。使用当时快照可标 as-of；当前登记表筛历史样本须标 retrospective-cohort。1M/500k 事后 episode 描述标签也未实现，计划复选框已退回。

minute-close 每分钟仍接纳整个历史前缀、全量重建投影并重新计价，规模扩大时耗时明显超线性。以下为本机实际单次测量：一个池、单批次、每分钟一条合成 Swap；包括读取/校验/投影/计价/规则/hash，不包括样本生成及报告文件输出。

| 分钟 / 帧数 | 本轮修复后耗时 ms | 每帧 ms |
|---:|---:|---:|
| 60 | 740 | 12.33 |
| 120 | 2939 | 24.49 |
| 240 | 14890 | 62.04 |
| 480 | 80347 | 167.39 |

环境：Node v24.5.0 / Windows x64；各次计时带实现 hash，见 [基准 JSON](../../artifacts/p5/benchmark.json) 和 [可复现脚本](../../artifacts/p5/benchmark.mjs)。修复前本机测得 60/120/240/480 分钟分别为 716/2894/14591/79696 ms，见 [修复前基准](../../artifacts/p5/benchmark-before-review-fixes.json)。这些单次数字不是性能保证；没有实测四天队列，不将外推时间当已验证结果。

覆盖历史上限 10080 分钟只是数据结构允许的范围；超过上限显式 incomplete，在上限内也不等于性能可用。长窗口增量处理仍待后续实现。操作范围重叠且修订顺序不明时保守 incomplete；不声称精确重演修订历史。

研究区间末端恰好发报的分钟仍按区间外处理，可能使端点暴露量保守地保持 incomplete；没有改变分钟时间公式。发现分母只豁免已明确属于操作 scope 的分钟边界缺口，其他产物、投影或未知来源问题仍可使分母为 null。

最终独立复核已关闭全部发现，需求符合与代码质量均通过本轮修复范围；见 [复核与关闭记录](2026-09-10-p5-review-fixes.md)。

## 交接

验收时位于 codex/p5-history，尚未提交；后续提交合并状态以 Git 记录为准。保留开始时已有的六份文档修改；默认实时信号配置、链配置、ABI、依赖和 lockfile 未改。无新 RPC 采集、交易、通知、部署、P6 或定时任务。P5 完整历史评估仍不作为 P6 前置；未完成能力已明确保留，不用合成测试替代真实输入。
