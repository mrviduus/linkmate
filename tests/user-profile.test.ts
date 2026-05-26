/**
 * Issue #16 — user-profile-store smoke test.
 *
 * IndexedDB is not available in jsdom, so we mock src/lib/idb.getDb with an
 * in-memory Map. The contract under test: saveUserProfile → getUserProfile
 * returns the same object; clearUserProfile makes get return null; isFresh
 * respects the 24h TTL.
 */

const memStore = new Map<string, unknown>();

jest.mock('../src/lib/idb', () => ({
  getDb: jest.fn(async () => ({
    put: async (_store: string, value: unknown, key: string) => {
      memStore.set(key, value);
    },
    get: async (_store: string, key: string) => memStore.get(key),
    delete: async (_store: string, key: string) => {
      memStore.delete(key);
    },
  })),
}));

import type { UserProfile } from '../src/lib/idb';
import {
  clearUserProfile,
  getUserProfile,
  isFresh,
  saveUserProfile,
  USER_PROFILE_TTL_MS,
} from '../src/user-profile-store';

function fixture(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    capturedAt: new Date().toISOString(),
    profileUrl: 'https://www.linkedin.com/in/test/',
    name: 'Test User',
    headline: 'Builder',
    skills: ['TypeScript'],
    experience: [],
    education: [],
    recentPosts: [],
    recentComments: [],
    ...overrides,
  };
}

beforeEach(() => {
  memStore.clear();
});

describe('user-profile-store', () => {
  it('save → get returns the same profile', async () => {
    const p = fixture({ name: 'Vasyl' });
    await saveUserProfile(p);
    const back = await getUserProfile();
    expect(back).not.toBeNull();
    expect(back?.name).toBe('Vasyl');
    expect(back?.skills).toEqual(['TypeScript']);
  });

  it('overwrite under fixed key "current"', async () => {
    await saveUserProfile(fixture({ name: 'A' }));
    await saveUserProfile(fixture({ name: 'B' }));
    const back = await getUserProfile();
    expect(back?.name).toBe('B');
  });

  it('clear removes the snapshot', async () => {
    await saveUserProfile(fixture());
    await clearUserProfile();
    expect(await getUserProfile()).toBeNull();
  });

  it('isFresh true for now, false past TTL', () => {
    const fresh = fixture({ capturedAt: new Date().toISOString() });
    expect(isFresh(fresh)).toBe(true);

    const stale = fixture({
      capturedAt: new Date(Date.now() - USER_PROFILE_TTL_MS - 1000).toISOString(),
    });
    expect(isFresh(stale)).toBe(false);
  });
});
