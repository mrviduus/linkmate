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
import {
  getCaptureFullProfile,
  getDeepScrape,
  getProfile,
  getProviderConfig,
  setDeepScrapeCancel,
  setDeepScrapeProgress,
  setProfile,
  STORAGE_KEYS,
} from './storage-schema';
import type { ProfileContext } from './storage-schema';
import { getUserProfile, isFresh, mergeUserProfile, saveUserProfile } from './user-profile-store';
import type { UserProfile } from './lib/idb';

const PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Sentinels that inject scripts prefix to / return as the HTML payload.
// Inject can't import closures (chrome.scripting.executeScript serialises the
// function body), so we ship constants through the `args` channel. Single
// bundle here is the source of truth — both injects receive it as cfg.
const CANCEL_MARKER = '__LINKMATE_CANCELLED__:';
// Session expired → /authwall, /login, /uas/login.
const AUTHWALL_MARKER = '__LINKMATE_AUTHWALL__';
// LinkedIn 302's into /checkpoint/{challenge,lg/login-submit,rm/...} when it
// suspects bot activity. Different UX than authwall ("complete the challenge,
// then retry"). Detected by both URL and in-page DOM signals (CAPTCHA iframe,
// challenge <form>) inside each inject.
const CHECKPOINT_MARKER = '__LINKMATE_CHECKPOINT__';

const INJECT_RUNTIME = {
  progressKey: STORAGE_KEYS.deepScrapeProgress,
  cancelKey: STORAGE_KEYS.deepScrapeCancel,
  cancelMarker: CANCEL_MARKER,
  authwallMarker: AUTHWALL_MARKER,
  checkpointMarker: CHECKPOINT_MARKER,
} as const;

type InjectRuntime = typeof INJECT_RUNTIME;

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
  | 'summary-failed'
  | 'checkpoint';

