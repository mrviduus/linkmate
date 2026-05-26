# Feature Specification: SSI Growth Mode

**Feature Branch**: `001-ssi-growth-mode`
**Created**: 2026-05-14
**Revised**: 2026-05-14 (v1.1 — compliance, MV3, SC-005 fixes from Claude Code review)
**Status**: Draft — ready for `/speckit.plan`
**Input**: Pivot LinkMate from "AI reply suggestions" to a complete personal-brand growth co-pilot for LinkedIn, organized around the user's Social Selling Index (SSI) score.

## Context

LinkMate v0.3.3 generates AI reply suggestions for LinkedIn posts using local WebLLM inference. The owner of this extension (single primary user, also the developer) has a measurable problem: LinkedIn SSI score of **18 / 100** (Industry Top 80%, Network Top 91%), with the lowest sub-score being "Engage with insights" at **0.85 / 25**. This means LinkedIn Recruiter search ranks the user near the bottom of `"AI Engineer" + Toronto + remote` searches, which directly blocks the goal of landing a $150K USD remote AI Engineer role within 6 weeks.

This feature reframes LinkMate from a single-purpose reply tool into a **co-pilot that helps the user grow their SSI from 18 to 65+**, while staying strictly within LinkedIn's TOS. The principle: **AI as drafting partner, never auto-pilot.** Every LinkedIn-visible action (post, comment, connection request, message) is performed by the human after editing an AI-suggested draft.

## Compliance Constraints (NON-NEGOTIABLE)

These constraints take precedence over every requirement in this document. Violation of any of these reverts work back to draft.

1. **No auto-submission to LinkedIn.** The extension MUST NOT programmatically click any LinkedIn button that posts content, sends a connection request, sends a message, or otherwise performs a write action against LinkedIn's UI on behalf of the user.
2. **No headless or invisible interactions with LinkedIn UI** beyond read-only DOM parsing of pages the user has already loaded. The single carved-out exception is the SSI page (`/sales/ssi`), which MAY be loaded in an inactive background tab on a 24-hour cadence for read-only score capture (see SSI Tracker section). This exception is justified because (a) the SSI page contains only the user's own metric data, (b) the read-only nature is enforced by the parser having no submit handler, and (c) the cadence is explicitly user-configurable and disable-able. **Profile capture (User Story 3) does NOT use this exception** — it injects via `chrome.scripting.executeScript` only when the user explicitly clicks "Capture profile" while on their own profile page.
3. **All inference local.** Reaffirm Constitution principle I. No LinkedIn content, draft, or profile data may leave the browser.
4. **All drafts editable before user submits.** UI MUST require an explicit user action (Copy, then user paste + edit + submit) for each LinkedIn-visible action.
5. **Rate-aware suggestions.** Suggestion volumes shown to the user MUST stay within LinkedIn's documented healthy human limits: ≤100 connection requests/week, ≤250 comments/week, ≤30 messages/day. Suggestions exceeding these throttle automatically.
6. **Compliance warning preserved.** The existing warning in `linkedin-content.ts` MUST remain and be expanded to cover the new SSI Growth Mode features.

## User Scenarios & Testing

### User Story 1 — Engagement Queue on the Feed (Priority: P1)

When the user opens `linkedin.com/feed/`, a sidebar appears showing the top 10 posts in the visible feed scored by relevance to the user's positioning ("AI Engineer | RAG | Agents"). For each post, an editable AI-drafted comment is shown, written in the user's voice. The user reviews the draft, optionally adjusts tone (Professional / Friendly / Enthusiastic / Thoughtful) and length (Brief / Standard / Detailed), edits the text inline, then clicks "Copy & Open Post" — the draft copies to clipboard and the LinkedIn post opens in focus, ready for the user to paste, refine, and post manually.

**Why this priority**: This single feature directly addresses the user's lowest SSI sub-score ("Engage with insights" 0.85 / 25). It collapses a 30-minute daily routine into 5 minutes, removes decision fatigue ("which post should I engage with?"), and produces commentary aligned with the user's professional brand. Without this, the rest of the feature does not move the SSI needle.

**Independent Test**: Load `linkedin.com/feed/` after install — sidebar appears within 3 seconds, lists 10 posts ranked by relevance score, each with an editable draft. Adjusting tone/length regenerates draft. Clicking Copy & Open Post copies to clipboard. Verifiable end-to-end without any other module.

**Acceptance Scenarios**:

