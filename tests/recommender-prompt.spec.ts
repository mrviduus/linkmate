import {
  buildRecommenderPrompt,
  buildPostDraftPrompt,
  buildWeeklyRetro,
} from '../src/prompt-builder';
import type { ProfileContext } from '../src/storage-schema';

const profile: ProfileContext = {
  fullName: 'Vasyl V',
  headline: 'AI engineer · Chrome extensions',
  about: 'Long about text',
  topSkills: ['TypeScript', 'AI', 'Chrome MV3'],
  recentPostThemes: ['LLM', 'DX'],
  positioningSummary: 'Builds AI-powered devtools focused on developer experience.',
  capturedAt: Date.now(),
};

const baseProgress = {
  brand: { done: 0, target: 1 },
  finding: { done: 2, target: 5 },
  engaging: { done: 1, target: 3 },
  building: { done: 0, target: 2 },
};

describe('buildRecommenderPrompt', () => {
  it('emits strict-JSON contract in system + grounds user in data', () => {
    const { system, user } = buildRecommenderPrompt({
      profile,
      cadence: { weakest: 'engaging', progress: baseProgress },
      topTopics: [{ topic: 'AI', count: 5 }],
      recentOutcomes: [{ topic: 'AI', likes: 12, replies: 1 }],
      ssiInsight: 'Engaging trending down 3 days.',
    });
    expect(system).toMatch(/JSON only/i);
    expect(system).toMatch(/Exactly 3 cards/);
    expect(user).toContain('Weakest pillar: engaging');
    expect(user).toContain('AI(5)');
    expect(user).toContain('Engaging trending down');
  });

  it('handles empty topics and outcomes gracefully', () => {
    const { user } = buildRecommenderPrompt({
      profile,
      cadence: { weakest: 'brand', progress: baseProgress },
      topTopics: [],
      recentOutcomes: [],
      ssiInsight: 'No data.',
    });
    expect(user).toContain('No topics tracked.');
    expect(user).toContain('No outcomes tracked yet.');
  });

  it('includes candidate posts when provided', () => {
    const { user } = buildRecommenderPrompt({
      profile,
      cadence: { weakest: 'engaging', progress: baseProgress },
      topTopics: [],
      recentOutcomes: [],
      ssiInsight: '',
      candidatePosts: [
        { id: 'urn:li:activity:1', authorName: 'Jane', text: 'Hi', topics: ['AI'] },
      ],
    });
    expect(user).toContain('urn:li:activity:1');
    expect(user).toContain('Jane');
  });
});

describe('buildPostDraftPrompt', () => {
  it('asks for 3 distinct angles in JSON', () => {
    const { system, user } = buildPostDraftPrompt({
      profile,
      weakest: 'brand',
      topTopics: [{ topic: 'AI', count: 3 }],
      underweightTopics: ['Hiring', 'Leadership'],
    });
    expect(system).toMatch(/Exactly 3 drafts/);
    expect(system).toMatch(/story|hot_take|lesson/);
    expect(user).toContain('Hiring, Leadership');
    expect(user).toContain('Weakest SSI pillar: brand');
  });
});

describe('buildWeeklyRetro', () => {
  it('formats progress + SSI delta + streak', () => {
    const r = buildWeeklyRetro({
      weekStartTs: 0,
      prevProgress: {
        brand: { done: 0, target: 1 },
        finding: { done: 5, target: 5 },
        engaging: { done: 3, target: 3 },
        building: { done: 1, target: 2 },
      },
      ssiDelta: { engaging: 1.2, brand: -0.4 },
      streak: 2,
    });
    expect(r).toContain('0/1 posts ❌');
    expect(r).toContain('5/5 invites ✅');
    expect(r).toContain('3/3 comments ✅');
    expect(r).toContain('1/2 thread replies ❌');
    expect(r).toContain('engaging +1.2');
    expect(r).toContain('brand -0.4');
    expect(r).toContain('Streak: 2 weeks');
  });

  it('omits SSI section when all deltas zero', () => {
    const r = buildWeeklyRetro({
      weekStartTs: 0,
      prevProgress: baseProgress,
      ssiDelta: {},
      streak: 1,
    });
    expect(r).not.toContain('SSI');
    expect(r).toContain('Streak: 1 week');
  });

  it('skips 0-target pillars in the breakdown', () => {
    const r = buildWeeklyRetro({
      weekStartTs: 0,
      prevProgress: {
        brand: { done: 0, target: 0 },
        finding: { done: 5, target: 5 },
        engaging: { done: 0, target: 0 },
        building: { done: 2, target: 2 },
      },
      ssiDelta: {},
      streak: 0,
    });
    expect(r).not.toContain('posts');
    expect(r).not.toContain('comments');
    expect(r).toContain('5/5 invites');
    expect(r).toContain('2/2 thread replies');
    expect(r).not.toContain('Streak');
  });
});
