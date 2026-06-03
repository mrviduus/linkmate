/**
 * Issue #16 — Welcome (onboarding) page handler.
 *
 * Shown once on `chrome.runtime.onInstalled` (reason: 'install'). After the
 * user clicks Get Started or Skip, we set `onboardingCompleted=true` so the
 * page never auto-opens again. All subsequent capture flows (icon click,
 * first-gesture on profile page, popup auto-fire) are gated behind that flag.
 */

import {
  ensureInstallToken,
  setCaptureFullProfile,
  setOnboardingCompleted,
} from './storage-schema';

const captureFull = document.getElementById('captureFull') as HTMLInputElement | null;
const getStartedBtn = document.getElementById('getStarted') as HTMLButtonElement | null;
const skipBtn = document.getElementById('skip') as HTMLButtonElement | null;

const PENDING_CAPTURE_KEY = 'linkmate.pendingCapture.v1';

async function handleGetStarted(): Promise<void> {
  if (!getStartedBtn) return;
  getStartedBtn.disabled = true;
  getStartedBtn.textContent = 'Opening LinkedIn…';
  await setCaptureFullProfile(captureFull?.checked ?? true);
  await setOnboardingCompleted(true);
  // Mint the anonymous install token so the free managed tier works immediately.
  await ensureInstallToken();
  // One-shot signal to the side panel: kick off a capture on the very next
  // open. Subsequent opens won't re-capture (the panel consumes this flag).
  await chrome.storage.local.set({ [PENDING_CAPTURE_KEY]: true });

  // Open the side panel BEFORE navigating — we're inside the synchronous
  // user-activation window of the click, so chrome.sidePanel.open() succeeds.
  // Side panel stays attached to this tab through the upcoming navigation.
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) {
      const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
        side_panel?: { default_path?: string };
      };
      const sidePanelPath = manifest.side_panel?.default_path ?? 'popup.html';
      const sp = chrome.sidePanel as unknown as {
        setOptions: (o: { tabId?: number; path?: string; enabled?: boolean }) => Promise<void>;
        open: (o: { tabId?: number }) => Promise<void>;
      };
      await sp.setOptions({
        tabId: tab.id,
        path: `${sidePanelPath}?targetTab=${tab.id}&auto=1`,
        enabled: true,
      });
      await sp.open({ tabId: tab.id });
    }
  } catch (err) {
    console.warn('[LinkMate] welcome → sidePanel.open failed:', err);
  }

  window.location.assign('https://www.linkedin.com/in/me/');
}

async function handleSkip(): Promise<void> {
  // Skip = explicit "no" to capture. Also clear the full-profile flag so a
  // later manual icon click doesn't fall through to a privacy-surprising scrape.
  await setCaptureFullProfile(false);
  await setOnboardingCompleted(true);
  window.close();
}

getStartedBtn?.addEventListener('click', () => void handleGetStarted());
skipBtn?.addEventListener('click', () => void handleSkip());
