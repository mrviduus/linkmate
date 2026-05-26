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
  // Send the gesture to background so it can open both the LinkedIn tab AND
  // the side panel inside the same user-activation window. After this fires,
  // we still navigate locally in case the message round-trip is slow.
  try {
    await chrome.runtime.sendMessage({ action: 'onboarding.start' });
  } catch {
    /* background may still be initializing; navigation below is the fallback */
  }
  window.location.assign('https://www.linkedin.com/in/me/');
}

async function handleSkip(): Promise<void> {
  await setOnboardingCompleted(true);
  window.close();
}

getStartedBtn?.addEventListener('click', () => void handleGetStarted());
skipBtn?.addEventListener('click', () => void handleSkip());
