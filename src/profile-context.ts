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
import { getCaptureFullProfile, getProfile, getProviderConfig, setProfile } from './storage-schema';
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
  | 'not-signed-in'
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

export type CaptureProgress =
  | 'cache-check'
  | 'opening-tab'
  | 'waiting-profile-load'
  | 'scraping'
  | 'parsing'
  | 'summarizing'
  | 'done';

export interface CaptureOptions {
  /** Optional progress reporter; called as the capture moves through substeps. */
  onProgress?: (step: CaptureProgress) => void;
}

const HIDDEN_PROFILE_TAB_URL = 'https://www.linkedin.com/in/me/';
const HIDDEN_TAB_LOAD_TIMEOUT_MS = 20_000;
const LOGIN_URL_FRAGMENTS = ['/login', '/uas/login', '/checkpoint', '/authwall'];

/**
 * Opens a hidden background tab at /in/me/ and resolves with its tabId once
 * LinkedIn redirects to a real /in/<handle> URL. Rejects on login redirect or
 * timeout. Caller MUST `closeHiddenTab(tabId)` in a finally to avoid leaks.
 *
 * Mirrors the proven pattern in background.ts:startSsiCapture so the user's
 * current tab is never navigated away (issue #18 follow-up: capture UX).
 */
async function openHiddenProfileTab(): Promise<number> {
  const tab = await chrome.tabs.create({ url: HIDDEN_PROFILE_TAB_URL, active: false });
  const tabId = tab.id;
  if (tabId === undefined) {
    throw new Error('Could not create background tab for profile capture.');
  }

  let listener: ((id: number, info: chrome.tabs.TabChangeInfo, t: chrome.tabs.Tab) => void) | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        if (listener) chrome.tabs.onUpdated.removeListener(listener);
        listener = null;
      };
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Profile tab did not load within ${HIDDEN_TAB_LOAD_TIMEOUT_MS / 1000}s`));
      }, HIDDEN_TAB_LOAD_TIMEOUT_MS);

      listener = (id, info, t) => {
        if (id !== tabId) return;
        const url = info.url ?? t.url ?? '';
        // Login redirect — LinkedIn punted us; fail fast so the user sees a clear error.
        if (url && LOGIN_URL_FRAGMENTS.some((f) => url.includes(f))) {
          clearTimeout(timeoutId);
          cleanup();
          reject(new Error('not-signed-in'));
          return;
        }
        // Wait for both URL transition to /in/<handle> AND status === 'complete'.
        if (info.status === 'complete' && PROFILE_URL_PATTERN.test(t.url ?? '')) {
          clearTimeout(timeoutId);
          cleanup();
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  } catch (err) {
    // Best-effort cleanup; caller's finally will try again.
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* swallow */
    }
    throw err;
  }
  return tabId;
}

async function closeHiddenTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* tab may already be gone; nothing to do */
  }
}

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
  async capture(opts: CaptureOptions = {}): Promise<CaptureResult> {
    const progress = opts.onProgress ?? (() => {});

    // Issue #16 — when full-capture is ON and IDB snapshot is <24h, short-circuit
    // before doing any DOM grab. Falls through to full capture otherwise.
    // IDB read is fail-soft: in environments without IndexedDB (jsdom tests,
    // some service-worker contexts) we just proceed with the regular flow.
    progress('cache-check');
    const fullProfileEnabled = await getCaptureFullProfile();
    if (fullProfileEnabled) {
      try {
        const cached = await getUserProfile();
        if (cached && isFresh(cached)) {
          // IDB is the source of truth for the new flow; legacy chrome.storage
          // ProfileContext may be absent (e.g. user has no OpenAI key) but the
          // IDB snapshot is still valid — surface it as cached without forcing
          // a 30s re-scrape.
          const existingProfile = (await getProfile()) ?? undefined;
          progress('done');
          return { ok: true, profile: existingProfile, cached: true, userProfile: cached };
        }
      } catch (err) {
        console.warn('[LinkMate] UserProfile cache check failed; proceeding with fresh capture:', err);
      }
    }

    // Step 1: target tab.
    //
    // Priority order:
    //   (a) Explicit ?targetTab= from the side panel URL AND it's on a profile
    //       page — happens when the user opens the panel from their own /in/
    //       (issue #16 auto-open flow). Use that tab; do not open a new one.
    //   (b) Any active LinkedIn tab that's already on /in/<handle> — use it.
    //   (c) Otherwise: open a HIDDEN background tab at /in/me/ — captures
    //       without disrupting the user's current tab. Tab is closed in finally.
    let tabId: number | undefined;
    let hiddenTabId: number | undefined; // tracks tab WE opened so finally can close it
    let url = '';
    try {
      const explicitId = getExplicitTargetTabId();
      if (explicitId !== null) {
        try {
          const t = await chrome.tabs.get(explicitId);
          if (t && PROFILE_URL_PATTERN.test(t.url ?? '')) {
            tabId = t.id ?? undefined;
            url = t.url ?? '';
          }
        } catch {
          /* explicit tab may be stale; fall through to fallbacks */
        }
      }
      if (tabId === undefined) {
        const candidates = await chrome.tabs.query({ url: 'https://www.linkedin.com/in/*' });
        const fresh = candidates.find((t) => PROFILE_URL_PATTERN.test(t.url ?? ''));
        if (fresh?.id !== undefined) {
          tabId = fresh.id;
          url = fresh.url ?? '';
        }
      }
      if (tabId === undefined) {
        progress('opening-tab');
        try {
          hiddenTabId = await openHiddenProfileTab();
          progress('waiting-profile-load');
          // openHiddenProfileTab already waited for /in/<handle> + complete.
          const t = await chrome.tabs.get(hiddenTabId);
          tabId = hiddenTabId;
          url = t.url ?? '';
        } catch (err) {
          const message = String(err instanceof Error ? err.message : err);
          if (message === 'not-signed-in') {
            return {
              ok: false,
              reason: 'not-signed-in',
              message:
                'Not signed in to LinkedIn. Sign in to linkedin.com in this browser and try again.',
            };
          }
          return {
            ok: false,
            reason: 'no-active-tab',
            message: `Could not open a profile tab in the background: ${message}`,
          };
        }
      }
    } catch (err) {
      return {
        ok: false,
        reason: 'no-active-tab',
        message: `Could not resolve a profile tab: ${String(err)}`,
      };
    }

    if (tabId === undefined) {
      return { ok: false, reason: 'no-active-tab', message: 'No profile tab available.' };
    }

    // Step 2: URL guard (defence-in-depth — branches above should already ensure this).
    if (!PROFILE_URL_PATTERN.test(url)) {
      if (hiddenTabId !== undefined) await closeHiddenTab(hiddenTabId);
      return {
        ok: false,
        reason: 'not-on-profile',
        message:
          'LinkMate captures from a LinkedIn profile page only. Open your profile (linkedin.com/in/your-handle) and click Capture.',
      };
    }
    // Synthesise an activeTab-like object for the existing downstream code paths
    // that previously used `activeTab.id` / `activeTab.url`.
    const activeTab = { id: tabId, url } as chrome.tabs.Tab;

    // Wrap the rest of the capture in a try/finally so the hidden tab is ALWAYS
    // closed — even on early-return error paths below — and never leaks.
    try {
    // Step 3: inject an HTML-grab function. Parser runs in popup context (step 4).
    //
    // v0.5.6 — LinkedIn migrated to React Server-Driven UI (SDUI). The initial
    // HTML only contains top-card (name/headline/location). About / Skills /
    // Activity sections are EMPTY placeholders (`<div componentkey="...">`) that
    // get filled via async XHR after the user scrolls them into view.
    //
    // So we scroll the page programmatically, wait for SDUI to fetch the async
    // sections, then grab the HTML. ~3.5s total wait inside keepAlive.
    progress('scraping');
    let html: string | null = null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const originalScroll = window.scrollY;
          const main = document.querySelector('main');
          const scope = main ?? document;
          const heightLog: number[] = [];

          // Phase 1 — brute scroll until ALL expected sections appear in DOM
          // OR scrollHeight has been stable for 3 iterations. Bails as soon as
          // experience/education/skills/projects h2s are present.
          const TARGETS = /^(experience|education|skills(\s*\(\d+\))?|projects(\s*\(\d+\))?)/i;
          const hasAllTargets = () => {
            const seen = new Set<string>();
            const list = Array.from((main ?? document).querySelectorAll('h2, h3'));
            for (const h of list) {
              const t = (h.textContent ?? '').trim();
              const m = t.match(/^(experience|education|skills|projects)/i);
              if (m) seen.add(m[1].toLowerCase());
            }
            return seen.size >= 4;
          };
          let lastHeight = 0;
          let stableCount = 0;
          for (let i = 0; i < 20; i++) {
            const h = Math.max(
              document.documentElement.scrollHeight,
              document.body.scrollHeight,
              main?.scrollHeight ?? 0,
            );
            heightLog.push(h);
            window.scrollTo({ top: h, behavior: 'instant' });
            if (main && 'scrollTo' in main) main.scrollTo({ top: h, behavior: 'instant' });
            document.documentElement.scrollTop = h;
            await wait(700);
            if (i >= 4 && hasAllTargets()) break;
            if (h === lastHeight) {
              stableCount++;
              if (stableCount >= 3 && i >= 6) break;
            } else {
              stableCount = 0;
            }
            lastHeight = h;
          }

          // Phase 2 — only scrollIntoView the target sections (not every h2).
          // Wait 500ms each; LinkedIn 2026 uses <div componentkey> + <p>, not
          // <li>, so the old "if items==0 wait more" heuristic was wrong.
          const headings = Array.from(scope.querySelectorAll('h2, h3')) as HTMLElement[];
          for (const h of headings) {
            if (!TARGETS.test((h.textContent ?? '').trim())) continue;
            try {
              h.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
              await wait(500);
            } catch {
              /* ignore */
            }
          }
          await wait(400);

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
    progress('parsing');
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

    // Step 6 — OpenAI positioning summary + chrome.storage ProfileContext.
    // Powers AI-drafted comments elsewhere in the extension. NON-BLOCKING:
    // failure here doesn't invalidate the IDB write above.
    //
    // Skip the OpenAI round-trip entirely when no API key is configured —
    // the summary call would just fail anyway, but skipping avoids ~5s of
    // background work and a noisy error in the console. The AI feed scoring
    // (issue #18) does not require positioningSummary; it falls back to the
    // rich IDB UserProfile via formatUserBackground().
    progress('summarizing');
    let profile: ProfileContext | undefined;
    let summaryError: string | undefined;
    let providerKeyConfigured = true;
    try {
      const cfg = await getProviderConfig();
      providerKeyConfigured = Boolean(cfg.openai?.apiKey?.trim());
    } catch {
      /* read failure → assume no key, skip the call */
      providerKeyConfigured = false;
    }
    if (!providerKeyConfigured) {
      summaryError = 'No OpenAI API key configured — positioning summary skipped.';
    } else {
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
    }
    if (summaryError) {
      console.warn('[LinkMate] positioning summary skipped:', summaryError);
    }

    progress('done');
    return { ok: true, profile, userProfile, summaryError };
    } finally {
      // ALWAYS close the hidden tab we opened, regardless of how we exited the
      // capture body. No-op when we used an explicit/existing tab.
      if (hiddenTabId !== undefined) await closeHiddenTab(hiddenTabId);
    }
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

  // Wait for the navigation to fully complete. Two failure modes guarded:
  //   1) onUpdated 'complete' fires before listener attaches (cached/fast nav).
  //      → post-attach we re-check tab.status and resolve if already complete.
  //   2) Listener fires first; setTimeout must be cleared to avoid leaked
  //      closures across rapid recaptures.
  await new Promise<void>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(finish, 15000);
    // Catch the case where 'complete' fired between update() and addListener().
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === 'complete') finish();
      },
      () => finish(),
    );
  });

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        // Authwall guard: LinkedIn 302's expired sessions to /authwall or
        // /uas/login. We must NOT silently scrape the logged-out shell as
        // if it were the activity HTML.
        if (/\/(authwall|login|uas\/login|checkpoint)\b/i.test(window.location.pathname)) {
          return '__LINKMATE_AUTHWALL__';
        }
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const main = document.querySelector('main');
        await wait(900);
        // Scroll until enough activity items show up OR scrollHeight stable.
        let lastHeight = 0;
        let stable = 0;
        for (let i = 0; i < 8; i++) {
          const h = Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            main?.scrollHeight ?? 0,
          );
          window.scrollTo({ top: h, behavior: 'instant' });
          if (main && 'scrollTo' in main) main.scrollTo({ top: h, behavior: 'instant' });
          document.documentElement.scrollTop = h;
          await wait(700);
          const itemCount = (main ?? document).querySelectorAll(
            '[data-urn^="urn:li:activity"]',
          ).length;
          if (itemCount >= 10) break;
          if (h === lastHeight) {
            stable++;
            if (stable >= 2 && i >= 3) break;
          } else {
            stable = 0;
          }
          lastHeight = h;
        }
        window.scrollTo({ top: 0, behavior: 'instant' });
        if (main && 'scrollTo' in main) main.scrollTo({ top: 0, behavior: 'instant' });
        await wait(200);
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
      if (postsHtml === '__LINKMATE_AUTHWALL__') {
        throw new Error('LinkedIn session expired (authwall). Sign in and try again.');
      }
      if (postsHtml) {
        const d = new DOMParser().parseFromString(postsHtml, 'text/html');
        profile.recentPosts = parseRecentPosts(d);
      }
      const commentsHtml = await scrapeInActiveTab(tabId, commentsUrl);
      if (commentsHtml === '__LINKMATE_AUTHWALL__') {
        throw new Error('LinkedIn session expired (authwall). Sign in and try again.');
      }
      if (commentsHtml) {
        const d = new DOMParser().parseFromString(commentsHtml, 'text/html');
        profile.recentComments = parseRecentComments(d, handle);
      }
    } finally {
      // Return tab to original profile URL only if it's still on one of OUR
      // scrape destinations. If the user navigated elsewhere during the
      // capture, respect their navigation and don't hijack them back.
      try {
        const current = await chrome.tabs.get(tabId);
        const onOurScrapePage =
          current.url?.startsWith(postsUrl) ||
          current.url?.startsWith(commentsUrl) ||
          current.url === url;
        if (onOurScrapePage && current.url !== url) {
          await chrome.tabs.update(tabId, { url });
        }
      } catch {
        /* tab may be closed; nothing to restore */
      }
    }
  }

  return profile;
}
