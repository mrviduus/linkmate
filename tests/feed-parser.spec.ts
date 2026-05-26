/**
 * T111 — Feed parser spec (Phase B, US1). Fixture-driven.
 * Drives src/feed-parser.ts (T112). Pure function.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  parseFeedDom,
  parseFollowerTier,
  parseAgoToTimestamp,
  parseDegree,
} from '../src/feed-parser';
import type { ParsedPost } from '../src/storage-schema';

const FIXED_NOW = 1_700_000_000_000;

function loadFixture(): Document {
  const html = fs.readFileSync(
    path.join(__dirname, 'fixtures/linkedin-feed.html'),
    'utf-8',
  );
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('parseFollowerTier', () => {
  it.each([
    ['400 followers', 'lt_1k'],
    ['999 followers', 'lt_1k'],
    ['1,000 followers', '1k_10k'],
    ['9,999 followers', '1k_10k'],
    ['10,000 followers', '10k_100k'],
    ['99,999 followers', '10k_100k'],
    ['100,000 followers', 'gt_100k'],
    ['1,234,567 followers', 'gt_100k'],
    ['no followers text', 'unknown'],
    ['', 'unknown'],
  ])('classifies "%s" → %s', (input, expected) => {
    expect(parseFollowerTier(input)).toBe(expected);
  });
});

describe('parseAgoToTimestamp', () => {
  it('30m → now - 30 minutes', () => {
    expect(parseAgoToTimestamp('30m', FIXED_NOW)).toBe(FIXED_NOW - 30 * 60 * 1000);
  });
  it('2h → now - 2 hours', () => {
    expect(parseAgoToTimestamp('2h', FIXED_NOW)).toBe(FIXED_NOW - 2 * 60 * 60 * 1000);
  });
  it('1d → now - 1 day', () => {
    expect(parseAgoToTimestamp('1d', FIXED_NOW)).toBe(FIXED_NOW - 24 * 60 * 60 * 1000);
  });
  it('2w → now - 14 days', () => {
    expect(parseAgoToTimestamp('2w', FIXED_NOW)).toBe(FIXED_NOW - 14 * 24 * 60 * 60 * 1000);
  });
  it('falls back to now when unparseable', () => {
    expect(parseAgoToTimestamp('???', FIXED_NOW)).toBe(FIXED_NOW);
    expect(parseAgoToTimestamp('', FIXED_NOW)).toBe(FIXED_NOW);
  });
});

describe('parseDegree', () => {
  it.each([
    ['1st', '1st'],
    ['2nd', '2nd'],
    ['3rd', '3rd'],
    ['Following', 'follow-only'],
    ['You', 'unknown'], // "You" is isOwn signal, not a degree
    ['', 'unknown'],
    ['something else', 'unknown'],
  ])('"%s" → %s', (input, expected) => {
    expect(parseDegree(input)).toBe(expected);
  });
});

describe('parseFeedDom against canonical fixture', () => {
  let posts: ParsedPost[];

  beforeAll(() => {
    posts = parseFeedDom(loadFixture(), { now: FIXED_NOW });
  });

  it('extracts exactly 10 posts', () => {
    expect(posts).toHaveLength(10);
  });

  it('post 1: Alex Karpova, gt_100k, 1st, fresh, high engagement', () => {
    const p = posts[0];
    expect(p.id).toBe('urn:li:activity:7000000000000000001');
    expect(p.authorName).toBe('Alex Karpova');
    expect(p.followerTier).toBe('gt_100k');
    expect(p.degree).toBe('1st');
    expect(p.text).toMatch(/MCP/);
    expect(p.likeCount).toBe(4210);
    expect(p.commentCount).toBe(312);
    expect(p.isOwn).toBe(false);
    // 2h ago vs FIXED_NOW
    expect(p.postedAt).toBe(FIXED_NOW - 2 * 60 * 60 * 1000);
  });

  it('post 3: low-tier (640 followers) → lt_1k', () => {
    const p = posts[2];
    expect(p.followerTier).toBe('lt_1k');
    expect(p.degree).toBe('3rd');
    expect(p.commentCount).toBe(2);
  });

  it('post 6: follow-only relationship parsed', () => {
    const p = posts[5];
    expect(p.degree).toBe('follow-only');
  });

  it('post 10: own post → isOwn=true (degree marker "You")', () => {
    const own = posts[9];
    expect(own.authorName).toBe('Synthetic Me');
    expect(own.isOwn).toBe(true);
  });

  it('all posts have non-empty ids and authorUrns', () => {
    for (const p of posts) {
      expect(p.id).not.toBe('');
      expect(p.authorUrn).not.toBe('');
    }
  });

  it('returns rounded integer likeCount and commentCount', () => {
    for (const p of posts) {
      expect(Number.isInteger(p.likeCount)).toBe(true);
      expect(Number.isInteger(p.commentCount)).toBe(true);
      expect(p.likeCount).toBeGreaterThanOrEqual(0);
      expect(p.commentCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('post 9: near-empty text edge case parses without throwing', () => {
    const p = posts[8];
    expect(p.text.length).toBeGreaterThanOrEqual(0);
    expect(p.likeCount).toBe(0);
    expect(p.commentCount).toBe(0);
  });
});

describe('parseFeedDom edge cases', () => {
  it('returns empty array for DOM with no posts', () => {
    const doc = new DOMParser().parseFromString('<main></main>', 'text/html');
    expect(parseFeedDom(doc, { now: FIXED_NOW })).toEqual([]);
  });

  it('skips posts missing the data-urn attribute', () => {
    const html = `<main role="main"><div class="feed-shared-update-v2"><span>no urn</span></div></main>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(parseFeedDom(doc, { now: FIXED_NOW })).toEqual([]);
  });

  it('is pure: same DOM → same output across calls', () => {
    const a = parseFeedDom(loadFixture(), { now: FIXED_NOW });
    const b = parseFeedDom(loadFixture(), { now: FIXED_NOW });
    expect(a).toEqual(b);
  });

  it('uses Date.now() when options.now omitted', () => {
    // Smoke test that no-options call doesn't throw and returns posts
    const posts = parseFeedDom(loadFixture());
    expect(posts.length).toBeGreaterThan(0);
  });
});
