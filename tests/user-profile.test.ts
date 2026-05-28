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
  profileContextFromUserProfile,
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

describe('profileContextFromUserProfile (issue #18 follow-up)', () => {
  it('maps the slim ProfileContext fields from the rich IDB UserProfile', () => {
    const up = fixture({
      name: 'Vasyl Vdovychenko',
      headline: 'Senior Engineer',
      about: 'Builder of AI in prod.',
      skills: ['TypeScript', 'AI', 'DevOps', 'Node.js'],
    });
    const ctx = profileContextFromUserProfile(up);
    expect(ctx.fullName).toBe('Vasyl Vdovychenko');
    expect(ctx.headline).toBe('Senior Engineer');
    expect(ctx.about).toBe('Builder of AI in prod.');
    expect(ctx.topSkills).toEqual(['TypeScript', 'AI', 'DevOps', 'Node.js']);
    expect(ctx.positioningSummary).toBe('');
    expect(ctx.recentPostThemes).toEqual([]);
  });

  it('parses capturedAt from ISO string to ms epoch', () => {
    const iso = '2026-01-15T10:00:00.000Z';
    const ctx = profileContextFromUserProfile(fixture({ capturedAt: iso }));
    expect(ctx.capturedAt).toBe(Date.parse(iso));
  });

  it('falls back to now() when capturedAt is unparseable', () => {
    const before = Date.now();
    const ctx = profileContextFromUserProfile(fixture({ capturedAt: 'not-a-date' }));
    expect(ctx.capturedAt).toBeGreaterThanOrEqual(before);
    expect(ctx.capturedAt).toBeLessThanOrEqual(Date.now() + 5);
  });

  it('caps topSkills at 10 and about at 1500 chars', () => {
    const skills = Array.from({ length: 20 }, (_, i) => `skill-${i}`);
    const longAbout = 'x'.repeat(3000);
    const ctx = profileContextFromUserProfile(fixture({ skills, about: longAbout }));
    expect(ctx.topSkills.length).toBe(10);
    expect(ctx.topSkills[0]).toBe('skill-0');
    expect(ctx.about.length).toBe(1500);
  });

  it('handles missing optional fields without throwing', () => {
    // about is optional in UserProfile schema.
    const up = fixture({ about: undefined });
    expect(() => profileContextFromUserProfile(up)).not.toThrow();
    expect(profileContextFromUserProfile(up).about).toBe('');
  });
});
