/**
 * Issue #64 — scoring evals against a labeled golden dataset.
 *
 * Each golden post carries expectMin/expectMax bounds on scoreRelevance().score.
 * The Feldera case (stale + promo + topical) is the headline regression:
 * topically perfect yet must land ≤ 50/100 so it never reaches "engage_now".
 */

import * as fs from 'fs';
import * as path from 'path';
import { scoreRelevance } from '../src/relevance-scorer';
import type {
  ConnectionDegree,
  FollowerTier,
  ParsedPost,
  ProfileContext,
} from '../src/storage-schema';

const NOW = 1_700_000_000_000;

interface GoldenPost {
  id: string;
  text: string;
  ageHours: number;
  followerTier: FollowerTier;
  degree: ConnectionDegree;
  likeCount: number;
  commentCount: number;
  isOwn?: boolean;
  dismissed?: boolean;
  alreadyEngaged?: boolean;
  labels: { topicalRelevance: string; commentWorthy: boolean; failureMode: string };
  expectMin?: number;
  expectMax?: number;
}

interface Golden {
  profile: { topSkills: string[]; recentPostThemes: string[] };
  posts: GoldenPost[];
}

const golden: Golden = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'golden-posts.json'), 'utf-8')
);

const profile: ProfileContext = {
  fullName: 'Eval Profile',
  headline: 'AI Engineer',
  about: '',
  topSkills: golden.profile.topSkills,
  recentPostThemes: golden.profile.recentPostThemes,
  positioningSummary: '',
  capturedAt: NOW,
};

function toParsedPost(g: GoldenPost): ParsedPost {
  return {
    id: g.id,
    authorUrn: `urn:li:person:${g.id}`,
    authorName: 'Author',
    authorTitle: 'Engineer',
    followerTier: g.followerTier,
    degree: g.degree,
    text: g.text,
    postedAt: NOW - g.ageHours * 60 * 60 * 1000,
    likeCount: g.likeCount,
    commentCount: g.commentCount,
    isOwn: g.isOwn ?? false,
  };
}

function scoreOf(g: GoldenPost): number {
  return scoreRelevance({
    post: toParsedPost(g),
    profile,
    signals: {
      alreadyEngaged: g.alreadyEngaged ?? false,
      dismissed: g.dismissed ?? false,
      recentlyDisplayedAuthors: [],
    },
    now: NOW,
  }).score;
}

describe('relevance-scorer golden evals (#64)', () => {
  it('dataset has 15–20 labeled posts', () => {
    expect(golden.posts.length).toBeGreaterThanOrEqual(15);
    expect(golden.posts.length).toBeLessThanOrEqual(20);
  });

  it.each(golden.posts.map((p) => [p.id, p] as const))('%s respects score bounds', (_id, g) => {
    const score = scoreOf(g);
    if (g.expectMin !== undefined) {
      expect(score).toBeGreaterThanOrEqual(g.expectMin);
    }
    if (g.expectMax !== undefined) {
      expect(score).toBeLessThanOrEqual(g.expectMax);
    }
  });

  it('REGRESSION: Feldera stale+promo post scores ≤ 50 despite high topic match', () => {
    const feldera = golden.posts.find((p) => p.id === 'feldera-context-engines');
    expect(feldera).toBeDefined();
    const result = scoreRelevance({
      post: toParsedPost(feldera as GoldenPost),
      profile,
      signals: { alreadyEngaged: false, dismissed: false, recentlyDisplayedAuthors: [] },
      now: NOW,
    });
    expect(result.score).toBeLessThanOrEqual(50);
    expect(result.category).not.toBe('engage_now');
    expect(result.reasons).toEqual(
      expect.arrayContaining(['promotional content penalty', 'stale (>48h)'])
    );
  });
});