1. **Given** the user is logged into LinkedIn with Profile Context captured, **When** the user navigates to `/feed/`, **Then** a sidebar appears within 3 seconds showing 5–10 ranked posts with AI-drafted comments.
2. **Given** the sidebar is visible with a draft for post X, **When** the user changes the tone slider to "Enthusiastic", **Then** the draft regenerates within 5 seconds reflecting the new tone.
3. **Given** the user has clicked Copy & Open Post, **When** the user pastes into LinkedIn's comment box and submits, **Then** that post is marked as engaged and removed from the queue for 30 days.
4. **Given** the queue has been refreshed within the last 5 minutes, **When** the user clicks Refresh, **Then** the click is rate-limited and a tooltip explains "Refresh available in N seconds."
5. **Given** a post in the queue is from the user's own LinkedIn account, **When** the queue is rendered, **Then** that post is excluded.

### User Story 2 — SSI Dashboard in Popup (Priority: P2)

The user opens the LinkMate popup and sees a new "SSI" tab. The tab displays the most recent SSI snapshot (total + 4 component scores), a 30-day trend graph, and an actionable insight ("Your 'Engage with insights' score dropped from 0.85 to 0.74 over the past 7 days. Open the Engagement Queue to recover."). A daily background job captures fresh SSI data automatically; the user may also tap "Refresh now" for an on-demand capture.

**Why this priority**: Closes the feedback loop. The user sees whether their daily routine moves the score, which sustains motivation and highlights which sub-score to push next. Without measurement the user cannot tell whether the work is paying off.

**Independent Test**: After install + 24 hours of daily captures, the SSI tab displays a graph with at least 1 data point and a current score matching what `linkedin.com/sales/ssi` shows in a manual visit.

**Acceptance Scenarios**:

1. **Given** the extension has been installed for at least 24 hours, **When** the user opens the popup and clicks the SSI tab, **Then** the tab displays the latest snapshot and a trend graph with all available data points (up to 90 days).
2. **Given** the user clicks "Refresh now" on the SSI tab, **When** the tracker captures a new snapshot, **Then** the snapshot appears in the graph within 10 seconds.
3. **Given** the daily background alarm fires, **When** LinkedIn is reachable and the user is logged in, **Then** a snapshot is captured and stored without any visible UI noise.
4. **Given** LinkedIn returns an unexpected DOM (e.g., site update), **When** the parser fails, **Then** the failure is logged, no snapshot is stored, and the popup surfaces a warning chip on next open.
5. **Given** the user has not logged into LinkedIn for 7 days, **When** the daily alarm fires, **Then** the capture is skipped silently (no error noise) and counted in a "missed captures" metric.

### User Story 3 — Profile-Aware Prompting (Priority: P1, foundational)

After install, the user manually visits their own LinkedIn profile (`/in/{me}`) and clicks "Capture profile" in the LinkMate popup. LinkMate uses `chrome.scripting.executeScript` to inject a one-shot parser into the active tab, extracts headline / About / top skills / recent post themes, runs the local WebLLM to produce a 2-sentence positioning summary, and stores everything locally. Every subsequent AI generation — comments, connection notes, replies — uses this positioning context so drafts read like the user, not generic LLM output. The user can refresh anytime; auto-refresh proposes itself (does not auto-execute) after 30 days.

**Why this priority**: Without profile-aware prompting, generated comments sound generic, get downranked by LinkedIn's "is-this-AI" classifier, and damage the user's brand instead of growing it. This module is foundational — Story 1 and Story 4 both depend on it.

