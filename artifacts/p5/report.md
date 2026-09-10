# P5 离线热度研究

状态：**incomplete**。现有阈值尚无足够独立验证证据；报告不证明 LP 净收益。

数据覆盖、命名案例与完整出生队列分列；没有数据的结果保持 unknown。

## 数据来源

| 本机 manifest | 状态 | 问题 |
|---|---|---|
| ../artifacts/p1/live/runs/2026-09-08T10-10-37-716Z-a18cd161/manifest.json | incomplete | artifact-hash-unavailable (88); unaccepted-batch (30); input-snapshot-missing (1); minute-boundary-missing (1); log-time-unresolved (1827); no-evaluable-frames (1) |
| ../artifacts/p1/live/runs/2026-09-08T10-29-50-452Z-0327f833/manifest.json | incomplete | artifact-hash-unavailable (35); unaccepted-batch (1); revision-history-unavailable (1); input-snapshot-missing (1); minute-boundary-missing (2); no-evaluable-frames (1) |
| ../artifacts/p1/live/runs/2026-09-08T10-37-00-932Z-b5217f30/manifest.json | incomplete | artifact-hash-unavailable (18); revision-history-unavailable (1); input-snapshot-missing (1); minute-boundary-missing (2); no-evaluable-frames (1) |
| ../artifacts/p1/live/runs/2026-09-08T10-39-47-703Z-89fdf338/manifest.json | incomplete | artifact-hash-unavailable (2); revision-history-unavailable (1); input-snapshot-missing (1); minute-boundary-missing (2); no-evaluable-frames (1) |

## 固定案例

| 案例 | UTC 核心区间 | 状态 |
|---|---|---|
| amc-meme-launch | 2026-09-04T03:25:00Z 至 2026-09-04T09:25:00Z | incomplete |
| meme-early-and-reheat | 2026-09-03T20:30:00Z 至 2026-09-04T12:00:00Z | incomplete |
| meme-large-reheat | 2026-09-06T17:00:00Z 至 2026-09-06T23:00:00Z | incomplete |
| 06_cyberbeer | 2026-09-07T04:21:00Z 至 2026-09-07T10:21:00Z | incomplete |
| 03_WET | 2026-09-06T20:38:00Z 至 2026-09-07T02:38:00Z | incomplete |
| 04_MUSCLE | 2026-09-06T20:35:00Z 至 2026-09-07T02:35:00Z | incomplete |
| 08_GEEG | 2026-09-04T02:29:00Z 至 2026-09-04T08:29:00Z | incomplete |

## 出生队列与再热样本

各队列列出来源中的 cohortMode；使用当前登记表筛选历史时为 retrospective-cohort。池没有成交也保留。独立链上覆盖验证：false。
- ../artifacts/p1/live/runs/2026-09-08T10-10-37-716Z-a18cd161/manifest.json（retrospective-cohort）：观测出生池 0，完整分母 unknown，出生时间未知 0，既有池 0。
- ../artifacts/p1/live/runs/2026-09-08T10-29-50-452Z-0327f833/manifest.json（retrospective-cohort）：观测出生池 0，完整分母 unknown，出生时间未知 0，既有池 0。
- ../artifacts/p1/live/runs/2026-09-08T10-37-00-932Z-b5217f30/manifest.json（retrospective-cohort）：观测出生池 0，完整分母 unknown，出生时间未知 0，既有池 0。
- ../artifacts/p1/live/runs/2026-09-08T10-39-47-703Z-89fdf338/manifest.json（retrospective-cohort）：观测出生池 0，完整分母 unknown，出生时间未知 0，既有池 0。

## 全部参数组合

金额门槛为美元估值，内部使用 USD micros。1m 候选沿用 P4 的绝对量与相对倍数规则；基线未就绪保留 absolute-only 标签。5m 使用 1/2 根绝对量确认，关闭并行的相对 5m 确认，避免绕过确认根数。默认实时配置未调整。

