# P0 identity verification report

## Implemented verification scope

`verifyIdentity(reader, config, anchor)` is a read-only, fixed-anchor verifier for Robinhood Chain (chain ID 4663). It performs the following checks through the supplied `EvidenceReader`:

- rejects the run at the chain gate unless `eth_chainId` is exactly 4663;
- reads bytecode at the supplied anchor for the configured V3 factory, V4 PoolManager, StateView, AMC, USDG, and every configured V3 pool, recording `keccak256` code hashes for non-empty code;
- calls `decimals()` for AMC and USDG at the same anchor;
- calls each V3 pool's `factory()`, `token0()`, `token1()`, and `fee()`, then checks the configured factory's `getPool(token0, token1, fee)` result against that pool;
- optionally calls `StateView.poolManager()` and records whether it agrees with the configured V4 PoolManager. Failure of this optional call does not invalidate otherwise complete current identity evidence;
- treats deployment candidate block 9070 as a search hint for the V3 factory and V4 PoolManager. It proves the immediately preceding block when the candidate is the first-code block, binary-searches earlier history when code already exists there, or searches between 9071 and the verification anchor when deployment occurred later;
- re-reads the fixed anchor by number after all identity requests and rejects the result if its block hash changed during verification.

The report deliberately separates `currentIdentityStatus` from the aggregate `status`. Current identity can be verified while deployment history remains unverified. `requiredPassed` follows the required current identity checks because historical state is an optional P0 capability. The aggregate `status` remains `unverified` until both deployment boundaries are also verified, so callers cannot mistake missing historical evidence for a complete identity record.

## RPC budget and failure handling

All requests go through `EvidenceReader.request`, so the reader's shared `RequestMeter` enforces its configured maximum of 150 calls, including retries. Deployment searches use this same budget. Before each optional historical request, the search reserves capacity for its maximum two retries and one mandatory final anchor read. If that capacity is unavailable, deployment evidence stops as `RPC optional-budget-reserved`; required current identity can still pass and the fixed anchor can still be rechecked. A provider error, unsupported historical state, exhausted request budget, malformed response, missing code, or inconsistent callable identity is retained as an explicit `unverified` result with a reason; it is not converted to absence or success. Caught request errors are reduced to the controlled `RpcFailure` classification, so provider URLs, credentials, and arbitrary exception text are not copied into the report.

## Verification limits

This module does not itself make a live RPC run or write `artifacts/p0/identity-evidence.json`; its output is the structured evidence intended for that coordinated capture step. It also does not validate V4 pool IDs. V4 `Initialize` event capture and PoolKey hash validation are handled by the capture workflow so the event's five PoolKey fields can be tied to the same block evidence.

Code presence and code hash establish bytecode continuity at a block, while V3 callable checks establish the configured pool/factory/token relationship. They do not prove source-code equivalence, proxy implementation identity, token economics, issuer backing, liquidity, or tradability. Official upstream deployment and contract-source cross-checks remain separate evidence and must be attached to the final P0 artifact.

## Local verification

- `node node_modules/vitest/vitest.mjs run tests/unit/identity.test.ts`: 8 tests passed.
- `node node_modules/typescript/bin/tsc --noEmit`: passed.
