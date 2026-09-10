# P5 Review 修复的独立复核

最终状态：本轮修复范围的需求符合与代码质量均通过。下文保留初次复核发现和后续关闭记录；最终 649 项测试、CLI 验收及性能证据以 [验收文档](2026-09-10-p5-acceptance.md) 为准。原生导出、长窗口增量处理和事后量级标签仍未实现。

---
# P5 independent fixes final review — 2026-09-10

Verdict: **changes requested**. The primary C1 / I1 / I2(a) / I4 fixes are present and their regression evidence addresses the original failures. One remaining M10 provenance error was independently reproduced. Documentation also has a stale current-state summary. Do not treat the passing suites as closing these findings.

## Review scope and evidence

Read the fix brief, implementer report, and actual uncommitted diff package first, then the original independent review and current source/tests. The package has base and HEAD both `ebd998b125d76e9a0c63ffb7e0ced0f1503531dd`; the appended working-tree diff and full untracked files are the relevant implementation. Re-read the final acceptance/README/plan/benchmark after root regenerated them. This review made no changes to source, tests, dependency files, historical inputs, or acceptance docs; the only repository write is this review report.

The root reports full suite 647/647, typecheck/lint/build exit 0, five compiled CLI checks exit 0, and default study exit 4 as expected. Those suites were not repeated. Read implementer focused output directly: 10 files / 94 tests passed, duration 20.99 s. One independent temp-fixture reproduction below was run, without network or source database access; the verified temporary directory was removed afterwards.

## Findings

### [P2 / Important] Require snapshot availability before labeling the earlier cohort as-of

- Location: `src/replay/study.ts:254-260` (mode selection), with saved version selection at line 282. The availability field is checked in `src/replay/runner.ts:212-220`, but it is not propagated in replay provenance at lines 116-125 for study to apply to the cohort interval.
- Trigger: a valid saved replay input says `cohortMode: as-of`, includes the requested RWA, and has `availableAtSec` after the cohort start. The runner correctly skips early evaluation frames, but the later accepted prefix still supplies the earlier creation records. Study then marks all those earlier births `as-of` merely because the final metrics contain that RWA.
- Independent reproduction used `replayFixture()`, changed only `replay.input.availableAtSec` to 600, and called `study()` with the fixture RWA/quote and cohort `[1970-01-01T00:02:00Z,1970-01-01T00:10:00Z)`. Actual output:

```json
{"availableAtSec":600,"cohortStartSec":120,"cohortEndSec":600,"cohortMode":"as-of","births":[{"creationMinuteStartSec":120,"historyComplete":true}],"inputNotYetAvailable":7,"reportStatus":"incomplete"}
```

The saved list only became available at the excluded end of this entire birth window. `status: incomplete` does not make the `as-of` provenance label true. This violates the M10 constraint against inferring historical watchlist availability.

- Required correction: preserve `availableAtSec` in replay provenance and require a trustworthy timestamp no later than the cohort start before using a whole-cohort `as-of` label, or implement explicit per-member temporal selection. Otherwise use `retrospective-cohort`. Keep the saved source version distinct from the fallback registry version. Add the late-snapshot regression and preserve the existing available-before-window as-of test.
- Targeted command: PowerShell single-quoted here-string piped to `node --import tsx --input-type=module -`; imports `tests/helpers/replay-fixture.ts`, `tests/helpers/alert-fixture.ts`, and `src/replay/study.ts`. No permanent test or source edits were made by this reviewer.

### [P3 / Minor] Update the current implementation-status summary to the regenerated evidence

- Location: `docs/implementation-status.md:3` and `docs/implementation-status.md:28`.
- Both current-status summaries still state 623 tests/codepassed, while the freshly updated final section at line 197 and the acceptance document state 647 tests. The opening explicitly calls itself the current status, so this is not merely a retained historical test count.
- Update both summaries to the final verified count/status after the M10 correction, retaining historical 623 references only where clearly described as prior evidence.

## Spec compliance assessment

