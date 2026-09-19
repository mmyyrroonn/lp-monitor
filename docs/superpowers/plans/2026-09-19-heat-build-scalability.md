# Heat Build Scalability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the dashboard metric build from ~18s to a few seconds (so the 10s snapshot-refresh watchdog stops killing the worker), and stop the recorder from crashing when the RPC provider has a sustained outage.

**Architecture:** Three independent fixes. (1) Replace the O(n²) linear `findPrecedingQuote` scan with a per-(token,quote) index so cross-pair swap pricing becomes O(1). (2) Remove per-event O(assets) and redundant-sort overhead in the valuation loop of `buildMetricsReport`. (3) Add growing backoff to the follow loop so a provider outage pauses instead of burning the RPC budget until `budget`/`incomplete-range` throws.

**Tech Stack:** TypeScript (Node), better-sqlite3, vitest, pnpm.

**Spec:** None written. This plan is the authority. Root-cause evidence lives in the session: 361,515 events (307,690 swaps) in the 3h live window; recorder stage timings show `valuation: 9.0s` with only `valuationComputes: 186` (so the time is loop overhead, not math); `findPrecedingQuote` is a linear scan over ~102k accumulated quotes called ~206k times.

## Global Constraints

- Node + TypeScript, pnpm. Commands: `pnpm typecheck`, `pnpm lint`, `pnpm vitest run <files>`, `pnpm build`.
- Tests run from the repo root of THIS worktree: `E:/lp-monitor/.worktrees/fix-heat-build-scalability`.
- `node_modules` is already symlinked to the main checkout — do not run `pnpm install`.
- Every task ends with its own test cycle and a git commit. Commit messages follow `perf(...)` / `fix(...)` convention.
- Do not change public report shape (`MetricsReport`) unless a task explicitly says so. The report's `quotes` field must still be the flat, in-event-order array.
- Existing tests must keep passing; add new tests for the changed behavior. Do not weaken an existing assertion to make it pass.
- Preserve exact valuation semantics: a quote is only usable if `effectiveAt < swap.ref`, `age >= 0`, `age <= min(maxQuoteAgeSec, candidate.maxAgeSec)`, and `numerator/denominator > 0`.

---

### Task 1: Index quotes so `findPrecedingQuote` is O(1) per call

**Files:**
- Modify: `src/metrics/price.ts` (the `findPrecedingQuote` function and a new index type + helpers)
- Modify: `src/storage/metric-store.ts` (the valuation loop callers — the `quotes` array usage)
- Modify: `src/ops/history.ts` (the `findPrecedingQuote` caller)
- Test: `tests/unit/notional.test.ts` or `tests/unit/swap-direction.test.ts` — add a new focused test file `tests/unit/quote-index.test.ts`

**Interfaces:**
- Consumes: `QuoteObservation`, `Swap`, `LogRef`, `LogTime`, `Address` from `src/domain/types.js`.
- Produces:
  ```ts
  export type QuoteIndex = { byPair: Map<string, QuoteObservation[]>; all: QuoteObservation[] };
  export function createQuoteIndex(): QuoteIndex;
  export function addQuote(index: QuoteIndex, quote: QuoteObservation): void;
  export function findPrecedingQuote(
    swap: Swap, token: Address, quoteToken: Address,
    index: QuoteIndex, maxQuoteAgeSec: number,
  ): QuoteObservation | null;
  ```

