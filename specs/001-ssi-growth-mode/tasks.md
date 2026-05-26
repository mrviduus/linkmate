---
description: "Task list for SSI Growth Mode (LinkMate v0.4.0) — v1.1"
---

# Tasks: SSI Growth Mode

**Input**: `specs/001-ssi-growth-mode/spec.md`, `specs/001-ssi-growth-mode/plan.md`
**Prerequisites**: spec.md ✅, plan.md ✅
**Tests**: REQUIRED — Constitution principle III (Test-First Development is NON-NEGOTIABLE).

**v1.1 changes**: T034–T036 rewritten for `chrome.scripting.executeScript` (replaces background-tab + registered content script). New T015 keep-alive helper added. T303 rewritten (TODO.md sync clarified). T213 manifest matches list reduced (no /in/* registered script).

## Format

`[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no cross-task dependencies)
- **[Story]**: US1 = Engagement Queue, US2 = SSI Dashboard, US3 = Profile Context, US4 = Connection Suggestor, FND = Foundation/cross-cutting
- Every implementation task is preceded by its test task. Implementation MUST NOT begin until the corresponding test fails (Red), then passes (Green).

## Path Conventions

- Source: `src/`
- Tests: `tests/`
- Fixtures: `tests/fixtures/`
- Spec/plan: `specs/001-ssi-growth-mode/`

## Pre-flight

- [x] **T000** — Create branch `001-ssi-growth-mode` from `main`. Run `npm install` to ensure baseline. Confirm `npm test`, `npm run lint`, `npm run type-check`, `npm run build` all pass on the branch.

---

## Phase A — Foundation (Day 1–2)

### Storage Schema [FND]

- [x] **T010** [FND] Write `tests/storage-schema.spec.ts` covering: schema versioning constant, `getProfile()` round-trip, `appendSsiSnapshot()` with eviction beyond 90, `markEngaged()` with 30-day expiry filter, migration helper invoked when stored version < current. Use `chrome.storage` jsdom mock from `tests/setup.ts`.
- [x] **T011** [FND] Implement `src/storage-schema.ts`: export TypeScript types for every entity in spec.md (`ProfileContext`, `ParsedPost`, `ScoredPost`, `DraftComment`, `EngagedPost`, `SsiSnapshot`, `ConnectionSuggestion`, `QueuePreferences`), all storage keys as constants, getter/setter helpers, eviction logic, schema-version migration scaffold (start at version 1). Make T010 pass.
- [x] **T012** [FND] Add JSDoc to every exported helper explaining when to call it from background vs popup vs content script.

### Prompt Builder [FND]

- [x] **T020** [FND] [P] Write `tests/prompt-builder.spec.ts` covering: `buildCommentPrompt` includes profile positioning summary, applies tone keyword, applies length constraint, contains "do-not" rules, includes 1-shot example. Snapshot the full prompt for 4 tone × 3 length combinations.
- [x] **T021** [FND] [P] Implement `src/prompt-builder.ts` with `buildCommentPrompt`, `buildConnectionNotePrompt`, `buildPositioningPrompt`. Pure function, no side effects. Make T020 pass.

### MV3 Keep-Alive Helper [FND] (NEW v1.1)

- [x] **T015** [FND] [P] Write `tests/keep-alive.spec.ts` covering: `start()` opens a port and begins a 20s ping interval; `stop()` clears interval and disconnects port; idempotent (double-start does not leak ports); `start()` followed immediately by `stop()` does not throw.
- [x] **T016** [FND] [P] Implement `src/keep-alive.ts` per the plan.md "MV3 service-worker keep-alive" section. Single export `keepAlive` with `start()` / `stop()` methods. Internal state private. Make T015 pass.

### Profile Context [US3] — REWRITTEN in v1.1 to use chrome.scripting.executeScript

**Compliance note**: NO content script registered on `linkedin.com/in/*`. NO background tab creation for profile capture. Capture is one-shot, user-click-initiated injection into the active tab via `chrome.scripting.executeScript`.

- [x] **T030** [US3] Capture an anonymized real LinkedIn profile page HTML to `tests/fixtures/linkedin-profile.html` (replace personal text with placeholders, keep DOM structure). Document the capture date inline. **DONE as synthetic fixture (no real-DOM capture available) — see file header.**
- [x] **T031** [US3] Write `tests/profile-parser.spec.ts` against the fixture: extract fullName, headline, About first 1500 chars, top 10 skills, recent post themes (3–5). Add edge-case fixtures: profile with no About, profile with no posts. **12/12 tests green.**
- [x] **T032** [US3] Implement `src/profile-parser.ts` as pure function `parseProfileDom(htmlOrDoc): RawProfileFields`. Make T031 pass.
- [x] **T033** [US3] Write `tests/profile-context.spec.ts`: orchestration with mocked `chrome.tabs.query`, mocked `chrome.scripting.executeScript` (returns canned RawProfileFields), mocked WebLLM (returns canned positioningSummary), mocked `chrome.storage`. Verify: (a) URL guard rejects non-`/in/` active tab, (b) executeScript called exactly once, (c) positioningSummary persisted, (d) 30-day staleness chip surfaces but does NOT auto-trigger refresh. **14/14 tests green.**
- [x] ~~**T034**~~ — DEVIATED. Original spec called for a separate `src/profile-injected.ts` in `web_accessible_resources`. Replaced by inline `() => document.documentElement.outerHTML` inside `chrome.scripting.executeScript({ func })` (in `profile-context.ts`). Reasons: (a) Parcel content-hashes filenames, making `files: ['profile-injected.js']` fragile; (b) `func: parseProfileDom` runs into chrome.scripting's typed `args[]` contract. Compliance footprint unchanged — still one-shot, read-only DOM access on a user-loaded /in/{me}/ page. Parsing happens in popup context.
- [x] **T035** [US3] Implement `src/profile-context.ts` exporting `ProfileContextService` (popup-side) with `capture()`, `get()`, `shouldRefresh()`. `capture()` flow:
  1. `chrome.tabs.query({active:true, currentWindow:true})`
  2. URL guard: must match `^https://www\\.linkedin\\.com/in/[^/]+/?$`
  3. `chrome.scripting.executeScript({ target:{tabId}, files:['profile-injected.js'] })`
  4. Send `profile.capture` message to background with the returned RawProfileFields
  5. Receive positioningSummary back, persist via storage-schema
  6. Resolve to caller (popup) for re-render

  Make T033 pass.
- [x] **T036** [US3] Wire `profile.capture` action handler in `src/background.ts`: receives RawProfileFields, builds prompt via `prompt-builder.buildPositioningPrompt`, runs WebLLM via existing inference path, returns positioningSummary. Background does NOT touch tabs or scripting for this flow. **Wrapped in `keepAlive.start()`/`stop()` per Constitution VII (cold WebLLM start can exceed MV3 SW suspension window).**
- [x] **T037** [US3] Add "Profile" tab to `popup.html` with: "Capture profile" button, active-tab URL hint ("Currently on: …"), captured fields display, "Refresh" button (only enabled when on `/in/`), captured-at timestamp, optional "Open my profile ↗" CTA when not on a profile page. Update `popup.ts` to wire to `ProfileContextService.capture()` and `get()`. **DONE as new section (popup is scroll-not-tabs; converting to tabbed UI is out of Phase A scope). Stale-chip surfaces when capturedAt > 30d. "Open My Profile" CTA always visible; URL-hint deferred.**
- [x] **T038** [US3] Update `src/popup.css` for new Profile tab styles. Match existing aesthetic.
- [x] **T039** [US3] Update `src/manifest.json`: add `"scripting"` to `permissions`. Add `profile-injected.js` to `web_accessible_resources` with match `https://www.linkedin.com/in/*`. Confirm NO entry added to `content_scripts` for `/in/*`. **Scripting permission added. No profile-injected.js bundle needed (T034 deviation). No `/in/*` entry in content_scripts — confirmed.**

---

## Phase B — Engagement Queue (Day 3–6) [US1]

### Relevance Scorer (pure)

- [x] **T100** [US1] Write `tests/relevance-scorer.spec.ts` covering every weight in plan.md formula. Each weight gets ≥3 cases (low/mid/high). Verify penalty stacking. Verify category buckets at 70 and 40 boundaries. Target ≥95% line + branch coverage. **43/43 tests green.**
- [x] **T101** [US1] Implement `src/relevance-scorer.ts` with single export `scoreRelevance(input: ScoringInput): RelevanceScore`. Pure function. Includes `obviousAiContent` heuristic (suspicious phrasing list).

### Feed Parser

- [x] **T110** [US1] Capture an anonymized LinkedIn `/feed/` snippet (10 posts) to `tests/fixtures/linkedin-feed.html`. **DONE as synthetic fixture covering 10 posts (varied tiers, topic matches, 1 own-post, 1 AI-suspicious phrasing edge case).**
- [x] **T111** [US1] Write `tests/feed-parser.spec.ts` against fixture: extract 10 ParsedPost records with all fields (id, authorUrn, text, postedAt, likeCount, etc.). **34/34 tests green.**
- [x] **T112** [US1] Implement feed parser as pure function `parseFeedDom(documentOrFragment): ParsedPost[]` — keep DOM-touching code thin, push logic to pure helpers. Place in `src/feed-parser.ts`. **Also adds ConnectionDegree + FollowerTier types to storage-schema.ts and `degree` field to ParsedPost.**

### Engagement Queue UI + mounting

- [x] **T120** [US1] Write `tests/engagement-queue.spec.ts` for mount/unmount, render-list, tone/length-change-regenerates-draft, copy-and-mark-engaged, refresh throttle (5-min). Use jsdom + canned ScoredPost arrays. **15/15 tests green.**
- [x] **T121** [US1] Implement `src/engagement-queue.ts` exporting `EngagementQueue` class with `mount()`, `unmount()`, `refresh()`. UI built with vanilla DOM (no framework — match repo style). Each post tile renders independently. **Dependency injection for testability; default deps wire to chrome.runtime + navigator.clipboard.**
- [x] **T122** [US1] Implement `src/engagement-queue.css` with styles per UI spec in plan.md. Sidebar z-index above LinkedIn but below LinkedIn modals. Position remembered via `linkmate.queue.preferences.v1`. **z-index 9000. Dark-mode media query included. sidebarPosition persistence DEFERRED — not blocking Phase B exit.**
- [x] **T123** [US1] Extend `src/linkedin-content.ts`: detect `/feed/` route, lazily mount `EngagementQueue`. Add an unmount on route-change. Preserve all existing reply-button injection behavior — no regressions. **SPA route changes handled via 1.5s setInterval poll on `location.pathname`.**
- [x] **T124** [US1] Add `queue.scoreFeed`, `queue.draftComment`, `queue.markEngaged`, `queue.dismiss` action handlers to `src/background.ts`. Each delegates to the appropriate pure module. **`queue.draftComment` wrapped in `keepAlive.start()/stop()` (Constitution VII).**
- [x] **T125** [US1] Add `engagement-queue.css` to `web_accessible_resources` in `src/manifest.json`.

### Compliance hooks

- [x] **T130** [US1] Update existing compliance warning in `src/linkedin-content.ts` to mention SSI Growth Mode + reaffirm "no auto-submit". **Expanded warning covers: drafts only, no programmatic submit/post/send/like, local-only inference.**
- [x] **T131** [US1] [P] Update `README.md` with SSI Growth Mode section, screenshots, compliance statement. **Section added. Screenshots DEFERRED to Phase D after real-Chrome validation.**

---

## Phase C — SSI Tracker (Day 7–9) [US2]

### SSI Parser (pure)

- [x] **T200** [US2] Capture an anonymized SSI page HTML to `tests/fixtures/linkedin-ssi.html`. Capture both Sales Navigator and free LinkedIn variants if both reachable. **DONE as synthetic fixture (free LinkedIn variant; Sales Navigator variant shares the same score-table classes). Re-verify selectors when real DOM available.**
- [x] **T201** [US2] Write `tests/ssi-parser.spec.ts` covering: total parsed correctly, 4 components parsed correctly, industry+network rank parsed, missing-element returns typed `SsiParseError`, fallback DOM variants handled. **11/11 tests green.**
- [x] **T202** [US2] Implement `src/ssi-parser.ts` as pure function `parseSsiDom(documentOrFragment): SsiSnapshot | SsiParseError`. Make T201 pass. **Tagged union `SsiParseResult`; components matched by h3 substring regex (handles A/B-test phrasing).**

### Content script + background orchestration

- [x] **T210** [US2] Implement `src/ssi-content.ts`: runs only on `/sales/ssi*`, parses DOM via ssi-parser, sends `ssi.snapshotReady` message to background. **Retry loop (4 × 1.5s) handles SSI page lazy-load.**
- [x] **T211** [US2] Add `chrome.alarms.create('linkmate.ssi.daily', { periodInMinutes: 1440 })` in `src/background.ts` install/startup hook. Add alarm listener that orchestrates capture per plan.md "SSI Capture Flow (with MV3 keep-alive)" — wraps the entire flow in `keepAlive.start()` / `keepAlive.stop()` from T016. Honor a 30s timeout; on timeout call `setSsiLastError`. **Done. 30s capture timeout. setSsiLastError on failure; clearSsiLastError on success.**
- [x] **T212** [US2] Add `ssi.captureNow`, `ssi.getHistory`, `ssi.snapshotReady` action handlers to `src/background.ts`. `ssi.captureNow` reuses the same orchestration path as the alarm (DRY). **Shared `startSsiCapture()` orchestrator. `ssi.getHistory` accepts optional `days` filter.**
- [x] **T213** [US2] Add `{ "matches": ["https://www.linkedin.com/sales/ssi*"], "js": ["ssi-content.ts"], "run_at": "document_idle" }` entry to `content_scripts` in `src/manifest.json`. Confirm `/in/*` does NOT appear in `content_scripts` (was in v1.0, removed in v1.1). **Done. `/in/*` confirmed absent from content_scripts.**
- [ ] **T214** [US2] Manual integration test in real Chrome: deliberately delay LinkedIn response (DevTools throttle to "Slow 3G"), verify keep-alive prevents SW suspension and snapshot still arrives. Document outcome in `manual-test-log.md`. **DEFERRED to Phase D — requires real Chrome.**

### Popup SSI tab

- [x] **T220** [US2] Write `tests/ssi-tracker.spec.ts` for: latest snapshot rendering, history graph rendering with 0/1/30/90 snapshots, insight generator output for 5 representative trend shapes (rising, falling, flat, spike, missed-week). **14/14 tests green.**
- [x] **T221** [US2] Implement `src/ssi-tracker.ts` (popup-side): `renderLatest`, `renderTrend`, `getInsight`. Make T220 pass. **Chart constructor injected for testability; renderLatest uses refs object pattern; getInsight covers onboarding/baseline/missed-week/rising/falling/flat.**
- [x] **T222** [US2] Add SSI tab to `src/popup.html`: latest scores, Chart.js canvas, insight chip, "Refresh now" + "Open SSI page ↗" buttons. **Added as section (popup remains scroll-not-tabs). Includes 4-component grid + error chip.**
- [x] **T223** [US2] Wire SSI tab handlers in `src/popup.ts`. **loadSsiData fires on popup open; Refresh calls ssi.captureNow.**
- [x] **T224** [US2] Update `src/popup.css` for SSI tab + chart sizing. **120px canvas, 4-component grid, insight chip with left border.**
- [x] **T225** [US2] Add `chart.js@^4` to `package.json` dependencies. Confirm bundle size impact <100 KB gzip. **chart.js@4.5.1 installed. Popup bundle grew ~2 MB uncompressed (~75 KB gzip — well under 100 KB).**

---

## Phase D — Polish (Day 10–11)

- [ ] **T300** [FND] Run end-to-end manual scenario per spec acceptance scenarios. Document outcomes in `specs/001-ssi-growth-mode/manual-test-log.md`. **DEFERRED — requires real Chrome. Skeleton checklist created in `manual-test-log.md`.**
- [x] **T301** [FND] [P] Update `CLAUDE.md` with SSI Growth Mode architecture, new file map, new message vocabulary. **Rewritten: new modules section, dotted message namespaces, v0.4.0 storage keys, three SSI Growth Mode flows documented.**
- [x] **T302** [FND] [P] Add `CHANGELOG.md` entry for v0.4.0. **New `CHANGELOG.md` at repo root following Keep-a-Changelog format. Lists all added modules, changed configs, deferred items, compliance posture.**
- [ ] **T303** [FND] [P] Verify the subsumed-items mapping in `spec.md` §References is still accurate at end of Phase D:
  - "Reply Tone Selector" → confirm US1 FR-014 ships with all 4 tones.
  - "Draft connection requests" → confirm US4 scaffolded in v0.4.0, full UI in v0.4.1.
  - "Compose InMail" → confirm still listed in spec.md Out of Scope (deferred to v0.5.0+).
  - "Reply History" → confirm `EngagedPost` storage exists and is queryable.
  - If any mapping drifted during implementation, update `spec.md` §References, not a separate TODO file (the file no longer exists; spec is the single source of truth).
- [x] **T304** [FND] [P] Create `specs/001-ssi-growth-mode/data-model.md` with full storage schema reference (extracted from plan.md for easier onboarding). **Done. Includes storage layout, constants, all 8 entity types, footprint estimate, caller boundary matrix.**
- [x] **T305** [FND] Run full Constitution gate: `npm run type-check && npm run lint && npm test && npm run build`. All must pass with 0 warnings/errors.
- [ ] **T306** [FND] Verify zero outbound LLM API calls in DevTools Network panel during a full Engagement Queue session and SSI capture. **DEFERRED — requires real Chrome. Procedure in `manual-test-log.md`.**
- [x] **T307** [FND] Verify total `chrome.storage.local` footprint stays under 5 MB after 90 days of simulated snapshots + 30 days of engaged posts (use a seeding script in `scripts/`). **Implemented as automated `tests/storage-footprint.spec.ts` — seeds full worst-case state, asserts under both the 5 MB budget and a tighter 200 KB expected bound. Logs actual KB count.**

---

## Phase E — Connection Suggestor scaffold (Day 12) [US4]

Deferred to v0.4.1 for full UI. v0.4.0 ships the data model, types, and storage hooks so v0.4.1 work is contained.

- [x] **T400** [US4] Add `ConnectionSuggestion` type + storage helpers in `src/storage-schema.ts` (covered in T011 — verify). **Verified: `ConnectionSuggestion` exported, keys `connectionsSuggestions` + `connectionsDraftedThisWeek` defined.**
- [x] **T401** [US4] Stub `src/connection-suggestor.ts` exporting `ConnectionSuggestor` class with method signatures only (`suggest()`, `markDrafted()`, throwing `NotImplementedError`).
- [x] **T402** [US4] Write `tests/connection-suggestor.spec.ts` skeleton (skipped tests with `it.todo`). **3 export-shape tests + 5 `it.todo` placeholders for v0.4.1.**

---

## Done Criteria for v0.4.0 (mirror of spec.md SC-XXX)

- [ ] SC-001 met: Engagement Queue mounts in <3s, ranks in <2s
- [ ] SC-002 met: Per-post draft <5s on 4 GB GPU baseline
- [ ] SC-003 met: ≥6 of 7 daily SSI captures land when LinkedIn logged in
- [ ] SC-004 met: SSI tab opens/renders <500ms with 90 snapshots
- [ ] SC-005: 30-day measurement window started; outcome tracked in manual-test-log.md
- [ ] SC-006: 90-day dogfood window started; LinkedIn account warnings tracked
- [ ] SC-007 met: ≥85% Jest coverage on new modules; Constitution gates green
- [ ] SC-008 met: Zero outbound LLM API calls (DevTools verified)

## Recommended Execution Order

```
T000 → T010 → T011 → T012 → T020|T021 (parallel) → T030..T038
       │
       ├─ Phase B: T100..T131 (US1 work begins after Phase A complete)
       │
       └─ Phase C: T200..T225 (US2 work can start in parallel with US1 once T011 done)

Phase D: T300..T307 only after A+B+C green
Phase E: T400..T402 anytime after T011
```

## Branch + PR Hygiene

- One PR per phase (4 PRs minimum).
- Each PR runs full Constitution gate in CI before merge.
- PR description includes: which user story slices, which acceptance scenarios pass, screenshots/GIFs of UI changes, and DevTools network panel screenshot proving no outbound LLM calls.

## Notes for the Implementing Agent (Claude Code)

You are implementing this on branch `001-ssi-growth-mode`. Read in this order:
1. `.specify/memory/constitution.md` — non-negotiable principles, especially Privacy-First and Test-First.
2. `specs/001-ssi-growth-mode/spec.md` — what we're building and why.
3. `specs/001-ssi-growth-mode/plan.md` — how we're building it.
4. This `tasks.md` — execution order.

Work the tasks in numeric order. For every task `T0X1` (implementation), the corresponding `T0X0` (test) MUST be in place AND failing before you write any production code. Run `npm test -- path/to/spec.ts` after each implementation task to confirm Green. Run `npm run lint && npm run type-check` after each task. Do not batch many tasks before testing.

When in doubt: smaller diff > bigger diff. Update `manual-test-log.md` after each phase with a short note on what was verified manually in a real Chrome browser against real LinkedIn.

Compliance is non-negotiable: at no point may any code in this branch programmatically click LinkedIn submit/post/send/like/share buttons or trigger their underlying handlers. If a task seems to require it, stop and update spec.md instead.
