# Incremental Valuation Assembly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `buildMetricsReport`'s valuation stage process O(changed events) per round instead of walking all ~361k events in the 3-hour window, by caching the assembled outputs across rounds.

**Architecture:** Extract the valuation loop into a pure `assembleValuations` function, then add an in-memory per-(database, scope) `AssemblyCache` (mirroring the existing `valuationIndexFor` WeakMap pattern in `src/metrics/valuation-index.ts`) that holds the four assembled outputs plus the event order. `buildMetricsReport` updates the cache incrementally (append for new events, truncate for a reorg suffix, expire for window slide-out) and falls back to a full rebuild on the triggers that change old events.

**Tech Stack:** TypeScript (Node), better-sqlite3, vitest, pnpm.

**Spec:** None. This plan is the authority. It implements the simplification agreed with the user: deletions in this system are always a contiguous suffix (reorg) or head (window aging), never scattered, so a quote cascade never leaves a surviving downstream swap to re-value — the "re-evaluate everything after the deleted quote" over-approximation is exact here and needs no per-quote dependency graph.

## Global Constraints

- Node + TypeScript, pnpm. Commands: `pnpm typecheck`, `pnpm lint`, `pnpm vitest run <files>`, `pnpm build`.
- Tests run from the worktree repo root. `node_modules` is already installed — do NOT run `pnpm install`.
- Every task ends with its own test cycle and a git commit (`perf(metrics): ...`).
- **The report shape must not change.** `MetricsReport`'s `valuations`, `quotes`, `rwa[].blockRangeActivity`, `rwa[].rolling`, `windows`, `grossFees` must stay byte-for-byte identical for the same input. Incremental and full paths must agree.
- **Fallback is mandatory, not optional.** The cache is an optimization; any path that cannot prove equivalence must fall back to the full walk. The full `assembleValuations` remains the source of truth.
- Preserve valuation semantics exactly (quote `effectiveAt < swap.ref`, age window, `numerator/denominator > 0`).
- Do not weaken an existing test. New behavior gets new tests.

---

### Task 1: Extract the valuation loop into a pure `assembleValuations`

**Files:**
- Create: `src/metrics/valuation-assembly.ts`
- Modify: `src/storage/metric-store.ts` (call the extracted function)
- Test: existing `tests/unit/windows.test.ts`, `tests/unit/valuation-index.test.ts`, `tests/dashboard/snapshot-worker.test.ts` (behavior must stay green)

**Interfaces:**
- Produces:
  ```ts
  export type ValuationAssembly = {
    quotes: QuoteIndex;
    valuations: SwapValuation[];
    metricEvents: MetricEvent[];
    valuedByRwa: Map<string, SwapValuation[]>;
  };
  export function assembleValuations(input: {
    events: readonly PoolEvent[];             // already sorted ascending by ref
    registrations: readonly PoolRegistration[];
    assetsByAddress: Map<string, AssetRegistration>;
    assets: AssetRegistry;                    // for input.assets.has / addresses
    usdg: Address;
    metadata: MetricMetadata;                 // reconciled metricMetadata
    sinceSec: number | null;
    inSelection: (event: PoolEvent) => boolean;
    valuationIndex: ValuationIndex | null;    // may be null
    cache: LiveMetricCache | null;            // durable cache, may be null
    scopeId: string;
    projectionEndTimestampSec: number;        // for the cache memo fallback minute
  }): ValuationAssembly;
  ```

- [ ] **Step 1: Move the loop.** In `src/storage/metric-store.ts`, find the `measureStage(options.timings, 'valuation', () => { ... })` block (starts right after `const valuedByRwa = new Map<...>()`, ends before `const windows = measureStage(...)`). Move its body verbatim into `assembleValuations` in the new file. The function receives the already-sorted events; it owns the `quotes`/`valuations`/`metricEvents`/`valuedByRwa` construction and returns them. Keep every guard exactly: the `related` asset lookup, `hasUsdg`, `findPrecedingQuote`, the `valuationIndex`/`cache`/`compute` triple, the `inWindow` gate, the non-selected quote publication, the `metricEvents.push` for selected events.

- [ ] **Step 2: Call it.** In `buildMetricsReport`, replace the moved block with:
  ```ts
  const sortedEvents = (() => { /* the isSorted-guarded copy from the current code */ })();
  const assembly = assembleValuations({
    events: sortedEvents,
    registrations,
    assetsByAddress,
    assets: input.assets,
    usdg: input.usdg,
    metadata: metricMetadata,
    sinceSec,
    inSelection,
    valuationIndex,
    cache,
    scopeId: input.scopeId,
    projectionEndTimestampSec: projection.end.timestampSec,
  });
  const { quotes, valuations, metricEvents, valuedByRwa } = assembly;
  ```
  (If any local used by the loop — e.g. `registrationFor` — is referenced, pass it or move it into the new file so the extraction compiles.)

