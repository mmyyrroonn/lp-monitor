# 交给 DeepSeek 的实施指令

把下面整段交给DeepSeek。实施入口是00-master；不要只发此前Review或单独一个性能数字。

```text
请实施 E:\lp-monitor 的实时性能修改计划。

先读取：
1. docs/superpowers/plans/2026-09-15-live-performance-00-master.md
2. docs/superpowers/specs/2026-09-15-live-runtime-performance-design.md
3. docs/reviews/2026-09-15-live-runtime-performance-review.md
然后按总计划顺序读取并执行01–05子计划。

要求：
- 从总计划的工作区隔离开始，在独立worktree/功能分支做。
- 当前任务是实施已写好的计划，按A1–E3共21项依次执行。
- 一次只处理一个任务；逐个勾选子步骤，先失败回归再实现，再运行指定测试。
- 每项都记录修改文件、RED/GREEN证据、实际计数、未通过项；每子计划通过后本地提交。
- 不重写窗口/信号公式，不省略unknown/gap/reorg/metadata锚及事务回滚测试。
- 不能仅把代码移到worker或提高超时就宣称性能问题解决。
- 所有新模块要接入真实调用路径；不能只导出一个未使用的优化函数给单测调用。
- 不动原工作区运行中的follow/dashboard、.env、实际config或data数据库。
- 不发起新的真实RPC采样；V4 Manager只做默认关闭的离线实验。
- 不merge main、不push、不删除分支；完成后等原审查者Review。
- 如果没有superpowers技能，直接遵守文档清单执行，不安装技能、不因此停工。

遇到当前代码与计划不一致：先检查实际类型和调用点，记录具体差异。
可以调整内部命名和适配签名，但不能改变业务约束、测试期望或性能门槛。
若出现算法/范围/事务语义冲突，保存最小反例和未完成任务，不自行删保护逻辑。
不要把计划里新增的类型误认为仓库已存在；按对应任务创建并补齐import。

完成后交付：
- worktree、branch、base/head和各阶段commit。
- docs/reviews/2026-09-15-live-performance-implementation.md
- docs/reviews/2026-09-15-live-performance-acceptance.md
- docs/reviews/2026-09-15-v4-capture-experiment.md
- 小样本逐批旧/新结果差异文件、80k/160k性能原始样本、测试命令与退出码。
- R01–R07解决位置及所有未达标项；真实provider、运行库迁移和生产切换仍未执行。
```

## 建议执行节奏

五个子计划分别是可以提交、检查和恢复的阶段。上下文不足时，每完成一个阶段保存实施记录；新窗口读00-master、Spec、实施记录、当前子计划及其依赖接口后继续，不凭压缩摘要重新设计。

| 阶段 | 任务 | 必须先拿到的结果 |
|---|---|---|
| 01 | A1–A4 | 合法规模夹具、真实计时、限流恢复、空池缓存回归 |
| 02 | B1–B6 | 无逐批全目录处理，小批次及旧格式/证据兼容 |
| 03 | C1–C5 | 热池工作集、依赖失效、后台metadata、状态机等价 |
| 04 | D1–D3 | 小汇总、真实分页、只读worker、慢任务下HTTP响应 |
| 05 | E1–E3 | 离线采集实验、全套验证、80k/160k验收报告 |

当前交付仅为计划。表格不是已完成清单；实施者必须用实际测试结果填写完成状态。
