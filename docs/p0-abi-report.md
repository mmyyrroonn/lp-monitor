# P0 ABI / PoolKey foundation report

Date: 2026-09-08. Scope: Task 0.2 ABI provenance, V4 PoolKey hashing, and strict event decoding. No RPC request, wallet client, transaction construction, or chain identity claim was made here.

## Delivered boundary

- `scripts/vendor-abis.mjs` verifies the exact installed package versions and generates `as const satisfies Abi` exports without hand-authored ABI fields:
  - `v3FactoryAbi` and `v3PoolAbi` from `@uniswap/v3-core@1.0.1`;
  - `v4ManagerAbi` from `@uniswap/v4-core@1.0.2`.
- The generator copies each official artifact, the relevant Solidity source, and its notice/license into `artifacts/p0/upstream/`. `artifacts/p0/dependency-evidence.json` records immutable package-version URLs, SPDX identifiers where available, and SHA-256 values for every copied input.
- `computeV4PoolId` uses `viem.encodeAbiParameters` plus `keccak256` over the official five-field order: `address,address,uint24,int24,address`. It rejects unsorted/equal currencies and values outside uint24/int24 before hashing.
- `decodeV4ManagerEvent` and `decodeV3PoolEvent` use viem `decodeEventLog` with `strict: true`. Unknown or missing topic 0 produces an explicit error; known but malformed V4 data produces a separate decode error.
- `tests/unit/abi.test.ts` cross-checks the runtime V4 hash against the pure `@uniswap/v4-sdk@2.3.3` `Pool.getPoolId` calculation using `@uniswap/sdk-core@7.19.2` tokens. The SDK is dev-only; runtime logic uses viem only.

## Provenance and license boundary

`@uniswap/v3-core` declares package license `BUSL-1.1`; its selected interfaces report SPDX `GPL-2.0-or-later`. `@uniswap/v4-core` declares package license `BUSL-1.1`, while selected `IPoolManager.sol` reports SPDX `MIT` and its MIT notice is copied. The evidence records both levels instead of inferring one from the other.

The lp-terminal reference remains read-only: fixed commit `c127e70a2a21ca40f5668d155587e36e80049277`, MIT, with no application code copied. Its Robinhood StateView candidate `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` is evidence-only and explicitly unverified.

## Verification

TDD red phase: `node node_modules/vitest/vitest.mjs run tests/unit/abi.test.ts` initially failed because the new protocol module did not exist. After generation and implementation, the same test file passed 6/6.

Regenerate and verify the provenance artifacts after an intentional exact-version upgrade:

```powershell
node scripts/vendor-abis.mjs --verified
node node_modules/vitest/vitest.mjs run tests/unit/abi.test.ts
```

The ABI test loads the Uniswap SDK distribution, which emits upstream missing-source-map warnings in Vitest; all six assertions pass. The workspace-wide `tsc --noEmit` remains blocked by concurrent P0 files outside this task: missing `src/rpc/capabilities.ts` and `src/ops/fixture-capture.ts` imports from their corresponding tests. No ABI/PoolKey type error was reported.
