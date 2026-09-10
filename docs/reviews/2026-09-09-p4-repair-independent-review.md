# P4 repair independent review — 2026-09-09

Result: no remaining critical or important finding in the reviewed coherent source tree. Ready for parent final acceptance checks; no RPC or live service was used. No source edits or commits were made by this reviewer.

Scope: repair plan and original P4 plan; engine/config/types, chronological projection and evidence, outbox/retraction, migration guards/indexes, recorder/follow startup and capture modes, CLI configuration diagnostics, formatter and regression tests.

## Findings discovered and resolved during review

1. Historical closed draft presentation included the next minute because evidence filtering used <= bucket end; report-wide lastSwap also exposed future liquidity observations. Final code uses < end for closed drafts and explicitly unknown historical liquidity. Regression covers transaction/provenance exclusion.
2. Mixed capture mode invalidation: live hot revision 1 followed by backfill revision 2 and retraction left live revision 1 deliverable. Independently reproduced against an in-memory database: delivery returned hot revision 1 after invalidation. Final ledger preserves live-ever eligibility while individual outbox rows keep their actual capture modes; live retraction supersedes the obsolete live revision. Regression passes.
3. Advancing-head branch replacement was not detected by endpoint-only comparison, retaining consumed state and suppressing a qualifying new-branch hot. Independently reproduced at old end 4800 / replacement end 4801. Final recorder recovery writes a durable branchRecovery evidence marker; projection bypasses the no-change cursor shortcut, resets the branch identity, and consumes the marker atomically with replacement projection. Advancing replacement regression passes.

## Contract assessment

- E1: retaining relative-unavailable zero-baseline behavior is a reasonable documented interpretation of original P4 plan line 45 and existing baseline null semantics. Absolute-only candidate and independent consecutive confirmation remain available; no fabricated infinite relative multiplier.
- E2/E3: unseen complete natural buckets are evaluated chronologically with bucket-local baselines and logical cooldown. Closed metrics exclude later minute and bucket observations; arrival metadata remains separate, and delayed historical drafts are backfill-only.
- E4/E5/E8: configurable inactivity expiry, same-minute material candidate updates, and independent complete cooling history through a current-minute gap are covered. Rechecking remains fail-closed.
- O9: initial epoch no longer depends on initial endpoint or receipt identity. Detected replacement branches receive a new hash-bound epoch.
- Storage: material correction of the consumed entry bucket reuses episode/cooldown and permits escalation, unrelated historical registration does not retract other pools, persisted JSON comparison is normalized, pending indexes and explicit bounded derived-history maintenance are present.
- Recorder: ordinary delivery is gated on verified current head, catchup batches drain only retractions, signal failure classification preserves atomic rollback/raw evidence, and delivery failure counts are visible. CLI rejects ignored signal options and reports sanitized file/schema locations.
- Formatting: exact half-unit baseline rendering, negative quantities and readable liquidity annotations reviewed.

## Independent verification

- Engine/baseline: 2 files, 28 tests passed.
- Coherent P4 regression selection before final recovery-marker change: 9 files, 99 tests passed.
- Final recovery/outbox/recorder selection after marker change: 4 files, 50 tests passed.
- git diff --check -- src tests config: passed.

Full-suite, lint/typecheck/build and acceptance/performance artifacts are owned and rerun by the parent. Full metric/evidence scans remain deliberate to preserve freshness correctness; explicit retention is an operator API, not a claim of automatic periodic cleanup. This review does not establish production throughput or live profitability.
