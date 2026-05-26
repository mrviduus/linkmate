/**
 * T010 — Storage schema spec (Phase A foundation).
 * Drives the API in src/storage-schema.ts (T011).
 */

import {
  SCHEMA_VERSION,
  STORAGE_KEYS,
  getProfile,
  setProfile,
  getSsiHistory,
  appendSsiSnapshot,
  getEngagedPosts,
  markEngaged,
  isEngaged,
  migrateIfNeeded,
  MAX_SSI_SNAPSHOTS,
  ENGAGED_POST_TTL_MS,
} from '../src/storage-schema';
import type {
  ProfileContext,
  SsiSnapshot,
  EngagedPost,
} from '../src/storage-schema';

// Minimal in-memory chrome.storage.local mock — replaces the bare jest.fn() in tests/setup.ts.
function installMemoryStorage() {
  const store = new Map<string, unknown>();

  (chrome.storage.local.get as jest.Mock).mockImplementation(
    (keys: string | string[] | null, cb?: (v: Record<string, unknown>) => void) => {
      const resolveKeys =
        keys === null || keys === undefined
          ? Array.from(store.keys())
          : Array.isArray(keys)
            ? keys
            : [keys];
      const out: Record<string, unknown> = {};
      for (const k of resolveKeys) {
        if (store.has(k)) out[k] = store.get(k);
      }
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

  (chrome.storage.local.remove as jest.Mock).mockImplementation(
    (keys: string | string[], cb?: () => void) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
      if (cb) cb();
      return Promise.resolve();
    },
  );

  return store;
}

const sampleProfile = (): ProfileContext => ({
  fullName: 'Test User',
  headline: 'AI Engineer | RAG | Agents',
  about: 'Builder of LLM systems.',
  topSkills: ['TypeScript', 'Python', 'WebLLM'],
  recentPostThemes: ['agents', 'rag'],
  positioningSummary: 'I help teams ship local-first AI features.',
  capturedAt: 1_700_000_000_000,
});

const sampleSnapshot = (capturedAt: number, total = 23): SsiSnapshot => ({
  total,
  components: {
    establishBrand: 5,
    findRightPeople: 6,
    engageWithInsights: 7,
    buildRelationships: 5,
  },
  industryRank: 'Top 75%',
  networkRank: 'Top 88%',
  capturedAt,
});

describe('storage-schema (T010)', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  describe('SCHEMA_VERSION', () => {
    it('exports a positive integer constant', () => {
      expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    });

    it('exposes versioned storage keys with linkmate. prefix', () => {
      for (const key of Object.values(STORAGE_KEYS)) {
        expect(key).toMatch(/^linkmate\./);
      }
    });
  });

  describe('getProfile / setProfile', () => {
    it('returns null when nothing stored', async () => {
      await expect(getProfile()).resolves.toBeNull();
    });

    it('round-trips a ProfileContext through set then get', async () => {
      const p = sampleProfile();
      await setProfile(p);
      await expect(getProfile()).resolves.toEqual(p);
    });

    it('overwrites prior profile on second set', async () => {
      await setProfile(sampleProfile());
      const updated: ProfileContext = { ...sampleProfile(), headline: 'New headline' };
      await setProfile(updated);
      const got = await getProfile();
      expect(got?.headline).toBe('New headline');
    });
  });

  describe('appendSsiSnapshot / getSsiHistory', () => {
    it('starts empty', async () => {
      await expect(getSsiHistory()).resolves.toEqual([]);
    });

    it('appends in insertion order', async () => {
      await appendSsiSnapshot(sampleSnapshot(1000, 20));
      await appendSsiSnapshot(sampleSnapshot(2000, 25));
      const history = await getSsiHistory();
      expect(history.map((s) => s.capturedAt)).toEqual([1000, 2000]);
    });

    it('evicts oldest beyond MAX_SSI_SNAPSHOTS cap', async () => {
      for (let i = 0; i < MAX_SSI_SNAPSHOTS + 5; i++) {
        await appendSsiSnapshot(sampleSnapshot(i + 1, 30));
      }
      const history = await getSsiHistory();
      expect(history).toHaveLength(MAX_SSI_SNAPSHOTS);
      // Oldest 5 should be gone; first remaining is snapshot at capturedAt=6
      expect(history[0].capturedAt).toBe(6);
      expect(history[history.length - 1].capturedAt).toBe(MAX_SSI_SNAPSHOTS + 5);
    });
  });

  describe('markEngaged / getEngagedPosts / isEngaged', () => {
    it('starts empty', async () => {
      await expect(getEngagedPosts()).resolves.toEqual([]);
    });

    it('records postId with engagedAt=now and expiresAt=now+TTL', async () => {
      const before = Date.now();
      await markEngaged('post-1');
      const after = Date.now();

      const engaged = await getEngagedPosts();
      expect(engaged).toHaveLength(1);
      const [e]: EngagedPost[] = engaged;
      expect(e.postId).toBe('post-1');
      expect(e.engagedAt).toBeGreaterThanOrEqual(before);
      expect(e.engagedAt).toBeLessThanOrEqual(after);
      expect(e.expiresAt - e.engagedAt).toBe(ENGAGED_POST_TTL_MS);
    });

    it('isEngaged returns true for an active mark, false for unknown', async () => {
      await markEngaged('post-active');
      await expect(isEngaged('post-active')).resolves.toBe(true);
      await expect(isEngaged('post-missing')).resolves.toBe(false);
    });

    it('filters out expired entries from getEngagedPosts and isEngaged', async () => {
      // Seed an expired entry directly via storage write
      const expired: EngagedPost = {
        postId: 'post-stale',
        engagedAt: Date.now() - ENGAGED_POST_TTL_MS - 1000,
        expiresAt: Date.now() - 1000,
      };
      const fresh: EngagedPost = {
        postId: 'post-fresh',
        engagedAt: Date.now(),
        expiresAt: Date.now() + ENGAGED_POST_TTL_MS,
      };
      await chrome.storage.local.set({
        [STORAGE_KEYS.queueEngaged]: [expired, fresh],
      });

      const visible = await getEngagedPosts();
      expect(visible.map((e: EngagedPost) => e.postId)).toEqual(['post-fresh']);
      await expect(isEngaged('post-stale')).resolves.toBe(false);
      await expect(isEngaged('post-fresh')).resolves.toBe(true);
    });
  });

  describe('migrateIfNeeded', () => {
    it('sets schemaVersion on first run (no stored version)', async () => {
      await migrateIfNeeded();
      const stored = (await chrome.storage.local.get(STORAGE_KEYS.schemaVersion) as unknown) as Record<string, unknown>;
      expect(stored[STORAGE_KEYS.schemaVersion]).toBe(SCHEMA_VERSION);
    });

    it('is idempotent when stored version === SCHEMA_VERSION', async () => {
      await chrome.storage.local.set({ [STORAGE_KEYS.schemaVersion]: SCHEMA_VERSION });
      await expect(migrateIfNeeded()).resolves.not.toThrow();
      const stored = (await chrome.storage.local.get(STORAGE_KEYS.schemaVersion) as unknown) as Record<string, unknown>;
      expect(stored[STORAGE_KEYS.schemaVersion]).toBe(SCHEMA_VERSION);
    });

    it('bumps stored version when older version detected', async () => {
      await chrome.storage.local.set({ [STORAGE_KEYS.schemaVersion]: 0 });
      await migrateIfNeeded();
      const stored = (await chrome.storage.local.get(STORAGE_KEYS.schemaVersion) as unknown) as Record<string, unknown>;
      expect(stored[STORAGE_KEYS.schemaVersion]).toBe(SCHEMA_VERSION);
    });
  });
});
