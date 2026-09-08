# P0 复验遗留处理（2026-09-08）

基线：be8d44f。来源：[CC 修复验收](2026-09-08-p0-review-acceptance.md)。本轮只处理复验遗留，P1 store/follow/恢复未开始。

| 编号 | 结果与证据 |
|---|---|
| R1 | 错误路径落盘失败通过 RpcFailure.evidenceFailure 保留，原 RPC 分类与重试次数不变；恢复后若全量证据仍写失败，不返回成功。CLI 关闭不覆盖主错误，也不会创建自引用错误；已输出 incomplete manifest 时保留退出码 4。capabilities 与范围拆分遇到附带证据失败的 range-limit 不再继续拆分；manifest 同时记录主错误与证据失败。真实写目录失败、容量耗尽、429/503/非重试错误、成功恢复后证据失败及 CLI 路径均有回归。 |
| R2 | resolver 只回调新观测，capture 不再每区间遍历累计 getter；一致的 number/hash/timestamp 版本只记录一次，冲突版本保留。回归原为 861 条/205 唯一区块，修复后稳定场景条目数等于唯一块数；重组场景仍保留同块不同 hash 并明确 incomplete。新 anchor 仍需时间一致性校验，未将 P0 内存缓存冒充 P1 持久化索引。 |
| R3 | hint 支持成对 fromBlock/toBlock，运行时强制重读两端并验证时间夹取及 predecessor。当前两枚 seed 分别使用归档真实锚点 53983884–53983885、53697162–53697163，来源与 hash 见 seed-hint-bounds.json。错误/过期界限明确 incomplete；未配置界限时用已验证缓存，证据不足仍回落 genesis/latest，不盲用未验证 deploymentCandidateBlock。配置版本更新为 2026-09-08.p0-review2；没有改写旧 capture 的 configHash。 |
| R4 | 原“后遍历小块使 low 回退”不成立：旧循环已过滤 number<low 或 number>high。增加乱序缓存测试，并显式 max/min 表达取更紧边界。 |
| R5 | parseRpcQuantity 移至 rpc/quantity.ts，删除 domain/hex.ts；domain 不再导入 RPC 错误类。 |
| R6 | 删除 EvidenceReader.anchors、实际空 Map 及 fake reader 字段；真实缓存由 resolver 管理。 |
| R7 | 两条完整 probe/capture 编排成功用例真实执行解码、验证、文件输出并返回 0（使用模拟 RPC，不是 --help）；client HTTP 429 后惩罚与连续成功回基线；原生币零地址排序及 SDK 对照；实际 RequestMeter 配额 1/3/7 下拆分发出请求数不超限。 |
| R8 | 补归档 V3 Swap 的 amount0=-186644829477990813964、tick=-266716 精确断言，与 ethers Interface 独立解码一致。上一轮处理记录的“已涵盖解码负值”确属不实，已删除旧陈述并添加更正说明，不能把本轮新增测试倒算成上一轮覆盖。 |
| R9 | 选择历史封存方案：audit-p0-archive.mjs 明确输出 historical archive audit / currentSourceValidation:not performed，只核对保留的历史哈希；结果另存 archive-audit.json，不覆盖原 acceptance.json。旧 p0-acceptance.mjs 是带提示的兼容入口。本轮当前源码另行实跑检查，保存源码快照哈希且确认检查期间源码未变。 |

其他小项：

- lint 不再在内部调用 pnpm，避免 corepack 调用时缺少全局 pnpm PATH 导致失败。
- 新证据统一 pathBase 为 repository / artifact-directory，读取兼容 manifest-directory / report-directory。历史 identity 使用带 SHA256 的路径元数据侧车，保持原文件与历史验收哈希不变；测试验证侧车和原文件篡改会失败。
- sampled 计数只推进含 result 的成功记录，错误记录不改变成功采样节奏。
- 低链高探测不请求负块号或未来块；范围报告给出实际 testedBlocks。创世单块不能验证范围拆分一致性时明确 unknown，不假装完成该能力。
- full/sampled/off 名称已纠正。

## 本轮验证

- 18 个测试文件，188 个用例通过，0 失败。
- lint、typecheck（含脚本）、生产 build、历史归档审计、git diff --check 均退出 0。
- [当前源码验证](../../artifacts/p0/acceptance-followup-validation.json)绑定[源码与测试快照](../../artifacts/p0/acceptance-followup-source-snapshot.json)；[本轮测试报告](../../artifacts/p0/acceptance-followup-tests.json)独立于历史 60/149 用例记录。
- [历史归档审计](../../artifacts/p0/archive-audit.json)只证明留存归档自洽。更换当前配置、源码不能让这个历史结果代表当前实现通过。
- [种子界限来源](../../artifacts/p0/seed-hint-bounds.json)为历史提示，需要运行时复验；本轮未重新采集公共 RPC，不声称验证了新的实时链状态。
- 远端 CI 未运行，未开始 P1。下一步仍为 P1 Task 1.1，后续实链分钟索引验收需明确跨 3–5 分钟。
