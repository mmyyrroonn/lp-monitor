# P1 final independent code review

Final disposition after the fixes below: **no remaining confirmed blocking findings**. The original findings and failed reproductions are retained as history; they are closed by independent probes against the corrected implementation.

Review date: 2026-09-08. Base: `af85a228d8945fbd01d6742c17a9a3559ee4fbb6`. Reviewed the uncommitted P1 implementation against `docs/superpowers/plans/2026-09-08-p1-recorder.md` and the range, time, recovery and scope contracts in the design. The working tree was changing concurrently; locations below identify the pre-fix code reviewed.

## Historical findings (closed after narrow re-review)

### P1 — explicit historical ingest bounds can be silently skipped by a higher saved cursor

Location: `src/ingest/follow.ts:125-126`, and cursor-only completion at `:171`.

The range start is always derived from the saved cursor minus overlap, even for an explicit one-shot historical request. A prior run covering 150–200 followed by `ingest --from-block 100 --to-block 220` therefore records only 181–220 and reports complete, although 100–149 was never covered. A wholly older request can perform no scan at all. The scope appropriately remains stable across run bounds, so using its tip as proof of all earlier requested coverage is insufficient.

A no-network deterministic probe against `follow` with prior tip 200, explicit bounds 100–220, and a mock transactional recorder returned:

```json
{"requested":["100","220"],"previouslyCovered":["150","200"],"ranges":[["181","220"]],"result":{"acceptedRanges":1,"reorgs":0,"warmupResets":0,"failures":[],"complete":true}}
```

Required correction: honor explicit historical bounds with independent scan progress, preserving a higher accepted cursor when correcting an older range. Test cursor 200 with requested 100–220, wholly older 100–120, multi-segment historical scans, and failed segments. Ordinary follow restart overlap should remain unchanged. Root accepted this finding and is implementing the regression and correction.

### P2 — conflicting duplicate raw identities within one response are accepted after silent deduplication

Locations: `src/ingest/fetch-range.ts:124-130`; `src/ingest/record-range.ts:108-120`.

The low-level `seen` set retains only the first payload per raw identity. The later fragment deduplication sends errors to a discarded empty array and replaces the actual response hash with a hash of the deduplicated logs. As a result, two records with the same blockHash/transactionHash/logIndex but different data in one successful response bypass the higher-level conflict checks and can become accepted discovery and raw state.

A no-network probe returned two individually valid V3 PoolCreated records with identical raw identity but different encoded pool addresses in the first response. `fetchRange` returned:

```json
{"complete":"complete","errors":[],"logs":1,"pools":1,"firstShardCount":1}
```

Required correction: detect payload conflicts before suppressing duplicates, preserve response evidence, and mark the range incomplete so no active state or cursor can advance. Test both a single-response conflict and a conflict repeated across split fragments; identical duplicates must remain idempotent. Root was notified with the exact reproducer outcome.

## Reviewed behavior and boundaries

- Stable observation scopes are distinct from per-batch filter/manifest hashes; discovery and operation cursors remain isolated.
- Normal operation fetch executes discovery before operation planning on every range, including the same creation block. The earlier withdrawn finding is not repeated.
- Registry staging, endpoint recheck, known-cap splitting, failed-shard acceptance blocking, immutable persisted raw identity, and transactional active/cursor updates were inspected.
- Minute lower_bound handling, zero timestamp rejection, retained-log retiming after invalidation, sparse checkpoints, warmup reset, and recorder evidence flushing were inspected. The previously reported missing-time repair and initial-run cleanup fixes are present.
- The root is independently correcting partial successful fragment retention on a later budget failure. The new focused regression was visible during this review; it is not duplicated as a new independent finding.
- P2 metrics and P4 alert execution are intentionally outside this stage. P1 returns change sets and records revision counts/evidence.

The initial review ran only the two deterministic probes described above; it did not rerun the full test suite or make network calls. Root owns the full validation, public bounded recording, and restart evidence. No production files or tests were changed by this reviewer.

## Narrow re-review and closure

The reviewer re-read the settled follow, fragmentation, manifest, and error-classification code. No implementation or test files were modified by this reviewer. The checks below used deterministic in-memory readers and made no network calls.

### Closed: explicit historical ingest bounds

Independent probes against the corrected `explicitNext` path produced:

| Initial cursor | Requested range | Actual ranges | Final cursor | Complete |
| --- | --- | --- | --- | --- |
| 200 | 100–220 | 100–220 | 220 | true |
| 200 | 100–120 | 100–120 | 200 | true |
| 200 | 100–3200 | 100–1099, 1100–2099, 2100–3099, 3100–3200 | 3200 | true |
| 200 | 100–3200, second range fails | 100–1099, attempted 1100–2099 | 1099 | false |

The normal follow overlap path remains separate. Higher cursors are retained during older corrections, and explicit scan progress determines whether the requested range completed.

### Closed: conflicting raw identity and response evidence

The original V3 PoolCreated conflict probe now returns `completeness=incomplete`, `recordingErrors=[conflicting-log-identity]`, one retained raw identity, zero staged pools, and a failed shard. Fingerprint checks run before suppressing both same-response and cross-leaf duplicates. Successful shard manifests now forward `fragment.responseHash`, preserving the pre-deduplication response hash. Identical duplicates remain idempotent.

The P1 caller opts into `captureCriticalFailures`; preceding successful leaves remain in the incomplete result when a later leaf fails. Legacy P0 callers retain the default throwing behavior for critical/evidence failures. The added targeted regressions were inspected; this reviewer did not rerun their entire suites.

### Filter-limit partitioning and manifest coverage

The proactive partition function preserves the address/topic Cartesian coverage and each shard's original block endpoints. The per-batch filter plan changes with partitioning; the observation scope remains stable. Explicit provider filter-limit errors split values before shrinking the block range. Unknown invalid-argument errors remain failures.

An independent 1810-pool V4 probe over blocks 100–110 emitted one Swap per pool and checked the resulting manifest through `verifySuccessfulShardCoverage`:

| Provider cap | RPC calls | Unique returned pool IDs | Complete manifest shards | Result |
| --- | --- | --- | --- | --- |
| 1000 | 6 | 1810 | 6, all IDs unique | complete |
| 512 | 42 | 1810 | 24, all IDs unique | complete |

The cap-512 path uses additional topic-family splits but preserves all pool coverage. The actual public RPC acceptance and restart are owned by the root; these synthetic checks do not replace that evidence.

### Additional regression found and closed: evidence failure took precedence too late

The first frozen reactive split implementation handled `filter-limit` before `evidenceFailure`. A deterministic probe whose first call threw `RpcFailure(filter-limit)` with secondary `RpcFailure(evidence-write)` then returned empty child responses produced three calls, `complete=true`, and no failures. This would have bypassed the existing P0 evidence failure contract and P1 acceptance gate. It was reported immediately and corrected by checking critical/evidence failures before any adaptive split.

The same independent probe now confirms:

```json
{"captureCriticalFailures":false,"calls":1,"threw":"filter-limit","evidence":"evidence-write"}
{"captureCriticalFailures":true,"calls":1,"complete":false,"failures":["filter-limit:evidence-evidence-write"],"shards":["failed"]}
```

Both P0 and P1 stop before adaptation; P1 records an incomplete failed leaf. This closes the additional regression. No remaining confirmed blocking findings were identified in the requested narrow re-review. Root still owns the final whole-tree checks and public same-database restart evidence.
