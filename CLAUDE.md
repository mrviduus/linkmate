# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LinkMate is a privacy-focused Chrome extension (Manifest V3) for LinkedIn engagement. All inference runs on-device via WebLLM — nothing leaves the browser.

v0.3.x ships AI reply suggestions on individual posts. v0.4.0 (branch `001-ssi-growth-mode`) adds **SSI Growth Mode** — a co-pilot around the user's LinkedIn Social Selling Index: Profile Context capture, Engagement Queue sidebar on `/feed/`, daily SSI Tracker with popup dashboard, and Connection Suggestor scaffold (full UI in v0.4.1).

## Commands

### Build / Dev
- `npm run dev` — Parcel watch mode against `src/manifest.json` (`@parcel/config-webextension`). Output → `dist/`.
- `npm run build` — Parcel production build.
- `npm run build:script` — Full quality-gated build via `./scripts/build.sh` (type-check → lint → `test:ci` → `tsc` → copy assets → manifest validate → size report). Note: this also runs a parallel `tsc` compile to `dist/`, which is separate from the Parcel pipeline.
- `npm run clean` — Wipes `dist/`, `packages/`, `.parcel-cache/`.
- `npm run package` / `npm run zip` — `./scripts/package.sh` ZIPs prod + dev builds.
- `./scripts/version-bump.sh --type {patch|minor|major|custom --version X.Y.Z}` — Bumps `package.json` + `src/manifest.json`, commits, tags.

### Test
- `npm test` — Jest (ts-jest + jsdom), config in `jest.config.js`, setup in `tests/setup.ts` (Chrome API mocks).
- `npm test -- <file-or-pattern>` — Single file.
- `npm test -- --testNamePattern="<regex>"` — By test name.
- `npm test -- --testPathIgnorePatterns=linkedin-integration` — Skip the integration suite (known flaky in some envs).
- `npm run test:coverage` / `npm run test:ci`.

### Quality (must pass before commit, per Constitution v1.1 §II)
- `npm run lint` — ESLint on `src/**/*.{ts,js}` (max-warnings=0) using `@typescript-eslint/parser`.
- `npm run type-check` — `tsc --noEmit` with strict mode.
- `npm run format` / `npm run format:check` — Prettier across `src/**/*.{ts,js,css,html,json}`.

## Architecture

### Runtime topology
```
LinkedIn feed page ──► linkedin-content.ts ──┐
LinkedIn /sales/ssi ─► ssi-content.ts ───────┤  chrome.runtime messages
popup.html ──► popup.ts ─────────────────────┤
                                              ▼
                                  background.ts (service worker, type: module)
                                              │
                       ┌──────────────────────┼──────────────────────┐
                       ▼                      ▼                      ▼
              model-loader.ts        chrome.alarms           chrome.scripting
              (engine singleton)     (SSI daily 1440min)    (profile capture)
                       │
                       ▼
                 @mlc-ai/web-llm  →  WebGPU / WASM
```

### Critical files

**Service worker / orchestration:**
- `src/background.ts` — Service worker. Engine lifecycle (`ensureEngine`), device-tier model selection, reply validation, performance telemetry, daily SSI alarm orchestrator (`startSsiCapture`), profile capture handler, Engagement Queue scoring/draft handlers.
- `src/model-loader.ts` — Singleton wrapping `CreateMLCEngine`. Single entry point — never call `CreateMLCEngine` directly elsewhere.
- `src/keep-alive.ts` — MV3 keep-alive helper. `keepAlive.start() / stop()` wraps any >25s flow (Constitution VII).

**Content scripts:**
- `src/linkedin-content.ts` — `LinkedInLinkMate` class. Mutation-observes feed, injects "Generate Reply" buttons, mounts EngagementQueue on `/feed/`, SPA route polling.
- `src/ssi-content.ts` — Tiny content script for `/sales/ssi*`. Retry × 4 parse + post `ssi.snapshotReady`. No listeners, no DOM mutation.