- [ ] **Step 1: Write the failing test** — `tests/unit/quote-index.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { createQuoteIndex, addQuote, findPrecedingQuote } from '../../src/metrics/price.js';
import type { QuoteObservation, Swap } from '../../src/domain/types.js';

const ref = (blockNumber: number, logIndex = 0) => ({
  blockNumber, blockHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
  transactionHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
  transactionIndex: 0, logIndex,
});
const time = (ts: number) => ({ source: 'verified', minuteStartSec: ts, exactTimestampSec: ts });
const swapAt = (blockNumber: number, tokenIn: string, tokenOut: string): Swap => ({
  ref: ref(blockNumber), time: time(blockNumber * 10), tokenIn, tokenOut,
  rawAmount0: -1n, rawAmount1: 1n, amountIn: 1n, amountOut: 1n,
  sqrtPriceX96After: 1n, liquidityAfter: 1n, tickAfter: 0, effectiveSwapFeePips: 0,
  pool: { chainId: 4663, protocol: 'v3', address: '0x00'.repeat(20) },
});
const quote = (blockNumber: number, token: string, quoteToken: string): QuoteObservation => ({
  token, quote: quoteToken, numerator: 1n, denominator: 1n,
  effectiveAt: ref(blockNumber), time: time(blockNumber * 10),
  source: 'rwa-usdg-swap', maxAgeSec: 60,
});

describe('quote index', () => {
  it('finds the latest preceding quote for the matching pair only', () => {
    const idx = createQuoteIndex();
    const TOKEN_A = '0x' + 'a'.repeat(40);
    const TOKEN_B = '0x' + 'b'.repeat(40);
    const USDG = '0x' + 'd'.repeat(40);
    addQuote(idx, quote(5, TOKEN_A, USDG));
    addQuote(idx, quote(10, TOKEN_A, USDG));
    addQuote(idx, quote(7, TOKEN_B, USDG)); // different pair, must be ignored
    const found = findPrecedingQuote(swapAt(12, TOKEN_A, TOKEN_B), TOKEN_A, USDG, idx, 60);
    expect(found?.effectiveAt.blockNumber).toBe(10);
  });
  it('rejects quotes that are too old', () => {
    const idx = createQuoteIndex();
    const TOKEN_A = '0x' + 'a'.repeat(40);
    const USDG = '0x' + 'd'.repeat(40);
    addQuote(idx, quote(1, TOKEN_A, USDG)); // effectiveAt block 1, time 10
    const swap = swapAt(1000, TOKEN_A, '0x' + 'e'.repeat(40)); // time 10000
    expect(findPrecedingQuote(swap, TOKEN_A, USDG, idx, 60)).toBeNull();
  });
  it('keeps the flat all[] array in insertion order for the report', () => {
    const idx = createQuoteIndex();
    addQuote(idx, quote(5, '0x' + 'a'.repeat(40), '0x' + 'd'.repeat(40)));
    addQuote(idx, quote(6, '0x' + 'b'.repeat(40), '0x' + 'd'.repeat(40)));
    expect(idx.all.map((q) => q.effectiveAt.blockNumber)).toEqual([5, 6]);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails** (compile error: `createQuoteIndex` not exported). Run: `pnpm vitest run tests/unit/quote-index.test.ts`.

- [ ] **Step 3: Implement** in `src/metrics/price.ts`:
  - Keep `compareRef`, `interval`, `upperAgeSec` as-is.
  - Add `const pairKey = (token: string, quoteToken: string) => token.toLowerCase() + '|' + quoteToken.toLowerCase();`
  - Add `QuoteIndex`, `createQuoteIndex`, `addQuote` as above. `addQuote` pushes to `all` AND to `byPair.get(pairKey)??[]` (append-only).
  - Rewrite `findPrecedingQuote` to look up the bucket and scan BACKWARD (bucket is append-only in `effectiveAt` order), returning the first candidate where `compareRef(candidate.effectiveAt, swap.ref) < 0`, `numerator/denominator > 0`, and `age` is non-null, `>= 0`, `<= Math.min(maxQuoteAgeSec, candidate.maxAgeSec)`. When `age > maxQuoteAgeSec`, `break` (older entries are strictly older).
  - Keep the old function's exported name so the signature change is intentional; remove the old `quotes: readonly QuoteObservation[]` parameter.

- [ ] **Step 4: Update callers.**
  - `src/storage/metric-store.ts`: replace `const quotes: QuoteObservation[] = []` with `const quotes = createQuoteIndex()`. Replace every `quotes.push(quote)` with `addQuote(quotes, quote)`. Replace `findPrecedingQuote(event, asset.address, input.usdg, quotes, 60)` with `findPrecedingQuote(event, asset.address, input.usdg, quotes, 60)` (signature unchanged at the call site). Replace the report field `quotes,` with `quotes: quotes.all,`.
  - `src/ops/history.ts`: same replacement — `quotes` becomes a `QuoteIndex`, `quotes.push(quote)` becomes `addQuote(quotes, quote)`, and `findPrecedingQuote(swap, metadata.rwa, metadata.usdg, quotes, metadata.maxQuoteAgeSec ?? 60)` keeps its call shape. The report field for quotes becomes `quotes.all`.

- [ ] **Step 5: Run tests.** `pnpm vitest run tests/unit/quote-index.test.ts tests/unit/notional.test.ts tests/unit/windows.test.ts tests/unit/swap-direction.test.ts` then `pnpm typecheck`. Expected: all green.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "perf(metrics): index quotes so cross-pair pricing is O(1)"`.

---

### Task 2: Remove per-event overhead in the valuation loop

**Files:**
- Modify: `src/storage/metric-store.ts` (the valuation loop inside `buildMetricsReport`)
- Test: `tests/unit/windows.test.ts` (or existing metric-store tests) — add a regression test only if one exists that exercises `buildMetricsReport`; otherwise verify via the existing `windows.test.ts` / `valuation-index.test.ts` suites.

**Interfaces:**
- Consumes: `AssetRegistry` (already imported), `MetricInput.assets`.
- Produces: no public API change. Behavior identical; only speed changes.

