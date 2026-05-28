[# LinkMate

> **Stop working for LinkedIn.** LinkMate is an AI agent that makes LinkedIn work for you — auditing your profile and feed, then telling you what to fix, who to engage, and what to post next.

A Chrome MV3 extension. Cloud-only (your OpenAI key, BYOK). No data leaves your browser except prompts you send to OpenAI.

Built in ~5 days · 28 test suites · 355 unit tests · zero runtime backend.

## The problem

LinkedIn's Social Selling Index ranks you 0–100 across four pillars (Brand · Find People · Engage · Build Relationships). The score is opaque, lagging, and only moves when you do the right *things* — comment thoughtfully, send invites, ship original posts, reply in threads. Most people guess. The lucky ones grind.

## What LinkMate does

- **Reads your SSI + your profile** and tracks how the score moves week-over-week.
- **Audits your profile** against 6 LinkedIn All-Star essentials (current position / education / skills ≥5 / about ≥50 chars / location / connections ≥50) and surfaces 4 activity signals (SSI ≥50, posts ≥4/30d, comments ≥8/30d, network ≥500) — all deterministic, instant, free.
- **Generates paste-ready profile rewrites** via two parallel LLM calls — a copy editor (headline + about + experience + photoBanner + openToWork) and an SSI strategist (weakest-pillar action + engagement angle grounded in your top posts + network growth tactic). Each click stores `{checkId, stem}` history so regenerate avoids repeating concepts.
- **Sets weekly quotas** mapped to each SSI pillar (1 post / 5 invites / 3 comments / 2 thread replies — tunable). Bars + a streak counter make it visceral.
- **Picks 3 actions a day** biased to your weakest pillar. Each card opens the relevant LinkedIn page in one click.
- **Drafts replies and original posts** in your voice using captured profile context + your topic distribution.
- **Closes the loop** — tracks which actions you actually took and what they got (likes / replies), and feeds outcomes back into tomorrow's prompt.

## Demo path (~3 min)

1. Load unpacked → paste OpenAI key.
2. Open your own LinkedIn profile → **Capture Profile** in popup (extracts headline / about / skills / themes → AI synthesizes a 2-sentence positioning summary).
3. **Profile audit** section appears under the hero — progress bar of 6 essentials + activity signals (SSI, posts/30d, comments/30d, network depth) — all computed instantly without an API call.
4. Click **Get AI rewrites for N gaps** → paste-ready copy lands under each failed check (headline / about / experience) + SSI tactical action + engagement angle. Each card has a **Copy** button. Click **Regenerate AI rewrites** for a different concept on every item.
5. Open `linkedin.com/sales/ssi` → **Refresh now** → score + 4 pillar gauges + donut chart populate.
6. Open `linkedin.com/feed/` → ✨ Reply button on every post; sidebar ranks the feed by relevance to your profile.
7. Open popup → **Today** tab: 3 AI cards biased to weakest pillar + cadence progress bars + streak.
8. Click **Suggest a post** → modal opens with 3 distinct drafts (story / hot take / lesson) tuned to your underweight topics.

## Architecture

```
LinkedIn tabs                Extension SW                 Popup UI
─────────────               ──────────────               ──────────
linkedin.com/*       ─┐
linkedin.com/in/*    ─┼─► content scripts ─► background.ts ─► popup.html
linkedin.com/feed/*  ─┘   (scrape + inject)  (orchestrator)    (Today/SSI/
                               │                  │             Profile/Settings)
                               │                  │
                               ▼                  ▼
                       chrome.storage.local    OpenAI API
                       (profile, settings,     (BYOK · gpt-4o-mini
                        SSI snapshots)          default)
                               +
                           IndexedDB
                          (action log,
                           outcomes)
```

**Modules** (in `src/`):

| File | Responsibility |
| --- | --- |
| `linkedin-content.ts` | Injects Reply button into every post; mounts Engagement Queue on `/feed/` |
| `ssi-content.ts` + `ssi-parser.ts` | Daily scrape of `/sales/ssi` — total + 4 component scores + industry/network rank |
| `profile-parser.ts` + `profile-context.ts` | Captures own profile fields and orchestrates the AI positioning summary |
| `profile-audit.ts` | Pure rule engine: 6 completeness checks + 4 activity signals (SSI, posts/30d, comments/30d, network) — no I/O, fully tested |
| `profile-audit-prompts.ts` | Two strict-JSON prompt builders — copy editor (rewrites + photoBanner + openToWork) and SSI strategist (pillar action + engagement + network growth) with a shared banned-phrase list and concept-rotation directives |
| `profile-recommender.ts` | Runs both prompts via Promise.allSettled (partial success allowed), parses + dedupes + caps |

### Profile audit flow

```
                    ┌─────────────────────────────────┐
                    │   LinkedIn profile (DOM)        │
                    └──────────────┬──────────────────┘
                                   │ parser
                                   ▼
                    ┌─────────────────────────────────┐
                    │   IDB.userProfile (full snap)   │
                    │   + SsiSnapshot history         │
                    └──────────────┬──────────────────┘
                                   │
                  ┌────────────────┴──────────────────┐
                  ▼                                   ▼
       ┌──────────────────┐                ┌──────────────────────┐
       │ auditProfile()   │                │ computeActivity      │
       │ 6 rules → score  │                │ Signals(profile,ssi) │
       └─────────┬────────┘                └──────────┬───────────┘
                 │  deterministic                     │  deterministic
                 ▼                                    ▼
       ┌────────────────────────────────────────────────────┐
       │  popup renders Profile audit + Activity signals    │
       │  (no LLM yet — instant, free)                      │
       └─────────────────────┬──────────────────────────────┘
                             │  user clicks "Get AI rewrites"
                             ▼
       ┌────────────────────────────────────────────────────┐
       │   background.handleProfileAuditRewrite             │
       │   ┌─────────────────────────────────────────────┐  │
       │   │ 1. Load: profile, audit, ssi, goals,        │  │
       │   │    storedState.avoidStems (if regenerate)   │  │
       │   └────────────┬────────────────────────────────┘  │
       │                ▼                                    │
       │   ┌─────────────────────────────────────────────┐  │
       │   │ Promise.allSettled([                        │  │
       │   │   copyEditor(profile,audit,goals,avoid),    │  │
       │   │   ssiStrategist(profile,ssi,goals,avoid)    │  │
       │   │ ])                                          │  │
       │   └────────────┬────────────────────────────────┘  │
       │                ▼                                    │
       │   ┌─────────────────────────────────────────────┐  │
       │   │ parseJSON → ProfileRecommendation[]         │  │
       │   │ merge, dedupe by checkId, cap 12            │  │
       │   └────────────┬────────────────────────────────┘  │
       │                ▼                                    │
       │   ┌─────────────────────────────────────────────┐  │
       │   │ accumulate avoidStems[]: prev + new         │  │
       │   │ (as {checkId, stem 200 chars} per entry)    │  │
       │   │ dedupe + cap 24, save to chrome.storage     │  │
       │   └────────────┬────────────────────────────────┘  │
       └────────────────┼───────────────────────────────────┘
                        ▼
            ┌────────────────────────────┐
            │ popup re-renders cards     │
            │ Copy button per item       │
            └────────────────────────────┘

   Click "Regenerate" → same flow with `regenerate=true` → reads
   stored.avoidStems → feeds both prompts grouped by checkId so the
   LLM has to pick a DIFFERENT concept for each known checkId.
```

| `engagement-queue.ts` + `relevance-scorer.ts` | Ranks feed posts vs profile (topic match 40% / tier 20% / degree 15% / recency 10% / engagement 10% / diversity 5%) |
| `action-log.ts` + `cadence.ts` | Append-only IndexedDB ledger of every action; rolling 7-day quota math + weakest-pillar selection + streak |
| `topic-tagger.ts` | Heuristic keyword tagger over 13 topics (no AI cost) attributing each action to a topic |
| `outcome-scanner.ts` | Lazy auto-read of likes + replies on the user's own comment when they revisit a post |
| `recommender.ts` + `prompt-builder.ts` | Daily 3-card generator (strict-JSON prompt grounded in profile + cadence + topics + outcomes + SSI insight) + post drafter + weekly retro |
| `providers/` | OpenAI fetch wrapper behind a `generate()` interface (Anthropic / Groq later) |
| `popup.html` / `.ts` / `.css` | Today tab (cards + bars + streak), Settings (key, quotas, prompts), SSI dashboard, Profile capture |
| `background.ts` | Message router · daily alarms for SSI capture and recommender refresh · rule-based fallback when no API key |

## Storage

Three backends — chosen by data shape, not convenience. Everything stays in your browser.

**`chrome.storage.local`** — hot key-value state (10 MB cap, each get = full JSON.parse). Lives in `src/storage-schema.ts` → `STORAGE_KEYS`:

| Key | Holds |
| --- | --- |
| `linkmate.profile.v1` | `ProfileContext` (headline, about, skills, positioning summary) |
| `linkmate.ssi.history.v1` | `SsiSnapshot[]` — ring buffer of 90 daily captures |
| `linkmate.ssi.lastError.v1` | Last SSI capture failure for the popup chip |
| `linkmate.queue.engaged.v1` | Engaged postIds with 30-day TTL |
| `linkmate.queue.dismissed.v1` | Dismissed postIds (forever) |
| `linkmate.provider.v1` | `{mode, openai: {apiKey, model}}` — BYOK, never synced |
| `linkmate.cadence.targets.v1` | `{brand, finding, engaging, building}` weekly quotas |
| `linkmate.cadence.streak.v1` | `{count, lastWindowEnd}` consecutive full-quota weeks |
| `linkmate.recommender.cards.v1` | Cached AI cards + generatedAt + source (ai/rule) |
| `linkmate.profile.audit.v1` | Last audit report + AI recommendations + `avoidStems[]` (concept history `{checkId, stem}` capped at 24, fed back on regenerate to force fresh angles) |
| `linkmate.retro.lastShown.v1` | Timestamp of last weekly-retro dismissal |
| `linkmate.schema.version` | For future migrations |

**`chrome.storage.sync`** — cross-device settings (100 KB cap):

| Key | Holds |
| --- | --- |
| `customPrompts` | User overrides of default reply prompts (standard + withComments) |
| `aiTemperature` / `aiMaxTokens` | Generation params (sliders in popup) |

OpenAI key is **deliberately not synced** — per-device secret.

**IndexedDB** (`linkmate` db v1, `src/lib/idb.ts` wrapper) — append-only time-series:

```
actions  store (autoinc id)
  value: {type, pillar, timestamp, postId?, draftText?, submitted, topics?}
  indexes: by-type-ts [type, timestamp] · by-ts timestamp

outcomes store (autoinc id)
  value: {actionId, timestamp, likes?, replies?, source: 'auto'|'manual', manualVerdict?}
  index: by-action actionId
```

Time-series in `chrome.storage.local` would re-parse the whole array on every popup-open and hit the 10 MB cap within months. IDB indexes give O(log n) `IDBKeyRange.lowerBound(now - 7d)` for cadence + outcome lookups.

**Write path** — content scripts never write directly; they send `chrome.runtime.sendMessage({action:'action.log.append', ...})` and the background service worker is the sole writer. Single-writer simplifies migrations and avoids storage races.

## Technical highlights

- **MV3 service worker** with idempotent `chrome.alarms` registration that survives SW eviction and missed install events.
- **IndexedDB via `idb`** (~1 KB wrapper) for the action log + outcomes — `chrome.storage.local` is unusable for time-series (every read is a JSON.parse of the whole key, 10 MB cap).
- **OpenAI provider** speaks raw `fetch` from the service worker (no SDK) — strict-JSON response parsing with validation + URN-shape guard against hallucinated `postId`s + rule-based fallback when the API key is missing.
- **Lazy outcome auto-attach** piggy-backs on natural LinkedIn navigation — no background tabs spawned, no ToS-risky polling. Manual 👍/👎 chip covers the rest.
- **Chart.js tree-shake wrapper** (`src/chart-loader.ts`) registers only the line + doughnut controllers we use — 2.2 MB → 566 KB gzipped, dynamically imported on popup open.
- **Heuristic topic tagger first** (13 keyword sets, 70% accuracy, free) — AI tagging is a planned v2 upgrade behind the same interface.
- **CI** runs build + 355 tests on every push & PR. Tag-push triggers release workflow that builds a zip and publishes a GitHub Release automatically.

## Install

```bash
npm install
npm run build
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → pick `dist/`.

Click LinkMate icon → paste OpenAI key (get one at <https://platform.openai.com/api-keys>) → Save.

## Use

| Where | What happens |
| --- | --- |
| Any LinkedIn post | ✨ **Reply** button drafts an AI comment into the composer |
| `linkedin.com/feed/*` | **Engagement Queue** sidebar ranks posts by relevance |
| `linkedin.com/in/<you>` | **Capture Profile** in popup ingests your context |
| `linkedin.com/sales/ssi` | **Refresh now** in popup; daily alarm handles it otherwise |
| Popup → Today | 3 AI cards · cadence bars · streak · pending-outcome chips · **Suggest a post** modal |

## Scripts

```bash
npm run dev          # parcel watch
npm run build        # parcel → dist/
npm run zip          # build + zip → linkmate.zip
npm test             # 28 suites · 355 tests · ~6s
npm run type-check   # tsc --noEmit
npm run lint         # eslint
```

## Releases

Pre-built zip per tag at <https://github.com/mrviduus/linkmate/releases>. Download, unzip, load unpacked.

## Notes

- **OpenAI key** lives in `chrome.storage.local` (plaintext, not synced). Don't install on shared machines.
- **LinkedIn ToS**: drafts are pre-fill only; you submit. No auto-actions, no scheduling.
- **DOM fragility**: LinkedIn rotates obfuscated class names; selectors live in `feed-parser.ts`, `profile-parser.ts`, `ssi-parser.ts` for one-place fixes.

## License

ISC.
](https://mrviduus.github.io/linkmate/)
