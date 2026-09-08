# P1 Task 1.1 SQLite store implementation report

## Outcome

Implemented the P1 range ledger and active-set store in the assigned files. P0 `RangeBatch` remains unchanged; persistence uses `RecordedRangeBatch` with explicit shard evidence and optional time, anchor, boundary, and pool-registration projections.

## Public API

- `openDatabase(path)` creates parent directories, enables foreign keys, a busy timeout, WAL for file databases, applies the raw schema, and upgrades earlier P1 pool tables with protocol identity.
- `SqliteRangeStore` exposes `saveRaw`, `acceptedTip`, `acceptRange`, `invalidateAfter`, `activeLogs`, `checkpoints`, `anchors`, `boundaries`, `logTimes`, `pools`, `invalidations`, `resetForWarmup`, `pruneCheckpoints`, and `recordRun`.
- `rawLogKey` is chain-namespaced and normalizes block and transaction hashes.
- `verifySuccessfulShardCoverage` validates expected shard identity, successful response evidence, continuous block coverage per stable filter family, response counts and keys, safe heights, and address/topic filter membership.

## Persistence and correction behavior

- Raw logs are immutable under `chainId + blockHash + transactionHash + logIndex`; normalized payload conflicts fail instead of overwriting branch evidence.
- Failed and truncated batches remain in `ingest_batches` and `fetch_shards`. The same transport batch can later be enriched with derived time evidence because transport immutability excludes derived projections.
- Acceptance requires a complete manifest, rejects stale writers and cursor gaps, unions concrete shards by stable filter family, and reconciles only that family's covered range.
- Active logs, cursor, log times, anchors, minute boundaries, pools, accepted coverage, and checkpoints commit in one immediate transaction.
- Time corrections return `retimed` for existing active logs. Reorg invalidation clears both minute windows adjacent to any invalid boundary, including dependent times below the rollback anchor.
- Pool registrations disappear when complete matching discovery coverage drops their creation ref. Registrations discovered outside the accepted range remain.
- Reorg and warmup resets append durable `range_invalidations` records while immutable raw batches remain.
- Run records support the live `running` to terminal-status lifecycle.

## TDD evidence

Observed red states before implementation or fixes:

1. Initial integration test failed because `storage/database.js` did not exist.
2. Durable recovery tests failed because `invalidations` did not exist.
3. Corrected discovery coverage test failed because a vanished creation log left its pool registered.

Each red case passed after the corresponding implementation.

## Verification

- `pnpm exec vitest run tests/integration/raw-store.test.ts`: 14/14 tests passed.
- `pnpm typecheck`: passed after the shared P1 contracts landed.
- Scoped TypeScript 7 check for Task 1.1 sources and test: passed.
- Assigned-file Prettier check: passed.
- Assigned-file `git diff --check`: passed.

The focused tests cover same-filter replacement, complete empty results, cross-filter isolation, stable-family pool expansion, overlapping concrete shards, internal coverage gaps, failed/truncated/missing/out-of-filter evidence, idempotency, raw immutability, scope isolation, simulated SQLite rollback, retiming, invalidation, pool rollback, checkpoint pruning, warmup reset, run updates, safe height bounds, and file-backed reopen.

No known Task 1.1 blocker remains. The coordinating agent owns the whole-branch suite and bounded public capture/restart.
