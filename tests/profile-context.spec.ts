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

function installChromeTabsScriptingMocks(opts: {
  activeTabUrl: string;
  activeTabId?: number;
  /** HTML string the injected `document.documentElement.outerHTML` returns. */
  scriptingHtml?: string;
  scriptingThrows?: boolean;
}) {
  const tabsQuery = jest.fn().mockResolvedValue([
    { id: opts.activeTabId ?? 42, url: opts.activeTabUrl, active: true, currentWindow: true },
  ]);
  (chrome.tabs.query as jest.Mock) = tabsQuery;

  const executeScript = jest.fn().mockImplementation(async () => {
    if (opts.scriptingThrows) throw new Error('script injection failed');
    return [{ result: opts.scriptingHtml ?? null, frameId: 0 }];
  });
  (chrome as unknown as { scripting: { executeScript: jest.Mock } }).scripting = {
    executeScript,
  };

  return { tabsQuery, executeScript };
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
    it('refuses when active tab is not on a /in/ URL', async () => {
      installChromeTabsScriptingMocks({ activeTabUrl: 'https://www.linkedin.com/feed/' });
      const svc = new ProfileContextService();
      const res = await svc.capture();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('not-on-profile');
    });

    it('refuses when there is no active tab', async () => {
      (chrome.tabs.query as jest.Mock) = jest.fn().mockResolvedValue([]);
      const svc = new ProfileContextService();
      const res = await svc.capture();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('no-active-tab');
    });

    it('calls executeScript exactly once with the active tab id and a func payload', async () => {
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

    it('persists ProfileContext when background returns a positioningSummary', async () => {
      installChromeTabsScriptingMocks({
        activeTabUrl: 'https://www.linkedin.com/in/synthetic-me/',
        scriptingHtml: sampleProfileHtml(),
      });
      installBackgroundMessenger('AI engineer focused on local-first agents.');

      const svc = new ProfileContextService();
      const res = await svc.capture();

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.profile.fullName).toBe('Synthetic Me');
        expect(res.profile.positioningSummary).toBe(
          'AI engineer focused on local-first agents.',
        );
        expect(res.profile.capturedAt).toBeGreaterThan(0);
      }
      // Persisted to storage under the v1 key
      expect(storage.get(STORAGE_KEYS.profile)).toBeDefined();
    });

    it('returns script-failed if executeScript throws', async () => {
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

    it('returns summary-failed if background returns an error', async () => {
      installChromeTabsScriptingMocks({
        activeTabUrl: 'https://www.linkedin.com/in/synthetic-me/',
        scriptingHtml: sampleProfileHtml(),
      });
      installBackgroundMessenger({ error: 'webllm not ready' });
      const svc = new ProfileContextService();
      const res = await svc.capture();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('summary-failed');
    });

    it('accepts URLs with or without trailing slash, with or without www, with query/hash', async () => {
      const variants = [
        'https://www.linkedin.com/in/synthetic-me',
        'https://www.linkedin.com/in/synthetic-me/',
        'https://linkedin.com/in/synthetic-me/',
        'https://www.linkedin.com/in/synthetic-me/?miniProfileUrn=urn%3Ali%3Afsd_profile%3A123',
        'https://www.linkedin.com/in/synthetic-me/#contact',
      ];
      for (const url of variants) {
        installMemoryStorage();
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

    it('rejects deep /in/ paths (e.g. /in/handle/details/...) — only canonical profile URL', async () => {
      installChromeTabsScriptingMocks({
        activeTabUrl: 'https://www.linkedin.com/in/synthetic-me/details/skills/',
        scriptingHtml: sampleProfileHtml(),
      });
      const svc = new ProfileContextService();
      const res = await svc.capture();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('not-on-profile');
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
