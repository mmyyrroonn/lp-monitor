# P1 Task 1.2 Discovery and Continuous Range Report

Date: 2026-09-08
Branch: feat/p1-recorder
Scope: Task 1.2 only. No live RPC calls and no commits.

## Outcome

Implemented two-pass Uniswap V3/V4 pool discovery and range recording.

- Discovery scans both observed-asset topic positions for V3 PoolCreated and V4 Initialize, then unions logs by immutable raw identity.
- Normal recording builds its operation filter from the known plus staged pool set and scans the entire original range again. A pool created at block 100 can therefore contribute Initialize, Mint/ModifyLiquidity, and Swap logs later in block 100.
- Discovery-only mode has a separate scope and records only the four sparse discovery filters. Callers control its large chunk size independently from the normal 1,000-block default.
- Scope identity binds chain, asset version and sorted asset set, protocol deployments, protocols, and event families. Pool membership and concrete shards do not change scope identity.
- V4 registrations retain manager, full PoolId, currencies, fee, tick spacing, and hooks. Same currencies with different fee/hooks remain distinct pools.
- Explicit config seeds can bootstrap operation filters. A later metadata-equivalent on-chain event replaces seed provenance.
- fetchRange does not mutate PoolRegistry. Complete batches return the full known plus staged poolRegistrations snapshot; callers register it only after storage accepts the batch. Incomplete batches return no registrations.
- The local response guard is combined with the known provider cap using the smaller positive value. Capped/range-limit responses split by block range, then by address and topic alternatives for a single block. An indivisible capped leaf is truncated and incomplete.
- maxFilterValues defaults to the verified value 1,000. The planner proactively creates the Cartesian product of address and topic-OR chunks while keeping stable discovery-v3, discovery-v4, operation-v3, and operation-v4 filter families. The 1,810-pool fixture produces 1,000 and 810 pool-ID requests.
- Explicit -32602 provider errors containing a topic/address/filter overflow are classified as filter-limit. Generic -32602 invalid arguments remain request-failed. Reactive fallback splits address/topic values before block ranges for smaller providers. Evidence-write failures are handled before adaptation: P0 throws immediately, while recorder capture records one incomplete leaf without further RPC calls.
- Each leaf records its exact filter request, status, actual RPC response hash, unique log keys, count, and safe error kind. Batch and filter-plan hashes are deterministic.
- A critical failure in a later leaf can be captured by the recorder without discarding earlier successful leaves. The P0 fetch API retains its default throw behavior.
- Conflicting duplicate raw identities within a response or across split leaves make the range incomplete while retaining one canonical log and the original response hash/error evidence.
- The requested end anchor is re-read after both passes. End-anchor changes, end-block log hash disagreement, or mixed hashes at one height make the batch incomplete.

## Public APIs

- registry/assets.ts: AssetRegistry, createAssetRegistry, loadAssetVersion
- registry/pools.ts: PoolRegistration, PoolRegistry, poolRegistrationId
- protocols/uniswap-v3/discover.ts: discoverPools
- protocols/uniswap-v4/discover.ts: discoverPools, V4PoolIdMismatchError
- ingest/filter-plan.ts: computeWatchScopeId, buildDiscoveryFilterPlan, buildOperationFilterPlan
- ingest/fetch-range.ts: fetchBoundedLogs with optional critical-failure capture
- ingest/record-range.ts: fetchRange returning RangeRecordingBatch, a RecordedRangeBatch with recordingErrors
- rpc/errors.ts: explicit provider filter-limit classification

## TDD Evidence

- Initial discovery suite failed because record-range.ts did not exist.
- The seed replacement fixture failed with an incomplete batch before registry merge semantics were added.
- The later-budget fixture failed by losing the earlier successful log before partial-result capture was added.
- Same-response and cross-leaf conflicting identity fixtures both failed before conflict detection was added.
- The 1,810-pool fixture failed on the synthetic provider before proactive value sharding was added.
- The reactive filter-limit and -32602 classification fixtures failed before the fallback and narrow classifier were added.
- Both evidence-failure guard-order fixtures failed before the critical guard was moved ahead of reactive splitting.

## Verification

Focused verification after the functional edits:

- pnpm exec vitest run tests/integration/discovery.test.ts tests/unit/fixture-capture.test.ts tests/unit/rpc-review.test.ts
  - 3 files passed
  - 73 tests passed
- pnpm typecheck
  - passed after maxFilterValues and strict undefined guards were added
- Prettier was applied to the assigned source, compatibility edits, and focused tests.
- verifySuccessfulShardCoverage accepts the complete same-block batch in the integration suite.

The full P1 and repository suites, build, lint, and bounded live run are owned by the root integration pass.
