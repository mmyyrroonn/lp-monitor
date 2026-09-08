# P0 independent review — 2026-09-08

Scope: START_HERE.md, P0 plan, src/, tests/, scripts/, config/, package.json. Read-only application review; no RPC, transaction, full test run, or application edits. Findings refer to the source snapshot reviewed before remediation; concurrent fixes may supersede them.

## Actionable findings

1. **[P2] Accept smaller supported getLogs ranges when a larger probe is rejected.** `src/rpc/capabilities.ts:51` marks each 10/20/100-block direct query required. A provider supporting 20-block ranges but rejecting 100-block queries produces `requiredPassed: false`, and the CLI never attempts identity verification even though the capture implementation can split the same query successfully. Keep size observations separate from the required bounded-range capability; retry/split an oversized probe under the shared call budget. Validate with a mocked endpoint accepting at most 20 blocks.

2. **[P2] Recheck range stability after collecting minute anchors.** `src/ops/fixture-capture.ts:79` freezes `stable`/`complete` before lines 87–94 query endpoint and minute anchors again through a new resolver. If a reorg occurs between these steps, rangeEvidence retains old endpoint hashes while anchors.json and time-boundaries.json can contain the new fork; no failure is recorded and acceptance can pass. Include time resolution inside the protected capture interval and compare the final range endpoints against the original anchors; detect conflicts across the anchors persisted for the run. Validate with a fake reader changing its fork only when minute resolution starts.

3. **[P2] Reserve required verification budget before optional deployment search.** `src/rpc/identity.ts:183` starts optional deployment binary searches before the mandatory recheck at line 188. If optional searches consume the shared call budget, the recheck throws, the CLI skips report persistence, and otherwise verified current identity fails solely because of optional history work. Reserve the required recheck call, stop optional search within its remaining allowance, and retain unverified optional evidence. Parent/identity agent have acknowledged this and are fixing it.

4. **[P2] Require target V4 seed evidence separately from arbitrary Initialize fixtures.** `src/ops/fixture-capture.ts:54` records `configuredSeed`, but acceptance at line 126 only requires any valid Initialize; `verifyIdentity` does not verify configured V4 pool IDs. A valid-length typo in config.v4PoolIds can coexist with successful probe/fixture acceptance using an unrelated Manager Initialize event. Expose per-seed verification from matching Initialize logs and bind the P0 target identity gate to those results. Preserve bounded missing-evidence results. Parent has acknowledged this and is adding bounded second-seed capture.

## Other checks

- Request transport has an explicit read-only method allowlist, disables viem retries, applies a 10-second configured maximum, records retries in the shared 150-call budget, and spaces requests at a configured maximum of 5 RPC/s. Configuration validates these maxima. Error persistence uses classifications rather than provider messages.
- Header lookups are sparse endpoints and binary-searched minute boundaries; no per-block header loop found.
- ABI generation copies the locked official V3/V4 artifacts rather than hand-writing events. Recomputed all 11 recorded ABI/source/license SHA256 values: all matched local vendored files. SDK PoolId cross-check exists in the unit tests. This verifies local evidence integrity, not an independent remote-source attestation.
- Existing fixture integration test verifies file hashes and independently decodes stored logs with ethers, but does not test the four failure scenarios above.
- No additional actionable defects identified in this bounded review. Existing passing tests and live results were not independently rerun.

## Narrow re-review after remediation

Reviewed the actual updated capabilities, fixture capture, identity verifier, CLI persistence, request transport/rate limiter, relevant regression tests, and the two fix reports. No RPC or test execution was performed in this re-review.

- **Finding 1 resolved:** direct range-limit outcomes now trigger bounded splitting for size probes and consistency checks. Tests cover endpoints limited to 10 and 20 blocks. Unknown/transient failures still do not become supported.
- **Finding 2 resolved:** minute resolution now precedes the final endpoint checks, and observed anchor conflicts make the overall manifest incomplete. The new mocked fork-change regression targets this ordering.
- **Finding 3 resolved:** optional deployment requests reserve capacity for their attempts and a final anchor read; exhaustion remains an optional unverified result. The budget regression checks that current identity still passes and the final anchor is read. CLI also persists classified identity failure and capability reports within the run directory.
- **Finding 4 resolved:** manifests now expose verification for every configured V4 seed, and acceptance requires all seeds to have valid matching Initialize evidence. Configured timestamp hints drive bounded, seed-filtered supplements; the missing-seed regression preserves explicit unverified results.

No remaining actionable issue identified in this narrow remediation review. This closes the four source findings; final full-suite, build, and live RPC acceptance remain the coordinating agent's verification responsibility. Earlier findings above are retained as the review history rather than current defects.
