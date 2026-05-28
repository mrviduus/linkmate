<a href="https://mrviduus.github.io/linkmate/" target="_blank">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:0A66C2,50:4338ca,100:7c3aed&height=220&section=header&text=LinkMate&fontSize=58&fontColor=ffffff&animation=fadeIn&fontAlignY=42&desc=Stop%20working%20for%20LinkedIn.%20Make%20LinkedIn%20work%20for%20you.&descSize=17&descAlignY=64&descColor=bfdbfe" width="100%" alt="LinkMate — Click to view Live Demo"/>
</a>

<p align="center">
  <br/>
  <a href="https://mrviduus.github.io/linkmate/">
    <img src="https://img.shields.io/badge/View%20Live%20Demo%20%26%20Landing%20Page-%E2%86%92%20Launch-ffffff?style=for-the-badge&labelColor=0A66C2&color=4338ca" height="46" alt="View Live Demo"/>
  </a>
  <br/><br/>
</p>

<p align="center">
  An intelligent, zero-backend, privacy-first AI agent built into your browser.<br/>
  Audits your profile, maps your metrics, and helps you post, engage, and grow — all locally.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Chrome%20Extension-MV3-0A66C2?style=for-the-badge&logo=google-chrome&logoColor=white" />
  &nbsp;
  <img src="https://img.shields.io/badge/OpenAI%20API-BYOK-f97316?style=for-the-badge&logo=openai&logoColor=white" />
  &nbsp;
  <img src="https://img.shields.io/badge/TypeScript-Strict-3178c6?style=for-the-badge&logo=typescript&logoColor=white" />
  &nbsp;
  <img src="https://img.shields.io/badge/License-ISC-22c55e?style=for-the-badge" />
</p>

<br/>

<p align="center">
  <img src="https://img.shields.io/badge/Unit%20Tests-355-38bdf8?style=flat-square&logo=checkmarx&logoColor=white" />
  &nbsp;&nbsp;
  <img src="https://img.shields.io/badge/Test%20Suites-28-a78bfa?style=flat-square&logo=jest&logoColor=white" />
  &nbsp;&nbsp;
  <img src="https://img.shields.io/badge/Build%20Time-~5%20Days-34d399?style=flat-square&logo=clockify&logoColor=white" />
  &nbsp;&nbsp;
  <img src="https://img.shields.io/badge/Backend%20Cost-%240.00-fb923c?style=flat-square&logo=amazonwebservices&logoColor=white" />
</p>

---

## 💡 The Idea in 60 Seconds

**The Problem:** LinkedIn uses a complex, opaque **Social Selling Index (SSI)** score — spanning *Brand, Finding, Engaging, and Relationships* — to rank every account. It tells you *what* your score is, but never *how* to change it. Most users guess. The lucky ones grind for hours.

**The Solution:** **LinkMate** is a local-first Chrome Extension that parses your profile and SSI score, instantly surfaces optimization gaps and weekly quotas, then drafts targeted posts and replies in your own voice. **No data ever leaves your browser** except the prompts you send directly to OpenAI with your own key (BYOK).

---

## 👥 Built By

We built LinkMate to make organic LinkedIn growth effortless, transparent, and completely private.

<table align="center">
  <tr>
    <td align="center" width="160">
      <img src="https://img.shields.io/badge/SH-AI%20Pipeline-818cf8?style=for-the-badge" /><br/>
      <b>Shyamal</b>
    </td>
    <td align="center" width="160">
      <img src="https://img.shields.io/badge/VA-Engine%20Design-818cf8?style=for-the-badge" /><br/>
      <b>Vasyl</b>
    </td>
    <td align="center" width="160">
      <img src="https://img.shields.io/badge/HO-UI%20%2F%20UX-818cf8?style=for-the-badge" /><br/>
      <b>Houman</b>
    </td>
    <td align="center" width="160">
      <img src="https://img.shields.io/badge/DA-Verification-818cf8?style=for-the-badge" /><br/>
      <b>David</b>
    </td>
  </tr>
</table>

---

## ⭐ Core Features

