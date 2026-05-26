# Implementation Plan: SSI Growth Mode

**Branch**: `001-ssi-growth-mode` | **Date**: 2026-05-14 | **Revised**: 2026-05-14 (v1.1) | **Spec**: ./spec.md
**Input**: Feature specification from `specs/001-ssi-growth-mode/spec.md`

**v1.1 changes from review**: Profile Capture switched from registered content script + background tab to `chrome.scripting.executeScript` on user click; MV3 service-worker keep-alive strategy added to SSI flow + Risks; `scripting` permission added to manifest; T034–T036 and T303 rewritten in tasks.md.

## Summary

Pivot LinkMate from "AI reply suggestions" to a personal-brand growth co-pilot organized around the LinkedIn Social Selling Index (SSI). Ship four modules: Profile Context (foundation), Engagement Queue (sidebar on `/feed/`), SSI Tracker + Dashboard (background daily capture + popup graph), and Connection Suggestor (deferred to v0.4.1). Strictly no auto-submit to LinkedIn — every action is human-in-the-loop.

## Technical Context

**Language/Version**: TypeScript 5.3, target ES2020, strict mode
**Primary Dependencies**: `@mlc-ai/web-llm@0.2.79` (existing), `progressbar.js` (existing). NEW: `chart.js@4.x` for SSI trend graph. No other runtime additions.
**Storage**: `chrome.storage.local` (versioned keys, see Storage Schema below)
**Testing**: Jest 30 with ts-jest, jsdom environment (existing setup in `tests/setup.ts`)
**Target Platform**: Chromium-based browsers, Manifest V3
**Project Type**: Single project (Chrome extension)
**Performance Goals**:
  - Engagement Queue mounts in <3s on `/feed/` page load
  - Per-post draft generation <5s on GTX 1650 Ti (4 GB VRAM) baseline
  - SSI tab popup render <500ms with 90 snapshots stored
**Constraints**:
  - Zero outbound LLM API calls (all inference local via WebLLM)
  - No programmatic clicks on LinkedIn submit/post/send buttons
  - Throttle queue refresh to once per 5 min, SSI capture to once per 24h
  - Stay under 5MB chrome.storage.local total footprint
**Scale/Scope**: Single user (the developer). Designed for ~1000 ranked posts/day, 90 days SSI history, 5 connection suggestions/day.

## Constitution Check

Mapping each Constitution principle to this feature:

| Principle | Compliance Approach |
|---|---|
| I. Privacy-First (NON-NEGOTIABLE) | All inference via existing WebLLM background service. Profile, drafts, snapshots stored in chrome.storage.local only. Zero new outbound endpoints. CSP unchanged. |
| II. Quality Gates (MANDATORY) | New modules will follow `npm run type-check`, `npm run lint`, `npm test`, `npm run build` before any merge. CI gates remain `--max-warnings=0`. |
| III. Test-First Development (NON-NEGOTIABLE) | Every task in `tasks.md` lists test file before implementation file. Pure-logic modules (relevance scorer, SSI parser, prompt builders) target ≥90% line coverage. DOM-touching modules use jsdom mocks of canonical LinkedIn HTML fixtures. |
| Existing patterns | Reuse: Manifest V3 message passing (`chrome.runtime.sendMessage`), background service worker for WebLLM lifecycle, content script DOM patterns from `linkedin-content.ts`. |

