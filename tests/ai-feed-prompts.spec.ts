/**
 * Issue #18 — AI feed prompt builders.
 *
 * Pure unit tests: no fetches, no storage. Asserts the prompt:
 *   - includes profile + goals + posts verbatim,
 *   - has the strict-JSON instruction,
 *   - caps post text + skill list lengths.
 */

import {
  buildAiScoreBatchPrompt,
  formatUserBackground,
} from '../src/ai-feed-prompts';
import type { UserProfile } from '../src/lib/idb';
import type { ParsedPost, ProfileContext } from '../src/storage-schema';

function profile(overrides: Partial<ProfileContext> = {}): ProfileContext {
  return {
    fullName: 'Vasyl',
    headline: 'Senior Engineer',
    about: '',
    topSkills: ['TypeScript', 'Node.js', 'AI engineering', 'distributed systems'],
    recentPostThemes: ['MCP', 'RAG'],
    positioningSummary: 'Senior engineer building AI features in production.',
    capturedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function post(id: string, text: string, overrides: Partial<ParsedPost> = {}): ParsedPost {
  return {
    id,
    authorUrn: `urn:li:fsd_profile:${id}`,
    authorName: 'Author Name',
    authorTitle: 'Staff Engineer',
    followerTier: '1k_10k',
    degree: '2nd',
    text,
    postedAt: Date.now(),
    likeCount: 10,
    commentCount: 2,
    isOwn: false,
    ...overrides,
  };
}

describe('buildAiScoreBatchPrompt', () => {
  it('emits strict-JSON instruction in the system prompt', () => {
    const { system } = buildAiScoreBatchPrompt({
      profile: profile(),
      goals: 'Looking for AI engineering roles',
      posts: [post('urn:li:activity:1', 'Hello world')],
    });
    expect(system).toMatch(/strict JSON/);
    expect(system).toMatch(/no markdown fences/);
    expect(system).toMatch(/postId/);
    expect(system).toMatch(/aiScore/);
    expect(system).toMatch(/whyForYou/);
  });

  it('interpolates each postId verbatim into the user prompt', () => {
    const posts = [
      post('urn:li:activity:111', 'A'),
      post('urn:li:activity:222', 'B'),
      post('urn:li:activity:333', 'C'),
    ];
    const { user } = buildAiScoreBatchPrompt({
      profile: profile(),
      goals: 'g',
      posts,
    });
    for (const p of posts) {
      expect(user).toContain(`id=${p.id}`);
    }
  });

  it('includes profile positioning, skills, themes, and goals', () => {
    const { user } = buildAiScoreBatchPrompt({
      profile: profile({ positioningSummary: 'POSITIONING-MARKER' }),
      goals: 'GOAL-MARKER',
      posts: [post('urn:li:activity:1', 'x')],
    });
    expect(user).toContain('POSITIONING-MARKER');
    expect(user).toContain('GOAL-MARKER');
    expect(user).toContain('TypeScript');
    expect(user).toContain('MCP');
  });

  it('caps post text at 280 chars', () => {
    const long = 'x'.repeat(1000);
    const { user } = buildAiScoreBatchPrompt({
      profile: profile(),
      goals: '',
      posts: [post('urn:li:activity:1', long)],
    });
    const xRun = user.match(/x+/g)?.[0] ?? '';
    expect(xRun.length).toBeLessThanOrEqual(280);
  });

  it('falls back to positioning when goals is empty', () => {
    const { user } = buildAiScoreBatchPrompt({
      profile: profile({ positioningSummary: 'POS-FALLBACK' }),
      goals: '',
      posts: [post('urn:li:activity:1', 'a')],
    });
    expect(user).toMatch(/Goals:\s*POS-FALLBACK/);
  });

  it('renders gracefully with an empty posts list', () => {
    const { user } = buildAiScoreBatchPrompt({
      profile: profile(),
      goals: '',
      posts: [],
    });
    expect(user).toContain('(none)');
  });
});

function userProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    capturedAt: '2026-01-15T10:00:00Z',
    profileUrl: 'https://www.linkedin.com/in/vasyl',
    name: 'Vasyl',
    headline: 'Senior Engineer',
    skills: ['TypeScript', 'AI'],
    experience: [
      {
        company: 'Shopify',
        title: 'Senior Engineer',
        dateRange: '2024–present',
        description: 'Leading payments platform AI work',
      },
      {
        company: 'Stripe',
        title: 'Engineer',
        dateRange: '2021–2024',
        description: 'Checkout team',
      },
    ],
    education: [],
    recentPosts: [
      {
        id: 'urn:li:activity:own:1',
        text: 'Just shipped agents that use MCP — composability finally clicking.',
        timestamp: '2026-01-10',
        engagement: { likes: 42, comments: 8, reposts: 1 },
        isRepost: false,
      },
      {
        id: 'urn:li:activity:own:2',
        text: 'Hot take: vector DBs are infrastructure not magic.',
        timestamp: '2026-01-08',
        engagement: { likes: 12, comments: 2, reposts: 0 },
        isRepost: false,
      },
    ],
    recentComments: [
      {
        id: 'c1',
        text: 'The composability angle resonates.',
        timestamp: '2026-01-09',
        originalPostText: 'Just launched our new AI agent platform...',
        originalAuthor: 'Some Author',
      },
    ],
    ...overrides,
  };
}

