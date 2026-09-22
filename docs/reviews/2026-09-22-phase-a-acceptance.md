# Phase A reliability acceptance

Scope: GitHub issues #2, #1, #3, #4, #5. Baseline `9652ec9`.
Branch: `fix/phase-a-reliability`; isolated worktree: `.worktrees/phase-a`.
Date: 2026-09-22, Windows / Node 24.5.0 / pnpm 11.19.0.

Status: implementation, task re-reviews, final integrated verification and final cross-task review passed at `48d18520482f14b7ddf6b51169aa233a9d056c9a`.
This report is local evidence, not a claim that GitHub Actions or a long-running chain test ran.

## Acceptance map

| Issues | Result and regression coverage                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #2     | Independent format, semantic, type, test and build matrix jobs; fail-fast disabled; final verify gate; always-uploaded SHA/run logs and test JUnit. Existing pins preserved. Negative format and semantic fixtures fail as expected.                                                             |
| #1     | One bounded batch set ordered by timestamp/ID drives atomic child/parent deletion. Reversed IDs, mixed states/scopes, repeated cleanup, rollback and foreign keys tested.                                                                                                                        |
| #3     | Shared raw retention fails closed across all known consumers, checkpoints, overlap, lookbacks and explicit pins. Actual expiry invalidates coverage, including zero-block minutes. Startup validation, read-only impact preview, integrity audit and retention-specific failure telemetry added. |
| #4     | Absolute deadline and caller cancellation span queue, headers and body; per-attempt cleanup handles early body rejection. Finalization starts a nonextendable 30-second RPC deadline before metadata drain. Cancelled metadata is not a token failure; cleanup failure cannot return success.    |
| #5     | Every expected minute is counted; only all-closed blocks rank as complete. Historical gaps and current progress differ; observed totals and unknown amounts stay explicit. Real app HTML/CSS/module DOM regression covers ranking, tooltip/classes and history clicks.                           |

## Verification

Baseline: 150 files / 1316 tests passed. Baseline typecheck/build passed; format check found existing recorder/retention formatting defects, now corrected.

First integrated run at `13545b7`: 156 files, 1354 passed / 1 failed. The failure exposed cancelled metadata being recorded as a token failure. Fixed with anchor/call regressions in `6cc5e84`; focused RPC/recorder/metadata verification then passed 81/81 tests in 8 files. Format, semantic, typecheck and build ran independently and each exited zero.

Task reviews caught and required corrections, including actual DOM coverage, oversized response cleanup, metadata cancellation classification, failed-close exit status, earlier drain deadline, retention/alert interaction and complete preview scope reporting. Review findings are not treated as acceptance until corrected and rechecked.

The final retention correction separates availability changes from genuine history repair; live and raw-batch expiry retain recent active alerts while genuine pending repairs survive. Scoped storage/projection/signal/legacy-read verification passed 82/82 tests in 9 files at `48d1852`. Frontend closure now matches the backend exclusive-minute boundary (599 remains partial; 600 can close the first ten-minute block); its focused aggregation/DOM tests passed 36/36 at `80e8388`.

Final verification at `48d1852` (2026-09-22 15:53–15:56 local):

| Command                                                                               | Result                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `pnpm install --offline --frozen-lockfile`                                            | Exit 0; locked dependencies already up to date         |
| `pnpm lint`                                                                           | Exit 0; all matched files formatted                    |
| `pnpm lint:semantic`                                                                  | Exit 0                                                 |
| `pnpm typecheck`                                                                      | Exit 0                                                 |
| `pnpm test --reporter=dot --reporter=junit --outputFile.junit=artifacts/ci/junit.xml` | Exit 0; 157 files / 1369 tests passed, 155.66 seconds  |
| `pnpm build`                                                                          | Exit 0; migration 017 and dashboard resources included |
| `git diff --check 9652ec9..48d1852`                                                   | Exit 0                                                 |

The JUnit XML was independently parsed as UTF-8: 1369 tests, zero failures, zero errors, 157 suites. `artifacts/ci/source.txt` binds local results to the tested SHA. The first failing integration logs/JUnit are preserved as `tests-at-13545b7.log` and `junit-at-13545b7.xml`. Vendor SDK source-map warnings do not change test results.

After this tested SHA, the acceptance-record commit changes documentation only.

Final independent review of `9652ec9..48d1852` found no Critical, Important or Minor issues. It traced expiry through projections/signals/dashboard cache identity, cancellation through metadata/finalization, migration/reopen behavior, build resources, and CI evidence. Ready for local acceptance; remote CI and long-run/production-scale behavior remain outside these results.

## Operational boundaries

- No production database was opened or pruned; tests use synthetic memory/temp SQLite databases and loopback HTTP servers.
- No real chain RPC, historical ingest, trading, notification delivery or long-run load test was started.
- No branch was pushed and no issue was closed. The first remote CI run, its five artifacts/JUnit and the final verify gate still need inspection after publication.
- DOM tests execute the production frontend with a stubbed HTTP boundary; they are not native-browser layout or screenshot acceptance.
- Local verification logs and JUnit live in ignored `artifacts/ci/`; remote CI publishes its own commit-bound evidence.

## Retention migration and rollback

See [retention operations](../retention.md) for preview, audit and explicit pin/unpin commands.
Migration `017-retention-safety.sql` is additive; existing unknown consumers do not acquire implied cleanup permission. Read-only opens do not migrate. Index creation needs time and disk space on large existing databases.

Migration replaces expiry/range-delete triggers with the corrected availability semantics. It does not erase ambiguous pre-existing dirty-coverage or pending-repair rows left by an earlier development version, since those cannot safely be distinguished from genuine source corrections.

Before enabling physical expiry, preserve a consistent backup. Code rollback cannot recover deleted facts; restore the backup or disable retention and avoid older readers that ignore expiry metadata. Do not delete availability floors to manufacture complete history.

Deliberately conservative choices: dormant/unknown scopes and pins can postpone cleanup indefinitely; pins require explicit release; availability floors can mark residual/reimported old rows unavailable. Audit checks structural integrity, not full historical semantic equivalence. No production-scale retention throughput claim is made.
