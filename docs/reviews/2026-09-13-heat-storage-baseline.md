# H2 存储压缩与审计基线

日期：2026-09-13。本文记录 H2 的离线能力和复核边界，不把合成夹具结果当作真实全链容量预测。

## 已实现

- `payload_objects` 使用 SHA-256（未压缩字节）寻址、gzip 存储和 64 MiB 单对象解压上限。
- `readBatch` 同时读取旧 inline JSON 与 `batch-ref-v1`；缺对象、坏 gzip、长度/hash 不一致和未知格式均失败，不按空数据处理。
- 新 recorder 批次写 compact batch 引用；旧 `saveRaw` 仍保留，便于读取和比较旧数据库。
- `storage audit` 只读统计数据库、WAL、SQLite 表、inline payload、compressed objects、artifacts 和持久化 cursor 覆盖时长。
- `storage compact` 通过 SQLite backup 写新目标，转换完成并 checkpoint 后才发布；源数据库和源 WAL 不改写。

## 复核命令

```powershell
pnpm lp storage audit --db data/recorder.sqlite --artifacts artifacts/p1
pnpm lp storage compact --source data/recorder.sqlite --out data/recorder-compact.sqlite
node scripts/benchmark-heat-storage.mjs --out artifacts/benchmarks/heat-storage
```

benchmark 是重复 selector/evaluation 的 10,000-event 合成夹具，只验证编码差异和逻辑 hash；它不证明生产库、全天、全股票池或整链的 bytes/hour。真实容量必须使用固定 target、实际覆盖小时、重试/缺口和 WAL checkpoint 后的 audit 结果单独记录。

## 未运行项

本轮未执行 H5 实链 catalogue、历史补采或长时 follow；未购买第三方数据、连接钱包、交易或安装常驻服务。若 compact 失败，临时副本被清理，源库保持可用；目标已存在、源目标相同或源 batch 损坏时命令拒绝继续。
