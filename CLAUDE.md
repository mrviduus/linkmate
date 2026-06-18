# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

LinkMate is a **Manifest V3 Chrome extension** that helps users grow on LinkedIn: tracks their SSI score, audits their profile, and drafts comments/replies via an LLM. **Zero backend** — all state lives in the browser; the only network egress is the user's own OpenAI/Groq API key (BYOK) hitting the provider directly. TypeScript strict, bundled by Parcel's webextension config.

## Commands

```bash
npm run dev          # parcel watch → rebuilds dist/ on change (load dist/ unpacked in chrome://extensions)
npm run build        # production bundle into dist/
npm run zip          # build + package dist/ into linkmate.zip
npm test             # jest (jsdom), all suites
npm run test:watch   # jest watch
npx jest tests/ssi-parser.spec.ts          # run ONE test file
npx jest -t "name of test"                 # run tests matching a name
npm run type-check   # tsc --noEmit, strict
npm run lint         # eslint, --max-warnings=0 (CI fails on any warning)
npm run format       # prettier --write
```

There is no compile step before tests — `ts-jest` transforms on the fly. Parcel is the only thing that reads `src/manifest.json` as the entry point.

## Architecture

Three execution contexts, isolated by Chrome's extension model. They never share memory — **all cross-context communication is `chrome.runtime.sendMessage` with `{ action: '...' }` envelopes**, routed by the big `onMessage` switch in `background.ts`.

1. **Background service worker** (`background.ts`) — the orchestrator and the *only* writer of most storage. Owns: the message router (every `action.*`, `queue.*`, `provider.*`, `ssi.*`, `profile.*`, `cadence.*`, `recommender.*` handler), LLM calls (always via `getActiveProvider()`), SSI capture orchestration, and two daily `chrome.alarms` (SSI snapshot + recommender refresh). MV3 workers die when idle — `keep-alive.ts` (`keepAlive.start()/stop()`) wraps long async work like LLM calls and SSI capture.

2. **Content scripts** — injected into LinkedIn pages (see `manifest.json` `content_scripts`):
   - `linkedin-content.ts` (all `*.linkedin.com/*`) — detects posts/comments via `MutationObserver`, injects the per-post AI overlay (`feed-post-overlay.ts`), runs `outcome-scanner.ts`. Parses feed with `feed-parser.ts`.
   - `ssi-content.ts` (only `/sales/ssi*`) — scrapes the SSI page via `ssi-parser.ts`, posts a snapshot back to background.
   - Content scripts **read** profile/engaged/dismissed storage but **never write** — they message background to write.

3. **Side Panel UI** (`popup.html` / `popup.ts` / `popup.css`) — `manifest.json` declares `popup.html` as `side_panel.default_path`, so the toolbar icon opens a **side panel, not a popup**. `welcome.*` is the first-install onboarding tab. Renders SSI dashboard (charts via `chart.js`, lazy-loaded through `chart-loader.ts`), profile audit, engagement queue, cadence/streak, settings.

### SSI capture flow (non-obvious)
`ssi.captureNow` → background opens a **background tab** at `/sales/ssi` → `ssi-content.ts` scrapes and sends `ssi.snapshotReady` → background resolves a pending promise (`pendingSsiCapture`), stores the snapshot, closes the tab. Times out at 30s; detects login redirects and reports "not signed in". Same path runs daily via `SSI_ALARM_NAME`.

### Provider abstraction
`src/providers/` — `getActiveProvider()` reads stored `ProviderConfig` and builds an `InferenceProvider` (OpenAI default, Groq optional). All LLM calls go through `provider.generate({ system, user, ... })`. Add new backends here without touching callers. CSP and `host_permissions` in `manifest.json` gate which API hosts are reachable — **add a host there when adding a provider**.

### Data layer (`storage-schema.ts` is the source of truth)
- `chrome.storage.local` — hot state: API key, profile, cached cards, SSI history (90-snapshot ring buffer). Keys are versioned `linkmate.<area>.vN`; breaking changes bump `SCHEMA_VERSION` + add a `migrateIfNeeded` step.
- `chrome.storage.sync` — non-secret prefs only (custom prompts, AI temperature/maxTokens). **Secrets are never synced.**
- **IndexedDB** (`action-log.ts` via `idb`, helpers in `lib/idb.ts`) — append-only time-series ledger of actions + outcomes; backs `cadence.ts` streaks and `recommender.ts` ranking.

### Reply generation pipeline
`prompt-builder.ts` / `*-prompts.ts` build prompts → `provider.generate` → `cleanReply()` strips LLM preambles → `trimToTwoSentences()` → `validateReplyQuality()` scores it; low scores trigger one retry at higher temperature (`generateWithRetry`). Default system prompts live in `background.ts` (`DEFAULT_PROMPTS`); users can override them via `chrome.storage.sync.customPrompts`.

## Conventions

- **Strict TypeScript** + ESLint `--max-warnings=0`; both run in CI (`.github/workflows/build.yml`). Run `type-check` and `lint` before considering a change done.
- Storage keys: always go through `STORAGE_KEYS` and the typed getters/setters in `storage-schema.ts` — don't hardcode key strings.
- Tests live in `tests/` (`*.spec.ts` for unit, `*.test.ts` for integration) with `tests/setup.ts` mocking the `chrome.*` APIs and `tests/fixtures/` holding LinkedIn DOM samples. Each `src/` module has a matching spec.
- **LinkedIn ToS guardrail:** drafts are pre-fill only. Never write code that auto-submits, auto-clicks, or schedules actions on the user's behalf.
