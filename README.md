# LinkMate

Chrome MV3 extension — LinkedIn SSI growth assistant. Tracks your Social Selling Index, audits profile completeness, suggests daily actions, drafts AI comments on the feed (semi-auto, you review before posting).

## Features

- **SSI tracking** — scrapes `linkedin.com/sales/ssi` on visit, stores time-series, charts trend.
- **Daily checklist** — likes / comments / posts / courses targets, auto-tuned to your weakest SSI pillar. Resets at local midnight.
- **Profile audit** — runs on your `/in/<slug>` page; scores banner, headline, about, skills, featured, experience, activity.
- **AI comment drafts** — ✨ Draft button on each feed post → 3 short, varied drafts (supportive / question / contrarian) via OpenAI → fills LinkedIn's comment box (you post manually).

## Install (dev)

```bash
npm install
npm run build
```

Then in Chrome:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick `dist/`
3. Click LinkMate icon → side panel opens → **Settings** → paste OpenAI API key

## Use

| Page | What happens |
| --- | --- |
| `linkedin.com/sales/ssi` | SSI captured into Trend tab |
| `linkedin.com/in/<you>` | Profile audit into Audit tab |
| `linkedin.com/feed/*` | ✨ Draft button on every post |

## Stack

Vite + `@crxjs/vite-plugin` · React + TypeScript · Tailwind · Recharts · OpenAI SDK · `chrome.storage.local`.

```
src/
  background/   service worker — message router, OpenAI calls, midnight alarm
  content/      ssi.ts · profile.ts · feed.ts
  lib/          storage · selectors · openai · types
  ui/panel/     side panel React app
```

## Scripts

```bash
npm run dev      # vite dev (HMR)
npm run build    # tsc + vite build → dist/
npm run zip      # package dist/ → linkmate.zip
```

## Notes & risks

- **LinkedIn ToS** — extension stays semi-auto: never auto-submits, never schedules actions, every action requires your click. Use at your own risk.
- **API key** — stored in `chrome.storage.local` (plaintext, not synced). Don't install on shared machines.
- **DOM fragility** — LinkedIn obfuscates class names; selectors centralized in `src/lib/selectors.ts` and `src/content/*` for one-place fixes when LinkedIn ships UI changes.
- **Placeholder icons** — solid blue squares in `icons/`. Replace before publishing.

## License

MIT.
