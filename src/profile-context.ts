/**
 * T035 — Profile Context service (Phase A, US3). Popup-side orchestrator.
 *
 * Per Constitution v1.1 §I (Privacy-First, background-tab carve-outs) and
 * v1.1 spec amendments: profile capture is USER-INITIATED on the active tab
 * the user has already loaded. No registered content script on /in/*. No
 * background tab creation. One-shot chrome.scripting.executeScript injection.
 *
 * T034 note: an earlier draft called for a separate `src/profile-injected.ts`
 * bundled into web_accessible_resources. Two reasons we don't use that:
 *   (a) Parcel content-hashes filenames, breaking `files: ['profile-injected.js']`.
 *   (b) `func: parseProfileDom` runs into chrome.scripting.executeScript's typed
 *       args contract (the function's param signature dictates the args[] shape).
 * Instead we inject a tiny `() => document.documentElement.outerHTML`, get the
 * HTML string back, and parse it in the popup context with parseProfileDom +
 * DOMParser. Compliance footprint unchanged: still one-shot, read-only DOM
 * access on a user-loaded /in/{me}/ page. Deviation documented in tasks.md.
 *
 * Flow:
 *   1. chrome.tabs.query active tab
 *   2. URL guard: ^https?://(www\.)?linkedin\.com/in/[^/]+/?$ only
 *   3. chrome.scripting.executeScript injects HTML-grab function
 *   4. parseProfileDom runs in popup against the returned HTML
 *   5. Send raw fields to background via 'profile.capture' message
 *   6. Background returns positioningSummary (uses OpenAI)
 *   7. Persist ProfileContext via storage-schema.setProfile
 *
 * Returns a typed Result; never throws. Caller (popup) renders an error chip.
 */

import {
  parseProfileDom,
  parseUserProfile,
  parseRecentPosts,
  parseRecentComments,
} from './profile-parser';
import type { RawProfileFields } from './profile-parser';
import { getCaptureFullProfile, getProfile, setProfile } from './storage-schema';
import type { ProfileContext } from './storage-schema';
import { getUserProfile, isFresh, saveUserProfile } from './user-profile-store';
import type { UserProfile } from './lib/idb';

const PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Canonical profile URLs — /in/{handle} with no extra path segments.
// Trailing slash optional. www. optional. Query string / hash tolerated
// (LinkedIn occasionally appends `?miniProfileUrn=...` or `#contact`).
// Deep paths like /in/handle/details/skills/ are still rejected.
const PROFILE_URL_PATTERN = /^https?:\/\/(www\.)?linkedin\.com\/in\/[^/?#]+\/?(\?[^#]*)?(#.*)?$/;

export type CaptureFailureReason =
  | 'no-active-tab'
  | 'not-on-profile'
  | 'script-failed'
  | 'summary-failed';

export type CaptureResult =
  | { ok: true; profile: ProfileContext; cached?: boolean; userProfile?: UserProfile }
  | { ok: false; reason: CaptureFailureReason; message: string };

interface ProfileCaptureResponse {
  ok: boolean;
  positioningSummary?: string;
  error?: string;
}

export class ProfileContextService {
  async capture(): Promise<CaptureResult> {
    // Issue #16 — when full-capture is ON and IDB snapshot is <24h, short-circuit
    // before doing any DOM grab. Falls through to full capture otherwise.
    // IDB read is fail-soft: in environments without IndexedDB (jsdom tests,
    // some service-worker contexts) we just proceed with the regular flow.
    const fullProfileEnabled = await getCaptureFullProfile();
    if (fullProfileEnabled) {
      try {
        const cached = await getUserProfile();
        const existingProfile = await getProfile();
        if (cached && existingProfile && isFresh(cached)) {
          return { ok: true, profile: existingProfile, cached: true, userProfile: cached };
        }
      } catch (err) {
        console.warn('[LinkMate] UserProfile cache check failed; proceeding with fresh capture:', err);
      }
    }

    // Step 1: active tab
    let activeTab: chrome.tabs.Tab | undefined;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTab = tabs[0];
    } catch (err) {
      return {
        ok: false,
        reason: 'no-active-tab',
        message: `Could not query active tab: ${String(err)}`,
      };
    }
    if (!activeTab || activeTab.id === undefined) {
      return { ok: false, reason: 'no-active-tab', message: 'No active tab available.' };
    }

    // Step 2: URL guard (compliance — must be on the user's own profile)
    const url = activeTab.url ?? '';
    if (!PROFILE_URL_PATTERN.test(url)) {
      return {
        ok: false,
        reason: 'not-on-profile',
        message:
          'LinkMate captures from the LinkedIn profile page only. Open your profile (linkedin.com/in/your-handle) and click Capture.',
      };
    }

    // Step 3: inject an HTML-grab function. Parser runs in popup context (step 4).
    //
    // v0.5.6 — LinkedIn migrated to React Server-Driven UI (SDUI). The initial
    // HTML only contains top-card (name/headline/location). About / Skills /
    // Activity sections are EMPTY placeholders (`<div componentkey="...">`) that
    // get filled via async XHR after the user scrolls them into view.
    //
    // So we scroll the page programmatically, wait for SDUI to fetch the async
    // sections, then grab the HTML. ~3.5s total wait inside keepAlive.
    let html: string | null = null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: async () => {
          const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const originalScroll = window.scrollY;
          // Scroll to ~mid then bottom to trigger lazy section loads
          window.scrollTo({ top: document.body.scrollHeight / 2, behavior: 'instant' });
          await wait(1500);
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
          await wait(1500);
          window.scrollTo({ top: originalScroll, behavior: 'instant' });
          await wait(300);
          return document.documentElement.outerHTML;
        },
      });
      html = (results?.[0]?.result as string | undefined) ?? null;
    } catch (err) {
      return {
        ok: false,
        reason: 'script-failed',
        message: `Could not read profile DOM: ${String(err)}`,
      };
    }
    if (!html) {
      return {
        ok: false,
        reason: 'script-failed',
        message: 'Profile DOM grab returned nothing. The page may still be loading.',
      };
    }

    // Step 4: parse in popup context
    const parsedDoc = new DOMParser().parseFromString(html, 'text/html');
    const rawFields: RawProfileFields = parseProfileDom(parsedDoc);

    // v0.5.2 — sanity check: if EVERY extracted field is empty, the parser
    // doesn't match the current LinkedIn DOM. Surface a loud error instead of
    // letting the AI hallucinate a positioning summary from nothing.
    const parsedAnything =
      rawFields.fullName ||
      rawFields.headline ||
      rawFields.about ||
      rawFields.topSkills.length > 0 ||
      rawFields.recentPostThemes.length > 0;
    if (!parsedAnything) {
      return {
        ok: false,
        reason: 'script-failed',
        message:
          "Profile parser couldn't read any fields from this page. LinkedIn's DOM may have changed — please report this. (Tip: run scripts/dump-linkedin-profile-dom.js in DevTools and share the JSON.)",
      };
    }

    // Step 5 + 6: ship raw fields to background, get positioning summary
    let response: ProfileCaptureResponse;
    try {
      response = (await chrome.runtime.sendMessage({
        action: 'profile.capture',
        fields: rawFields,
      })) as ProfileCaptureResponse;
    } catch (err) {
      return {
        ok: false,
        reason: 'summary-failed',
        message: `Background did not respond: ${String(err)}`,
      };
    }
    if (!response?.ok || !response.positioningSummary) {
      return {
        ok: false,
        reason: 'summary-failed',
        message: response?.error ?? 'No positioning summary returned.',
      };
    }

    // Step 7: persist
    const profile: ProfileContext = {
      ...rawFields,
      positioningSummary: response.positioningSummary,
      capturedAt: Date.now(),
    };
    await setProfile(profile);

    // Issue #16 — full UserProfile capture (extended fields + recent activity).
    // Soft-fail: never block the legacy ProfileContext capture on a parse error.
    let userProfile: UserProfile | undefined;
    if (fullProfileEnabled) {
      try {
        userProfile = await captureFullUserProfile(url, parsedDoc);
        await saveUserProfile(userProfile);
      } catch (err) {
        console.warn('[LinkMate] Full profile capture failed:', err);
      }
    }

    return { ok: true, profile, userProfile };
  }

  /** Read the currently-stored profile (or null). Cheap; no network/DOM access. */
  async get(): Promise<ProfileContext | null> {
    return getProfile();
  }

  /** True iff profile is missing or older than PROFILE_TTL_MS. Pure read; never triggers capture. */
  async shouldRefresh(): Promise<boolean> {
    const profile = await getProfile();
    if (!profile) return true;
    return Date.now() - profile.capturedAt > PROFILE_TTL_MS;
  }
}

// ─── Issue #16 — full-profile + recent-activity ─────────────────────────────

function extractHandle(url: string): string | null {
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1] : null;
}

async function fetchActivityHtml(handle: string, kind: 'all' | 'comments'): Promise<Document | null> {
  const target = `https://www.linkedin.com/in/${encodeURIComponent(handle)}/recent-activity/${kind}/`;
  try {
    const res = await fetch(target, { credentials: 'include' });
    if (!res.ok) return null;
    // Detect login wall via final URL — LinkedIn 302's unauthenticated requests
    // to /login or /authwall. Cheaper and more reliable than scanning the body.
    if (/\/(login|authwall|uas\/login|checkpoint)/i.test(res.url)) return null;
    const html = await res.text();
    if (!html || html.length < 1000) return null;
    return new DOMParser().parseFromString(html, 'text/html');
  } catch (err) {
    console.warn(`[LinkMate] fetch recent-activity/${kind} failed:`, err);
    return null;
  }
}

/**
 * Build a UserProfile from the already-loaded main-profile DOM, then enrich
 * with recent posts/comments via background fetch of the activity pages.
 */
async function captureFullUserProfile(
  url: string,
  parsedDoc: Document
): Promise<UserProfile> {
  const handle = extractHandle(url);
  const canonical = handle ? `https://www.linkedin.com/in/${handle}/` : url;
  const profile = parseUserProfile(parsedDoc, canonical);

  if (handle) {
    const [postsDoc, commentsDoc] = await Promise.all([
      fetchActivityHtml(handle, 'all'),
      fetchActivityHtml(handle, 'comments'),
    ]);
    if (postsDoc) profile.recentPosts = parseRecentPosts(postsDoc);
    if (commentsDoc) profile.recentComments = parseRecentComments(commentsDoc);
  }

  return profile;
}