class CheckpointError extends Error {
  constructor() {
    super('LinkedIn checkpoint');
    this.name = 'CheckpointError';
  }
}

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
  // Open ACTIVE so LinkedIn's intersection observers, rAF, and SDUI hydration
  // run at full speed. Background (active:false) tabs get throttled by Chrome
  // and LinkedIn's lazy-loaded sections fail to render. We close the tab
  // in finally so the disruption is brief.
  const tab = await chrome.tabs.create({ url: HIDDEN_PROFILE_TAB_URL, active: true });
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
        // CRITICAL: /in/me/ is a magic alias that LinkedIn redirects to the real
        // /in/{handle}/ — but it matches PROFILE_URL_PATTERN too, so without
        // explicitly excluding it we'd resolve BEFORE the redirect lands and
        // downstream code (recent-activity URLs, profileUrl) would be built
        // against /in/me/ which 404s.
        const stillOnAlias = /\/in\/me\/?(\?.*)?$/i.test(t.url ?? '');
        if (
          info.status === 'complete' &&
          PROFILE_URL_PATTERN.test(t.url ?? '') &&
          !stillOnAlias
        ) {
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

    // Step 1: ALWAYS open a fresh dedicated tab for capture.
    //
    // Reusing the user's existing /in/{handle}/ tab caused intermittent
    // degraded SSR responses from LinkedIn — likely state pollution from prior
    // SPA navigations the user did in that tab. A fresh tab gives clean SSR.
    //
    // Tab is opened ACTIVE (visible) — Chrome throttles background tabs,
    // which breaks LinkedIn's lazy-loaded SDUI sections. Closed in finally so
    // the disruption is brief (~25-30s for full capture).
    let tabId: number | undefined;
    let hiddenTabId: number | undefined; // tracks tab WE opened so finally can close it
    let url = '';
    // Remember the user's original active tab so we can restore focus at the end.
    let originalActiveTabId: number | undefined;
    try {
      const [origTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      originalActiveTabId = origTab?.id;
    } catch {
      /* ignore */
    }
    try {
      progress('opening-tab');
      hiddenTabId = await openHiddenProfileTab();
      progress('waiting-profile-load');
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
        message: `Could not open a profile tab: ${message}`,
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
    // Read deepScrape ahead of time — passed to scrapeInActiveTab (activity
    // subpages) downstream. The main-profile inject below intentionally does
    // NOT use deep/cancel/progress — that's what v0.4.0 did and what works.
    const deepScrapeEnabled = await getDeepScrape();
    if (deepScrapeEnabled) {
      await setDeepScrapeCancel(false);
      await setDeepScrapeProgress(null);
    }
    let html: string | null = null;
    try {
      // INTENTIONAL: this inject is byte-for-byte the v0.4.0 main-profile
      // scrape. Anything more (cancel polling, progress writes, extra DOM
      // checks) prolongs the run and triggers LinkedIn's degraded SSR for
      // owner-view of /in/{handle}/. Keep it minimal. Deep-mode features
      // live in scrapeInActiveTab (recent-activity scrape).
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
        const fresh = await captureFullUserProfile(url, parsedDoc, activeTab.id, deepScrapeEnabled);
        // URN-merge with previous snapshot — accumulates history across runs
        // so old activity isn't lost when LinkedIn paginates it out of view.
        const previous = await getUserProfile().catch(() => null);
        userProfile = mergeUserProfile(previous, fresh);
        await saveUserProfile(userProfile);
      } catch (err) {
        if (err instanceof CheckpointError) {
          if (deepScrapeEnabled) {
            await setDeepScrapeProgress(null);
            await setDeepScrapeCancel(false);
          }
          return {
            ok: false,
            reason: 'checkpoint',
            message:
              'LinkedIn asked for verification (checkpoint). Open the tab, complete the challenge, then click Capture again.',
          };
        }
        console.warn('[LinkMate] Full profile capture failed:', err);
      }
    }
    // Always clear the progress badge on the way out.
    // captureFullUserProfile's finally{} does the same for the normal path,
    // but this catches early-return paths above (parser-empty, etc).
    if (deepScrapeEnabled) {
      await setDeepScrapeProgress(null);
      await setDeepScrapeCancel(false);
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
      // ALWAYS close the capture tab we opened, regardless of how we exited.
      if (hiddenTabId !== undefined) await closeHiddenTab(hiddenTabId);
      // Restore focus to whatever the user was on before we hijacked it with
      // our active capture tab.
      if (originalActiveTabId !== undefined) {
        try {
          await chrome.tabs.update(originalActiveTabId, { active: true });
        } catch {
          /* original tab may be gone */
        }
      }
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
 * Skills-only details fallback. The main /in/{handle}/ page renders only the
 * top-2 skills under owner view; the full list (often 30-50+) lives on the
 * dedicated /details/skills/ subpage. Navigate the active capture tab there,
 * scroll + wait for hydration, return parsed skill names. Minimal inject —
 * no progress/cancel/checkpoint plumbing.
 */
async function scrapeAllSkills(tabId: number, handle: string): Promise<string[]> {
  const url = `https://www.linkedin.com/in/${handle}/details/skills/`;
  await chrome.tabs.update(tabId, { url });
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
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(finish, 12000);
    chrome.tabs.get(tabId).then(
      (t) => {
        if (t.status === 'complete') finish();
      },
      () => finish(),
    );
  });
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const main = document.querySelector('main');
        await wait(800);
        // Skills are paginated — LinkedIn lazy-loads more as you scroll down.
        // Brute-scroll to the bottom several times to force all to render.
        for (let i = 0; i < 10; i++) {
          const h = Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            main?.scrollHeight ?? 0,
          );
          window.scrollTo({ top: h, behavior: 'instant' });
          if (main && 'scrollTo' in main) main.scrollTo({ top: h, behavior: 'instant' });
          await wait(700);
        }
        return document.documentElement.outerHTML;
      },
    });
    const html = (results?.[0]?.result as string | undefined) ?? null;
    if (!html) return [];
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Scope strictly to the skills card. The page has NO h2 saying "Skills"
    // (it IS the skills section) — find the card via the SDUI componentkey
    // that ends with "SkillDetails". Walking the whole <main> would suck in
    // ads, sidebar widgets, footer links etc as fake skills.
    //
    // DOM signature (snapped via MCP):
    //   <div componentkey="com.linkedin.sdui.profile.card.ref…SkillDetails">
    //     <p>Skills</p>                              ← page title (skip)
    //     <p>React Native</p>                        ← skill
    //     <p>Senior Software Engineer at Pinnacle</p>← role context (skip)
    //     <p>Passed LinkedIn Skill Assessment</p>    ← badge text (skip)
    //     <p>1 endorsement</p>                       ← endorsement count (skip)
    //     ... (alternating skill / role-context / occasional badges)
    let card = doc.querySelector('[componentkey$="SkillDetails" i]');
    if (!card) {
      // Fallback — find the <p>Skills</p> page title and walk up to nearest
      // componentkey ancestor. Defensive against componentkey suffix changes.
      const title = Array.from(doc.querySelectorAll('main p')).find(
        (p) => (p.textContent ?? '').trim() === 'Skills'
      );
      card = title?.closest('[componentkey]') ?? null;
    }
    if (!card) return [];
    const ROLE_CONTEXT = /\bat\s+\S/i;
    const SKIP_EXACT = new Set([
      'Skills',
      'Passed LinkedIn Skill Assessment',
    ]);
    const SKIP_PATTERN = /^(\d+\s*endorsements?|Show all|See all)\b/i;
    const skills: string[] = [];
    for (const p of Array.from(card.querySelectorAll('p'))) {
      const t = (p.textContent ?? '').trim();
      if (!t || t.length < 2 || t.length > 80) continue;
      if (ROLE_CONTEXT.test(t)) continue;
      if (SKIP_EXACT.has(t)) continue;
      if (SKIP_PATTERN.test(t)) continue;
      if (skills.includes(t)) continue;
      skills.push(t);
    }
    return skills;
  } catch (err) {
    console.warn('[LinkMate] scrapeAllSkills failed:', err);
    return [];
  }
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
async function scrapeInActiveTab(
  tabId: number,
  url: string,
  opts: { deep?: boolean; phase?: 'posts' | 'comments' } = {}
): Promise<string | null> {
  // Announce the new phase BEFORE the tab navigates — otherwise the popup
  // keeps showing the previous phase's stale "iter N items M" for the 1-2s
  // of navigation + SDUI hydration. Reset to iter=0 / items=0 so the badge
  // reads "Scraping posts — 0 items, iter 0" immediately.
  if (opts.deep) {
    await setDeepScrapeProgress({
      phase: opts.phase ?? 'posts',
      iter: 0,
      items: 0,
      height: 0,
      ts: Date.now(),
    });
  }
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
      args: [
        { ...INJECT_RUNTIME, deep: !!opts.deep, phase: opts.phase ?? 'posts' },
      ],
      func: async (
        cfg: InjectRuntime & { deep: boolean; phase: 'posts' | 'comments' }
      ) => {
        // Checkpoint: LinkedIn detected suspicious activity (often triggered
        // by aggressive scroll in deep mode) and is asking the user to verify.
        // Two delivery modes:
        //   - full-page redirect → window.location.pathname starts /checkpoint/
        //   - in-page challenge → URL stays put but a checkpoint <form> or
        //     Arkose CAPTCHA iframe appears in the DOM.
        // We check BOTH on entry and again after every scroll iteration.
        //
        // Selectors below are best-guess. When LinkedIn changes the challenge
        // UI: open DevTools on a real challenge page, copy outerHTML of the
        // challenge container, grep for stable id/class/data-* attributes, add
        // them here. Avoid text-based detection — false-positives in feed.
        const hasCheckpoint = () =>
          /\/checkpoint\b/i.test(window.location.pathname) ||
          !!document.querySelector(
            'form[action*="/checkpoint/"], #captcha-internal-iframe, [id^="captcha-"], iframe[src*="arkoselabs"]',
          );
        if (hasCheckpoint()) {
          return cfg.checkpointMarker;
        }
        // Authwall: session expired. We must NOT silently scrape the
        // logged-out shell as if it were the activity HTML.
        if (/\/(authwall|login|uas\/login)\b/i.test(window.location.pathname)) {
          return cfg.authwallMarker;
        }
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        // Deep-mode jitter: ±200ms randomisation makes the scroll cadence look
        // less robotic. LinkedIn's anti-bot heuristics flag uniform 900ms
        // beats; jittered waits stay safe. ~15% wall-clock cost.
        const jitter = cfg.deep ? () => Math.floor(Math.random() * 400) - 200 : () => 0;
        const main = document.querySelector('main');
        await wait(900 + jitter());

        // Inject script runs in isolated world and CAN call chrome.storage —
        // popup writes the cancel flag, we poll it; we write progress, popup
        // observes it via storage.onChanged. Gated to deep mode only — quick
        // mode finishes in ~6s, the UI flash isn't useful and adds noise.
        const writeProgress = cfg.deep
          ? async (iter: number, items: number, height: number) => {
              try {
                await chrome.storage.local.set({
                  [cfg.progressKey]: { phase: cfg.phase, iter, items, height, ts: Date.now() },
                });
              } catch {
                /* storage write failures shouldn't kill scrape */
              }
            }
          : async (_iter: number, _items: number, _height: number) => {};
        const isCancelled = cfg.deep
          ? async (): Promise<boolean> => {
              try {
                const row = (await chrome.storage.local.get(cfg.cancelKey)) as Record<string, unknown>;
                return !!row[cfg.cancelKey];
              } catch {
                return false;
              }
            }
          : async (): Promise<boolean> => false;

        // Deep mode: scroll until scrollHeight is stable N iterations in a row
        // or we hit a safety cap (LinkedIn lazy-loads indefinitely; this is the
        // "no more new content" signal). Quick mode: stop at ~10 items.
        const MAX_ITERS = cfg.deep ? 200 : 8;
        const ITEM_TARGET = cfg.deep ? Infinity : 10;
        const STABLE_TARGET = cfg.deep ? 4 : 2;
        const STABLE_MIN_ITER = cfg.deep ? 0 : 3;

        let lastHeight = 0;
        let stable = 0;
        let lastItemCount = 0;
        let cancelled = false;
        let checkpointMidScroll = false;
        for (let i = 0; i < MAX_ITERS; i++) {
          const h = Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            main?.scrollHeight ?? 0,
          );
          window.scrollTo({ top: h, behavior: 'instant' });
          if (main && 'scrollTo' in main) main.scrollTo({ top: h, behavior: 'instant' });
          document.documentElement.scrollTop = h;
          await wait((cfg.deep ? 900 : 700) + jitter());
          // Recheck checkpoint each iteration — LinkedIn can inject a
          // challenge modal mid-scroll without changing the URL.
          if (hasCheckpoint()) {
            checkpointMidScroll = true;
            break;
          }
          const itemCount = (main ?? document).querySelectorAll(
            '[data-urn^="urn:li:activity"]',
          ).length;
          await writeProgress(i + 1, itemCount, h);
          if (await isCancelled()) {
            cancelled = true;
            break;
          }
          if (itemCount >= ITEM_TARGET) break;
          // Deep mode: stable means BOTH height AND item count unchanged.
          const heightStable = h === lastHeight;
          const itemsStable = itemCount === lastItemCount;
          if (cfg.deep ? heightStable && itemsStable : heightStable) {
            stable++;
            if (stable >= STABLE_TARGET && i >= STABLE_MIN_ITER) break;
          } else {
            stable = 0;
          }
          lastHeight = h;
          lastItemCount = itemCount;
        }
        if (checkpointMidScroll) return cfg.checkpointMarker;
        window.scrollTo({ top: 0, behavior: 'instant' });
        if (main && 'scrollTo' in main) main.scrollTo({ top: 0, behavior: 'instant' });
        await wait(200);
        // Final race-closer: between the loop's last hasCheckpoint() and the
        // outerHTML grab there's a 200ms+ window. One more check here keeps
        // a late-injected challenge modal from being silently scraped.
        if (hasCheckpoint()) return cfg.checkpointMarker;
        // Return partial HTML even on cancel — caller still merges with cache.
        const html = document.documentElement.outerHTML;
        return cancelled ? cfg.cancelMarker + html : html;
      },
    });
    return (results?.[0]?.result as string | undefined) ?? null;
  } catch (err) {
    console.warn('[LinkMate] scrapeInActiveTab failed:', err);
    return null;
  }
}

