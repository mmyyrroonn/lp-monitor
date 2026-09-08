# P0 sparse time resolver report

Date: 2026-09-08

## Implemented contract

`createTimeResolver(reader)` creates an isolated resolver with no global RPC state. Its
`resolveBlockAtOrAfter(timestampSec, bounds?)` method performs a lower-bound binary
search over block anchors and returns the first block whose timestamp is greater than
or equal to the target.

- Explicit bounds are inclusive. Without bounds, the resolver searches from block 0
  through the anchor returned for `latest`.
- Targets must be positive safe integers. Bounds must be ordered, nonnegative bigint
  values, and the target must fall within their timestamp range.
- Sampled timestamps must be positive safe integers except for the observed Robinhood
  genesis anchor: block 0 may legitimately have timestamp 0. Timestamp 0 on any later
  block remains invalid.
- The resolver queries the returned block's immediate predecessor (except at genesis)
  and requires its timestamp to be lower than the target. This makes duplicate-second
  blocks resolve to the first matching block.
- Queried anchors are cached by block number and exposed as the sorted read-only
  `queriedAnchors` property. Repeated searches reuse the cache.
- Every newly sampled anchor is checked against cached samples. A timestamp decrease
  as block number increases aborts the search as nonmonotonic rather than hiding the
  contradiction with interpolation.

The algorithm queries sparse endpoints and binary-search midpoints. It does not read
every block header or keep a full header ledger.

## Verification

- RED: the focused suite failed because `src/rpc/resolve-time.ts` did not exist.
- GREEN: `node node_modules/vitest/vitest.mjs run tests/unit/resolve-time.test.ts`
  passed 14 tests, including the block-0 timestamp-0 regression case.
- Targeted strict TypeScript verification of the resolver, its domain contract, and
  its test passed with no diagnostics.
- The repository-wide typecheck was also attempted, but other concurrently assigned
  P0 modules were still absent (`pool-key`, `errors`, `request-meter`, `capabilities`,
  `client`, and `fixture-capture`). Those unrelated missing modules prevent a clean
  full-project result at this point.
