/**
 * T307 — chrome.storage.local footprint after 90 days simulated.
 *
 * Seeds the v0.4.0 storage shape (profile + engaged + dismissed + ssi history +
 * connections + prefs + schemaVersion), serializes to JSON, and confirms total
 * bytes are well under the 5 MB performance budget (Constitution v1.1 §V).
 *
 * Hard quota for chrome.storage.local is 10 MB — we leave headroom.
 */

import {
  setProfile,
  appendSsiSnapshot,
  markEngaged,
  addDismissedPostId,
  STORAGE_KEYS,
  MAX_SSI_SNAPSHOTS,
} from '../src/storage-schema';
import type { ConnectionSuggestion, QueuePreferences } from '../src/storage-schema';

const STORAGE_BUDGET_BYTES = 5 * 1024 * 1024; // 5 MB
const REASONABLE_UPPER_BOUND = 200 * 1024;     // 200 KB — comfortable expectation per data-model.md

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

describe('storage footprint (T307)', () => {
  it('worst-case 90 days of simulated state stays under the 5 MB budget', async () => {
    const store = installMemoryStorage();
    const now = 1_700_000_000_000;
    const oneDay = 24 * 60 * 60 * 1000;

    // 1. Profile with realistic content lengths
    await setProfile({
      fullName: 'Synthetic Subject',
      headline: 'AI Engineer | RAG | Agents | TypeScript | WebLLM',
      about:
        'Builder of local-first AI systems. '.repeat(50).slice(0, 1500), // exactly cap
      topSkills: Array.from({ length: 10 }, (_, i) => `Synthetic Skill ${i + 1}`),
      recentPostThemes: Array.from({ length: 5 }, (_, i) => `Theme ${i}: short summary text`),
      positioningSummary:
        'Synthetic engineer focused on local-first LLM apps and tool-using agents. ' +
        'Distinct angle: privacy-first inference inside an existing product surface.',
      capturedAt: now,
    });

    // 2. 90 daily SSI snapshots
    for (let i = 0; i < MAX_SSI_SNAPSHOTS; i++) {
      await appendSsiSnapshot({
        total: 18 + (i % 30),
        components: {
          establishBrand: 5 + (i % 6),
          findRightPeople: 4 + (i % 5),
          engageWithInsights: i % 7,
          buildRelationships: 5 + (i % 4),
        },
        industryRank: `You rank in the top ${85 - (i % 30)}% of your industry.`,
        networkRank: `You rank in the top ${90 - (i % 30)}% of your network.`,
        capturedAt: now - (MAX_SSI_SNAPSHOTS - i) * oneDay,
      });
    }

    // 3. 250 engaged posts (8/day * 30-day TTL window — upper bound before eviction)
    for (let i = 0; i < 250; i++) {
      await markEngaged(`urn:li:activity:${7_000_000_000_000_000 + i}`);
    }

    // 4. 500 dismissed post IDs
    for (let i = 0; i < 500; i++) {
      await addDismissedPostId(`urn:li:activity:${8_000_000_000_000_000 + i}`);
    }

    // 5. Connection suggestions — 7-day history × 5/day = 35
    const suggestions: ConnectionSuggestion[] = Array.from({ length: 35 }, (_, i) => ({
      profileUrl: `https://www.linkedin.com/in/synthetic-target-${i}/`,
      name: `Synthetic Target ${i}`,
      title: 'AI Talent Lead at Placeholder Co — building ML teams',
      company: 'Placeholder Co',
      personalizedNote:
        'Saw your post about hiring ML engineers — your framing of evaluation harnesses ' +
        'as the bottleneck matches what we discussed at the meetup last quarter.',
      suggestedAt: now - i * oneDay,
      status: 'pending',
    }));
    await chrome.storage.local.set({
      [STORAGE_KEYS.connectionsSuggestions]: suggestions,
      [STORAGE_KEYS.connectionsDraftedThisWeek]: 42,
    });

    // 6. Preferences + schema version
    const prefs: QueuePreferences = {
      defaultTone: 'friendly',
      defaultLength: 'standard',
      autoRefreshMinutes: 5,
      sidebarPosition: { top: 80, right: 16 },
    };
    await chrome.storage.local.set({
      [STORAGE_KEYS.queuePreferences]: prefs,
      [STORAGE_KEYS.schemaVersion]: 1,
    });

    // Measure: serialize the entire store and check byte length.
    const all: Record<string, unknown> = {};
    for (const [k, v] of store.entries()) all[k] = v;
    const bytes = Buffer.byteLength(JSON.stringify(all), 'utf8');

    // Sanity log so future-you can read the actual number when this test runs
    // (`--silent` hides this in CI; that's fine — assertions still gate).
    // eslint-disable-next-line no-console
    console.log(`📦 Worst-case storage footprint: ${(bytes / 1024).toFixed(1)} KB`);

    expect(bytes).toBeLessThan(STORAGE_BUDGET_BYTES);
    // Tighter expected bound from data-model.md: should comfortably fit in 200 KB.
    expect(bytes).toBeLessThan(REASONABLE_UPPER_BOUND);
  });
});
