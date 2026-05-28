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
  mergeUserProfile,
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

describe('mergeUserProfile', () => {
  const post = (id: string, text = `post-${id}`, likes = 0) => ({
    id,
    text,
    timestamp: '1d',
    engagement: { likes, comments: 0, reposts: 0 },
    isRepost: false,
  });
  const comment = (id: string, text = `c-${id}`) => ({
    id,
    text,
    timestamp: '1d',
    originalPostText: 'parent',
    originalAuthor: 'Author',
  });

  it('returns fresh untouched when no existing snapshot', () => {
    const fresh = fixture({ recentPosts: [post('A')] });
    const merged = mergeUserProfile(null, fresh);
    expect(merged).toBe(fresh);
  });

  it('fresh entry wins on duplicate URN (fresher engagement)', () => {
    const existing = fixture({ recentPosts: [post('A', 'old', 5)] });
    const fresh = fixture({ recentPosts: [post('A', 'new', 99)] });
    const merged = mergeUserProfile(existing, fresh);
    expect(merged.recentPosts).toHaveLength(1);
    expect(merged.recentPosts[0].text).toBe('new');
    expect(merged.recentPosts[0].engagement?.likes).toBe(99);
  });

  it('preserves old entries not present in fresh scrape', () => {
    const existing = fixture({ recentPosts: [post('A'), post('B'), post('C')] });
    const fresh = fixture({ recentPosts: [post('A')] });
    const merged = mergeUserProfile(existing, fresh);
    const ids = merged.recentPosts.map((p) => p.id);
    expect(ids).toEqual(['A', 'B', 'C']);
  });

  it('fresh items appear before leftover old items', () => {
    const existing = fixture({ recentPosts: [post('X'), post('Y')] });
    const fresh = fixture({ recentPosts: [post('Z'), post('X')] });
    const merged = mergeUserProfile(existing, fresh);
    expect(merged.recentPosts.map((p) => p.id)).toEqual(['Z', 'X', 'Y']);
  });

  it('merges recentComments by URN the same way', () => {
    const existing = fixture({ recentComments: [comment('1'), comment('2')] });
    const fresh = fixture({ recentComments: [comment('2', 'updated'), comment('3')] });
    const merged = mergeUserProfile(existing, fresh);
    expect(merged.recentComments.map((c) => c.id)).toEqual(['2', '3', '1']);
    expect(merged.recentComments[0].text).toBe('updated');
  });

  it('non-array fields take from fresh', () => {
    const existing = fixture({ name: 'Old Name', headline: 'Old' });
    const fresh = fixture({ name: 'New Name', headline: 'New' });
    const merged = mergeUserProfile(existing, fresh);
    expect(merged.name).toBe('New Name');
    expect(merged.headline).toBe('New');
  });

  it('drops entries with empty id', () => {
    const existing = fixture({ recentPosts: [post('')] });
    const fresh = fixture({ recentPosts: [post(''), post('A')] });
    const merged = mergeUserProfile(existing, fresh);
    expect(merged.recentPosts.map((p) => p.id)).toEqual(['A']);
  });
});
