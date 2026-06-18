# Privacy Policy

_Last updated: June 1, 2026_

LinkMate ("the extension") is a Chrome extension that helps LinkedIn users track their Social Selling Index (SSI), audit their profile, and generate AI-assisted reply drafts. This document describes what data LinkMate handles and how.

## TL;DR

- LinkMate has **no servers**. We do not collect, store, or transmit your data to LinkMate-operated infrastructure.
- The extension stores your settings and captured LinkedIn context locally in `chrome.storage.local` on your device.
- When you click "Generate Reply" or trigger any AI action, the extension sends a request **directly from your browser** to your chosen LLM provider (OpenAI or Groq) using **your own API key**.
- The extension does **not** track, sell, or share your data with any third party.

## What data LinkMate processes

The extension reads and stores the following data **locally on your device only**:

| Data | Source | Storage | Purpose |
| --- | --- | --- | --- |
| OpenAI / Groq API key | You enter it manually | `chrome.storage.local` | Authenticate calls to the LLM provider you chose |
| Model preferences (provider, model name, temperature, max tokens) | Your selection | `chrome.storage.local` | Apply your settings to generated drafts |
| Custom system prompts | Your edits | `chrome.storage.local` | Used to construct LLM requests |
| LinkedIn profile context (name, headline, about, skills, recent themes) | Scraped from `linkedin.com/in/<you>` when you click Capture Profile | `chrome.storage.local` | Personalize drafts so they match your voice |
| SSI score history | Scraped from `linkedin.com/sales/ssi` daily | `chrome.storage.local` | Render trend chart and components |
| Post content being engaged with | LinkedIn post DOM on `linkedin.com/feed/*` | In-memory and sent to your LLM provider only when you click "Generate Reply" | Compose a relevant draft reply |
| Engagement queue state ("marked engaged" flags) | Your clicks | `chrome.storage.local` | Avoid re-suggesting posts you've already handled |

## Where data is sent

LinkMate makes network requests to two categories of endpoints:

1. **`https://www.linkedin.com/*`** — to read pages you are already authenticated on (feed, profile, SSI). The extension does not log in, post, comment, send messages, or click "Submit" on your behalf.
2. **`https://api.openai.com/*`** or **`https://api.groq.com/*`** — only when you explicitly trigger an action that requires AI generation (e.g., "Generate Reply", "Capture Profile" summary). The request is authenticated with **your own API key** and the request body contains the post content + your profile context + your custom system prompt. Responses are returned directly to your browser.

LinkMate does **not** send data to any other server, including LinkMate-operated servers, analytics services, error reporting services, or advertising networks.

## What LinkMate does **not** do

- We do not run any servers that receive your data.
- We do not collect analytics, telemetry, or usage statistics.
- We do not include third-party trackers, advertising SDKs, or session replay tools.
- We do not sell, share, or transfer your data to anyone.
- We do not click Submit / Post / Send buttons on LinkedIn for you. Every action is "copy → paste → edit → you submit."
- We do not read your LinkedIn private messages (DMs).
- We do not access financial information, location, health data, or browsing history outside LinkedIn.

## Your control over your data

- All data is stored in `chrome.storage.local`. You can clear it any time by uninstalling the extension or via `chrome://extensions` → LinkMate → Storage → Clear.
- Your API key can be removed in the LinkMate settings panel.
- Captured LinkedIn profile context can be cleared from the same panel.

## Third-party LLM providers

When you use OpenAI or Groq through LinkMate, your interactions are subject to their respective privacy policies and terms:

- OpenAI: https://openai.com/policies/privacy-policy
- Groq: https://groq.com/privacy-policy/

LinkMate does not control how these providers handle the data you submit through your own API key. Choose the provider you trust.

## Changes to this policy

We may update this policy as the extension evolves. Material changes will be reflected in the "Last updated" date at the top and noted in the release notes for the corresponding extension version.

## Contact

Questions or concerns? Open an issue at https://github.com/mrviduus/linkmate/issues or email mrviduus@gmail.com.