- [ ] **Step 1: Precompute an asset lookup map.** At the top of the valuation stage (right after `const quotes = createQuoteIndex()` from Task 1), add:
  ```ts
  const assetsByAddress = new Map(input.assets.assets.map((a) => [a.address.toLowerCase(), a]));
  ```
  Then replace the per-event filter
  ```ts
  const related = input.assets.assets.filter(
    (a) => a.address === registration.token0 || a.address === registration.token1,
  );
  ```
  with a direct lookup of the two pool tokens:
  ```ts
  const related = [assetsByAddress.get(registration.token0), assetsByAddress.get(registration.token1)]
    .filter((a): a is (typeof input.assets.assets)[number] => a !== undefined);
  ```
  (A pool where neither side is a tracked asset yields an empty list, exactly as the filter did.)

- [ ] **Step 2: Stop re-sorting already-ordered events.** The loop currently does `[...projection.events].sort((a, b) => comparePosition(a.ref, b.ref))`. Confirm `projection.events` is already delivered in log order (the projection store appends in order). If it is, replace the sort with a shallow copy `[...projection.events]` (keep the copy so iteration does not mutate the projection). Verify by running the existing `valuation-index.test.ts` and `windows.test.ts` — if any test depends on the sort ordering being applied, keep the sort only when the array is not already ordered; simplest correct form: retain the sort, but guard it behind a cheap `isSorted` scan that returns `false` on the first inversion. Either way, the loop must still process events in ascending `comparePosition` order.

- [ ] **Step 3: Run tests.** `pnpm vitest run tests/unit/windows.test.ts tests/unit/valuation-index.test.ts tests/unit/rolling-windows.test.ts tests/dashboard/snapshot-worker.test.ts` then `pnpm typecheck`. Expected: all green.

- [ ] **Step 4: Commit.** `git add -A && git commit -m "perf(metrics): avoid per-event asset filter and redundant sort in valuation"`.

---

### Task 3: Back off on sustained RPC failure instead of crashing

**Files:**
- Modify: `src/ingest/follow.ts` (the retry catch in `follow`)
- Modify: `src/ops/recorder.ts` only if the `sleep`/`poll` options are not already threaded through (check `FollowOptions.sleep` / `pollIntervalMs` are passed).
- Test: `tests/unit/` — find the follow-loop test file (search `rg -l "follow(" tests/unit`) and add a backoff regression test there.

**Interfaces:**
- Consumes: `FollowOptions` (already has `sleep` and `nowMs` and `pollIntervalMs`).
- Produces: no public API change. New behavior: consecutive retryable failures increase the wait before the next range attempt, and a successful range resets the wait.

- [ ] **Step 1: Locate the retry catch.** In `src/ingest/follow.ts`, the `catch (error)` block that currently does `result.failures.push(error.kind); gap = true;` is where consecutive failures are swallowed and the outer `do/while` re-enters after `sleep(poll)`.

- [ ] **Step 2: Write the failing test.** Add a test that runs `follow` with a `recordRange` that throws a retryable `RpcFailure('request-failed', undefined, true)` the first N calls then succeeds, and a fake `sleep` that records delays. Assert that after consecutive failures the delay grows (e.g. `poll * 2^consecutive` capped at a max), and that one success resets it back to `poll`. If no follow-loop test file exists, create `tests/unit/follow-backoff.test.ts` with the same `follow` import used by existing tests.

- [ ] **Step 3: Implement.** Track `let consecutiveFailures = 0` outside the `do` loop. In the retry catch, increment it. In the success path (after a range is accepted), reset it to 0. Replace the end-of-loop `await sleep(Math.min(poll, ...))` with a backoff:
  ```ts
  const backoffMs = Math.min(poll * 2 ** Math.min(consecutiveFailures, 5), 60_000);
  await sleep(Math.min(backoffMs, Math.max(0, stopAtMs - now())));
  ```
  Keep `poll` as the floor for the healthy case (`consecutiveFailures === 0` → `poll`). A non-retryable error (including `budget`) must still `throw` exactly as today — the backoff only spaces out retryable failures.

- [ ] **Step 4: Run tests.** `pnpm vitest run tests/unit/follow-backoff.test.ts` plus the recorder/follow suites already in `tests/unit` (`rg -l "follow(" tests/unit`), then `pnpm typecheck`. Expected: all green.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "fix(ingest): exponential backoff on sustained RPC failure"`.

---

## Notes for the executor

- Task order matters: Task 1 changes `findPrecedingQuote`'s parameter type, so Task 2's loop must be applied on top of Task 1's `createQuoteIndex()` (not the old flat array).
- The full "skip walking all 361k events every round" (true incremental valuation) is intentionally NOT in this plan — it needs cached per-round derived structures and carries reorg/quote-invalidation risk. Tasks 1+2 remove the O(n²) and the per-event overhead, which is what the 9s `valuation` stage is made of; the remaining walk is cheap.
