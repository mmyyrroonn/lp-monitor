# P1 Task 1.4 scheduler review

Scope reviewed: `follow.ts`, `reorg.ts`, `checkpoint.ts`, `health.ts`, and their follow/reorg/CLI tests. Recorder CLI wiring was intentionally excluded. No code was changed and no tests were rerun.

## Findings

### P1 — replay can retain a stale target anchor after fork recovery

`follow` captures `head` and `target` at lines 45–47, then detects a cursor fork at lines 51–67. It invalidates or warmup-resets the scope but continues to call `recordRange` with the pre-recovery `target` (lines 71–74). If the branch changes between the initial target read and the cursor verification, `target.hash` can describe the displaced branch. Passing that anchor through as the batch end can record against an anchor that is no longer canonical, unless the not-reviewed recorder independently refetches and rejects it.

Reacquire the bounded head/target after successful `invalidateAfter` or `resetForWarmup`, before calculating the next range. The reorg test only replaces block 120 while retaining the original synthetic head at 127; it does not model the descendant hash change that a real fork creates, so it cannot expose this path.

### P1 — the deadline is checked before anchor work, not immediately before recording a range

The only inner-loop deadline check is at line 49. The subsequent cursor verification, recovery search, and end-anchor read all await RPC before `recordRange` at line 74. If that work crosses `stopAtMs`, a new range may still start after the user-requested duration has expired. The current duration test changes its fake clock inside `recordRange`, so it verifies stopping after one accepted range but not this pre-record race.

Check `now() >= stopAtMs` again immediately before `recordRange`; report the remaining backlog as a gap. Add a test where `getAnchor(limit)` advances the fake clock past the deadline and assert that `recordRange` is never called.

### P2 — programmatic `toBlock` accepts negative or unordered bounds

Line 35 validates `startBlock` only. A caller outside CLI parsing can pass `toBlock: -1n`, making lines 46–47 ask the reader for a negative anchor. A `toBlock` below `startBlock` has inconsistent health/gap handling instead of a clear contract failure. The CLI tests cover command arguments, but `follow` is exported and is the actual runtime boundary.

Reject a defined `toBlock` when it is negative or less than `startBlock`, before any RPC request. Add direct `follow` tests for both cases.

## Checkpoint budget and positive observations

`findMatchingCheckpoint` enforces a maximum of 32 calls (lines 9, 17–18) and its exponential-backoff plus binary refinement stays within that budget. The 10,000-checkpoint test explicitly asserts `<= 32`. RPC failures are propagated rather than interpreted as fork evidence, which avoids destructive warmups on an unavailable provider. `warmupStart` also uses chain-time lower-bound resolution rather than estimated block rates.

The scope lock is keyed by both store identity and scope ID, so concurrent writers for one scope are rejected while different stores/scopes remain independent. Overlap validation prevents non-advancing segments.
## Resolution re-review (2026-09-08)

All three reported scheduler findings are fixed in `src/ingest/follow.ts`:

- After a recovery, it refreshes `latest` and the bounded target before continuing (lines 65–70), so replay does not retain a stale pre-fork end anchor.
- It checks the deadline again after the end-anchor read and immediately before `recordRange` (line 78), preventing a new range from beginning after expiry.
- It rejects a defined `toBlock` below `startBlock` before RPC (line 35); because a negative `toBlock` is necessarily below nonnegative `startBlock`, the negative case is covered as well.

The changes directly satisfy the prior findings. No new actionable scheduler issue was found in this re-review.