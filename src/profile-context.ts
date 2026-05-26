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
  | {
      ok: true;
      profile?: ProfileContext;
      cached?: boolean;
      userProfile?: UserProfile;
      summaryError?: string;
    }
  | { ok: false; reason: CaptureFailureReason; message: string };

interface ProfileCaptureResponse {
  ok: boolean;
  positioningSummary?: string;
  error?: string;
}

/**
 * Detached popup windows (chrome.windows.create) become their own
 * "currentWindow" — so chrome.tabs.query({active,currentWindow:true}) returns
 * the popup itself, NOT the LinkedIn tab. The background passes the real tab
 * id via ?targetTab=… so we can target it explicitly.
 */
function getExplicitTargetTabId(): number | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('targetTab');
    if (id && /^\d+$/.test(id)) return Number(id);
  } catch {
    /* ignore */
  }
  return null;
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

    // Step 1: target tab — prefer explicit ?targetTab= from the side panel URL,
    // otherwise find the active tab in the last-focused window (side panel
    // shares window context with content).
    let activeTab: chrome.tabs.Tab | undefined;
    try {
      const explicitId = getExplicitTargetTabId();
      if (explicitId !== null) {
        activeTab = await chrome.tabs.get(explicitId);
      } else {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        activeTab = tabs[0];
      }
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
          const main = document.querySelector('main');
          const scope = main ?? document;
          const heightLog: number[] = [];

          // Phase 1 — brute-force scroll. LinkedIn hydrates sections only as
          // they enter the viewport, and the page's scrollHeight grows in
          // chunks. Run for at least ~18s, bailing only after 8 consecutive
          // iterations with no growth. Data quality > capture speed (#16).
          let lastHeight = 0;
          let stableCount = 0;
          for (let i = 0; i < 36; i++) {
            const h = Math.max(
              document.documentElement.scrollHeight,
              document.body.scrollHeight,
              main?.scrollHeight ?? 0,
            );
            heightLog.push(h);
            window.scrollTo({ top: h, behavior: 'instant' });
            if (main && 'scrollTo' in main) main.scrollTo({ top: h, behavior: 'instant' });
            document.documentElement.scrollTop = h;
            // Also scroll by viewport increments to trigger IntersectionObservers
            // on partially-rendered cards.
            window.scrollBy({ top: 200, behavior: 'instant' });
            await wait(800);
            if (h === lastHeight) {
              stableCount++;
              if (stableCount >= 8 && i >= 22) break; // ≥18s minimum
            } else {
              stableCount = 0;
            }
            lastHeight = h;
          }

          // Phase 2 — scrollIntoView every h2/h3 in <main> with a long wait
          // each so SDUI cards load their <li> items. We do ALL headings, not
          // a curated list, since LinkedIn occasionally renames sections.
          const headings = Array.from(scope.querySelectorAll('h2, h3')) as HTMLElement[];
          for (const h of headings) {
            try {
              h.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
              await wait(700);
              // If the card is still empty, wait a bit more.
              const card = h.closest('section, div[componentkey]');
              const itemCount = card?.querySelectorAll('li').length ?? 0;
              if (itemCount === 0) await wait(1500);
            } catch {
              /* ignore */
            }
          }
          await wait(1000);

          window.scrollTo({ top: originalScroll, behavior: 'instant' });
          if (main && 'scrollTo' in main) main.scrollTo({ top: originalScroll, behavior: 'instant' });
          await wait(300);

          // Diagnostic dump alongside HTML so popup can console.log it.
          const targets = ['experience', 'education', 'skills', 'licenses', 'languages', 'projects', 'certifications'];
          const diag = {
            heightLog,
            finalHeight: Math.max(
              document.documentElement.scrollHeight,
              document.body.scrollHeight,
              main?.scrollHeight ?? 0,
            ),
            h2List: headings.map((h) => (h.textContent ?? '').trim()).slice(0, 40),
            sectionItemCounts: targets.map((t) => {
              const h = headings.find((el) =>
                new RegExp(`^${t}(\\s*\\(\\d+\\))?\\b`, 'i').test((el.textContent ?? '').trim()),
              );
              const card = h?.closest('section, div[componentkey]') ?? null;
              return { t, found: !!h, items: card?.querySelectorAll('li').length ?? 0 };
            }),
          };
          return (
            document.documentElement.outerHTML +
            `\n<!-- LINKMATE_DIAG:${JSON.stringify(diag)} -->`
          );
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

    // Extract diagnostic block embedded by the inject script (issue #16 debug)
    const diagMatch = html.match(/<!-- LINKMATE_DIAG:({[\s\S]*?}) -->/);
    if (diagMatch) {
      try {
        const diag = JSON.parse(diagMatch[1]);
        console.log('[LinkMate diag]', diag);
      } catch {
        /* ignore parse error */
      }
    }

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

    // Step 5 — Issue #16: pure-algorithm DOM scrape → IDB. Runs FIRST and is
    // independent of any AI. If OpenAI key isn't configured or the API errors
    // out later, we still have the structured profile saved.
    let userProfile: UserProfile | undefined;
    if (fullProfileEnabled && activeTab?.id !== undefined) {
      try {
        userProfile = await captureFullUserProfile(url, parsedDoc, activeTab.id);
        await saveUserProfile(userProfile);
      } catch (err) {
        console.warn('[LinkMate] Full profile capture failed:', err);
      }
    }

    // Step 6 — legacy: OpenAI positioning summary + chrome.storage ProfileContext.
    // This powers AI-drafted comments elsewhere in the extension. NON-BLOCKING:
    // failure here doesn't invalidate the IDB write above.
    let profile: ProfileContext | undefined;
    let summaryError: string | undefined;
    try {
      const response = (await chrome.runtime.sendMessage({
        action: 'profile.capture',
        fields: rawFields,
      })) as ProfileCaptureResponse;
      if (response?.ok && response.positioningSummary) {
        profile = {
          ...rawFields,
          positioningSummary: response.positioningSummary,
          capturedAt: Date.now(),
        };
        await setProfile(profile);
      } else {
        summaryError = response?.error ?? 'No positioning summary returned.';
      }
    } catch (err) {
      summaryError = `Background did not respond: ${String(err)}`;
    }
    if (summaryError) {
      console.warn('[LinkMate] positioning summary skipped:', summaryError);
    }

    return { ok: true, profile, userProfile, summaryError };
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

/**
 * Navigate the user's active tab to `url`, wait for load + LinkedIn SDUI to
 * hydrate, scroll to trigger lazy loads, and return the full outer HTML.
 *
 * Why not fetch(): the recent-activity page renders server-side as an empty
 * SDUI shell; activity items are loaded by post-render XHR calls that require
 * runtime auth tokens. The only reliable read is in a real browser tab.
 * Background tabs are banned by spec; we re-use the user's active tab and
 * restore the original URL at the end.
 */
async function scrapeInActiveTab(tabId: number, url: string): Promise<string | null> {
  await chrome.tabs.update(tabId, { url });

  // Wait for the navigation to fully complete.
  await new Promise<void>((resolve) => {
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Safety: bail after 15s so a hung navigation can't pin us forever.
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const main = document.querySelector('main');
        // Extra wait for the SDUI XHR hydration cycle.
        await wait(1500);
        // Loop scroll while scrollHeight grows OR until 10 attempts.
        let lastHeight = 0;
        let stable = 0;
        for (let i = 0; i < 10; i++) {
          const h = Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            main?.scrollHeight ?? 0,
          );
          window.scrollTo({ top: h, behavior: 'instant' });
          if (main && 'scrollTo' in main) main.scrollTo({ top: h, behavior: 'instant' });
          document.documentElement.scrollTop = h;
          await wait(900);
          if (h === lastHeight) {
            stable++;
            if (stable >= 2) break;
          } else {
            stable = 0;
          }
          lastHeight = h;
        }
        window.scrollTo({ top: 0, behavior: 'instant' });
        if (main && 'scrollTo' in main) main.scrollTo({ top: 0, behavior: 'instant' });
        await wait(300);
        return document.documentElement.outerHTML;
      },
    });
    return (results?.[0]?.result as string | undefined) ?? null;
  } catch (err) {
    console.warn('[LinkMate] scrapeInActiveTab failed:', err);
    return null;
  }
}

