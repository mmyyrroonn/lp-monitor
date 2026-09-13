# Token heat dashboard implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated tasks and independent code review. Steps use checkbox syntax.

**Goal:** Implement the approved Chinese local token heat dashboard: rankings, minute heatmap, token drawer, favorites and runtime health.
**Architecture:** A loopback-only HTTP server serves compiled browser TypeScript and local assets. A read-only snapshot adapter reuses the existing fresh metrics report and bounded chain-time evidence. No RPC is sent by the dashboard.
**Tech Stack:** Node.js 24, existing TypeScript and SQLite dependencies; browser-native DOM/CSS/SVG, no external runtime dependencies.

## Global Constraints
- Source is the selected DB/config/watchlist, defaulting to existing CLI defaults. No new collection, historical acquisition, wallet, orders, permanent service or notifications.
- Preserve null/unknown, scope boundaries, provisional finality, USDG valuation assumption and shared-stock participation accounting.
- Same-window comparisons use preceding equal duration at a chain-time cutoff; missing coverage/boundary time never becomes zero. Never show a zero-denominator percentage.
- Only registered RWA categories are classified; unsupported Meme classification is explicitly unavailable.
- Serve on 127.0.0.1, with allowlisted static paths, GET-only API, no credentials or filesystem mutation endpoints. Refresh every 5 seconds, retain last good data on failures with a visible stale label.
- Initial delivery left reviewable changes on codex/heat-dashboard. The follow-up request authorizes commit and merge to main; no long live soak is requested.

### Task 1: Read-only snapshot and HTTP server
Files: src/dashboard/types.ts, snapshot.ts, server.ts, cli.ts; src/cli.ts; tests/dashboard/snapshot.test.ts, server.test.ts. Minimal metrics-core additions only when essential for preserving asset valuation and deduplication.
- [x] Establish serializable browser contract before implementation; current/previous windows, minute series, pool details, coverage, source time, freshness and sanitized health.
- [x] Write failing tests using existing synthetic SQLite fixtures for no data/stale projection, gaps versus zeros, duplicate transactions, comparison baseline, historical cutoff and read-only operation.
- [x] Build adapter atop buildMetricsReport with bounded 180-minute live horizon; HTTP snapshots do not mutate the source or bypass freshness checks. Reject unsupported query values.
- [x] Add lp dashboard --db ... --port 8787, matching config/watchlist/metadata defaults; missing data renders a useful empty state. Close cleanly on SIGINT/SIGTERM. Cache/poll with no overlapping expensive refreshes.
- [x] Test HTTP paths, JSON errors, loopback isolation, static MIME/CSP, source failures and asset delivery.

### Task 2: Browser UI
Files: src/dashboard/web/index.html, styles.css, app.ts, view-model.ts; tests/dashboard/view-model.test.ts; scripts/copy-build-assets.mjs; package.json.
- [x] First test pure sorting, heat classification, unknown ordering, zero baseline, favorites scope, heatmap scales and value formatting.
- [x] Implement dark industrial dashboard: Chinese hierarchy, orange warming/blue cooling, compact numerical table, 1m/5m/15m/1h selector, search and favorites.
- [x] Implement 15/30/60-minute heatmap with absolute/relative scale, readable keyboard-accessible minute buttons, historical cutoff and return to live.
- [x] Implement token drawer, trend charts with gaps, pool table, contract copy, local favorites and explicit estimate/coverage notes.
- [x] Implement runtime page, 5-second sequential refresh, pausing while table is hovered/focused, error retention, empty/loading states, responsive layout, accessible labels and Escape/focus restoration.
- [x] Build copies HTML/CSS and compiles browser ES modules; no network font/script dependencies.

### Task 3: Integration and delivery
Files: README.md, docs/dashboard.md, verification artifacts under ignored .superpowers/dashboard.
- [x] Run targeted tests, pnpm typecheck, pnpm lint, pnpm test, pnpm build and git diff --check.
- [x] Inspect real local DB without mutation; do not imply stale data is live. Start dashboard locally and verify via HTTP/browser if tooling permits.
- [x] Request independent code review, fix actionable findings and rerun affected tests.
- [x] Document startup, how to attach existing bounded collection, window semantics, empty/gap handling and limits. Report verified results and remaining limitations.

## Completion evidence
- Implemented and reviewed on codex/heat-dashboard; follow-up authorizes committing the verified changes and merging to main, with the feature branch retained.
- Full offline regression: 84 files, 814 tests passed. Final dashboard regression: 3 files, 23 tests passed after UI fixes.
- Typecheck, lint, HTML/CSS formatting, production build and git diff --check passed.
- Independent review's four issues fixed and re-reviewed: no remaining actionable blocker.
- Chrome desktop and 390px mobile validation: search, favorites persistence, drawer/heatmap focus, historical cutoff, injected 503 retention and recovery. Synthetic interaction run: 9 requests, no unexpected browser errors.
- Real readonly source: data/p3-acceptance.sqlite + config/watchlist.amc.json + --legacy-snapshot. 1 AMC token, 1827 registered pools. Source is stale; current 5m boundary time is unknown and correctly remains null. Historical heatmap and 20-at-a-time pool expansion verified. No source DB writes or RPC.
- Default stocks scope has no recorded data in existing local DBs. P6 legacy sources fail freshness verification and remain explicitly unavailable; neither was silently repaired.
- --legacy-snapshot is an explicit compatibility addition: one initial full-source verification, trimmed 180m plus 120s quote context, source writes invalidate at next uncached read; restart required.
- Actual preview remains local at 127.0.0.1:8787; stopping the foreground dashboard ends it. It is not an installed service.
- Follow-up pre-merge verification: 84 test files, 815 tests passed; typecheck, lint, HTML/CSS format and build passed. Documentation line endings normalized before staging.
