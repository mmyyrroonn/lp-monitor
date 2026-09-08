# P1 Task 1.1 raw store and completeness review

Scope reviewed: `src/ingest/completeness.ts`, `src/storage/raw-store.ts`, migration `001-raw.sql`, manifest contracts, and the current raw-store integration tests. This was source review only; tests were not rerun.

## Finding

### P1 — boundary invalidation misses logs whose minute starts at the invalid boundary

`persistDerived` records every minute-boundary assignment with `boundary_timestamp_sec = minuteStartSec + 60`. `invalidateAfter` then deletes only times whose stored boundary timestamp is one of the invalidated boundaries (raw-store.ts lines 130–131), as well as times for raw logs on the discarded branch (lines 133–140).

That is sufficient for a log in the minute before a boundary: minute 60 records dependency 120, so invalidating boundary 120 clears it. It fails for a log on the first block of minute 120 that was assigned using boundary 120's `at` proof: it records dependency 180 and survives invalidation of boundary 120, even though its assigned minute proof has changed hash. The current invalidation test covers only the prior-minute case.

Persist the exact boundary dependency for each assignment, or conservatively delete `source = 'minute-boundary'` times in both minute windows adjacent to every invalidated boundary (`T - 60` and `T`). Add an integration test with a log at `boundary.at` in minute 120, then invalidate boundary 120 and assert the time is removed and returned as retimed. This finding was sent to the storage owner during review.

## Verified behavior

- `verifySuccessfulShardCoverage` requires a complete batch, exact expected shard set, successful response evidence, safe ranges, counts/keys that correspond to raw logs, and continuous coverage for each logical filter family. Empty successful shards are permitted, allowing a complete empty replacement to remove prior active logs for that filter.
- `acceptRange` validates completeness before its immediate transaction, then persists raw transport, reconciles active rows, persists derived state, accepted fragments, checkpoint, and cursor in one transaction (raw-store.ts lines 72–98). A write failure rolls all of those accepted-state changes back; raw transport submitted earlier through `saveRaw` remains immutable evidence.
- Raw identity is scoped by the fixed chain ID plus normalized block hash, transaction hash, and log index. Re-saving a changed payload at that identity rejects rather than replacing the immutable raw response.
- Active rows are separated by `scope_id` and `filter_id`; reconciliation removes only the covered logical filter/range. This preserves an unrelated filter's active logs while allowing a complete empty response for the same filter to clear its range.
- `invalidateAfter` removes affected active logs, pools, anchors, boundaries, checkpoints, cursor evidence, and accepted ranges transactionally. It preserves immutable raw records, as required for branch history.

No separate actionable problem was found in raw/filter completeness, immutable transport versus derived enrichment, pool rollback, or accepted-state atomicity.
## Resolution re-review (2026-09-08)

The storage owner fixed the reported boundary-proof invalidation. For every invalidated boundary `T`, `invalidateAfter` now deletes times with an exact stored dependency `T` and conservatively deletes `source = 'minute-boundary'` assignments whose minute start is `T - 60` or `T` (raw-store.ts lines 127–139). This covers both sides of the boundary, including logs at its `at` anchor. The fix is bounded to the adjacent windows and preserves unrelated minute assignments. The P1 finding is resolved.