/**
 * Inject script prefixes the HTML with CANCEL_MARKER when the user hit Cancel
 * mid-scroll. Strip the marker so downstream HTML parsing isn't confused;
 * partial HTML still flows through merge.
 */
function stripCancelPrefix(html: string | null): string | null {
  if (html === null) return null;
  if (html.startsWith(CANCEL_MARKER)) {
    return html.slice(CANCEL_MARKER.length);
  }
  return html;
}

/**
 * Build a UserProfile from the already-loaded main-profile DOM, then enrich
 * with recent posts/comments by navigating the user's active tab through
 * the recent-activity subpages and finally restoring the original profile URL.
 */
async function captureFullUserProfile(
  url: string,
  parsedDoc: Document,
  tabId: number,
  deep: boolean
): Promise<UserProfile> {
  const handle = extractHandle(url);
  const canonical = handle ? `https://www.linkedin.com/in/${handle}/` : url;
  const profile = parseUserProfile(parsedDoc, canonical);

  // Deep mode: keep everything we can scrape. The scrape loop is the real
  // bottleneck; parser caps were just defensive defaults.
  const parseOpts = deep ? { limit: Infinity } : {};

  if (handle) {
    // Skills enrichment — main profile only renders the top-2 skills for
    // owner view; full list (often 30-50+) is on /details/skills/. Trigger
    // when we have suspiciously few (<5) — heuristic.
    if (profile.skills.length < 5) {
      try {
        const allSkills = await scrapeAllSkills(tabId, handle);
        if (allSkills.length > profile.skills.length) {
          profile.skills = allSkills;
        }
      } catch (err) {
        console.warn('[LinkMate] skills enrichment failed:', err);
      }
    }

    const postsUrl = `https://www.linkedin.com/in/${handle}/recent-activity/all/`;
    const commentsUrl = `https://www.linkedin.com/in/${handle}/recent-activity/comments/`;
    // Note: caller (capture()) already cleared progress/cancel for this run.
    // Re-clearing here would clobber a cancel set during the profile phase
    // and flicker the progress badge between phase transitions.
    try {
      const postsHtml = stripCancelPrefix(
        await scrapeInActiveTab(tabId, postsUrl, { deep, phase: 'posts' })
      );
      if (postsHtml === CHECKPOINT_MARKER) {
        throw new CheckpointError();
      }
      if (postsHtml === AUTHWALL_MARKER) {
        throw new Error('LinkedIn session expired (authwall). Sign in and try again.');
      }
      if (postsHtml) {
        const d = new DOMParser().parseFromString(postsHtml, 'text/html');
        profile.recentPosts = parseRecentPosts(d, parseOpts);
      }
      const commentsHtml = stripCancelPrefix(
        await scrapeInActiveTab(tabId, commentsUrl, { deep, phase: 'comments' })
      );
      if (commentsHtml === CHECKPOINT_MARKER) {
        throw new CheckpointError();
      }
      if (commentsHtml === AUTHWALL_MARKER) {
        throw new Error('LinkedIn session expired (authwall). Sign in and try again.');
      }
      if (commentsHtml) {
        const d = new DOMParser().parseFromString(commentsHtml, 'text/html');
        profile.recentComments = parseRecentComments(d, handle, parseOpts);
      }
    } finally {
      await setDeepScrapeProgress(null);
      await setDeepScrapeCancel(false);
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
