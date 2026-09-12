# Incremental Live Metrics Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the independent storage tasks and requesting-code-review before integration.

**Goal:** Remove whole-history work from normal live batches while preserving correction and evidence contracts.

**Architecture:** Durable dirty-event projection and source revisions feed an incremental valuation/minute store. Live reports use a bounded horizon; offline rebuild stays available.

**Tech Stack:** Existing TypeScript, Node.js 24, better-sqlite3, viem, Vitest.

## Global Constraints

- No RPC, wallets, trading, long live tests or new dependencies.
- Preserve raw evidence, unknown/null values, transaction deduplication and existing rule units.
- New branch codex/incremental-live-metrics; merge to main after verification; retain branch.
- No full-history decoding, hashing or replacement in ordinary live processing.
- Scope corrections, restart, SQLite rollback and expiry must preserve output integrity.

## Tasks

- [x] Raw acceptance: constrain before/after comparisons to affected records; add bounded coverage reads. Tests: `node node_modules/vitest/vitest.mjs run tests/integration/raw-incremental.test.ts` plus recorder/time/reorg coverage tests.
- [x] Projection: add `LiveProjectionStore.sync(scopeId, registryScopeId, configVersion)` and bounded `read(..., sinceSec)` with durable source revision and dirty-event processing. Tests: `tests/integration/live-projection.test.ts` covering append, removal, retime, restart and unrelated event preservation.
- [x] Metrics: persist event valuation and minute contributions; reuse unchanged minutes; bound baseline context and expire realtime rows. Compare current results against offline `buildMetricsReport` on the same fixtures, including quote dependencies and missing coverage.
- [x] Signals/recorder: wire incremental projection/report into accepted transaction, preserve evidence withdrawal and deduplication; ensure ordinary window expiry does not retract historical signals.
- [x] Historical review: explicit inclusive block range, isolated database snapshot, independently validated discovery and operation coverage, fetch missing intervals only, preserve unknown results. Mock-reader tests cover zero-RPC reuse and source isolation.
- [x] Verification/docs/integration: run offline suite, typecheck, lint, build and diff check; independent review, repair findings, commit and fast-forward main. Report tests actually run and no long live acceptance claim.

Validation: 79 files / 774 tests passed; typecheck, lint, build and diff check passed. Independent final review has no remaining Critical/Important findings. User-authorized commit and fast-forward integration follow this verified tree.
