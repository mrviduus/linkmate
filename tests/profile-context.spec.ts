/**
 * T033 — Profile Context service spec (Phase A, US3).
 * Drives src/profile-context.ts (T035). Popup-side orchestrator that:
 *   1. queries the active tab
 *   2. guards the URL against the /in/{handle} pattern (compliance)
 *   3. injects parseProfileDom via chrome.scripting.executeScript
 *   4. sends raw fields to background → receives positioningSummary
 *   5. persists ProfileContext via storage-schema
 */

import { ProfileContextService } from '../src/profile-context';
import { STORAGE_KEYS } from '../src/storage-schema';
import type { ProfileContext } from '../src/storage-schema';

// In-memory chrome.storage.local mock (same pattern as storage-schema.spec.ts)
function installMemoryStorage(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  (chrome.storage.local.get as jest.Mock).mockImplementation(
    (keys: string | string[] | null, cb?: (v: Record<string, unknown>) => void) => {
      const arr = keys === null || keys === undefined
        ? Array.from(store.keys())
        : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of arr) if (store.has(k)) out[k] = store.get(k);
      if (cb) cb(out);
      return Promise.resolve(out);
    },
  );
  (chrome.storage.local.set as jest.Mock).mockImplementation(
    (items: Record<string, unknown>, cb?: () => void) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
      if (cb) cb();
      return Promise.resolve();
    },
  );
  return store;
}

interface ChromeTabsScriptingMockOpts {
  activeTabUrl: string;
  activeTabId?: number;
  /** HTML string the injected `document.documentElement.outerHTML` returns. */
  scriptingHtml?: string;
  scriptingThrows?: boolean;
  /**
   * If true (default), chrome.tabs.create throws — simulating "we tried to
   * open a hidden capture tab but it failed". Set to false to allow the
   * hidden-tab flow to succeed (the mock then synthesises a tab on /in/me/
   * and synchronously fires the 'complete' update event).
   */
  failHiddenTabCreate?: boolean;
}

function installChromeTabsScriptingMocks(opts: ChromeTabsScriptingMockOpts) {
  const failCreate = opts.failHiddenTabCreate ?? true;

  const tabsQuery = jest.fn().mockImplementation(async (q: chrome.tabs.QueryInfo) => {
    // When refactored capture asks specifically for /in/* tabs, only return the
    // active tab when its URL matches; otherwise return empty so the fallback
    // (hidden-tab creation) is exercised.
    if (q?.url === 'https://www.linkedin.com/in/*') {
      return /\/in\//.test(opts.activeTabUrl)
        ? [{ id: opts.activeTabId ?? 42, url: opts.activeTabUrl, active: true }]
        : [];
    }
    return [{ id: opts.activeTabId ?? 42, url: opts.activeTabUrl, active: true }];
  });
  (chrome.tabs.query as jest.Mock) = tabsQuery;

  const onUpdatedListeners: Array<(id: number, info: chrome.tabs.TabChangeInfo, t: chrome.tabs.Tab) => void> = [];
  (chrome.tabs as any).onUpdated = {
    addListener: (fn: any) => onUpdatedListeners.push(fn),
    removeListener: (fn: any) => {
      const i = onUpdatedListeners.indexOf(fn);
      if (i >= 0) onUpdatedListeners.splice(i, 1);
    },
    hasListener: () => false,
    hasListeners: () => false,
  };

  const tabsCreate = jest.fn().mockImplementation(async () => {
    if (failCreate) throw new Error('chrome.tabs.create unavailable in this test');
    const newTab = {
      id: 999,
      url: 'https://www.linkedin.com/in/synthetic-me/',
      active: false,
    } as chrome.tabs.Tab;
    // Fire 'complete' on next tick so the awaiting code path resolves.
    setTimeout(() => {
      for (const l of onUpdatedListeners.slice()) {
        l(999, { status: 'complete', url: newTab.url }, newTab);
      }
    }, 0);
    return newTab;
  });
  (chrome.tabs as unknown as { create: jest.Mock }).create = tabsCreate;

  const tabsGet = jest.fn().mockImplementation(async (id: number) => {
    if (id === 999) {
      return {
        id: 999,
        url: 'https://www.linkedin.com/in/synthetic-me/',
        active: false,
      } as chrome.tabs.Tab;
    }
    return {
      id: opts.activeTabId ?? 42,
      url: opts.activeTabUrl,
      active: true,
    } as chrome.tabs.Tab;
  });
  (chrome.tabs as unknown as { get: jest.Mock }).get = tabsGet;

  const tabsRemove = jest.fn().mockResolvedValue(undefined);
  (chrome.tabs as unknown as { remove: jest.Mock }).remove = tabsRemove;

  const executeScript = jest.fn().mockImplementation(async () => {
    if (opts.scriptingThrows) throw new Error('script injection failed');
    return [{ result: opts.scriptingHtml ?? null, frameId: 0 }];
  });
  (chrome as unknown as { scripting: { executeScript: jest.Mock } }).scripting = {
    executeScript,
  };

  return { tabsQuery, executeScript, tabsCreate, tabsGet, tabsRemove };
}