- [ ] **Step 3: Run the full affected suite.** `pnpm typecheck && pnpm vitest run tests/unit/windows.test.ts tests/unit/valuation-index.test.ts tests/unit/rolling-windows.test.ts tests/dashboard/snapshot-worker.test.ts tests/dashboard/snapshot.test.ts`. All green, no behavior change.

- [ ] **Step 4: Commit.** `git add src/metrics/valuation-assembly.ts src/storage/metric-store.ts && git commit -m "refactor(metrics): extract valuation loop into assembleValuations"`.

---

### Task 2: Add `AssemblyCache` and incremental append/truncate/expire

**Files:**
- Modify: `src/metrics/valuation-assembly.ts`
- Test: `tests/unit/valuation-assembly.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export type AssemblyCache = {
    quotes: QuoteIndex;
    valuations: SwapValuation[];
    metricEvents: MetricEvent[];
    valuedByRwa: Map<string, SwapValuation[]>;
    /** refs parallel to the event order; used to find the truncation point and expire the head. */
    orderedRefs: LogRef[];
  };
  export function createAssemblyCache(): AssemblyCache;
  export function assemblyCacheFor(db: Database.Database, scopeId: string): AssemblyCache;
  export type AssemblyDelta = {
    /** newly inserted events, ascending by ref (already valued elsewhere). */
    appended: readonly EventContribution[];
    /** reorg point: every cached contribution with ref >= this is dropped. */
    truncateAfter: LogRef | null;
    /** window lower bound: every cached contribution with ref < this is dropped. */
    expireBefore: LogRef | null;
  };
  export type EventContribution = {
    ref: LogRef;
    quote: QuoteObservation | null;         // for the flat quotes.all
    valuation: SwapValuation | null;        // for valuations
    metricEvent: MetricEvent | null;        // for metricEvents
    assetValuations: readonly [Address, SwapValuation][]; // for valuedByRwa
  };
  export function applyAssemblyDelta(
    cache: AssemblyCache,
    delta: AssemblyDelta,
    assemble: (refs: readonly LogRef[]) => EventContribution[],
  ): void;
  ```

- [ ] **Step 1: Write the test.** `tests/unit/valuation-assembly.test.ts` — construct a cache, apply deltas, and assert the four outputs stay correct after: (a) pure append of two new events, (b) a truncateAfter that drops a suffix, (c) an expireBefore that drops the head, (d) a combined truncate+append (the reorg case). Assert `valuations`/`quotes.all`/`metricEvents`/`valuedByRwa` contents and order. Use tiny synthetic `SwapValuation`/`MetricEvent`/`QuoteObservation` objects — reuse the helpers style from `tests/unit/quote-index.test.ts` (bigint block numbers, `kind:'swap'`).

- [ ] **Step 2: Implement.** `createAssemblyCache` returns empty structures. `assemblyCacheFor` copies the `valuationIndexFor` WeakMap pattern. `applyAssemblyDelta`:
  1. If `expireBefore`, drop leading entries with `comparePosition(ref, expireBefore) < 0` (and their contributions from all four outputs).
  2. If `truncateAfter`, drop trailing entries with `comparePosition(ref, truncateAfter) >= 0` (contiguous suffix — walk `orderedRefs` from the end).
  3. Call `assemble(appendedRefs)` to compute contributions for the appended events only, then append them to the four outputs (assume appended refs are >= all retained refs; if the caller violates that, sort-insert).
  Keep `orderedRefs` in sync. Rebuild `quotes.byPair` from the retained+appended quotes so the index and `quotes.all` agree.

- [ ] **Step 3: Run.** `pnpm vitest run tests/unit/valuation-assembly.test.ts tests/unit/quote-index.test.ts && pnpm typecheck`. Green.

- [ ] **Step 4: Commit.** `git add src/metrics/valuation-assembly.ts tests/unit/valuation-assembly.test.ts && git commit -m "perf(metrics): add incremental assembly cache with append/truncate/expire"`.

---

### Task 3: Wire the cache into `buildMetricsReport` with a full-rebuild fallback

**Files:**
- Modify: `src/storage/metric-store.ts`
- Test: `tests/dashboard/snapshot-worker.test.ts`, `tests/unit/windows.test.ts` (must stay green)

