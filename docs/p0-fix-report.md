# P0 review fixes — findings 1, 2, and 4

## Implemented

- Finding 1: capability probes retain the direct 10/20/100-block outcome and use bounded splitting after a range-limit response. Complete adaptive coverage is supported; rate limits and other unknown failures remain unknown. Code and call evidence now records hashes plus compact decoded metadata.
- Finding 2: fixture capture resolves minute boundaries before its final endpoint stability check. It compares resolver observations with all anchors already observed in the run, persists conflicting observations, and marks conflicts, unresolved time, or exhausted budget incomplete.
- Finding 4: config provides one timestamp hint for every configured V4 pool ID. Each bounded supplement queries only the Manager `Initialize` topic and target pool ID around the resolved hint. If V3 Swap evidence is still missing, capture reuses the first seed's resolved anchor for one bounded V3-only birth window without another global time search. The manifest reports each seed as `verified`, `invalid`, or `unverified`, and acceptance requires every seed to be verified.
- Capability and fixture manifests include SHA-256 identities for the parsed config and the locked V3/V4 ABI values.

## Configuration evidence

- AMC/USDG seed hint: `1788496435`.
- AMC/MEME seed hint: `1788467405`, derived from `2026-09-03T20:30:05Z` in `research/amc-meme/public-analysis/meme_amc_v4_detail.json`.
- Live RPC was deliberately not run during this fix; final probe and capture remain a separate verification step.

## Verification

- `node node_modules/vitest/vitest.mjs run tests/unit/capabilities.test.ts tests/unit/fixture-capture.test.ts`: 2 files passed, 15 tests passed.
- `pnpm typecheck`: passed (`tsc --noEmit`).