/**
 * Seed the in-memory storage with an OpenAI provider config so capture()'s
 * provider-key gate lets the OpenAI summary call through. Tests that don't
 * call this run the no-key short-circuit path (capture succeeds, profile
 * undefined, summaryError set).
 */
async function seedProviderKey(): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.provider]: {
      mode: 'openai',
      openai: { apiKey: 'sk-test', model: 'gpt-4o-mini' },
    },
  });
}

// Minimal HTML snippet matching the fixture's structure — enough for parser to
// extract fullName, headline, and a couple of skills/themes. Avoids loading the
// whole fixture file into every test.
function sampleProfileHtml(): string {
  return `<!DOCTYPE html><html><body><main>
    <h1 class="text-heading-xlarge">Synthetic Me</h1>
    <div class="text-body-medium break-words">AI Engineer | RAG | Agents</div>
    <section id="about"><div class="inline-show-more-text"><span aria-hidden="true">Builder of local-first AI systems.</span></div></section>
    <section id="skills"><ul class="pvs-list">
      <li class="pvs-list__paged-list-item"><div><span class="t-bold"><span aria-hidden="true">TypeScript</span></span></div></li>
      <li class="pvs-list__paged-list-item"><div><span class="t-bold"><span aria-hidden="true">WebLLM</span></span></div></li>
      <li class="pvs-list__paged-list-item"><div><span class="t-bold"><span aria-hidden="true">RAG</span></span></div></li>
    </ul></section>
    <section id="content_collections"><ul class="pvs-list">
      <li><div class="update-components-text"><span aria-hidden="true">agents</span></div></li>
      <li><div class="update-components-text"><span aria-hidden="true">rag</span></div></li>
      <li><div class="update-components-text"><span aria-hidden="true">local-llms</span></div></li>
    </ul></section>
  </main></body></html>`;
}

function installBackgroundMessenger(positioningSummary: string | { error: string }) {
  const sendMessage = jest.fn().mockImplementation(
    (message: { action: string }, cb?: (response: unknown) => void) => {
      const response =
        message.action === 'profile.capture'
          ? typeof positioningSummary === 'string'
            ? { ok: true, positioningSummary }
            : { ok: false, error: positioningSummary.error }
          : { ok: false, error: 'unknown action' };
      if (cb) cb(response);
      return Promise.resolve(response);
    },
  );
  (chrome.runtime.sendMessage as jest.Mock) = sendMessage;
  return sendMessage;
}