**Interfaces:**
- Consumes: `assemblyCacheFor`, `applyAssemblyDelta`, `assembleValuations` from `src/metrics/valuation-assembly.js`.

- [ ] **Step 1: Decide cache eligibility.** In `buildMetricsReport`, after computing `changes` (the `LiveProjectionChanges`) and `metricMetadata`, compute a boolean `incrementalOk`:
  ```ts
  const metadataChanged = /* metadata revision differs from the revision the cache was built under */;
  const incrementalOk =
    workset !== null &&
    changes?.eventDelta !== undefined &&
    !metadataChanged;
  ```
  The assembly cache is orthogonal to the valuation-result cache (`valuationIndex` vs the durable `cache`): both the recorder and the dashboard worker pass `changes.eventDelta`, and either valuation-result cache still values only the NEW events. Track the metadata revision inside the cache by adding an optional `metadataRevision: number | string | null` field to `AssemblyCache` (default `null`); when it is `null` or differs from `input.metadata.version`, treat the cache as cold. On any exception during the incremental path, reset the cache to `createAssemblyCache()` and fall through to the full path.

- [ ] **Step 2: Full path (unchanged semantics).** When `!incrementalOk`, run `assembleValuations` over the full sorted event set exactly as Task 1, then rebuild the cache from those four outputs (so the next round can be incremental) and stamp its `metadataRevision`.

- [ ] **Step 3: Incremental path.** When `incrementalOk`, derive the delta from `changes.eventDelta`:
  - `upserts` → appended contributions, computed by `assembleValuations` over only the upsert events (pass the same metadata/registrations/quote index context). Re-use the cached valuations for unchanged events.
  - `deletedKeys` → `truncateAfter` = the smallest ref among the deleted events (they are a contiguous suffix; assert this and fall back to full path if the deleted refs are not a suffix).
  - Window slide → `expireBefore` = the window's new lower bound (same value `sinceSec - 120` the existing `expireOutside`/`expireBefore` uses).
  Then `applyAssemblyDelta(cache, delta, ...)` and read the four outputs from the cache. Assemble the report from those outputs (the downstream `windows`/`rwa`/`grossFees` still run as today over the assembled arrays).

- [ ] **Step 4: Verify equivalence.** Add a test (in `tests/unit/valuation-assembly.test.ts` or a new `tests/unit/valuation-incremental.test.ts`) that builds a small synthetic event set, runs the FULL path and the INCREMENTAL path (simulate two rounds: round 1 full over N events, round 2 incremental over N+k events), and asserts the four outputs are identical. Run `pnpm typecheck && pnpm vitest run tests/unit/valuation-assembly.test.ts tests/unit/windows.test.ts tests/dashboard/snapshot-worker.test.ts`.

- [ ] **Step 5: Commit.** `git add src/storage/metric-store.ts src/metrics/valuation-assembly.ts && git commit -m "perf(metrics): incremental valuation assembly with full-rebuild fallback"`.

---

### Task 4 (deferrable): Make `#eventDelta` incremental

**Files:**
- Modify: `src/dashboard/snapshot-worker.ts`

**Interfaces:**
- Consumes: the `LiveEventIndex` API in `src/storage/live-event-index.ts`; the recorder already receives `changes` from `LiveProjectionStore.sync`, so this task is dashboard-worker-only.

- [ ] **Step 1: Find the scan.** `#eventDelta()` currently calls `this.#index!.eventsFor(this.#index!.pools())` and rebuilds the full `revisions` map. This is the remaining O(n) scan. Investigate `LiveEventIndex` for an already-available "events changed since <position/block>" accessor (the projection sync necessarily knows the delta); if one exists, use it to produce `upserts`/`deletedKeys` without walking all events. If no such accessor exists, STOP and report BLOCKED with the finding — do not invent a new index in this task.

- [ ] **Step 2: If an accessor exists**, replace the scan, run `tests/dashboard/snapshot-worker.test.ts` + `tests/unit/valuation-index.test.ts`, and commit `perf(dashboard): incremental event delta for the snapshot worker`.

## Notes for the executor

- Tasks 1–3 are the deliverable the user asked for. Task 4 is explicitly deferrable and may return BLOCKED.
- The hard correctness rule is **fallback**: the incremental path must only run when it can prove it matches the full path (warm cache, unchanged metadata, suffix-shaped deletions). Everything else recomputes.
- Do not touch `findPrecedingQuote` or `valueSwap` semantics — Tasks 1–3 reuse them as-is.