/**
 * Build a UserProfile from the already-loaded main-profile DOM, then enrich
 * with recent posts/comments by navigating the user's active tab through
 * the recent-activity subpages and finally restoring the original profile URL.
 */
async function captureFullUserProfile(
  url: string,
  parsedDoc: Document,
  tabId: number
): Promise<UserProfile> {
  const handle = extractHandle(url);
  const canonical = handle ? `https://www.linkedin.com/in/${handle}/` : url;
  const profile = parseUserProfile(parsedDoc, canonical);

  if (handle) {
    const postsUrl = `https://www.linkedin.com/in/${handle}/recent-activity/all/`;
    const commentsUrl = `https://www.linkedin.com/in/${handle}/recent-activity/comments/`;
    try {
      const postsHtml = await scrapeInActiveTab(tabId, postsUrl);
      if (postsHtml) {
        const d = new DOMParser().parseFromString(postsHtml, 'text/html');
        profile.recentPosts = parseRecentPosts(d);
      }
      const commentsHtml = await scrapeInActiveTab(tabId, commentsUrl);
      if (commentsHtml) {
        const d = new DOMParser().parseFromString(commentsHtml, 'text/html');
        profile.recentComments = parseRecentComments(d, handle);
      }
    } finally {
      // Always return the tab to the user's original page, even on partial failure.
      await chrome.tabs.update(tabId, { url });
    }
  }

  return profile;
}
