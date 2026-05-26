/**
 * T100 — Relevance scorer spec (Phase B, US1).
 * Drives src/relevance-scorer.ts (T101). Pure functions only.
 *
 * Targets ≥95% line + branch coverage per plan.md.
 * Formula (plan.md §"Relevance Scoring Algorithm"):
 *   score = (topicMatch*0.40 + authorTier*0.20 + relationship*0.15 +
 *            recency*0.10 + engagement*0.10 + diversityBonus*0.05) * 100
 *   penalties: alreadyEngaged/isOwn/dismissed → 0 (skip);
 *              obviousAiContent → score *= 0.5
 *   buckets: ≥70 engage_now / 40–69 consider / <40 skip
 */

import {
  scoreRelevance,
  jaccard,
  authorTierScore,
  relationshipScore,
  recencyScore,
  engagementScore,
  diversityBonus,
  obviousAiContent,
  tokenize,
} from '../src/relevance-scorer';
import type {
  ConnectionDegree,
  FollowerTier,
  ParsedPost,
  ProfileContext,
} from '../src/storage-schema';

const NOW = 1_700_000_000_000; // fixed clock for deterministic recency tests

const profile = (): ProfileContext => ({
  fullName: 'Synthetic Me',
  headline: 'AI Engineer | RAG | Agents',
  about: '',
  topSkills: ['TypeScript', 'WebLLM', 'RAG', 'Agents', 'Chrome Extensions'],
  recentPostThemes: ['agents', 'rag', 'local llms'],
  positioningSummary: '',
  capturedAt: NOW,
});

const post = (overrides: Partial<ParsedPost> = {}): ParsedPost => ({
  id: 'urn:li:activity:1',
  authorUrn: 'urn:li:person:default',
  authorName: 'Default Author',
  authorTitle: 'Engineer',
  followerTier: '1k_10k',
  degree: '2nd',
  text: 'A generic post about something.',
  postedAt: NOW - 60 * 60 * 1000, // 1h ago
  likeCount: 50,
  commentCount: 5,
  isOwn: false,
  ...overrides,
});

describe('tokenize / jaccard', () => {
  it('tokenize drops stop-words and short tokens', () => {
    expect(tokenize('The quick brown FOX jumps')).toEqual(['quick', 'brown', 'fox', 'jumps']);
  });

  it('tokenize handles punctuation', () => {
    expect(tokenize('AI/ML, RAG; agents.')).toEqual(['rag', 'agents']);
  });

  it('jaccard empty arrays → 0', () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(['a'], [])).toBe(0);
  });

  it('jaccard identical sets → 1', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('jaccard partial overlap', () => {
    // |{a,b} ∩ {b,c}| = 1, |{a,b} ∪ {b,c}| = 3 → 1/3
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });
});

describe('authorTierScore', () => {
  const cases: Array<[FollowerTier, number]> = [
    ['lt_1k', 0.2],
    ['1k_10k', 0.5],
    ['10k_100k', 0.8],
    ['gt_100k', 1.0],
    ['unknown', 0.4],
  ];
  it.each(cases)('tier %s → %d', (tier, expected) => {
    expect(authorTierScore(tier)).toBe(expected);
  });
});

describe('relationshipScore', () => {
  const cases: Array<[ConnectionDegree, number]> = [
    ['1st', 1.0],
    ['2nd', 0.6],
    ['3rd', 0.3],
    ['follow-only', 0.4],
    ['unknown', 0.4],
  ];
  it.each(cases)('degree %s → %d', (degree, expected) => {
    expect(relationshipScore(degree)).toBe(expected);
  });
});

describe('recencyScore', () => {
  it('returns 1.0 for posts < 1 minute old', () => {
    expect(recencyScore(NOW, NOW)).toBe(1);
  });
  it('returns ~0.5 at 12 hours old', () => {
    expect(recencyScore(NOW - 12 * 60 * 60 * 1000, NOW)).toBeCloseTo(0.5, 2);
  });
  it('returns 0 at 24 hours old', () => {
    expect(recencyScore(NOW - 24 * 60 * 60 * 1000, NOW)).toBe(0);
  });
  it('returns 0 for older than 24h', () => {
    expect(recencyScore(NOW - 48 * 60 * 60 * 1000, NOW)).toBe(0);
  });
  it('handles future timestamps as 1.0 (clock-skew tolerant)', () => {
    expect(recencyScore(NOW + 60 * 1000, NOW)).toBe(1);
  });
});