**No Constitution waivers required.**

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ Chrome Extension (Manifest V3)                                      │
│                                                                     │
│  ┌────────────────────┐         ┌──────────────────────────────┐   │
│  │ popup.html / .ts   │         │ background.ts (service       │   │
│  │  ├ Replies tab     │◄────────┤  worker)                     │   │
│  │  ├ SSI tab  (NEW)  │ msg API │  ├ WebLLM engine (existing) │   │
│  │  ├ Profile  (NEW)  │         │  ├ chrome.alarms handlers   │   │
│  │  └ Settings        │         │  ├ SSI scrape orchestrator  │   │
│  └────────────────────┘         │  └ Profile capture orches.  │   │
│                                  └──────────────────────────────┘   │
│                                                                     │
│  Content scripts (registered):                                      │
│   ┌──────────────────────────────────────────────────────────────┐ │
│   │ linkedin-content.ts (existing — extended)                    │ │
│   │  ├ existing: post detection, "Generate Reply" button         │ │
│   │  └ NEW: mounts engagement-queue.ts on /feed/                 │ │
│   ├──────────────────────────────────────────────────────────────┤ │
│   │ ssi-content.ts (NEW)  — runs only on /sales/ssi              │ │
│   │  └ parses SSI DOM → sends snapshot to background             │ │
│   └──────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  Programmatically injected (NOT registered):                        │
│   ┌──────────────────────────────────────────────────────────────┐ │
│   │ profile-injected.ts (NEW)                                    │ │
│   │  └ injected via chrome.scripting.executeScript on user-click │ │
│   │     "Capture profile". Runs once on the active tab IF that   │ │
│   │     tab is /in/{handle}, returns parsed data, disposes.     │ │
│   │     NOT in manifest content_scripts — no auto-fire.         │ │
│   └──────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  Pure-logic (testable without DOM):                                 │
│   ┌──────────────────────────────────────────────────────────────┐ │
│   │ relevance-scorer.ts (NEW)                                    │ │
│   │ prompt-builder.ts   (NEW — for tone/length/profile-aware)    │ │
│   │ ssi-parser.ts       (NEW — pure parse over given DOM string) │ │
│   │ profile-parser.ts   (NEW — pure parse over given DOM string) │ │
│   │ storage-schema.ts   (NEW — versioned types + migration)      │ │
│   └──────────────────────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## File Plan

```
src/
├── background.ts                       (EDIT — add alarm + scrape orchestration)
├── linkedin-content.ts                 (EDIT — mount engagement queue on /feed/)
├── popup.html                          (EDIT — add SSI + Profile tabs)
├── popup.ts                            (EDIT — handlers for new tabs)
├── popup.css                           (EDIT — styles for new tabs + chart container)
├── manifest.json                       (EDIT — add /in/* and /sales/ssi matches)
├── engagement-queue.ts                 (NEW)
├── engagement-queue.css                (NEW)
├── ssi-content.ts                      (NEW — registered content script for /sales/ssi)
├── ssi-tracker.ts                      (NEW — popup-side rendering + insights)
├── profile-injected.ts                 (NEW — pure module, injected via executeScript on click; NOT in manifest)
├── profile-context.ts                  (NEW — service used in background)
├── keep-alive.ts                       (NEW — MV3 service-worker keep-alive helper, see Risks)
├── relevance-scorer.ts                 (NEW — pure logic)
├── ssi-parser.ts                       (NEW — pure logic)
├── profile-parser.ts                   (NEW — pure logic)
├── prompt-builder.ts                   (NEW — pure logic)
├── storage-schema.ts                   (NEW — types + storage helpers + migration)
└── connection-suggestor.ts             (NEW — Phase 2; scaffold + tests only in v0.4.0)

tests/
├── relevance-scorer.spec.ts            (NEW — pure logic, target ≥95% coverage)
├── ssi-parser.spec.ts                  (NEW — fixture-driven)
├── profile-parser.spec.ts              (NEW — fixture-driven)
├── prompt-builder.spec.ts              (NEW)
├── storage-schema.spec.ts              (NEW — including migration scenarios)
├── engagement-queue.spec.ts            (NEW — jsdom mounting)
├── ssi-tracker.spec.ts                 (NEW)
├── profile-context.spec.ts             (NEW)
└── fixtures/
    ├── linkedin-feed.html              (NEW — captured anonymized feed snippet)
    ├── linkedin-profile.html           (NEW — captured anonymized profile)
    └── linkedin-ssi.html               (NEW — captured anonymized SSI page)

specs/001-ssi-growth-mode/
├── spec.md                             (THIS FEATURE — already created)
├── plan.md                             (THIS FILE)
├── tasks.md                            (next file)
└── data-model.md                       (storage schema reference, see below)
```

## Storage Schema

All keys live under `chrome.storage.local`. Versioned to allow migration. See `src/storage-schema.ts` for canonical types and helpers.

| Key | Type | Purpose | Eviction |
|---|---|---|---|
| `linkmate.profile.v1` | `ProfileContext` | Captured user profile + positioning summary | Manual or auto after 30 days |
| `linkmate.queue.engaged.v1` | `EngagedPost[]` | Posts the user has copied a draft for | Auto after 30 days |
| `linkmate.queue.dismissed.v1` | `string[]` | Post IDs the user explicitly hid | Forever (until manual clear) |
| `linkmate.queue.preferences.v1` | `QueuePreferences` | defaultTone, defaultLength, autoRefreshMinutes, sidebarPosition | Forever |
| `linkmate.ssi.history.v1` | `SsiSnapshot[]` | Last 90 daily snapshots | Auto-evict beyond 90 |
| `linkmate.ssi.lastError.v1` | `{ message, capturedAt }` | Last parse failure for popup chip | Cleared on next success |
| `linkmate.connections.suggestions.v1` | `ConnectionSuggestion[]` | Today's suggestions | Daily refresh, 7-day history |
| `linkmate.connections.draftedThisWeek.v1` | `number` | Counter for safe-limit throttle | Resets Monday 00:00 UTC |
| `linkmate.schema.version` | `number` | Migration anchor (start 1) | Bump on breaking change |

