import { buildFeedPostAnalysis } from '../src/feed-analysis';
import type { ParsedPost, ProfileContext, RelevanceScore } from '../src/storage-schema';

const profile: ProfileContext = {
  fullName: 'Hooman Haji',
  headline: 'ML engineer',
  about: 'I build AI systems and startup products.',
  topSkills: ['AI systems', 'machine learning', 'infrastructure'],
  recentPostThemes: ['startup strategy', 'privacy'],
  positioningSummary: 'ML engineer focused on production AI systems.',
  capturedAt: 1_700_000_000_000,
};

const post: ParsedPost = {
  id: 'urn:li:activity:123',
  authorUrn: 'urn:li:profile:jay',
  authorName: 'Jay Chaudhry',
  authorTitle: 'CEO at Zscaler',
  followerTier: 'gt_100k',
  degree: '2nd',
  text:
    'AI agents are changing cybersecurity infrastructure. Enterprise security teams need new model and cloud controls for production AI systems.',
  postedAt: 1_700_000_100_000,
  likeCount: 18,
  commentCount: 1,
  isOwn: false,
};

const relevance: RelevanceScore = {
  score: 82,
  reasons: ['topic match (42%)', 'high-tier author (gt_100k)'],
  category: 'engage_now',
};

describe('feed analysis API shape', () => {
  it('builds the standardized sections other surfaces can render', () => {
    const analysis = buildFeedPostAnalysis({
      post,
      profile,
      relevance,
      generatedAt: 1_700_000_200_000,
    });

    expect(analysis).toMatchObject({
      apiVersion: 'linkmate.feed.analysis.v1',
      generatedAt: 1_700_000_200_000,
      highlight: true,
      post: {
        id: post.id,
        authorName: 'Jay Chaudhry',
        engagement: { likes: 18, comments: 1 },
      },
      score: {
        value: 8.2,
        raw: 82,
        scale: '0-10',
        category: 'engage_now',
      },
    });
    expect(analysis.sections.whyItRanks).toContain('ranks high');
    expect(analysis.sections.strongPoints).toEqual(
      expect.arrayContaining(['topic match (42%).', 'high-tier author (gt_100k).'])
    );
    expect(analysis.sections.especiallyRelevantBecause.length).toBeGreaterThan(0);
    expect(analysis.sections.whatThisProvides.length).toBeGreaterThan(0);
    expect(analysis.sections.tags).toEqual(expect.arrayContaining(['AI']));
    expect(analysis.sections.recommendation).toContain('Definitely highlight');
  });
});
