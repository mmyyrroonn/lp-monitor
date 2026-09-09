# P4 本机提醒验收

状态：**passed**。最终539个测试全部通过，lint/typecheck/build及离线验收退出0；独立审查无未解决问题。范围仅 P4，P5/P6 未开始。

## 实现范围

- 纯规则引擎读取新鲜 P3 业务结果；不读取裸 metric_windows 缓存。起始配置为本分钟20k/历史60桶5倍、自然完整5m100k/历史12桶5倍、连续两根自然5m各50k。两条确认规则保留独立命中结果。
- 新池在出生分钟的完整已扫前缀内可输出已观测partial成交并发候选；出生前及闭合后的不完整出生分钟仍为warming/null，不填入基线。为绑定此P4所需语义，metric version升至p3-v3。
- 金额保持 bigint；相对基线只使用先前完整、同尺度同单位的桶。样本不足或中位数零保留 null，未计价原币不套 USDG 阈值。本分钟候选标 partial。
- 同级300秒冷却；同口径翻倍升级与再热绕过冷却；连续三根完整自然5m低于原进入阈值25%才降温。缺口中断降温计数，不注销池。候选期间的冷却状态仍保留再热资格。
- 在 --notify local 模式，范围有效集合、P2重建、P3读取、信号快照和outbox同事务；事务外顺序写本机JSONL与控制台。默认follow只记录。
- 提醒绑定池、规则配置hash、episode、kind、批次、扫描锚点、P2/P3来源hash与事件证据；同ID使用递增revision。成功/失败/待发送/已被新修订替代均保留，失败计attempt，恢复后可重试。
- 历史输入/时间/分钟覆盖/登记或配置修正后，保守撤回依赖受影响历史的provisional提醒并重新评估当前状态。完整scope恢复时先撤回，再校验登记；即使暂时没有下一批或accepted tip也保留撤回。不是P5精确历史策略回放。
- 启动时先校验旧操作锚点；旧历史评估标backfill，不自动升级为实时提醒。已有live提醒的撤回保留live资格。普通backfill/synthetic不进入实时sink。
- 通知只支持本机控制台及数据库路径旁的JSONL；无email/webhook/聊天配置。文件写完、sent落盘前崩溃仍可能重复，消费者以id/revision识别。尚未发送的旧修订被新修订替代后不会发送。

## 验收证据

- [机器验收](../../artifacts/p4/acceptance.json)
- [历史库保护](../../artifacts/p4/source-db.json)
- [历史评估](../../artifacts/p4/historical-alerts.json)
- [合成提醒JSONL](../../artifacts/p4/alerts.jsonl)、[可读示例](../../artifacts/p4/rendered.txt)
- [可复算脚本](../../artifacts/p4/verify-acceptance.mjs)
- [独立审查](2026-09-09-p4-review.md)

使用SQLite online backup从P3验收库复制到data/p4-acceptance.sqlite，逐表比较P1内容hash并确认源库不变。历史输入仍是1827个登记池、603笔Swap、34笔未计价、29个闭合分钟。本轮历史样本没有触发提醒；不能由此判断阈值预测能力。历史评估observedAtMs=0是显式离线标记，不伪造实际到达时间。没有新增RPC。

合成序列经过同一evaluateSignal核心及SQLite outbox，覆盖候选、热度确认、10秒冷却内升级、降温、再热和撤回。liquidity-watch只有独立标注的格式示例，没有臆造自动触发阈值；实际加减动作及最近Swap的L作为附注，不能解释为已验证撤资金额或LP收益。

## 运行与限制

```powershell
pnpm lp follow --config config/robinhood.json --duration 10m --notify local
pnpm build
node artifacts/p4/verify-acceptance.mjs
```

首次命令会使用本机RPC环境并进行有时限采集；本轮未执行公共RPC实跑。可指定 --signals config/signals.initial.json 与 --metadata config/metric-metadata.json。本机JSONL默认是 --db 指定路径加 .alerts.jsonl。

沿用2秒轮询配置。P4启用后每批全scope P2/P3复核与同步JSONL写盘增加处理时间，尚未证明实际2秒端到端延迟或长期运行负载；有界实链验证属于P6。P5历史队列/阈值效果、P6实时故障验收均保持pending。

基线是0c2e2e1、477个通过测试；旧P3文档453是先前时点。本轮无依赖/lockfile/ABI变更，没有交易、钱包连接、永久服务、提交或推送。
本机投递失败保存在outbox并等待后续重试；采集退出码仍描述采集结果，不能单凭退出0断言所有提醒已写出。

## 最终检查

| 命令 | 结果 |
|---|---|
| pnpm lint | 退出0；首次发现两个新文件格式问题，已修复复跑 |
| pnpm typecheck | 退出0，含scripts类型检查 |
| pnpm test --reporter=json --outputFile=artifacts/p4/tests.json | 退出0；539通过、0失败、0跳过 |
| pnpm build | 退出0 |
| node artifacts/p4/verify-acceptance.mjs | 退出0；原库保护、历史评估、10条合成展示记录 |
| git diff --check | 退出0 |

[逐项检查](../../artifacts/p4/verification.json)、[全量测试](../../artifacts/p4/tests.json)。原有上游SDK source-map缺源提示保留；没有隐藏测试失败。独立审查发现的升级、历史/当前覆盖修订、provenance重复、异步被替代记录复活、登记恢复中断漏撤回均已修复并回归。最终source/build哈希绑定在acceptance.json。