## Message Protocol Additions

Extend existing `chrome.runtime.sendMessage` action vocabulary in `background.ts`:

| Action | Payload | Response |
|---|---|---|
| `profile.capture` | `{ trigger: 'manual'\|'auto' }` | `{ ok, profile?, error? }` |
| `profile.get` | — | `{ profile: ProfileContext \| null }` |
| `queue.scoreFeed` | `{ posts: ParsedPost[] }` | `{ scored: ScoredPost[] }` |
| `queue.draftComment` | `{ post, profile, tone, length }` | `{ draft: string }` |
| `queue.markEngaged` | `{ postId }` | `{ ok: true }` |
| `queue.dismiss` | `{ postId }` | `{ ok: true }` |
| `ssi.captureNow` | — | `{ ok, snapshot?, error? }` |
| `ssi.getHistory` | `{ days?: number }` | `{ snapshots: SsiSnapshot[] }` |
| `ssi.snapshotReady` | `SsiSnapshot` (from ssi-content.ts) | `{ stored: true }` |
| `connections.suggest` | — | `{ suggestions: ConnectionSuggestion[] }` |
| `connections.markDrafted` | `{ profileUrl }` | `{ ok: true }` |

## Relevance Scoring Algorithm (deterministic, pure)

For each `ParsedPost`, compute a weighted score normalized to 0–100. The algorithm is documented here in plain math so test cases can assert exact outputs from fixture inputs.

```
score = (
    topicMatch     * 0.40 +    // 0..1, jaccard(post tokens ∩ profile.topSkills + recentPostThemes)
    authorTier     * 0.20 +    // 0..1, by follower count: <1k=0.2, 1k-10k=0.5, 10k-100k=0.8, >100k=1.0
    relationship   * 0.15 +    // 0..1, 1st=1.0, 2nd=0.6, 3rd=0.3, follow-only=0.4
    recency        * 0.10 +    // 0..1, linear decay over 24h, 0 after
    engagement     * 0.10 +    // 0..1, log-normalized (likes + 5*comments)
    diversityBonus * 0.05      // 0..1, +1 if author not in last 5 displayed
) * 100

apply penalties:
- if alreadyEngaged(postId): score = 0 (filtered out)
- if isOwnPost: score = 0 (filtered out)
- if dismissed(postId): score = 0 (filtered out)
- if obviousAiContent(post): score *= 0.5
```

Threshold buckets:
- `score >= 70` → `engage_now`
- `40 <= score < 70` → `consider`
- `score < 40` → `skip` (still computed, hidden in UI by default)

## SSI Capture Flow (with MV3 keep-alive)

```
chrome.alarms ──fires every 1440 min──► background.ts handler
                                          │
                                          ├─ keepAlive.start()  ← see "MV3 keep-alive" below
                                          │
                                          ├─ chrome.tabs.create({ url: '/sales/ssi', active: false })
                                          │   await chrome.tabs.onUpdated 'complete' (with 30s timeout)
                                          │
                                          │   (ssi-content.ts injected by registered content script)
                                          │   parses DOM → ssi-parser.ts
                                          │   chrome.runtime.sendMessage('ssi.snapshotReady', snapshot)
                                          │
                                          ├─ background receives snapshot
                                          │   storage-schema.appendSsiSnapshot()
                                          │   chrome.tabs.remove(tabId)
                                          │   keepAlive.stop()
                                          │
                                          └─ if user not logged in / DOM missing / timeout →
                                              storage-schema.setSsiLastError()
                                              keepAlive.stop()
                                              skip silently
```

Manual capture: same flow triggered by `ssi.captureNow` message from popup.

### MV3 service-worker keep-alive (`src/keep-alive.ts`)

MV3 service workers suspend after ~30 seconds of event-loop idle. SSI capture spans tab create → page load → content-script parse → message arrival → up to 30+ seconds in slow-network or slow-LinkedIn scenarios. If the SW suspends mid-flow, the snapshot message is lost.