describe('profile-context (T033)', () => {
  let storage: Map<string, unknown>;

  beforeEach(() => {
    storage = installMemoryStorage();
  });

  describe('capture()', () => {
    it.skip('opens a hidden background tab when no /in/ tab is open, captures there, closes it', async () => {
      // failHiddenTabCreate=false allows the synthetic hidden-tab flow.
      const { tabsCreate, tabsRemove } = installChromeTabsScriptingMocks({
        activeTabUrl: 'https://www.linkedin.com/feed/',
        scriptingHtml: sampleProfileHtml(),
        failHiddenTabCreate: false,
      });
      const svc = new ProfileContextService();
      const res = await svc.capture();
      expect(res.ok).toBe(true);
      expect(tabsCreate).toHaveBeenCalledTimes(1);
      const createCall = tabsCreate.mock.calls[0][0];
      expect(createCall.url).toBe('https://www.linkedin.com/in/me/');
      expect(createCall.active).toBe(false); // hidden — does not disturb user
      // The hidden tab MUST be closed regardless of success/failure.
      expect(tabsRemove).toHaveBeenCalledWith(999);
    });

    it('returns no-active-tab when no /in/ tab exists AND we cannot open a hidden tab', async () => {
      // failHiddenTabCreate defaults to true → chrome.tabs.create throws.
      installChromeTabsScriptingMocks({ activeTabUrl: 'https://www.linkedin.com/feed/' });
      const svc = new ProfileContextService();
      const res = await svc.capture();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('no-active-tab');
    });

    it('refuses when there is no active tab', async () => {
      (chrome.tabs.query as jest.Mock) = jest.fn().mockResolvedValue([]);
      const svc = new ProfileContextService();
      const res = await svc.capture();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('no-active-tab');
    });

    it.skip('calls executeScript exactly once with the active tab id and a func payload', async () => {
      const { executeScript } = installChromeTabsScriptingMocks({
        activeTabUrl: 'https://www.linkedin.com/in/synthetic-me/',
        activeTabId: 99,
        scriptingHtml: sampleProfileHtml(),
      });
      installBackgroundMessenger('AI engineer focused on local-first agents.');
      const svc = new ProfileContextService();
      await svc.capture();
      expect(executeScript).toHaveBeenCalledTimes(1);
      const call = executeScript.mock.calls[0][0];
      expect(call.target.tabId).toBe(99);
      expect(typeof call.func).toBe('function');
    });

    it.skip('persists ProfileContext when background returns a positioningSummary', async () => {
      await seedProviderKey();
      installChromeTabsScriptingMocks({
        activeTabUrl: 'https://www.linkedin.com/in/synthetic-me/',
        scriptingHtml: sampleProfileHtml(),
      });
      installBackgroundMessenger('AI engineer focused on local-first agents.');

      const svc = new ProfileContextService();
      const res = await svc.capture();

      expect(res.ok).toBe(true);
      if (res.ok && res.profile) {
        expect(res.profile.fullName).toBe('Synthetic Me');
        expect(res.profile.positioningSummary).toBe(
          'AI engineer focused on local-first agents.',
        );
        expect(res.profile.capturedAt).toBeGreaterThan(0);
      } else {
        throw new Error('expected res.profile to be defined');
      }
      // Persisted to storage under the v1 key
      expect(storage.get(STORAGE_KEYS.profile)).toBeDefined();
    });

    it.skip('returns script-failed if executeScript throws', async () => {
      installChromeTabsScriptingMocks({
        activeTabUrl: 'https://www.linkedin.com/in/synthetic-me/',
        scriptingThrows: true,
      });
      installBackgroundMessenger('unused');
      const svc = new ProfileContextService();
      const res = await svc.capture();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('script-failed');
    });

    it.skip('still succeeds when AI positioning summary errors out (issue #16: DOM scrape is independent)', async () => {
      await seedProviderKey();
      installChromeTabsScriptingMocks({
        activeTabUrl: 'https://www.linkedin.com/in/synthetic-me/',
        scriptingHtml: sampleProfileHtml(),
      });
      installBackgroundMessenger({ error: 'webllm not ready' });
      const svc = new ProfileContextService();
      const res = await svc.capture();
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.summaryError).toBeDefined();
        expect(res.profile).toBeUndefined();
      }
    });

    it.skip('skips the OpenAI positioning summary entirely when no API key is configured', async () => {
      // No seedProviderKey() → empty config → AI step short-circuits.
      installChromeTabsScriptingMocks({
        activeTabUrl: 'https://www.linkedin.com/in/synthetic-me/',
        scriptingHtml: sampleProfileHtml(),
      });
      const sendMessage = installBackgroundMessenger('AI engineer focused on local-first agents.');
      const svc = new ProfileContextService();
      const res = await svc.capture();
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.summaryError).toMatch(/no openai api key/i);
        expect(res.profile).toBeUndefined();
      }
      // The whole profile.capture round-trip MUST be skipped — no wasted call.
      const profileCaptureCalls = sendMessage.mock.calls.filter(
        (c) => (c[0] as { action: string }).action === 'profile.capture',
      );
      expect(profileCaptureCalls).toHaveLength(0);
    });

    it.skip('reports progress substeps via onProgress callback', async () => {
      await seedProviderKey();
      installChromeTabsScriptingMocks({
        activeTabUrl: 'https://www.linkedin.com/in/synthetic-me/',
        scriptingHtml: sampleProfileHtml(),
      });
      installBackgroundMessenger('summary');
      const steps: string[] = [];
      const svc = new ProfileContextService();
      await svc.capture({ onProgress: (s) => steps.push(s) });
      // Capture starts with cache-check and ends with done.
      expect(steps[0]).toBe('cache-check');
      expect(steps).toContain('scraping');
      expect(steps).toContain('parsing');
      expect(steps[steps.length - 1]).toBe('done');
    });

    it.skip('accepts URLs with or without trailing slash, with or without www, with query/hash', async () => {
      const variants = [
        'https://www.linkedin.com/in/synthetic-me',
        'https://www.linkedin.com/in/synthetic-me/',
        'https://linkedin.com/in/synthetic-me/',
        'https://www.linkedin.com/in/synthetic-me/?miniProfileUrn=urn%3Ali%3Afsd_profile%3A123',
        'https://www.linkedin.com/in/synthetic-me/#contact',
      ];
      for (const url of variants) {
        installMemoryStorage();
        await seedProviderKey();
        installChromeTabsScriptingMocks({
          activeTabUrl: url,
          scriptingHtml: sampleProfileHtml(),
        });
        installBackgroundMessenger('summary');
        const svc = new ProfileContextService();
        const res = await svc.capture();
        expect(res.ok).toBe(true);
      }
    });

    it('does not scrape a deep /in/handle/details/skills/ tab — falls back to hidden /in/me/ tab', async () => {
      const { tabsCreate, executeScript } = installChromeTabsScriptingMocks({
        activeTabUrl: 'https://www.linkedin.com/in/synthetic-me/details/skills/',
        scriptingHtml: sampleProfileHtml(),
        failHiddenTabCreate: false,
      });
      const svc = new ProfileContextService();
      const res = await svc.capture();
      expect(res.ok).toBe(true);
      // Hidden tab MUST be opened (we did not use the deep-path tab).
      expect(tabsCreate).toHaveBeenCalledTimes(1);
      // Scrape script targets the hidden tab (id=999), not the deep-path active tab (id=42).
      expect(executeScript.mock.calls[0][0].target.tabId).toBe(999);
    });
  });

  describe('get() and shouldRefresh()', () => {
    it('get() returns null when no profile stored', async () => {
      const svc = new ProfileContextService();
      await expect(svc.get()).resolves.toBeNull();
    });

    it('get() returns the stored profile', async () => {
      const profile: ProfileContext = {
        fullName: 'Stored',
        headline: 'Stored headline',
        about: '',
        topSkills: [],
        recentPostThemes: [],
        positioningSummary: 'stored summary',
        capturedAt: Date.now(),
      };
      storage.set(STORAGE_KEYS.profile, profile);
      const svc = new ProfileContextService();
      await expect(svc.get()).resolves.toEqual(profile);
    });

    it('shouldRefresh() is true when no profile stored', async () => {
      const svc = new ProfileContextService();
      await expect(svc.shouldRefresh()).resolves.toBe(true);
    });

    it('shouldRefresh() is false when profile is < 30 days old', async () => {
      storage.set(STORAGE_KEYS.profile, {
        fullName: 'X',
        headline: '',
        about: '',
        topSkills: [],
        recentPostThemes: [],
        positioningSummary: '',
        capturedAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days
      });
      const svc = new ProfileContextService();
      await expect(svc.shouldRefresh()).resolves.toBe(false);
    });

    it('shouldRefresh() is true when profile is > 30 days old', async () => {
      storage.set(STORAGE_KEYS.profile, {
        fullName: 'X',
        headline: '',
        about: '',
        topSkills: [],
        recentPostThemes: [],
        positioningSummary: '',
        capturedAt: Date.now() - 31 * 24 * 60 * 60 * 1000, // 31 days
      });
      const svc = new ProfileContextService();
      await expect(svc.shouldRefresh()).resolves.toBe(true);
    });

    it('shouldRefresh() does NOT auto-trigger a capture (read-only check)', async () => {
      const { executeScript } = installChromeTabsScriptingMocks({
        activeTabUrl: 'https://www.linkedin.com/in/synthetic-me/',
        scriptingHtml: sampleProfileHtml(),
      });
      installBackgroundMessenger('summary');
      storage.set(STORAGE_KEYS.profile, {
        fullName: 'X',
        headline: '',
        about: '',
        topSkills: [],
        recentPostThemes: [],
        positioningSummary: '',
        capturedAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
      });
      const svc = new ProfileContextService();
      await svc.shouldRefresh();
      expect(executeScript).not.toHaveBeenCalled();
    });
  });
});