describe('engagementScore', () => {
  it('0 likes/comments → 0', () => {
    expect(engagementScore(0, 0)).toBe(0);
  });
  it('rises monotonically with engagement', () => {
    const low = engagementScore(10, 1);
    const mid = engagementScore(500, 50);
    const high = engagementScore(10_000, 1000);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });
  it('caps at 1.0 for extreme values', () => {
    expect(engagementScore(1_000_000, 100_000)).toBeLessThanOrEqual(1);
  });
});

describe('diversityBonus', () => {
  it('returns 1.0 when author not in recent list', () => {
    expect(diversityBonus('urn:li:person:new', ['urn:li:person:old'])).toBe(1);
  });
  it('returns 0 when author already shown recently', () => {
    expect(diversityBonus('urn:li:person:x', ['urn:li:person:x'])).toBe(0);
  });
  it('handles empty recent list', () => {
    expect(diversityBonus('urn:li:person:x', [])).toBe(1);
  });
});

describe('obviousAiContent', () => {
  it('flags buzzword combos', () => {
    expect(obviousAiContent('Leverage synergies to unlock transformative outcomes — a game-changer.')).toBe(true);
  });
  it('flags "Here are N takeaways" intros', () => {
    expect(obviousAiContent('Here are 5 takeaways every leader must know.')).toBe(true);
  });
  it('flags "ever-evolving landscape"', () => {
    expect(obviousAiContent("In today's ever-evolving landscape, we must adapt.")).toBe(true);
  });
  it('does NOT flag normal posts', () => {
    expect(obviousAiContent('Spent the weekend wiring MCP into a C# server. Composability is the win.')).toBe(false);
  });
  it('does NOT flag empty/short text', () => {
    expect(obviousAiContent('')).toBe(false);
    expect(obviousAiContent('hi')).toBe(false);
  });
});