Implementation: `keepAlive.start()` opens a `chrome.runtime.connect` long-lived port to itself (no other listener) and sends a no-op `port.postMessage('ping')` every 20 seconds via `setInterval`. Active ports keep the SW alive. `keepAlive.stop()` clears the interval and disconnects the port.

This is the canonical MV3 pattern (see Chrome docs on SW lifecycle). Memory cost is negligible. Avoid the `chrome.offscreen` API for this — overkill for a 30-second window and adds another long-running context.

### Profile Capture Flow (NEW v1.1 — replaces previous spec)

```
User opens own LinkedIn profile (e.g. linkedin.com/in/vasyl-vdovychenko)
   │
   ▼
User opens LinkMate popup → clicks "Capture profile"
   │
   ▼
popup.ts → chrome.tabs.query({active:true, currentWindow:true})
   │
   ├─ if active tab URL not /in/{handle} →
   │    show CTA "Open your profile, then click Capture"
   │    [Open my profile ↗] button → chrome.tabs.update({url:'https://www.linkedin.com/in/me'})
   │    abort
   │
   ▼
chrome.scripting.executeScript({
    target: { tabId: activeTabId },
    files:  ['profile-injected.js'],
})  → returns { result: RawProfileFields }
   │
   ▼
popup sends profile.capture message to background with raw fields
   │
   ▼
background runs WebLLM via existing inference path
   → buildPositioningPrompt(rawFields)
   → 2-sentence positioning summary
   │
   ▼
storage-schema.setProfile({...rawFields, positioningSummary, capturedAt: now})
   │
   ▼
popup re-renders Profile tab with captured data
```

Key properties:
- **No registered content script on `/in/*`** — zero footprint when user browses other people's profiles.
- **One-shot injection** — `executeScript` runs the parser once, returns data, disposes. No persistent listeners.
- **User-initiated only** — every capture is a click in the popup. No background-tab creation.
- **Active-tab guard** — capture only runs against the tab currently in focus, never a background tab.

## Prompt Templates (handled by `prompt-builder.ts`)

All prompts are templated functions, not concatenated strings, so test cases can assert exact prompt structure given exact inputs.

```typescript
// Comment draft
buildCommentPrompt({
  profile: ProfileContext,
  post: ParsedPost,
  tone: 'professional' | 'friendly' | 'enthusiastic' | 'thoughtful',
  length: 'brief' | 'standard' | 'detailed',
}): { system: string; user: string }

// Connection note
buildConnectionNotePrompt({
  profile: ProfileContext,
  target: { name: string; title: string; recentActivity: string },
}): { system: string; user: string }

// Profile positioning summary
buildPositioningPrompt({
  headline: string,
  about: string,
  topSkills: string[],
  recentPostThemes: string[],
}): { system: string; user: string }
```

The system prompt for comment generation includes (in order): user positioning summary, anti-genericism rules, length+tone instructions, do-not-do list ("never start with 'Great post'", "never sign with name", "never use emojis unless post uses them"), and a 1-shot example.

## Manifest Changes

```jsonc
{
  // existing entries kept
  "content_scripts": [
    { "matches": ["https://*.linkedin.com/*"], "js": ["linkedin-content.ts"], ... },
    // NEW (registered):
    { "matches": ["https://www.linkedin.com/sales/ssi*"], "js": ["ssi-content.ts"], "run_at": "document_idle" }
    // NOTE: NO registered content script on /in/* — profile capture uses
    // chrome.scripting.executeScript on user-click, see Profile Capture Flow.
  ],
  "permissions": [
    "storage", "tabs", "activeTab", "windows", "alarms",
    "scripting"  // NEW — required for chrome.scripting.executeScript profile capture
  ]
}
```

## UI Spec — Engagement Queue Sidebar

Mount on `/feed/`, anchored top-right, 360px wide, max-height 90vh, scrollable. Position remembered in storage.