| 组合 | 1m USD | 倍数 | 5m USD | 根数 | 同级冷却 | 状态 | 通知数 | 每小时通知 |
|---|---:|---:|---:|---:|---:|---|---:|---:|
| 92a04d634c1edbaa | 10000 | 3 | 50000 | 1 | 300s | incomplete | unknown | unknown |
| 2794064f0e6eb7d7 | 10000 | 3 | 50000 | 2 | 300s | incomplete | unknown | unknown |
| f337bbf78e4a49e4 | 10000 | 3 | 100000 | 1 | 300s | incomplete | unknown | unknown |
| 1991fd98c810d819 | 10000 | 3 | 100000 | 2 | 300s | incomplete | unknown | unknown |
| 059c4a25da944bdc | 10000 | 5 | 50000 | 1 | 300s | incomplete | unknown | unknown |
| 2ce6371908b84c4b | 10000 | 5 | 50000 | 2 | 300s | incomplete | unknown | unknown |
| 7d8897742cc2aa5f | 10000 | 5 | 100000 | 1 | 300s | incomplete | unknown | unknown |
| 636d2242196a1dbb | 10000 | 5 | 100000 | 2 | 300s | incomplete | unknown | unknown |
| 34a456667f631ff4 | 10000 | 10 | 50000 | 1 | 300s | incomplete | unknown | unknown |
| ea5e42deebdcde8a | 10000 | 10 | 50000 | 2 | 300s | incomplete | unknown | unknown |
| 8cc8a8d2b21580d2 | 10000 | 10 | 100000 | 1 | 300s | incomplete | unknown | unknown |
| c70349e975188c49 | 10000 | 10 | 100000 | 2 | 300s | incomplete | unknown | unknown |
| 0bab1f609bcbdf54 | 20000 | 3 | 50000 | 1 | 300s | incomplete | unknown | unknown |
| deee3c048575c47e | 20000 | 3 | 50000 | 2 | 300s | incomplete | unknown | unknown |
| fa3c5d6224c134fe | 20000 | 3 | 100000 | 1 | 300s | incomplete | unknown | unknown |
| 4dea1d73f0c38278 | 20000 | 3 | 100000 | 2 | 300s | incomplete | unknown | unknown |
| 7d7d4c0e6b19f841 | 20000 | 5 | 50000 | 1 | 300s | incomplete | unknown | unknown |
| bba8a4557d1b16c1 | 20000 | 5 | 50000 | 2 | 300s | incomplete | unknown | unknown |
| dd7fceba0f3c6541 | 20000 | 5 | 100000 | 1 | 300s | incomplete | unknown | unknown |
| a715627892cb4074 | 20000 | 5 | 100000 | 2 | 300s | incomplete | unknown | unknown |
| 40590ea36631beb0 | 20000 | 10 | 50000 | 1 | 300s | incomplete | unknown | unknown |
| 9ea2982d240a9808 | 20000 | 10 | 50000 | 2 | 300s | incomplete | unknown | unknown |
| 7e313577848430e8 | 20000 | 10 | 100000 | 1 | 300s | incomplete | unknown | unknown |
| b3213cfceea28626 | 20000 | 10 | 100000 | 2 | 300s | incomplete | unknown | unknown |
| 2fa79bc483f64ed0 | 50000 | 3 | 50000 | 1 | 300s | incomplete | unknown | unknown |
| 3bf759052335b65d | 50000 | 3 | 50000 | 2 | 300s | incomplete | unknown | unknown |
| f6a6988fa059bfa8 | 50000 | 3 | 100000 | 1 | 300s | incomplete | unknown | unknown |
| 089051111cb5f266 | 50000 | 3 | 100000 | 2 | 300s | incomplete | unknown | unknown |
| 93914706970f2f54 | 50000 | 5 | 50000 | 1 | 300s | incomplete | unknown | unknown |
| e5f0041117c7ecc6 | 50000 | 5 | 50000 | 2 | 300s | incomplete | unknown | unknown |
| 08ea4975834854d7 | 50000 | 5 | 100000 | 1 | 300s | incomplete | unknown | unknown |
| 6537832f2f66efba | 50000 | 5 | 100000 | 2 | 300s | incomplete | unknown | unknown |
| 47d3e5d83e05f4ce | 50000 | 10 | 50000 | 1 | 300s | incomplete | unknown | unknown |
| 436a3dbd54fb2375 | 50000 | 10 | 50000 | 2 | 300s | incomplete | unknown | unknown |
| da8de6b77479ec5d | 50000 | 10 | 100000 | 1 | 300s | incomplete | unknown | unknown |
| 134a7397b67725ba | 50000 | 10 | 100000 | 2 | 300s | incomplete | unknown | unknown |

## 解释范围

- 09-03 至 09-05 为探索，09-06 至 09-07 为验证，结果窗在分割边界右截尾。同币跨期依赖和 leave-one-token-out 数量见 results.json。
- 15/60/180 分钟结果比较额外 0/1/5 分钟延迟。delay=0 包含发报当分钟，可能计入发报前的秒数；以 delay≥1 为主要保守口径。Meme/RWA 与 RWA/USDG 各池分列，不相加冒充同一池费用。
- 缺口与右截尾保留；覆盖不足的总量、交易次数、持续时间与每小时通知率保持 null。已观察前缀次数另列。
- 后续成交区间、独立 episode、活跃分钟和最长连续活跃分钟见 results.json；样本量列出，不估计可靠胜率。
- 毛费未估计，费用可信度为 not-estimated；没有仓位、完整交易成本与无常损失模型，不输出 LP 净收益。
- GMGN 代币级成交与链上单池成交的统计范围、时间聚合和估值时点不同，不强行对齐研究数字。

实验：study-cae69a3c-7878-4e1a-9c69-173071468fba