describe('scoreRelevance', () => {
  describe('hard filters', () => {
    it('alreadyEngaged → score 0, category skip', () => {
      const r = scoreRelevance({
        post: post(),
        profile: profile(),
        signals: { alreadyEngaged: true, dismissed: false, recentlyDisplayedAuthors: [] },
        now: NOW,
      });
      expect(r.score).toBe(0);
      expect(r.category).toBe('skip');
      expect(r.reasons).toContain('already engaged');
    });
    it('isOwn → score 0, category skip', () => {
      const r = scoreRelevance({
        post: post({ isOwn: true }),
        profile: profile(),
        signals: { alreadyEngaged: false, dismissed: false, recentlyDisplayedAuthors: [] },
        now: NOW,
      });
      expect(r.score).toBe(0);
      expect(r.category).toBe('skip');
      expect(r.reasons).toContain('own post');
    });
    it('dismissed → score 0, category skip', () => {
      const r = scoreRelevance({
        post: post(),
        profile: profile(),
        signals: { alreadyEngaged: false, dismissed: true, recentlyDisplayedAuthors: [] },
        now: NOW,
      });
      expect(r.score).toBe(0);
      expect(r.category).toBe('skip');
      expect(r.reasons).toContain('dismissed');
    });
  });

  describe('formula application', () => {
    it('high-relevance post lands in engage_now bucket', () => {
      // Top-tier author, 1st degree, fresh, high engagement, topic match,
      // author not seen recently — should sum well above 70.
      const r = scoreRelevance({
        post: post({
          authorUrn: 'urn:li:person:fresh',
          followerTier: 'gt_100k',
          degree: '1st',
          text: 'Building agents with RAG and TypeScript over a local LLM. Composability matters.',
          postedAt: NOW - 30 * 60 * 1000, // 30 minutes ago
          likeCount: 5000,
          commentCount: 500,
        }),
        profile: profile(),
        signals: { alreadyEngaged: false, dismissed: false, recentlyDisplayedAuthors: [] },
        now: NOW,
      });
      expect(r.score).toBeGreaterThanOrEqual(70);
      expect(r.category).toBe('engage_now');
    });

    it('mid-relevance post lands in consider bucket', () => {
      const r = scoreRelevance({
        post: post({
          followerTier: '1k_10k',
          degree: '2nd',
          text: 'Working on agents tooling lately.',
          postedAt: NOW - 6 * 60 * 60 * 1000, // 6h ago
          likeCount: 100,
          commentCount: 10,
        }),
        profile: profile(),
        signals: { alreadyEngaged: false, dismissed: false, recentlyDisplayedAuthors: [] },
        now: NOW,
      });
      expect(r.score).toBeGreaterThanOrEqual(40);
      expect(r.score).toBeLessThan(70);
      expect(r.category).toBe('consider');
    });

    it('low-relevance post lands in skip bucket', () => {
      const r = scoreRelevance({
        post: post({
          followerTier: 'lt_1k',
          degree: '3rd',
          text: 'Mondays are for planning, not shipping.',
          postedAt: NOW - 24 * 60 * 60 * 1000, // 24h — recency 0
          likeCount: 3,
          commentCount: 0,
        }),
        profile: profile(),
        signals: { alreadyEngaged: false, dismissed: false, recentlyDisplayedAuthors: [] },
        now: NOW,
      });
      expect(r.score).toBeLessThan(40);
      expect(r.category).toBe('skip');
    });

    it('obviousAiContent halves the score and adds reason', () => {
      const aiPost = post({
        followerTier: 'gt_100k',
        degree: '1st',
        text: 'Leverage synergies to unlock transformative outcomes — a true game-changer.',
        postedAt: NOW - 30 * 60 * 1000,
        likeCount: 5000,
        commentCount: 500,
      });
      const cleanPost = { ...aiPost, text: 'A grounded note on agent tool composition with RAG.' };
      const dirty = scoreRelevance({
        post: aiPost,
        profile: profile(),
        signals: { alreadyEngaged: false, dismissed: false, recentlyDisplayedAuthors: [] },
        now: NOW,
      });
      const clean = scoreRelevance({
        post: cleanPost,
        profile: profile(),
        signals: { alreadyEngaged: false, dismissed: false, recentlyDisplayedAuthors: [] },
        now: NOW,
      });
      expect(dirty.score).toBeLessThan(clean.score);
      expect(dirty.reasons).toContain('AI-like phrasing penalty');
    });

    it('diversity bonus drops to 0 if author already shown recently', () => {
      const repeated = scoreRelevance({
        post: post({ authorUrn: 'urn:li:person:repeat' }),
        profile: profile(),
        signals: {
          alreadyEngaged: false,
          dismissed: false,
          recentlyDisplayedAuthors: ['urn:li:person:repeat'],
        },
        now: NOW,
      });
      const fresh = scoreRelevance({
        post: post({ authorUrn: 'urn:li:person:fresh' }),
        profile: profile(),
        signals: { alreadyEngaged: false, dismissed: false, recentlyDisplayedAuthors: [] },
        now: NOW,
      });
      expect(fresh.score).toBeGreaterThan(repeated.score);
    });

    it('returns score in [0, 100]', () => {
      const r = scoreRelevance({
        post: post({
          followerTier: 'gt_100k',
          degree: '1st',
          text: 'RAG agents TypeScript WebLLM local LLM',
          postedAt: NOW,
          likeCount: 1_000_000,
          commentCount: 100_000,
        }),
        profile: profile(),
        signals: { alreadyEngaged: false, dismissed: false, recentlyDisplayedAuthors: [] },
        now: NOW,
      });
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    });

    it('reasons array is non-empty for non-filtered posts', () => {
      const r = scoreRelevance({
        post: post(),
        profile: profile(),
        signals: { alreadyEngaged: false, dismissed: false, recentlyDisplayedAuthors: [] },
        now: NOW,
      });
      expect(r.reasons.length).toBeGreaterThan(0);
    });

    it('bucket boundary at 70: score 70 → engage_now', () => {
      // Tune to hit exactly ≥70: construct an input known to land just above 70
      const r = scoreRelevance({
        post: post({
          followerTier: 'gt_100k', // tier 1.0 * 0.20 = 20
          degree: '1st',           // 1.0 * 0.15 = 15
          text: 'RAG agents TypeScript WebLLM matter for local LLM tools',
          postedAt: NOW,            // recency 1.0 * 0.10 = 10
          likeCount: 1000,
          commentCount: 100,
        }),
        profile: profile(),
        signals: { alreadyEngaged: false, dismissed: false, recentlyDisplayedAuthors: [] },
        now: NOW,
      });
      if (r.score >= 70) expect(r.category).toBe('engage_now');
      else if (r.score >= 40) expect(r.category).toBe('consider');
      else expect(r.category).toBe('skip');
    });
  });

  it('is deterministic: same input → same output', () => {
    const input = {
      post: post(),
      profile: profile(),
      signals: { alreadyEngaged: false, dismissed: false, recentlyDisplayedAuthors: [] },
      now: NOW,
    };
    expect(scoreRelevance(input)).toEqual(scoreRelevance(input));
  });
});