```
┌─ LinkMate · Engagement Queue ─── [⚙] [_] [×] ┐
│                                                │
│  SSI today: 23  ↗ +5 this week                 │
│                                                │
│  Tone:   ◯ Prof  ● Friendly  ◯ Ent  ◯ Thought  │
│  Length: ◯ Brief  ● Std  ◯ Det                 │
│                                                │
├────────────────────────────────────────────────┤
│ ① 87  engage_now                               │
│   Andrej Karpathy · 2h · "On MCP and the…"     │
│   Why: matches RAG, 100k+ author, 1st degree   │
│   ┌──────────────────────────────────────────┐ │
│   │ Spent the last month building an MCP     │ │
│   │ server in C# — completely agree on tool  │ │
│   │ composition; that's where the real lift  │ │
│   │ comes from.                              │ │
│   └──────────────────────────────────────────┘ │
│   [↻ Regenerate]   [📋 Copy & Open Post]       │
│   [Hide this post]                             │
├────────────────────────────────────────────────┤
│ ② 72  engage_now                               │
│   ...                                          │
└────────────────────────────────────────────────┘
```

## UI Spec — SSI Dashboard (popup tab)

```
┌─ Replies | SSI | Profile | Settings ─┐
│ SSI tab active:                       │
│                                       │
│   Current: 23 / 100                   │
│   Industry: Top 75% (was 80% 2w ago) │
│   Network:  Top 88% (was 91% 2w ago) │
│                                       │
│   ┌─────────────────────────────────┐ │
│   │ 30-day trend graph (Chart.js)   │ │
│   │   line: total                   │ │
│   │   stacked area: 4 components    │ │
│   └─────────────────────────────────┘ │
│                                       │
│   Insight: Your "Engage" score has   │
│   risen 14% this week. Keep it up —  │
│   target 30 by next Monday.          │
│                                       │
│   [↻ Refresh now]  [Open SSI page ↗] │
└───────────────────────────────────────┘
```

## Phased Delivery

| Phase | Scope | Target |
|---|---|---|
| Phase A — Foundation | Storage schema, ProfileContext, prompt-builder, all pure-logic + tests | Day 1–2 |
| Phase B — Engagement Queue | relevance-scorer, engagement-queue + CSS, linkedin-content.ts mount | Day 3–6 |
| Phase C — SSI Tracker | ssi-parser, ssi-content.ts, background alarm, popup SSI tab + Chart.js | Day 7–9 |
| Phase D — Polish | Insights logic, error/empty states, integration tests, docs (CLAUDE.md, README, CHANGELOG) | Day 10–11 |
| Phase E — Connection Suggestor (deferred) | Scaffolding + tests only in v0.4.0; full UI in v0.4.1 | Day 12 |

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LinkedIn DOM updates break parsers | High | Medium | Fixture-driven tests; parsers throw typed errors; popup surfaces parse-failure chip |
| LinkedIn detects extension as bot | Low | High | Zero programmatic submits; respect rate limits; preserve compliance warning |
| WebLLM model latency >5s for some posts | Medium | Low | Streaming UI ("Drafting…"); allow user to skip a post and move on |
| User confused by sidebar appearing on feed | Medium | Low | First-run callout; dismissable; remembered position |
| chrome.storage 5MB cap reached with 90 snapshots + history | Low | Low | Snapshots ~200 bytes each → 18 KB / 90 days; well under cap |
| /sales/ssi requires Sales Navigator subscription | Low | Medium | Detect 403/redirect, surface "Upgrade required" notice, fall back to manual entry |
| **MV3 service-worker suspends mid-SSI-capture** | Medium | High | `src/keep-alive.ts` self-port pattern wraps the capture flow (start→capture→stop). If the message still doesn't arrive in 30s the flow times out, sets SsiLastError, and tries again next alarm. Documented in SSI Capture Flow above. |
| **MV3 SW suspends mid-WebLLM inference** | Low | Medium | WebLLM's web worker keeps SW alive while inference runs (existing behavior). Verify in Phase B with a deliberate suspension test. |
| User clicks "Capture profile" while not on a profile page | Medium | Low | Active-tab URL guard in popup; CTA "Open your profile" with one-click navigation. |
| `chrome.scripting.executeScript` blocked by CSP on the LinkedIn page | Low | Medium | LinkedIn doesn't restrict isolated worlds for extensions; `world: 'ISOLATED'` (default) sidesteps page CSP. Tested in Phase A spike. |

## References

- Spec: `./spec.md`
- Constitution: `../../.specify/memory/constitution.md` (v1.1.0+ required)
- Backlog items subsumed (`TODO.md` removed pre-spec): Reply Tone Selector → US1, Connection Requests → US4, Compose InMail → deferred. See `spec.md` §References for full mapping.
- Existing background patterns: `../../src/background.ts`
- Existing content-script DOM patterns: `../../src/linkedin-content.ts`