describe('formatUserBackground', () => {
  it('returns empty string when no profile given', () => {
    expect(formatUserBackground(null)).toBe('');
    expect(formatUserBackground(undefined)).toBe('');
  });

  it('renders experience + recent posts + recent comments sections', () => {
    const out = formatUserBackground(userProfile());
    expect(out).toMatch(/Background/);
    expect(out).toContain('Shopify');
    expect(out).toContain('Senior Engineer');
    expect(out).toMatch(/recent posts/);
    expect(out).toContain('MCP');
    expect(out).toMatch(/recent comments/);
    expect(out).toContain('composability angle');
  });

  it('sorts recent posts by engagement (likes + comments) desc', () => {
    const out = formatUserBackground(userProfile());
    const mcpIdx = out.indexOf('MCP');
    const vectorIdx = out.indexOf('vector DBs');
    expect(mcpIdx).toBeGreaterThan(0);
    expect(vectorIdx).toBeGreaterThan(mcpIdx); // 50 engagement > 14, MCP first
  });

  it('caps experience at 3 entries', () => {
    const many = userProfile({
      experience: Array.from({ length: 8 }, (_, i) => ({
        company: `Co${i}`,
        title: `Role${i}`,
        dateRange: '2020-2021',
      })),
    });
    const out = formatUserBackground(many);
    expect(out).toContain('Co0');
    expect(out).toContain('Co2');
    expect(out).not.toContain('Co3');
  });

  it('truncates long description text in experience', () => {
    const long = userProfile({
      experience: [
        {
          company: 'X',
          title: 'Y',
          dateRange: '',
          description: 'x'.repeat(500),
        },
      ],
      recentPosts: [],
      recentComments: [],
    });
    const out = formatUserBackground(long);
    const xRun = out.match(/x+/g)?.[0] ?? '';
    expect(xRun.length).toBeLessThanOrEqual(150);
  });

  it('filters reposts out of "Your recent posts" (bug #1)', () => {
    const withRepost = userProfile({
      recentPosts: [
        {
          id: 'urn:li:activity:original:1',
          text: 'OWN-POST-MARK',
          timestamp: '2026-01-10',
          engagement: { likes: 5, comments: 0, reposts: 0 },
          isRepost: false,
        },
        {
          id: 'urn:li:activity:reposted:9',
          text: 'VIRAL-REPOSTED-CONTENT',
          timestamp: '2026-01-11',
          engagement: { likes: 9999, comments: 500, reposts: 200 },
          isRepost: true,
        },
      ],
      recentComments: [],
    });
    const out = formatUserBackground(withRepost);
    expect(out).toContain('OWN-POST-MARK');
    expect(out).not.toContain('VIRAL-REPOSTED-CONTENT');
  });

  it('sorts recentComments by timestamp desc (bug #2)', () => {
    const profile = userProfile({
      recentPosts: [],
      recentComments: [
        {
          id: 'old',
          text: 'OLD-COMMENT',
          timestamp: '2025-01-01T00:00:00Z',
          originalPostText: 'old op',
          originalAuthor: 'A',
        },
        {
          id: 'new',
          text: 'NEW-COMMENT',
          timestamp: '2026-05-01T00:00:00Z',
          originalPostText: 'new op',
          originalAuthor: 'B',
        },
      ],
    });
    const out = formatUserBackground(profile);
    const newIdx = out.indexOf('NEW-COMMENT');
    const oldIdx = out.indexOf('OLD-COMMENT');
    expect(newIdx).toBeGreaterThan(0);
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('caps recentComments at 3', () => {
    const many = userProfile({
      recentPosts: [],
      recentComments: Array.from({ length: 8 }, (_, i) => ({
        id: `c${i}`,
        text: `COMMENT-${i}`,
        // monotonically newer so sort doesn't shuffle the index
        timestamp: `2026-0${i % 9}-01T00:00:00Z`,
        originalPostText: 'op',
        originalAuthor: 'A',
      })),
    });
    const out = formatUserBackground(many);
    const matches = out.match(/COMMENT-\d/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it('caps recentPosts at 3 (after sort by engagement)', () => {
    const many = userProfile({
      recentPosts: Array.from({ length: 10 }, (_, i) => ({
        id: `urn:li:activity:${i}`,
        text: `POST-${i}`,
        timestamp: '2026-01-10',
        engagement: { likes: i, comments: 0, reposts: 0 },
        isRepost: false,
      })),
      recentComments: [],
    });
    const out = formatUserBackground(many);
    const matches = out.match(/POST-\d+/g) ?? [];
    expect(matches.length).toBe(3);
    // Highest-engagement (POST-9, POST-8, POST-7) should win.
    expect(out).toContain('POST-9');
    expect(out).toContain('POST-7');
    expect(out).not.toContain('POST-0');
  });

  it('renders engagement block defensively when likes/comments are undefined (bug #3)', () => {
    const partial = userProfile({
      recentPosts: [
        {
          id: 'urn:li:activity:1',
          text: 'TEST-POST',
          timestamp: '2026-01-10',
          // engagement present but fields missing (stale-row scenario)
          engagement: {} as { likes: number; comments: number; reposts: number },
          isRepost: false,
        },
      ],
      recentComments: [],
    });
    const out = formatUserBackground(partial);
    expect(out).toContain('TEST-POST');
    expect(out).toContain('[0❤ 0💬]');
    expect(out).not.toContain('undefined');
  });
});

describe('buildAiScoreBatchPrompt — UserProfile integration (issue #18)', () => {
  it('omits the background block when no userProfile is provided', () => {
    const { user } = buildAiScoreBatchPrompt({
      profile: profile(),
      goals: '',
      posts: [post('urn:li:activity:1', 'x')],
    });
    expect(user).not.toMatch(/Background \(/);
  });

  it('weaves company + own-post text into the user prompt when userProfile provided', () => {
    const { user, system } = buildAiScoreBatchPrompt({
      profile: profile(),
      goals: '',
      posts: [post('urn:li:activity:1', 'x')],
      userProfile: userProfile(),
    });
    expect(user).toContain('Shopify');
    expect(user).toContain('MCP');
    expect(user).toContain('composability angle');
    // System prompt also acknowledges richer grounding.
    expect(system).toMatch(/background/i);
  });
});

