/**
 * T210 — SSI page content script (Phase C, US2).
 *
 * Registered in manifest for https://www.linkedin.com/sales/ssi*.
 * Run-at document_idle, but the SSI page lazy-loads scores via XHR, so
 * we retry up to 4 times with 1.5s spacing before reporting failure.
 *
 * On success → posts { action: 'ssi.snapshotReady', snapshot } to background.
 * On hard failure → posts { action: 'ssi.snapshotReady', error, reason } to background.
 *
 * Compliance (Constitution §I closed-list carve-out): read-only DOM parse,
 * no clicks, no DOM mutation, no message handlers, no long-lived state.
 */

import { parseSsiDom } from './ssi-parser';

const MAX_RETRIES = 4;
const RETRY_DELAY_MS = 1500;

function sendSnapshot(payload: unknown): void {
  try {
    chrome.runtime.sendMessage(payload, () => {
      // swallow lastError; background may have closed the tab already
      if (chrome.runtime.lastError) {
        // intentional: tab closure race is expected on success path
      }
    });
  } catch {
    // Channel closed; nothing useful we can do from a soon-to-close tab.
  }
}

async function captureWithRetry(): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = parseSsiDom(document);
    if (result.ok) {
      sendSnapshot({ action: 'ssi.snapshotReady', snapshot: result.snapshot });
      return;
    }
    // For hard failures (malformed, missing-rank, missing-component) on first try,
    // wait once more in case of lazy-load. After 1 retry, escalate as hard failure.
    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    } else {
      sendSnapshot({
        action: 'ssi.snapshotReady',
        error: result.message,
        reason: result.reason,
      });
    }
  }
}

void captureWithRetry();
