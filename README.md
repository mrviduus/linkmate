# LinkMate

Chrome MV3 extension — AI-powered LinkedIn assistant. Tracks your Social Selling Index (SSI), audits profile completeness, drafts in-voice replies on the feed via OpenAI (BYOK).

## Features

- **OpenAI reply drafts** — generate professional 1–2 sentence replies on any LinkedIn post; smart mode analyzes top comments before drafting.
- **SSI Tracker** — daily snapshot of your Social Selling Index with donut + trend chart; manual refresh and daily background capture.
- **Profile Context** — capture your own profile (headline / about / skills / recent themes) so drafts read in your voice.
- **Engagement Queue** — scored feed posts on `/feed/*` ranked by relevance to your profile, with one-click draft + mark-engaged.
- **Prompt customization** — edit standard and smart-reply system prompts; adjust temperature + max tokens.

## Install (dev)

```bash
npm install
npm run build
```

Then in Chrome:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick `dist/`
3. Click the LinkMate icon → paste your OpenAI API key → choose model (default `gpt-4o-mini`)

## Use

| Page | What happens |
| --- | --- |
| Any LinkedIn post | Inline "Generate AI reply" button (smart mode reads top comments) |
| `linkedin.com/feed/*` | Engagement Queue sidebar ranks posts by relevance |
| `linkedin.com/in/<you>` | Click **Capture Profile** in popup to ingest your context |
| `linkedin.com/sales/ssi` | Click **Refresh now** in popup, or wait for the daily alarm |

## Stack

Parcel + `@parcel/config-webextension` · Vanilla TypeScript · Chart.js (lazy) · OpenAI REST (no SDK — `fetch` direct from service worker) · `chrome.storage.local`.

```
src/
  background.ts         service worker — message router, OpenAI calls, SSI daily alarm
  popup.html/css/ts     popup UI — settings, profile, SSI dashboard, prompts
  linkedin-content.ts   per-post reply injection on all LinkedIn pages
  engagement-queue.ts   feed sidebar widget (relevance scoring + draft)
  ssi-content.ts        scraper for /sales/ssi
  profile-parser.ts     /in/<slug> profile scraper
  profile-context.ts    capture orchestration (popup → background)
  prompt-builder.ts     positioning + comment prompt construction
  relevance-scorer.ts   post-to-profile relevance heuristics
  storage-schema.ts     typed chrome.storage.local helpers
  providers/            OpenAI provider + factory
```

## Scripts

```bash
npm run dev          # parcel watch
npm run build        # parcel production build → dist/
npm run zip          # build + package (scripts/package.sh)
npm test             # jest
npm run type-check   # tsc --noEmit
npm run lint         # eslint
```

## Notes & risks

- **OpenAI cost** — all generation hits OpenAI. Default `gpt-4o-mini` is cheap (~$0.15/M input). Models picker supports gpt-4o, gpt-4.1, o4-mini.
- **API key** — stored in `chrome.storage.local` (plaintext, not synced). Don't install on shared machines.
- **LinkedIn ToS** — drafts are pre-fill only; you submit. No auto-actions, no scheduling.
- **DOM fragility** — LinkedIn obfuscates class names; selectors centralized in `feed-parser.ts`, `profile-parser.ts`, `ssi-parser.ts` for one-place fixes.

## License

ISC.
