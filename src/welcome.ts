/**
 * Issue #16 — Welcome (onboarding) page handler.
 *
 * Shown once on `chrome.runtime.onInstalled` (reason: 'install'). After the
 * user clicks Get Started or Skip, we set `onboardingCompleted=true` so the
 * page never auto-opens again. All subsequent capture flows (icon click,
 * first-gesture on profile page, popup auto-fire) are gated behind that flag.
 */

import { setCaptureFullProfile, setOnboardingCompleted } from './storage-schema';

const captureFull = document.getElementById('captureFull') as HTMLInputElement | null;
const getStartedBtn = document.getElementById('getStarted') as HTMLButtonElement | null;
const skipBtn = document.getElementById('skip') as HTMLButtonElement | null;

async function handleGetStarted(): Promise<void> {
  if (!getStartedBtn) return;
  getStartedBtn.disabled = true;
  getStartedBtn.textContent = 'Opening LinkedIn…';
  await setCaptureFullProfile(captureFull?.checked ?? true);
  await setOnboardingCompleted(true);
  // Navigate the same tab to LinkedIn. The content script's first-gesture
  // listener will open the side panel and auto-capture from there.
  window.location.assign('https://www.linkedin.com/in/me/');
}

async function handleSkip(): Promise<void> {
  await setOnboardingCompleted(true);
  window.close();
}

getStartedBtn?.addEventListener('click', () => void handleGetStarted());
skipBtn?.addEventListener('click', () => void handleSkip());
