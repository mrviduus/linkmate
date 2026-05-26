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
npm run zip          # build + zip dist → linkmate.zip
npm test             # jest (24 suites, 331 tests)
npm run type-check   # tsc --noEmit
npm run lint         # eslint
```

## Testing

### Automated

```bash
npm install
npm test               # full suite, ~6s
npm run type-check     # zero TS errors expected
npm run build          # parcel production build
```

CI runs `npm ci && npm run build` on every push/PR (`.github/workflows/build.yml`).

### Manual (smoke test, ~5 min)

Prerequisite: an OpenAI API key from <https://platform.openai.com/api-keys>.

1. **Install**
   ```bash
   npm install && npm run build
   ```
   Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick `dist/`.

2. **Configure**
   Click the LinkMate icon → paste the OpenAI key → leave model as `gpt-4o-mini` → **Save**.
   Expect: green "Saved. Using gpt-4o-mini." chip.

3. **Capture profile**
   Click **Open My Profile** → wait for `/in/<you>` to load → in the popup click **Capture Profile**.
   Expect: name + headline + 2-sentence positioning summary appear; "X skills · just now" footer.

4. **Reply button on a feed post**
   Open `linkedin.com/feed/` → scroll to any post → look for the LinkMate **Reply** button in the post's action bar → click it.
   Expect: AI-drafted reply (1–2 sentences, max 40 words, no "Great post!" filler) inserted into the comment composer; user submits manually.

5. **Engagement Queue**
   On `/feed/`, expect a LinkMate sidebar listing scored posts (relevance + reasons). Each card has **Draft** and **Mark engaged** buttons.

6. **SSI Tracker**
   In popup → **Open SSI page** → wait for LinkedIn's `/sales/ssi` to load (sign in required) → back in popup click **Refresh now**.
   Expect: total / 100, donut + 4 component scores, trend chart populated. Daily auto-capture runs in background via `chrome.alarms`.

7. **Custom prompts**
   In popup → edit Standard or Smart Reply prompts → **Save** → trigger a Reply on a post.
   Expect: generated reply visibly follows the custom prompt; **Reset to Defaults** restores them.

### Releases

Pre-built zip per tag at <https://github.com/mrviduus/linkmate/releases>: download `linkmate-vX.Y.Z.zip`, unzip, load unpacked.

## Notes & risks

- **OpenAI cost** — all generation hits OpenAI. Default `gpt-4o-mini` is cheap (~$0.15/M input). Models picker supports gpt-4o, gpt-4.1, o4-mini.
- **API key** — stored in `chrome.storage.local` (plaintext, not synced). Don't install on shared machines.
- **LinkedIn ToS** — drafts are pre-fill only; you submit. No auto-actions, no scheduling.
- **DOM fragility** — LinkedIn obfuscates class names; selectors centralized in `feed-parser.ts`, `profile-parser.ts`, `ssi-parser.ts` for one-place fixes.

## License

ISC.
