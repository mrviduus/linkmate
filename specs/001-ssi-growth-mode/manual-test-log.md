# Manual Test Log — SSI Growth Mode v0.4.0

This log records hands-on validation of acceptance scenarios from `spec.md` in a real Chrome browser against real LinkedIn. Tests that can be exercised in jsdom live in `tests/`; this log covers what jsdom cannot: real DOM, real WebLLM cold-start, real `chrome.alarms` timing, real LinkedIn responses.

**Test browser:** Chrome / Chromium version: _to be recorded_
**Test date:** _to be recorded_
**Extension version:** _to be recorded after version bump_

Mark each scenario `✅ passed`, `❌ failed`, or `⏸️ skipped` with a one-line note. Attach screenshots/GIFs at `manual-test-artifacts/` (gitignored) if useful.

---

## T300 — Acceptance scenarios from spec.md

### US1 — Engagement Queue on the Feed

- [ ] **AS1.1**: Logged-in user with profile captured navigates to `/feed/`. Sidebar appears within 3 seconds showing 5–10 ranked posts with editable drafts.
- [ ] **AS1.2**: With sidebar visible, change tone slider to "Enthusiastic". Drafts regenerate within 5 seconds reflecting the new tone.
- [ ] **AS1.3**: After clicking "Copy & Open Post", paste into LinkedIn's comment box and submit. Post is marked as engaged and removed from queue for 30 days. (Verify by refreshing — same post should be gone for 30d window.)
- [ ] **AS1.4**: Refresh button within 5 minutes is rate-limited; tooltip shows countdown.
- [ ] **AS1.5**: Own posts in feed are filtered out of the queue.

### US2 — SSI Dashboard in Popup

- [ ] **AS2.1**: After 24h+ install, popup SSI section shows latest snapshot + trend graph with all available points (up to 90).
- [ ] **AS2.2**: Click "Refresh now". New snapshot appears within 10 seconds.
- [ ] **AS2.3**: Daily alarm fires when LinkedIn is reachable and logged in → snapshot captured silently (no visible UI noise). Inspect background-page logs or storage to confirm.
- [ ] **AS2.4**: When LinkedIn returns unexpected SSI DOM (test by editing fixture or temporarily breaking selectors), parser fails → no snapshot stored → popup shows warning chip on next open.
- [ ] **AS2.5**: After 7 days without LinkedIn login, daily alarm fires but capture skipped — `ssiLastError` chip surfaces ("capture timed out" or similar).

### US3 — Profile-Aware Prompting

- [ ] **AS3.1**: Fresh install. Open popup → click "Capture Profile" while NOT on a profile page → CTA appears ("Open your profile, then click Capture"). Click "Open My Profile" → LinkedIn navigates to `/in/me/`. Click Capture again → within 30 seconds, popup shows captured fields + positioningSummary.
- [ ] **AS3.2**: Manually modify `capturedAt` in storage to >30d ago. Refresh popup → stale chip appears next to "Captured X ago".
- [ ] **AS3.3**: Clear profile from storage. Engagement Queue on `/feed/` → either CTA "Capture your profile first" or empty queue with explanation (not just silent empty render — see Bug Report in commit `45e2fc8`).

### US4 — Connection Suggestor (v0.4.1; out of scope for v0.4.0 manual test)

Marked as scaffold only in v0.4.0 (T400–T402). No manual scenarios this phase.

---

## T214 — MV3 keep-alive integration test

- [ ] **T214.1**: DevTools → Network → throttle to "Slow 3G". Trigger SSI capture (popup Refresh now or manual `chrome.alarms` fire). Verify capture completes within 30s timeout, OR cleanly fails to `ssiLastError` if LinkedIn slow-loads past 30s.
- [ ] **T214.2**: chrome://serviceworker-internals — observe SW status during capture. Expected: SW stays "ACTIVATED" throughout the flow. Without keep-alive it would suspend at ~30s idle and lose the snapshotReady message.
- [ ] **T214.3**: Verify the keep-alive port is active during the capture. The default `port.postMessage('ping')` has no listener on the other side, so the pings are invisible unless you instrument. From the background page DevTools console, paste this temporarily before triggering capture:
  ```js
  chrome.runtime.onConnect.addListener((p) => {
    if (p.name === 'linkmate.keep-alive') {
      p.onMessage.addListener((m) => console.log('[keep-alive]', m));
    }
  });
  ```
  Then trigger capture — you should see `[keep-alive] ping` log every ~20s for as long as the capture is in flight. Alternative: inspect `chrome://extensions/` → Service Worker → Ports — the port named `linkmate.keep-alive` should appear during the capture and disappear after.

---

## T306 — DevTools Network panel: zero outbound LLM calls

Constitution v1.1 §I (NON-NEGOTIABLE). All LLM inference must run locally via WebLLM. Verify:

- [ ] **T306.1**: Open Chrome → DevTools → Network → Filter: All. Clear log.
- [ ] **T306.2**: Open popup → click Capture Profile (after positioning yourself on `/in/me/`). Wait for completion.
- [ ] **T306.3**: Navigate to `/feed/`. Wait for Engagement Queue to mount + render drafts for all top-10 tiles.
- [ ] **T306.4**: Trigger SSI capture from popup.
- [ ] **T306.5**: Network log review: confirm there are NO requests to OpenAI / Anthropic / Cohere / Google AI / xAI / Mistral / any other LLM provider endpoint. The only outbound traffic should be `huggingface.co` / `cdn-lfs*.huggingface.co` for the WebLLM model downloads themselves. Take a screenshot for the v0.4.0 release notes.

---

## T307 — chrome.storage footprint after 90 days

Covered by the automated `tests/storage-footprint.spec.ts` (seeds 90 snapshots + 30 engaged posts + 1 profile and confirms JSON-serialized size <5 MB). Re-verify here with a real extension instance:

- [ ] **T307.1**: After ≥7 days of daily use, run in DevTools console on the extension's background page:
  ```js
  chrome.storage.local.get(null, (all) => {
    const json = JSON.stringify(all);
    console.log('storage.local bytes:', new Blob([json]).size);
  });
  ```
  Expected: well under 5 MB (estimate from `data-model.md`: ~70 KB at 90-day worst case).

---

## Notes / surprises / regressions

(Add findings here. Re-validate the synthetic fixtures against the real DOM you capture during these tests — if selectors drift, update `tests/fixtures/*.html` and parsers per Constitution VIII.)