| Requirement | Assessment |
|---|---|
| C1 | Satisfied on inspected implementation: typed `IncompleteRangeError` and `NoAcceptedScopeError`, narrow legacy range messages, separate `historical-shard-gap`, preserved incomplete report. Regression covers missing, unaccepted, and omitted middle batches. |
| I1 | Satisfied: minute replay calls shared transactional `commitSignalDecision`; `alertRevisions` retains commits, `alerts` has one latest record per id; experiment `seenAlertIds` counts first identity and retains first outcome timing. Actual two-spike regression expects revisions 1,2 and one identity. Identical-payload no-op is shared with existing live commit coverage. |
| I2(a) | Satisfied: native manifestHash/log count/fromBlock/toBlock/completeness cross-check; absent original SHA remains explicit; mismatch is excluded; portable output preserves missing original SHA. Coherent truncation regression exercises the original failure. |
| I2(b) | Allowed documentation option satisfied in refreshed README, acceptance and unchecked Task 5.1 native replay acceptance. Native exporter remains absent and is not represented as implemented. |
| I3 | Allowed deferral option satisfied. Final measured 60/120/240/480-minute samples are 731/2933/14724/79089 ms and agree with acceptance. Benchmark records environment, runtime code hash and inclusion boundaries. No multi-day practicality is claimed. |
| I4 | Satisfied: one-bar failure reason is `no-complete-above-threshold`; two-bar default unchanged and negative reason regression present. |
| M1/M4 | Refreshed acceptance explicitly reports zero actual alerts/outcomes/first comparisons; episode magnitude labels remain unchecked. Current-status summary finding above remains. |
| M2 | Satisfied: machine-readable outcome/study semantics plus rendered report/README identify optimistic delay 0 and primary delays 1/5. Formula intentionally unchanged. |
| M3 | Satisfied: no readChunkSize or fake 1/100 assertions remain in source/tests/verifier. Actual portable rerun business equivalence retained. Whole JSON reading limitation documented. |
| M5 | Required issue-code assertions present, including artifact/unaccepted/hash/projection/overlap/window-limit. |
| M6 | Satisfied for covered scope: per-pool historyComplete uses selected interval / observed end / actual operation scope; gaps yield incomplete independently of discovery denominator; dead pools and censored flags retained. |
| M7 | Satisfied: both runner and experiments use the target closed minute, and exposure requires that target to be closed. Passthrough-engine regression observes `gap`. |
| M8 | Satisfied within documented semantics: outside drafts/outcomes/exposure are excluded; preperiod frames still update shared state. Right endpoint exclusion is expressly disclosed as conservative. |
| M9/M12 | README documents context-dependent exit code 4 and explicit buckets=2 configuration-hash/state consequences. |
| M10 | Partially satisfied: vocabulary, saved asset version and membership checks fixed; late snapshot availability still produces false as-of labeling (P2 above). |
| M11 | Satisfied: every accepted scope receives minute envelope/gap checks; discovery gap is not silently complete. |

## Code quality assessment

The changes are focused and generally maintainable. Reusing the live commit function avoids duplicate revision logic, typed recoverable exceptions preserve internal-error distinctions, and provenance is not promoted by re-exporting missing original hashes. Tests include real multi-spike behavior and meaningful failure injection rather than only shape assertions. Removing the fake chunk parameter improves the API/evidence contract.

The remaining M10 error is a cross-file data-contract omission: mode and asset version survive into study, but the timestamp that makes an as-of claim valid does not. Fix that boundary before closing. Full-prefix computational cost, native export absence, conservative discovery gating, and right-edge exposure limitations are known and accurately disclosed; this review does not elevate those permitted deferrals into new implementation blockers.

## Closure after narrow M10 follow-up — 2026-09-10

**Updated verdict: both findings are closed; no remaining actionable finding in this review scope.** This closure supersedes the initial changes-requested verdict above, which is retained as the original review record. Final full-suite/build/artifact regeneration remains owned by root and is not claimed by this closure.

### P2 / M10 closed

Re-read actual current `src/replay/runner.ts`, `src/replay/study.ts`, and `tests/integration/study.test.ts`; the old diff package predates this narrow fix and was not treated as its source of truth.

- `runner.ts:57,127` now propagates the saved availability timestamp through replay provenance, with null when absent. Existing snapshot validation at lines 144-149 rejects non-safe-integer availability, so study does not consume an unvalidated timestamp.
- `study.ts:254-262` requires saved as-of mode, present availability no later than cohortStart, and corresponding saved RWA membership. A late snapshot therefore selects retrospective-cohort; line 284 selects the configured cohort registry version for that fallback while retaining the saved asset version for valid as-of selection.
- `study.test.ts:158-192` covers both the inclusive equality boundary (availableAtSec 120 / cohortStart 120) and the independently reproduced late boundary (availableAtSec 600 / cohortStart 120). Assertions check mode, retained birth count, correct registry version and rendered mode. The earlier before-window as-of test at lines 53-80 remains present.
- Read `.superpowers/p5/independent-late-snapshot-results.txt`: 4 files / 43 tests passed, start 16:23:49, duration 13.46 s. The implementer report records the actual late-boundary RED and subsequent GREEN. No duplicate test run or new reproduction was necessary because the new real-study regression directly covers this reviewer's original reproduction.

### P3 / status summary closed

Re-read `docs/implementation-status.md:3,28`. The opening now describes 647 as the most recent prior full run, explicitly says the availability regression awaits the final rerun, and keeps P5 in_progress with missing native export / long-window / historical capabilities. The table no longer claims current 623-test codepassed evidence. Root will update the count when the fresh run finishes; the present wording is truthful while that run is pending.

### Final separate assessments

- **Spec compliance: pass for the requested review-fix scope.** C1 / I1 / I2(a) / I4 and the listed Minor corrections are addressed. I2(b) and I3 remain the expressly permitted documented deferrals, not completed native export or incremental replay capabilities.
- **Code quality: pass for the reviewed changes.** The M10 fix carries the existing timestamp through the data contract and checks it at the cohort decision point, with a small, direct condition and meaningful temporal boundary regressions. No new dependency, duplicate mode vocabulary, synthetic completeness promotion, or unnecessary architectural expansion was introduced.

Only this closure was appended by the reviewer. No source, tests, acceptance docs or original history were edited.
