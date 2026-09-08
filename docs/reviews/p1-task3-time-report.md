# P1 Task 1.3 minute time index report

## Delivered

- `src/ingest/time-index.ts` provides `resolveMinuteBoundary(reader, timestampSec, lo, hi)`. It uses lower-bound binary search, retains actual anchor responses in an optional sparse cache, and returns adjacent `before`/`at` proof for the first block at or after the minute.
- `src/ingest/log-time.ts` provides `logTimeKey`, `assignLogMinutes`, and `resolveLogTimes`.
- Keys reuse storage `rawLogKey`: `4663:<lowercase-block-hash>:<lowercase-tx-hash>:<log-index>`.
- `resolveLogTimes(reader, logs, fromBlock, end, cachedAnchors?, cachedBoundaries?)` returns `{ times, queriedAnchors, boundaries, failures }`. It reuses persisted anchors/boundaries, fetches the range start only when not cached, preserves raw logs on individual boundary failures, and returns unresolved minute times rather than throwing.
- Event exact timestamps remain `null`; provider `rawBlockTimestamp`, including the observed `0x0` fixture, is not used as time proof.
- Same-minute range endpoints assign the enclosed range without a genesis/boundary query. Crossed minutes are located with lower-bound searches only; no per-log or per-block header loop is used.

## Tests and evidence

RED observed:

1. `pnpm exec vitest run tests/unit/time-index.test.ts tests/integration/log-time.test.ts` initially failed because the requested modules did not exist.
2. The added same-minute endpoint regression then failed with an unresolved result before the range fast path was implemented.

GREEN:

- `pnpm exec vitest run tests/unit/time-index.test.ts tests/integration/log-time.test.ts` — 2 files, 7 tests passed.
- `pnpm exec tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --skipLibCheck src/ingest/time-index.ts src/ingest/log-time.ts` — passed.
- `pnpm exec prettier --check src/ingest/time-index.ts src/ingest/log-time.ts tests/unit/time-index.test.ts tests/integration/log-time.test.ts` — passed.
- `git diff --check -- src/ingest/time-index.ts src/ingest/log-time.ts tests/unit/time-index.test.ts tests/integration/log-time.test.ts` — passed.

The repository-wide `pnpm exec tsc --noEmit` is currently blocked by concurrent P1 work that imports not-yet-created `recorder`, `record-range`, `assets`, `pools`, and `raw-store`; these diagnostics do not name the Task 1.3 files.

## Integration notes

Storage should persist `queriedAnchors` and `boundaries` per scope, pass them back as the optional cache arguments, and compare the returned `times` map with all active logs, including retained overlap logs. A change from unresolved to minute-boundary is a retiming even when no raw log was added.
## Sparse-anchor regression fix (2026-09-08)

A cross-minute range can begin before its first newly resolved boundary. `assignLogMinutes` now accepts either a same-hash sampled block anchor as direct minute evidence or the nearest lower and upper sparse anchors when both lie in the same minute. It still leaves logs unresolved when the surrounding sparse evidence crosses a minute or a sampled block hash conflicts.

The new regression spans blocks 100–200 (timestamps 1100–1200) with logs at 120 and 180. It proves the pre-first-boundary log receives minute 1080 from its enclosing sparse anchors and the later log receives minute 1140. The boundary-failure fixture was tightened so it remains unresolved only where no direct or same-minute bracket evidence exists.

Validation: focused minute tests plus `tests/integration/recorder.test.ts` passed (3 files, 11 tests); scoped strict typecheck, Prettier, and `git diff --check` passed.