**Why on-click `executeScript` instead of registered content script**: A registered content script on `https://www.linkedin.com/in/*` would auto-fire on EVERY profile the user visits (including others' profiles), which is both a privacy concern and a violation of Compliance Constraint #2. On-click `executeScript` makes capture explicitly user-initiated, runs once, returns data, and disposes — no persistent footprint on `/in/*` pages.

**Independent Test**: After installing, opening own profile page, and tapping "Capture profile", the popup shows a captured headline, ~10 top skills, and a 2-sentence positioning summary that mentions the user's actual focus areas (e.g., RAG, agents).

**Acceptance Scenarios**:

1. **Given** the user has just installed LinkMate and is on their own LinkedIn profile page, **When** the user clicks "Capture profile" in popup, **Then** within 30 seconds the popup shows the captured fields and a positioning summary.
2. **Given** the user clicks "Capture profile" while NOT on a profile page, **Then** the popup surfaces "Open your LinkedIn profile, then click Capture" with a button that opens `linkedin.com/in/me`.
3. **Given** Profile Context is older than 30 days, **When** the user opens the popup, **Then** an unobtrusive "Refresh recommended" chip appears with a button — no automatic re-capture happens.
4. **Given** Profile Context is missing, **When** Engagement Queue or Connection Suggestor runs, **Then** the feature shows a CTA "Capture your profile first" instead of generic drafts.

### User Story 4 — Connection Suggestor (Priority: P3, can ship in v0.4.1)

Each weekday morning, the popup surfaces 5 suggested LinkedIn profiles to connect with — AI engineers, ML/AI recruiters, hiring managers at target companies — each with an AI-drafted personalized note (≤300 chars) referencing one specific recent activity from that profile. The user reviews, optionally edits, then clicks "Copy note & open profile" to send manually.

**Why this priority**: Boosts "Find the right people" sub-score (currently 6.12 / 25). Lower priority than Story 1 because the user's bigger gap is engagement, not connections. Reasonable to ship in v0.4.1 after the Engagement Queue proves out.

**Independent Test**: After install + Profile Context captured, opening the popup's "Connections" tab shows 5 suggestions with personalized notes within 10 seconds.

**Acceptance Scenarios**:

1. **Given** Profile Context is captured, **When** the user opens the Connections tab, **Then** 5 suggestions appear with name, title, company, and personalized note.
2. **Given** the user clicks "Copy note & open profile", **When** the profile opens in a new tab, **Then** the note is in clipboard and the suggestion is marked "drafted" (excluded from tomorrow's batch).
3. **Given** the user has already reached 100 drafted-this-week, **When** the suggestor runs, **Then** it pauses with a message "Weekly safe limit reached, resumes Monday".

### Edge Cases

- LinkedIn DOM changes (post containers, SSI page layout) → parsers MUST log and degrade gracefully, never throw uncaught exceptions on the page.
- User is on LinkedIn Sales Navigator vs free LinkedIn → SSI page may differ; tracker MUST detect and log unsupported variants.
- User is in incognito or has multiple LinkedIn sessions → storage scoped per browser profile; no assumption of identity continuity.
- WebLLM model is loading or unavailable → all generation features show a "Loading AI…" state and queue the request, never silently fail.
- User clicks Copy in Engagement Queue but never returns to LinkedIn → after 24h the post is automatically un-marked as engaged.
- LinkedIn rate-limits or returns CAPTCHA → tracker MUST stop attempts for 24h and surface a popup warning.
- The user's profile changes substantially (new headline / new role) → Profile Context refresh button is prominent and recommended.

## Requirements

### Functional Requirements

#### Profile Context (Story 3)

- **FR-001**: System MUST allow the user to capture their LinkedIn profile via `chrome.scripting.executeScript` injected into the active tab when the user explicitly clicks "Capture profile" in the popup. System MUST NOT register a content script on `linkedin.com/in/*` for this purpose.
- **FR-002**: Before injection, system MUST verify the active tab URL matches `linkedin.com/in/{handle}` (any handle). If not, MUST surface a CTA to open the user's profile and abort the capture attempt.
- **FR-003**: Injected parser MUST extract: full name, headline, About (first 1500 chars), top 10 skills, and recent post themes (3–5), then return the data via `executeScript` result and dispose. No long-lived listeners installed.
- **FR-004**: System MUST generate a 2-sentence positioning summary from extracted fields using the local WebLLM, and store it with the captured fields in `chrome.storage.local` under a versioned key.
- **FR-005**: System MUST mark Profile Context as stale after 30 days and surface a "Refresh recommended" chip in the popup. Refresh MUST be user-initiated; system MUST NOT auto-trigger a re-capture.
- **FR-006**: All draft generators (Story 1, 4) MUST inject Profile Context into the LLM system prompt.

#### Engagement Queue (Story 1)

- **FR-010**: System MUST mount a sidebar UI on `linkedin.com/feed/` and `linkedin.com/feed/?*` paths, dismissable by the user, position remembered.
- **FR-011**: System MUST scan visible posts in the user's feed and produce a relevance score (0–100) for each, using a deterministic algorithm (see plan.md for weights).
- **FR-012**: System MUST display the top 10 posts ordered by relevance, hiding any post whose author is the user, any post already engaged in the last 30 days, and any post explicitly dismissed.
- **FR-013**: For each displayed post, the system MUST generate an editable AI draft comment using local WebLLM, applying the current Tone and Length settings.
- **FR-014**: System MUST expose Tone slider (Professional / Friendly / Enthusiastic / Thoughtful) and Length slider (Brief 1–2 sentences / Standard 3–4 / Detailed 5–7) per post.
- **FR-015**: System MUST provide a "Copy & Open Post" action that copies the current draft to clipboard, opens the post in focus, and marks the post as engaged with a 30-day expiry.
- **FR-016**: System MUST throttle queue refresh to once per 5 minutes (showing a countdown otherwise).
- **FR-017**: System MUST NOT under any condition click LinkedIn's comment, like, or share buttons programmatically.

#### SSI Tracker + Dashboard (Story 2)

- **FR-020**: System MUST schedule a daily `chrome.alarms` job ("linkmate.ssi.daily", periodInMinutes: 1440) on install.
- **FR-021**: When the alarm fires, system MUST open `linkedin.com/sales/ssi` in a background tab, parse the SSI total and 4 sub-scores plus industry/network rank, store the snapshot, then close the tab.
- **FR-022**: System MUST retain up to 90 daily snapshots, evicting oldest beyond 90.
- **FR-023**: Popup MUST display an "SSI" tab showing the latest snapshot and a 30-day trend (line graph).
- **FR-024**: Popup MUST surface one "actionable insight" per visit (e.g., "Engage score dropped 14% this week — open Engagement Queue").
- **FR-025**: User MUST be able to trigger an on-demand capture via "Refresh now" button.
- **FR-026**: If LinkedIn returns an unexpected SSI DOM, the system MUST log a warning, skip the snapshot, and surface a chip on the SSI tab.

#### Connection Suggestor (Story 4)

- **FR-030**: System MUST maintain a target list of search queries (e.g., "AI Engineer hiring Toronto", "ML Recruiter Bay Area") configurable in popup settings.
- **FR-031**: System MUST surface 5 profile suggestions per weekday morning with name, title, company, and a ≤300-char personalized note referencing one specific recent activity.
- **FR-032**: System MUST cap "drafted this week" at 100 to stay below LinkedIn's safe weekly connection limit.
- **FR-033**: System MUST never auto-send a connection request.

#### Cross-cutting

- **FR-040**: System MUST preserve and extend the existing compliance warning in `linkedin-content.ts` to mention SSI Growth Mode.
- **FR-041**: System MUST log all storage writes and content-script DOM access at `console.debug` level for in-DevTools auditing.
- **FR-042**: All new generated text (drafts, notes, summaries) MUST be tagged in storage with model name + timestamp + temperature for reproducibility.

### Key Entities

- **ProfileContext**: User's positioning snapshot. Fields: fullName, headline, about, topSkills[10], recentPostThemes[5], positioningSummary, capturedAt.
- **ParsedPost**: One LinkedIn feed post extracted from DOM. Fields: id, authorUrn, authorName, authorTitle, followerTier, text, postedAt, likeCount, commentCount, isOwn.
- **ScoredPost**: ParsedPost + RelevanceScore { score:0–100, reasons:string[], category:engage_now|consider|skip }.
- **DraftComment**: { postId, text, tone, length, generatedAt, model }.
- **EngagedPost**: { postId, engagedAt, expiresAt }.
- **SsiSnapshot**: { total, components{establishBrand, findRightPeople, engageWithInsights, buildRelationships}, industryRank, networkRank, capturedAt }.
- **ConnectionSuggestion**: { profileUrl, name, title, company, personalizedNote, suggestedAt, status:pending|drafted|skipped }.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Engagement Queue mounts on `/feed/` within 3 seconds of page load, ranks visible posts in under 2 seconds total.
- **SC-002**: Per-post draft generation completes in under 5 seconds on a 4 GB GPU (the user's GTX 1650 Ti baseline).
- **SC-003**: SSI Tracker successfully captures ≥6 snapshots in any 7-day window where the user is logged into LinkedIn at least 6 of those days.
- **SC-004**: Popup SSI tab open-to-render under 500 ms when up to 90 snapshots are stored.
- **SC-005**: User's measured SSI score moves from baseline 18 to ≥40 within 30 days of daily use, and to ≥65 within 60 days. (Aligns with HANDOFF.md and the broader 6-week career-pivot plan: ship v0.4.0 → dogfood for 6 weeks → flip Open to Work to All members at SSI 65+.)
- **SC-006**: Zero LinkedIn account warnings, restrictions, or bot-detection challenges attributed to LinkMate over a 90-day dogfood window.
- **SC-007**: All new modules ship with ≥85% Jest test coverage; Constitution gates (lint 0 warnings, TypeScript strict 0 errors, full suite green) hold.
- **SC-008**: Cumulative draft generation cost: $0 (entirely local WebLLM) — measured by network panel showing zero outbound LLM API calls.

## Out of Scope (deferred to v0.5.0+)

- Auto-posting, auto-commenting, auto-connecting (forever out of scope per compliance).
- Multi-account support.
- Mobile companion app.
- Analytics aggregation across multiple users (would violate Constitution privacy principle).
- Native LinkedIn API integration (LinkedIn does not expose required endpoints to developers).
- Sharing or syncing settings to a backend.
- A/B testing different draft styles automatically across the user's actual posts.

## References

- LinkMate Constitution: `.specify/memory/constitution.md` (v1.1.0+ required — amended 2026-05-14 with carve-outs, MV3 lifecycle, fixture hygiene)
- Items subsumed from prior backlog (file `TODO.md` removed during pre-spec cleanup): Reply Tone Selector → US1 tone slider; Draft connection requests → US4; Compose InMail → deferred (Out of Scope); Reply History → EngagedPost storage.
- LinkedIn SSI methodology: https://www.linkedin.com/sales/ssi (user-visible page)
- User's measured baseline: SSI 18 / 100 (captured 2026-05-14)