| Feature | Description |
|---|---|
| 📊 **SSI Tracker** | Daily scrape of `/sales/ssi` stores score movements, 4 component sub-metrics, and industry rankings into a local 90-day ring buffer. |
| 🛡️ **Profile Audit** | Checks 6 LinkedIn All-Star completeness criteria and 4 activity signals. Built on a fully local, zero-cost rules check pipeline. |
| ✨ **AI Rewrites & Rotation** | Runs parallel copy-editor and strategy prompts. Avoids concept repetition across click cycles using `avoidStems` logic blocks. |
| 🎯 **Cadence & Streak Quotas** | Set weekly custom-targets mapped to individual SSI metric gaps. Track consistency milestones via visual streak trackers. |
| 💬 **Smart Reply Composer** | Injects custom reply triggers into LinkedIn post feeds. Formulates rich, context-aware comment drafts mirroring your own writing voice. |
| 🔁 **Closed-Loop Outcomes** | Implicitly tracks likes and comment engagements. Re-feeds actual user interaction data back into local prompt strategies automatically. |

---

## 🏗️ System & Design Architecture

The core logic is split across three distinct layers — content scripts, a background service worker, and the popup UI — with all data persisted locally.

### System Architecture

<p align="center">
  <img src="docs/architecture.svg" alt="LinkMate System Architecture" width="100%" />
</p>

### Profile Audit & Concept Rotation Flow

<p align="center">
  <img src="docs/audit_flow.svg" alt="LinkMate Audit Workflow" width="100%" />
</p>

### Project Modules

| Module / File | Responsibility |
|---|---|
| `linkedin-content.ts` | Injects draft triggers into post compositions; mounts feed relevance queues |
| `ssi-content.ts` + `ssi-parser.ts` | Headless scraping of `linkedin.com/sales/ssi` metrics |
| `profile-parser.ts` + `profile-context.ts` | Captures profile context and manages user positioning summary |
| `profile-audit.ts` | Rule-check pipeline: 6 completeness conditions + 4 activity thresholds |
| `profile-audit-prompts.ts` | Structured JSON prompt builder with concept blacklist & rotation arrays |
| `profile-recommender.ts` | Executes and dedupes parallel LLM suggestions with fallback thresholds |
| `engagement-queue.ts` | Relevance scorer sorting feed posts based on profile topic overlap |
| `action-log.ts` + `cadence.ts` | Append-only IndexedDB metrics ledger recording streak patterns |

---

## 🗄️ Storage Layer

Data is segmented into three storage systems to guarantee maximum privacy and O(log n) read performance:

| Storage | Role | Contents |
|---|---|---|
| 🔵 **`chrome.storage.local`** | Hot State | Decrypted OpenAI key, profile metrics, cached cards, SSI history snapshots |
| 🟣 **`chrome.storage.sync`** | Cross-Device Sync | Non-sensitive preferences — customized prompts and generation parameters. *Secrets are never synced.* |
| 🟢 **IndexedDB** | Time-Series Ledger | Append-only action records and outcome logs. Indices keep queries fast as records grow unbounded. |

---

## 🚀 Install in 3 Steps

**Step 1 — Build**

```bash
git clone https://github.com/mrviduus/linkmate.git
cd linkmate
npm install
npm run build
```

**Step 2 — Load the Extension**

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** via the top-right toggle
3. Click **Load unpacked** and select the `dist/` folder

**Step 3 — Add your API Key**

Open the LinkMate popup via the extensions toolbar, go to **Settings**, paste your OpenAI API Key, and save.

---

## 💻 CLI Reference

| Command | Description |
|---|---|
| `npm run dev` | Interactive watch mode via Parcel |
| `npm run build` | Production extension bundle into `/dist` |
| `npm run zip` | Package release zip for distribution |
| `npm test` | Run all 355 unit tests across 28 suites |
| `npm run type-check` | Strict TypeScript compile audit |

---

## 📜 License & Disclaimers

- **License:** ISC
- **LinkedIn ToS:** Draft generation is exclusively pre-fill. LinkMate never auto-submits, auto-clicks, or schedules actions on your behalf — keeping your account fully compliant.

---

<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:7c3aed,50:4338ca,100:0A66C2&height=100&section=footer" width="100%"/>
</p>
