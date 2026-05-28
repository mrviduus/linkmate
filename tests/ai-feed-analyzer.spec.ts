/**
 * Issue #18 — AI feed analyzer.
 *
 * Drives `aiScoreBatch`, the strict-JSON parser, the cache (TTL, invalidation,
 * clearAiCache), and the AiParseError contract.
 */

import {
  AI_CACHE_TTL_MS,
  AiParseError,
  __testing__,
  aiScoreBatch,
  buildCacheKey,
  clearAiCache,
  djb2,
  parseAiScores,
  resolveGoals,
} from '../src/ai-feed-analyzer';
import type { UserProfile } from '../src/lib/idb';
import type { ParsedPost, ProfileContext } from '../src/storage-schema';
import type { InferenceProvider } from '../src/providers/inference-provider';

function fakeProvider(responses: string[]): InferenceProvider & { calls: number } {
  let i = 0;
  return {
    name: 'fake',
    isCloud: false,
    calls: 0,
    async generate() {
      this.calls += 1;
      const r = responses[i] ?? responses[responses.length - 1];
      i += 1;
      return r;
    },
  };
}

function profile(overrides: Partial<ProfileContext> = {}): ProfileContext {
  return {
    fullName: 'Vasyl',
    headline: 'Senior engineer',
    about: '',
    topSkills: ['TypeScript'],
    recentPostThemes: ['MCP'],
    positioningSummary: 'Senior engineer building AI in prod.',
    capturedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function post(id: string, text = 'sample'): ParsedPost {
  return {
    id,
    authorUrn: `urn:li:fsd_profile:${id}`,
    authorName: 'Alice',
    authorTitle: 'Eng',
    followerTier: '1k_10k',
    degree: '2nd',
    text,
    postedAt: Date.now(),
    likeCount: 1,
    commentCount: 0,
    isOwn: false,
  };
}

const validBatch = (...ids: string[]) =>
  JSON.stringify({
    scores: ids.map((id, i) => ({
      postId: id,
      aiScore: 5 + i,
      whyForYou: `because ${id}`,
    })),
  });

describe('pure helpers', () => {
  it('djb2 is deterministic and base-36', () => {
    expect(djb2('foo')).toBe(djb2('foo'));
    expect(djb2('foo')).not.toBe(djb2('bar'));
    expect(djb2('hello')).toMatch(/^[0-9a-z]+$/);
  });

  it('resolveGoals prefers override; falls back to positioningSummary', () => {
    expect(resolveGoals(profile({ positioningSummary: 'POS' }), '  ')).toBe('POS');
    expect(resolveGoals(profile({ positioningSummary: 'POS' }), 'GOAL')).toBe('GOAL');
    expect(resolveGoals(profile({ positioningSummary: 'POS' }), null)).toBe('POS');
  });

  it('buildCacheKey changes when capturedAt or goals change', () => {
    const p1 = profile({ capturedAt: 1 });
    const p2 = profile({ capturedAt: 2 });
    expect(buildCacheKey(p1, 'g')).not.toBe(buildCacheKey(p2, 'g'));
    expect(buildCacheKey(p1, 'g1')).not.toBe(buildCacheKey(p1, 'g2'));
  });

  it('buildCacheKey changes when the IDB UserProfile capturedAt changes', () => {
    const p = profile();
    const ub = (capturedAt: string): UserProfile => ({
      capturedAt,
      profileUrl: 'u',
      name: 'n',
      headline: 'h',
      skills: [],
      experience: [],
      education: [],
      recentPosts: [],
      recentComments: [],
    });
    expect(buildCacheKey(p, 'g', ub('2026-01-01T00:00:00Z'))).not.toBe(
      buildCacheKey(p, 'g', ub('2026-01-02T00:00:00Z')),
    );
    expect(buildCacheKey(p, 'g', null)).toBe(buildCacheKey(p, 'g', undefined));
  });
});

describe('parseAiScores', () => {
  const allowed = new Set(['urn:li:activity:1', 'urn:li:activity:2']);

  it('returns null on malformed JSON', () => {
    expect(parseAiScores('not json', allowed)).toBeNull();
    expect(parseAiScores('{}', allowed)).toBeNull();
  });

  it('drops entries whose postId is not in allowed set (anti-hallucination)', () => {
    const raw = JSON.stringify({
      scores: [
        { postId: 'urn:li:activity:1', aiScore: 8, whyForYou: 'ok' },
        { postId: 'urn:li:activity:HALLUC', aiScore: 9, whyForYou: 'bad' },
      ],
    });
    const out = parseAiScores(raw, allowed);
    expect(out).toHaveLength(1);
    expect(out![0].postId).toBe('urn:li:activity:1');
  });

  it('clamps aiScore into 0..10 and rounds to int', () => {
    const raw = JSON.stringify({
      scores: [
        { postId: 'urn:li:activity:1', aiScore: 99, whyForYou: 'over' },
        { postId: 'urn:li:activity:2', aiScore: -4.4, whyForYou: 'under' },
      ],
    });
    const out = parseAiScores(raw, allowed);
    expect(out!.find((s) => s.postId === 'urn:li:activity:1')!.aiScore).toBe(10);
    expect(out!.find((s) => s.postId === 'urn:li:activity:2')!.aiScore).toBe(0);
  });

  it('truncates whyForYou to 240 chars', () => {
    const long = 'x'.repeat(1000);
    const raw = JSON.stringify({
      scores: [{ postId: 'urn:li:activity:1', aiScore: 5, whyForYou: long }],
    });
    const out = parseAiScores(raw, allowed);
    expect(out![0].whyForYou.length).toBe(240);
  });

  it('drops entries with non-numeric or missing aiScore', () => {
    const raw = JSON.stringify({
      scores: [
        { postId: 'urn:li:activity:1', whyForYou: 'no score' },
        { postId: 'urn:li:activity:2', aiScore: 'seven', whyForYou: 'bad type' },
      ],
    });
    expect(parseAiScores(raw, allowed)).toBeNull();
  });

  it('deduplicates repeated postIds', () => {
    const raw = JSON.stringify({
      scores: [
        { postId: 'urn:li:activity:1', aiScore: 5, whyForYou: 'first' },
        { postId: 'urn:li:activity:1', aiScore: 9, whyForYou: 'second' },
      ],
    });
    const out = parseAiScores(raw, allowed);
    expect(out).toHaveLength(1);
    expect(out![0].aiScore).toBe(5);
  });
});

describe('aiScoreBatch — caching & invalidation', () => {
  beforeEach(() => {
    clearAiCache();
    __testing__.resetNow();
  });

  it('calls the provider once and caches subsequent identical requests', async () => {
    const provider = fakeProvider([validBatch('urn:li:activity:1', 'urn:li:activity:2')]);
    const posts = [post('urn:li:activity:1'), post('urn:li:activity:2')];
    const first = await aiScoreBatch({ provider, profile: profile(), goalsOverride: null, posts });
    expect(first).toHaveLength(2);
    expect(provider.calls).toBe(1);

    const second = await aiScoreBatch({ provider, profile: profile(), goalsOverride: null, posts });
    expect(second).toHaveLength(2);
    expect(provider.calls).toBe(1);
  });

  it('re-calls the provider only for uncached posts on partial overlap', async () => {
    const provider = fakeProvider([
      validBatch('urn:li:activity:1'),
      validBatch('urn:li:activity:2'),
    ]);
    await aiScoreBatch({
      provider,
      profile: profile(),
      goalsOverride: null,
      posts: [post('urn:li:activity:1')],
    });
    expect(provider.calls).toBe(1);
    const merged = await aiScoreBatch({
      provider,
      profile: profile(),
      goalsOverride: null,
      posts: [post('urn:li:activity:1'), post('urn:li:activity:2')],
    });
    expect(provider.calls).toBe(2);
    expect(merged.map((r) => r.postId).sort()).toEqual([
      'urn:li:activity:1',
      'urn:li:activity:2',
    ]);
  });

  it('invalidates cached entries after TTL expires', async () => {
    let now = 1_000_000_000;
    __testing__.setNow(() => now);
    const provider = fakeProvider([
      validBatch('urn:li:activity:1'),
      validBatch('urn:li:activity:1'),
    ]);
    await aiScoreBatch({
      provider,
      profile: profile(),
      goalsOverride: null,
      posts: [post('urn:li:activity:1')],
    });
    expect(provider.calls).toBe(1);
    now += AI_CACHE_TTL_MS + 1;
    await aiScoreBatch({
      provider,
      profile: profile(),
      goalsOverride: null,
      posts: [post('urn:li:activity:1')],
    });
    expect(provider.calls).toBe(2);
  });

  it('invalidates implicitly when goals change (different cache key)', async () => {
    const provider = fakeProvider([
      validBatch('urn:li:activity:1'),
      validBatch('urn:li:activity:1'),
    ]);
    const args = {
      provider,
      profile: profile(),
      posts: [post('urn:li:activity:1')],
    };
    await aiScoreBatch({ ...args, goalsOverride: 'A' });
    await aiScoreBatch({ ...args, goalsOverride: 'B' });
    expect(provider.calls).toBe(2);
  });

  it('clearAiCache drops everything', async () => {
    const provider = fakeProvider([
      validBatch('urn:li:activity:1'),
      validBatch('urn:li:activity:1'),
    ]);
    await aiScoreBatch({
      provider,
      profile: profile(),
      goalsOverride: null,
      posts: [post('urn:li:activity:1')],
    });
    expect(__testing__.cacheSize()).toBe(1);
    clearAiCache();
    expect(__testing__.cacheSize()).toBe(0);
    await aiScoreBatch({
      provider,
      profile: profile(),
      goalsOverride: null,
      posts: [post('urn:li:activity:1')],
    });
    expect(provider.calls).toBe(2);
  });

  it('throws AiParseError when the model returns garbage', async () => {
    const provider = fakeProvider(['not json at all']);
    await expect(
      aiScoreBatch({
        provider,
        profile: profile(),
        goalsOverride: null,
        posts: [post('urn:li:activity:1')],
      }),
    ).rejects.toBeInstanceOf(AiParseError);
  });

  it('returns empty array immediately for empty posts (no provider call)', async () => {
    const provider = fakeProvider([validBatch('urn:li:activity:1')]);
    const out = await aiScoreBatch({
      provider,
      profile: profile(),
      goalsOverride: null,
      posts: [],
    });
    expect(out).toEqual([]);
    expect(provider.calls).toBe(0);
  });

  it('re-calls the provider when the IDB UserProfile capturedAt changes', async () => {
    const provider = fakeProvider([
      validBatch('urn:li:activity:1'),
      validBatch('urn:li:activity:1'),
    ]);
    const baseUp: UserProfile = {
      capturedAt: '2026-01-01T00:00:00Z',
      profileUrl: 'u',
      name: 'n',
      headline: 'h',
      skills: ['TS'],
      experience: [],
      education: [],
      recentPosts: [],
      recentComments: [],
    };
    const args = {
      provider,
      profile: profile(),
      goalsOverride: null,
      posts: [post('urn:li:activity:1')],
    };
    await aiScoreBatch({ ...args, userProfile: baseUp });
    expect(provider.calls).toBe(1);
    await aiScoreBatch({ ...args, userProfile: { ...baseUp, capturedAt: '2026-02-01T00:00:00Z' } });
    expect(provider.calls).toBe(2);
  });
});

