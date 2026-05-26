# LinkMate

> **Stop working for LinkedIn.** LinkMate is an AI agent that makes LinkedIn work for you — auditing your profile and feed, then telling you what to fix, who to engage, and what to post next.

A Chrome MV3 extension. Cloud-only (your OpenAI key, BYOK). No data leaves your browser except prompts you send to OpenAI.

Built in ~5 days · 28 test suites · 355 unit tests · zero runtime backend.

## The problem

LinkedIn's Social Selling Index ranks you 0–100 across four pillars (Brand · Find People · Engage · Build Relationships). The score is opaque, lagging, and only moves when you do the right *things* — comment thoughtfully, send invites, ship original posts, reply in threads. Most people guess. The lucky ones grind.

## What LinkMate does

- **Reads your SSI + your profile** and tracks how the score moves week-over-week.
- **Sets weekly quotas** mapped to each SSI pillar (1 post / 5 invites / 3 comments / 2 thread replies — tunable). Bars + a streak counter make it visceral.
- **Picks 3 actions a day** biased to your weakest pillar. Each card opens the relevant LinkedIn page in one click.
- **Drafts replies and original posts** in your voice using captured profile context + your topic distribution.
- **Closes the loop** — tracks which actions you actually took and what they got (likes / replies), and feeds outcomes back into tomorrow's prompt.

## Demo path (~3 min)

1. Load unpacked → paste OpenAI key.
2. Open your own LinkedIn profile → **Capture Profile** in popup (extracts headline / about / skills / themes → AI synthesizes a 2-sentence positioning summary).
3. Open `linkedin.com/sales/ssi` → **Refresh now** → score + 4 pillar gauges + donut chart populate.
4. Open `linkedin.com/feed/` → ✨ Reply button on every post; sidebar ranks the feed by relevance to your profile.
5. Open popup → **Today** tab: 3 AI cards biased to weakest pillar + cadence progress bars + streak.
6. Click **Suggest a post** → modal opens with 3 distinct drafts (story / hot take / lesson) tuned to your underweight topics.

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
| `engagement-queue.ts` + `relevance-scorer.ts` | Ranks feed posts vs profile (topic match 40% / tier 20% / degree 15% / recency 10% / engagement 10% / diversity 5%) |
| `action-log.ts` + `cadence.ts` | Append-only IndexedDB ledger of every action; rolling 7-day quota math + weakest-pillar selection + streak |
| `topic-tagger.ts` | Heuristic keyword tagger over 13 topics (no AI cost) attributing each action to a topic |
| `outcome-scanner.ts` | Lazy auto-read of likes + replies on the user's own comment when they revisit a post |
| `recommender.ts` + `prompt-builder.ts` | Daily 3-card generator (strict-JSON prompt grounded in profile + cadence + topics + outcomes + SSI insight) + post drafter + weekly retro |
| `providers/` | OpenAI fetch wrapper behind a `generate()` interface (Anthropic / Groq later) |
| `popup.html` / `.ts` / `.css` | Today tab (cards + bars + streak), Settings (key, quotas, prompts), SSI dashboard, Profile capture |
| `background.ts` | Message router · daily alarms for SSI capture and recommender refresh · rule-based fallback when no API key |

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