**Pure-logic modules (DOM-free, fixture-driven tests):**
- `src/storage-schema.ts` — Single source of truth for chrome.storage.local layout. Entity types, versioned keys, eviction/migration helpers.
- `src/profile-parser.ts` — `parseProfileDom(doc): RawProfileFields`. Self-contained for `chrome.scripting.executeScript`.
- `src/feed-parser.ts` — `parseFeedDom(doc, opts): ParsedPost[]`. Extracts URN, author, follower tier, degree, posted-time, engagement.
- `src/ssi-parser.ts` — `parseSsiDom(doc, opts): SsiParseResult`. Tagged union; matches component cards by h3 substring regex.
- `src/relevance-scorer.ts` — `scoreRelevance(input): RelevanceScore`. Weighted formula (topic*0.40 + tier*0.20 + relationship*0.15 + recency*0.10 + engagement*0.10 + diversity*0.05). obviousAiContent penalty *0.5.
- `src/prompt-builder.ts` — `buildCommentPrompt / buildConnectionNotePrompt / buildPositioningPrompt`. Deterministic; snapshot-tested across 4×3 tone×length.

**UI services (popup-side):**
- `src/profile-context.ts` — `ProfileContextService.capture() / get() / shouldRefresh()`. Active-tab guard, executeScript({ func: HTML-grab }), parses in popup, persists.
- `src/ssi-tracker.ts` — `renderLatest / renderTrend / getInsight`. Chart.js constructor injected for testability.
- `src/engagement-queue.ts` — `EngagementQueue` class. Vanilla DOM sidebar, DI for scoreFeed/draftComment/markEngaged/dismiss/copyToClipboard/openPost. 5-min refresh throttle.

**Popup:**
- `src/popup.ts` + `popup.html` / `popup.css` — Single-page scroll layout (NOT tabs). Sections: Profile, SSI, AI Model, Parameters, Prompts, Quick Actions.

### Model tiers (background)
Device-capability gated in `getOptimalBackgroundModel`:
- ≥8 GB RAM and ≥8 cores → `Llama-3.2-3B-Instruct-q4f16_1-MLC`
- ≥4 GB RAM or ≥4 cores → `Llama-3.2-1B-Instruct-q4f16_1-MLC`
- otherwise → `Qwen2.5-0.5B-Instruct-q4f16_1-MLC`

### Message contract (`chrome.runtime.sendMessage` actions)

**Legacy (v0.3.x):**
- `generateReply` / `generateLinkedInReply` / `generateLinkedInReplyWithComments` — content → background.
- `linkedinContentScriptReady` — content → background, triggers engine warm-up.
- `getPrompts` / `savePrompts` / `resetPrompts` — popup ↔ background (custom prompts).
- `getModelsInfo` / `testModel` / `resetModel` / `updateModel` / `updateAIParameters` / `initializeModel` / `popupReady` / `checkEngineStatus` — popup ↔ background.
- `modelLoadProgress` — background → all tabs (broadcast).

**v0.4.0 SSI Growth Mode (dotted namespaces per Constitution IV):**
- `profile.capture` — popup → background. Payload: `{ fields: RawProfileFields }`. Returns `{ ok, positioningSummary }` or `{ ok: false, error }`. WebLLM call wrapped in keepAlive.
- `queue.scoreFeed` — content (queue sidebar) → background. Payload: `{ posts: ParsedPost[] }`. Returns `{ ok, scored: ScoredPost[] }`.
- `queue.draftComment` — content → background. Payload: `{ post, tone, length }`. Returns `{ ok, draft }`. keepAlive-wrapped.
- `queue.markEngaged` / `queue.dismiss` — content → background. Payload: `{ postId }`. Returns `{ ok }`.
- `ssi.captureNow` — popup → background. Triggers `startSsiCapture` orchestrator. Returns `{ ok, snapshot }` or `{ ok: false, error }`.
- `ssi.getHistory` — popup → background. Payload: `{ days? }`. Returns `{ snapshots: SsiSnapshot[] }`.
- `ssi.snapshotReady` — ssi-content → background. Payload: `{ snapshot? }` or `{ error?, reason? }`. Resolves pending capture promise.

### Storage keys

**`chrome.storage.sync` (existing v0.3.x):** `customPrompts`, `aiTemperature` (default 0.85), `aiMaxTokens` (default 150), `selectedModel`.

