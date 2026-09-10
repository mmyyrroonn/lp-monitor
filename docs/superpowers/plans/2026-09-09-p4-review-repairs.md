# P4 review repair plan (2026-09-09)

Review: docs/reviews/2026-09-09-p4-review-findings.md against b5e8c81. The requested September 5 filename is absent.

## Scope and decisions

Only P4 corrections and offline verification. Preserve existing unrelated README, START_HERE, implementation-status, P5/P6 plan and design edits. No RPC acquisition, live service, P5/P6 implementation or automatic commit.

- E1: retain the specified zero-baseline / insufficient-baseline rule: relative confirmation is unavailable; an absolute-only candidate and independent consecutive confirmation remain possible. Add explicit evidence and regressions; do not label division by zero as verified relative growth.
- E2/E3: evaluate unseen closed buckets in chronological order with per-bucket baselines and logical bucket-end cooldown; preserve actual arrival time and restrict delayed historical drafts to backfill delivery eligibility.
- E4/E5/E7/E8/E9/O9: configurable episode expiry, material current-minute updates, truthful rule reasons, preserve valid cooling history during current gaps, canonical identifiers.
- E6/E10/E11/E12: exact rational baseline display, signed quantities, fully typed fixtures and readable observed-liquidity notes.
- O2/O3/O4/O5/O8/O10/O11/O13: mode-safe outbox supersession, scoped evidence invalidation and cooldown preservation, prepared statements / indexes / sparse audit and bounded derived retention, isolated failed deliveries, durable JSON equality and SQL validation. Optimize only with complete freshness evidence.
- O1/O6/O7/O12/O13: startup live eligibility only at verified current head; explicitly classify signal failures while preserving atomic accepted-range/P2/signal commits and previously saved raw evidence; expose delivery failure summaries; actionable sanitized configuration errors and reject ignored options.
- O6: do not implement a silent non-atomic fallback; fail closed with observable cause. O12: readonly P3 compatibility must remain supported; alert-specific schema checks apply only to alert readers.

## Work units

1. Engine/config/types and engine regressions.
2. Projection/outbox/schema and storage regressions, integrating chronological decisions.
3. Formatter and sink cleanup with typed display regressions.
4. Recorder/CLI diagnostics and startup integration regressions.
5. Review each unit, run full tests, lint, typecheck, build and offline acceptance/performance measurement; record resolution for every review ID.

Use subagent-driven-development for independent units. Shared interface changes must be announced before integration. No commits from implementers.

## Completion

Completed P4 repair scope: 577/577 full tests, lint, typecheck, build, offline acceptance and independent review passed. See docs/reviews/2026-09-09-p4-review-resolution.md for per-item adjudication. O4 remains partial (complete freshness scan retained), derived pruning is explicit maintenance, E1 relative-unavailable behavior retained. No new commit or RPC.
