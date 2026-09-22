# Phase A reliability implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for scoped implementation and review; track verification below.

**Goal:** Resolve GitHub issues #2, #1, #3, #4 and #5: verifiable CI, safe retention, bounded shutdown and honest heatmap coverage.

**Architecture:** Preserve TypeScript/SQLite and existing raw/derived separation. Retention must fail closed where consumer ownership is uncertain; RPC cancellation must span queue, headers and body; heatmap completeness derives from every expected minute.

**Tech Stack:** Node 24, pnpm 11.19.0, TypeScript, Vitest, better-sqlite3, viem.

**Spec:** https://github.com/mmyyrroonn/lp-monitor/issues/15 and issues #1–#5 linked there. Baseline `9652ec9`.

## Global Constraints

- Keep latest-only defaults; do not start chain ingestion, touch production databases, or retrieve historical data.
- Keep Node 24, pnpm 11.19.0 and existing dependency versions; any lint tooling must have a reproducible lockfile and narrow initial scope.
- Preserve BigInt amounts and unknown/incomplete coverage; missing evidence must never become complete zero activity.
- Use temporary fixture databases and local mock HTTP servers for verification.
- Changes live in `.worktrees/phase-a`, branch `fix/phase-a-reliability`; leave existing `.codex/` untouched.
- Reproduce defects before production changes; run focused tests per change and all four verification categories at integration.

### Task 1: Retention safety (#1 and #3)

**Files:** `src/storage/retention.ts`, storage migrations/database and coverage readers as required; retention portions of `src/ops/recorder.ts`; chain/signal config validation; storage CLI dry-run entry point; `tests/unit/retention.test.ts` and relevant integration tests.

**Interfaces:** Existing `pruneRawBatches`, `pruneRawLogs`, `pruneLiveWindow`; recorder calls retention within follow wait. Shared raw facts outlive any one scope's cutoff.

- [x] Reproduce reversed insertion order IDs (`ffff`, `0000`) with `maxBatches: 1`, mixed states/scopes and repeated cleanup; assert the exact surviving batch and `foreign_key_check`.
- [x] Select a bounded doomed batch set once, ordered by `(end_timestamp_sec, id)`; use the same set for every child and parent deletion in one transaction.
- [x] Trace all coverage promises and consumers. Add conservative cross-scope retention eligibility, history/replay pin and reorg/quote-window protection; missing consumer progress must block reclamation rather than authorize it.
- [x] Invalidate affected coverage atomically with actual expiry and return unavailable/incomplete through coverage readers. Test fast/slow scopes sharing raw data and global expiry without complete zero windows.
- [x] Validate retention windows against actual signal, quote and reorg requirements before starting RPC. Add dry-run impact reporting and integrity audit, using no production data.
- [x] Classify retention failures in recorder telemetry. Run focused retention/config/coverage tests and record RED/GREEN evidence.

### Task 2: Independent CI and reproducible evidence (#2)

**Files:** `.github/workflows/ci.yml`, `package.json`, lint configuration/tooling if needed, `README.md`, relevant scripts/tests.

- [x] Run baseline lint/typecheck/tests/build separately and capture exit status.
- [x] Format affected source with the pinned Prettier. Split lint/typecheck/test/build into independent jobs using fail-fast false or separate jobs; require all for the final gate.
- [x] Upload logs and test JUnit with commit SHA, including failure paths. Verify a deliberately invalid format fixture fails format checking while another check executes.
- [x] Add narrowly scoped semantic lint for unhandled promises/unsafe assertions in the affected runtime boundary; document resource-lifetime review and progressive rollout.
- [x] Document current CI versus historical verification and unperformed long-run testing. Validate workflow/tooling locally, without claiming a remote run occurred.

### Task 3: Absolute RPC deadlines and shutdown cancellation (#4)

**Files:** `src/rpc/client.ts`, `src/rpc/rate-limit.ts`, `src/rpc/errors.ts`, `src/ops/shutdown.ts`, reader setup/shutdown portions of `src/ops/recorder.ts`; RPC/shutdown integration tests.

- [x] Reproduce streaming responses whose chunks arrive within idle timeout but run beyond deadline using a local HTTP server.
- [x] Add caller AbortSignal and absolute-deadline cancellation throughout queued permit waits, headers and streamed body. Preserve idle timeout and allow legitimate slow responses within total budget.
- [x] Wire SIGINT/SIGTERM into the reader; bound normal drain, retain accurate abort/deadline/timeout classification and budget/queue/concurrency telemetry.
- [x] Release listeners/timers/sockets on every success/error/cancel path; prohibit new scheduling after cancellation and never accept an incomplete range.
- [x] Verify header wait, body streaming and rate queue cancellation, successful slow response, zero pending work after close and incomplete-range safety.

### Task 4: Honest heatmap completeness (#5)

**Files:** `src/dashboard/web/view-model.ts`, `src/dashboard/web/app.ts`, heatmap CSS as needed, `tests/dashboard/view-model.test.ts`, dashboard UI tests.

- [x] Reproduce 1/10, 9/10 with middle gap, all-gap, warming, full ten-minute and current in-progress blocks.
- [x] Count expected/closed/missing/partial minutes and compute status after accumulation. Only all expected closed minutes yield closed; reason order/status cannot depend on input traversal.
- [x] Preserve observed totals and unknown amounts, distinguishing current progress from historical incompleteness. Ensure missing minutes have coverage reasons.
- [x] Use only closed blocks for peak/normal intensity; show observed labels and consistent historical click behavior. Verify one-minute view and unpriced amounts.

### Task 5: Integration and review

- [x] Independently review each task's requirements and implementation, then review full branch for cross-task defects.
- [x] Run pinned formatter, lint, typecheck, full Vitest/JUnit and production build; fix failures introduced or exposed within scope.
- [x] Record commands, counts, baseline/final SHA or uncommitted diff state, migration/rollback instructions, and remaining environmental limits in an acceptance report.
- [x] Leave a concrete local result for review; do not mark GitHub issues closed without confirmed acceptance or claim remote CI without a run.