**`chrome.storage.local` (versioned, v0.4.0+):**
- `linkmate.profile.v1` — `ProfileContext`
- `linkmate.queue.engaged.v1` — `EngagedPost[]` (30-day TTL filtered on read)
- `linkmate.queue.dismissed.v1` — `string[]` (forever, until manual clear)
- `linkmate.queue.preferences.v1` — `QueuePreferences` (defaultTone, defaultLength, sidebarPosition) [persistence pending]
- `linkmate.ssi.history.v1` — `SsiSnapshot[]` (max 90, evicts oldest)
- `linkmate.ssi.lastError.v1` — `{ message, capturedAt }` (cleared on next success)
- `linkmate.connections.suggestions.v1` — `ConnectionSuggestion[]` [scaffolded, v0.4.1]
- `linkmate.connections.draftedThisWeek.v1` — `number` (resets Monday)
- `linkmate.schema.version` — migration anchor (current: 1)

**Legacy `chrome.storage.local` (existing v0.3.x):** `model-<modelId>-cached`, `performanceMetrics`, `hasUsedExtension`.

### Manifest essentials (`src/manifest.json`)
- Permissions: `storage`, `tabs`, `activeTab`, `windows`, `alarms`, `scripting`.
- Host permissions: `https://*.linkedin.com/*`.
- Content scripts: `linkedin-content.ts` on `https://*.linkedin.com/*`; `ssi-content.ts` on `https://www.linkedin.com/sales/ssi*`.
- **NO** `/in/*` content script registered (Constitution I carve-out: profile capture uses `chrome.scripting.executeScript` only when user clicks Capture).
- `web_accessible_resources`: `linkedin-styles.css`, `engagement-queue.css`.
- CSP allows `wasm-unsafe-eval` and HuggingFace CDNs for model fetches.

## LinkedIn integration notes
Post detection relies on `[data-urn^="urn:li:activity"]` / `.feed-shared-update-v2` containers. SSI page selectors: `.ssi-score-table__current-ssi-score`, `.ssi-component-card` + `.ssi-component-card__title` h3 (matched by substring regex — A/B-test tolerant). LinkedIn's DOM shifts often — fixtures under `tests/fixtures/` are SYNTHETIC; re-validate selectors when you capture real DOM (per Constitution VIII fixture hygiene).

## SSI Growth Mode flows

**Profile capture (one-shot, user-initiated):**
popup → `chrome.tabs.query` active tab → URL guard `/in/{handle}/$` → `chrome.scripting.executeScript({ func: () => document.documentElement.outerHTML })` → parser runs in popup → send `profile.capture` to background → WebLLM positioning summary → persist.

**Engagement Queue (mount on `/feed/`):**
linkedin-content detects `/feed/` → mounts EngagementQueue in `document.body` → 2.5s after mount: `parseFeedDom(document)` → `queue.scoreFeed` → render top-10 → per-tile `queue.draftComment` (streams from WebLLM). Tone/Length selects → regenerate all. Copy & Open: clipboard + `queue.markEngaged` + `window.open(post URL)` in new tab. **NEVER** programmatic submit.

**SSI capture (daily alarm + manual):**
`chrome.alarms.create('linkmate.ssi.daily', { periodInMinutes: 1440 })` → on fire: `startSsiCapture()` opens background tab on `/sales/ssi`, waits for `ssi.snapshotReady` (30s timeout, keepAlive wrapped), persists snapshot, removes tab. Manual `ssi.captureNow` reuses same path.

## Conventions
- TypeScript strict mode (Constitution II); `any` only with eslint-disable + reason.
- The optimized model loader is the single entry point for engine creation.
- `model-loader.ts` and `background.ts` are the ONLY callers of WebLLM API.
- Long-running background flows MUST wrap in `keepAlive.start()/stop()` (Constitution VII).
- Pure-logic modules (parsers, scorer, prompt-builder) export individual helpers for ≥90% line coverage (Constitution III).
- Fixtures in `tests/fixtures/` are synthetic and anonymized (Constitution VIII).
- Tests use Chrome API mocks from `tests/setup.ts`; spec files install their own in-memory storage mock when round-tripping data.

## Active feature
`specs/001-ssi-growth-mode/` — v0.4.0 SSI Growth Mode. Read `spec.md` → `plan.md` → `tasks.md` for context. Constitution at `.specify/memory/constitution.md` (v1.1.0+).
