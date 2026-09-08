# P1 第二轮 recorder 审查处理 — 2026-09-08

基线提交：6f2bc6835e3df725d06f7541cb7b74ad5c2f3282。四条反馈均已处理，本轮仅做本地验证，未重新调用公共 RPC。

- Manifest 写入：捕获写入失败，保留已有 RPC/预算/不完整结果的退出码 3/4；原成功结果改为失败并退出 1。单独输出脱敏 manifest-write 分类，finished.manifest 为 null。数据库仍可写时更新最终失败状态；数据库和 manifest 同时失败也不覆盖原有分类。
- Hash 比较：bootstrap 与 follow 一致忽略 hash 大小写，避免仅大小写差异触发恢复。
- Reader 包装：getLogs 经原 reader 调用，保留依赖 this 的方法接收对象。
- Raw identity：fetch-range 删除本地重复定义，复用 storage/manifest 的规范 rawLogKey。

验证：新增 8 个回归用例先复现失败，再修复通过。覆盖正常成功、不完整发现、RPC 身份失败、预算、期限、数据库与 manifest 同时失败，以及大小写差异和 reader 接收对象。

最终全库 281 测试通过，0 失败、0 跳过；typecheck/test/build/lint 均退出 0。最后一次修改仅为测试 this 类型标注；之后重跑 typecheck/test/lint，生产构建保持已验证版本。运行输出与完整测试 JSON 仅保存在系统临时目录，不纳入 Git。

原 P1 实链验收与其源码哈希仍是历史记录，不将其覆盖成这次修复的实链验证。

本次最终源文件 SHA256：

- src/ops/recorder.ts: d9a84a5dfbe8bb36bf3fd921b94e48108662c614b84aa4c13497825561f005c5
- src/ingest/fetch-range.ts: 7846a74ba3a0ca65cb18b6603908ba78d48bb76f190d50666bd32618997ec14e
- tests/integration/recorder.test.ts: d2c40efa6a35a0bef685954e863a02bccb509ec5f5f346016fa5267c8654024e
