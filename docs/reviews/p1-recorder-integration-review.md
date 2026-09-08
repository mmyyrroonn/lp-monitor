# P1 recorder integration review

Scope reviewed: `src/ops/recorder.ts`, `src/ops/recorder-cli.ts`, CLI/config wiring, and the current recorder/CLI tests. The in-progress `record-range` implementation was not reviewed and tests were not rerun.

## Findings

### P1 — normal follow never advances discovery coverage, so pools created after startup are invisible

The recorder runs `bootstrap(initial)` once (recorder.ts line 184), then operation ranges at lines 210–280 use only the persisted discovery/operation registries. `bootstrap` runs again only from the fork-recovery callback (lines 205–209). The operation filter plan contains only operations for registered pools, so a V3/V4 pool created after the initial head is not discovered or monitored during a healthy long-running `follow`.

Run discovery for every new follow range before its operations pass, or advance discovery to the selected operation end and build the operation registry from that accepted result. Preserve the existing two-pass same-block behavior. Add a follow test that advances the fixture head with a new `PoolCreated`/`Initialize` after startup, then asserts its same-block operation becomes active without a fork.

### P1 — fork invalidation removes time rows, but recorder only retries rows explicitly marked unresolved

Storage correctly deletes invalidated minute-boundary time proofs. Recorder's retry set at lines 228–238 includes only active logs whose existing time source is `'unresolved'`. A log with a now-deleted `log_times` row is absent from `priorTimes`, so it is excluded unless it happens to appear in the next operation overlap. This can leave an old active log unbucketed indefinitely after a boundary/proof invalidation, and no retiming is emitted for it.

Include active logs with no stored time (`!priorTimes.has(rawLogKey(log))`) in the timing repair set, ideally constrained by the `RangeChangeSet.retimed`/affected window supplied by recovery. Add a fork test where a retained active log loses its boundary proof outside the next overlap; its time must be re-derived and surface as `retimed` with no raw addition.

### P1 — a failure recording the initial run bypasses cleanup and final manifest handling

`openDatabase` and the RPC reader are created before the first `store.recordRun` (lines 59–116), but that call is outside the enclosing `try/finally` (which starts at line 119). If SQLite is full, locked beyond its timeout, or its schema write fails at that point, neither `reader.close()` nor `db.close()` runs and no finished run/manifest reports the failure.

Move the initial run record inside a try whose finally closes both resources and writes the best-effort failure manifest. Add a test that makes the initial run insert throw and asserts close/DB cleanup and an error result.

### P2 — minute-resolution failures are counted but not attributable in the manifest

`resolveLogTimes` returns per-window failures, but recorder.ts lines 245–264 saves only anchors, boundaries, assignments, and one aggregate `timingUnresolved` count. Neither `result.failures` nor the range manifest records the failed boundary timestamps/reasons. The raw range is retained and logs become unresolved, which is correct, but an operator cannot distinguish an RPC boundary outage from another unresolved cause.

Include `resolution.failures` in the range artifact and summary failure/evidence section. Keep cursor advancement allowed for complete raw coverage, with timing explicitly labelled unresolved.

## Verified behavior

- CLI accepts only ordered safe ingest heights; follow requires a bounded duration and rejects `to-block`. The recorded RPC budget is distinct from the P0 probe budget.
- A failed or incomplete discovery batch is saved as raw evidence and prevents operation-scope acceptance. An incomplete operations batch returns `null` before `acceptRange`, so it cannot advance the cursor.
- Operation range handling rebuilds the `PoolRegistry` from persisted discovery and operation registrations for each range. Recovery reboots discovery before continuation, so forked persisted pool provenance is refreshed when a recovery occurs.
- Successful raw/operation acceptance flushes request evidence before committing accepted state. The manifest records provider alias, scope IDs, configuration and asset versions, range metadata, revisions, meter summary, and close failures.

The existing integration test covers initial bootstrap, idempotent restart, and a forked operation log. It does not cover normal post-start pool discovery, loss of a retained time proof, or initial-run persistence failure.
## Amendment — normal follow discovery (2026-09-08)

The first P1 finding is withdrawn. After the review, `src/ingest/record-range.ts` became available and shows that `fetchRange` always executes the discovery plan before building the operation plan, including when `mode: 'operations'`. Each normal follow range therefore performs the required two-pass discovery and can include a pool created in that same range. Bootstrap remains the historic cold-pool seed path. The remaining findings are unchanged.