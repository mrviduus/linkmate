/**
 * Profile recommender — prompt structure, JSON parsing, 2-call orchestration.
 */

import { auditProfile } from '../src/profile-audit';
import {
  buildProfileRewritePrompt,
  buildSsiStrategyPrompt,
} from '../src/profile-audit-prompts';
import {
  generateProfileRecommendations,
  parseProfileRecommendations,
  ProfileRecommenderParseError,
} from '../src/profile-recommender';
import type { UserProfile } from '../src/lib/idb';
import type { InferenceProvider } from '../src/providers/inference-provider';
import type { SsiSnapshot } from '../src/storage-schema';

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    capturedAt: '2026-05-01T00:00:00.000Z',
    profileUrl: 'https://www.linkedin.com/in/vasyl/',
    name: 'Vasyl V.',
    headline: 'Senior engineer building AI products',
    location: 'Kyiv, Ukraine',
    connectionsCount: 312,
    followersCount: 600,
    about: 'A'.repeat(120),
    skills: ['TypeScript', 'React', 'Node', 'AWS', 'Postgres'],
    experience: [
      { title: 'Senior engineer', company: 'Acme', dateRange: '2022–present', description: 'Built X.' },
    ],
    education: [{ school: 'KPI', degree: 'BSc', field: 'CS' }],
    certifications: [],
    languages: [],
    recentPosts: [
      { id: 'p1', text: 'Shipped a RAG pipeline that cut latency 40%', timestamp: '2026-04-20', engagement: { likes: 42, comments: 8, reposts: 1 }, isRepost: false },
      { id: 'p2', text: 'Repost of foo', timestamp: '2026-04-15', isRepost: true },
    ],
    recentComments: [
      { id: 'c1', text: 'Worth pairing this with an eval harness.', timestamp: '2026-04-22', originalPostText: 'On RAG hallucinations', originalAuthor: 'Alice' },
    ],
    ...overrides,
  };
}

function ssi(overrides: Partial<SsiSnapshot> = {}): SsiSnapshot {
  return {
    total: 62,
    components: {
      establishBrand: 18,
      findRightPeople: 14,
      engageWithInsights: 10,
      buildRelationships: 20,
    },
    industryRank: 'top 18%',
    networkRank: 'top 12%',
    capturedAt: Date.parse('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Fake provider with a per-call response queue. The recommender now runs
 * two parallel calls; tests want to control each independently.
 */
function fakeProvider(
  responses: string[],
): InferenceProvider & { calls: number; prompts: Array<{ system: string; user: string }> } {
  let i = 0;
  return {
    name: 'fake',
    isCloud: false,
    calls: 0,
    prompts: [],
    async generate(params) {
      this.calls += 1;
      this.prompts.push({ system: params.system, user: params.user });
      const r = responses[i] ?? responses[responses.length - 1];
      i += 1;
      return r;
    },
  };
}

const copyResponse = JSON.stringify({
  recommendations: [
    { checkId: 'about', diagnosis: 'too short', suggestion: 'Backend engineer with 10 years…', rationale: 'Ties to current role.' },
    { checkId: 'photoBanner', diagnosis: 'verify pro photo', suggestion: 'Upload an industry-relevant banner.', rationale: 'Visibility.' },
    { checkId: 'openToWork', diagnosis: 'private only', suggestion: 'Switch frame to Recruiters Only.', rationale: 'Leverage.' },
  ],
});

const strategyResponse = JSON.stringify({
  recommendations: [
    { checkId: 'ssi', diagnosis: 'weakest pillar engageWithInsights', suggestion: 'Comment on 5 posts about RAG eval this week.', rationale: 'engageWithInsights 10/25.' },
    { checkId: 'engagementStrategy', diagnosis: 'lean into RAG content', suggestion: 'Publish a lesson-style post on eval harnesses.', rationale: 'RAG post got 42 likes.' },
  ],
});

describe('buildProfileRewritePrompt', () => {
  it('emits compact profile + audit state + advisory instructions', () => {
    const p = profile();
    const audit = auditProfile(p);
    const { user, system } = buildProfileRewritePrompt({
      profile: p,
      audit,
      goals: 'Land a senior backend role at a fintech',
    });
    expect(system).toContain('strict JSON');
    expect(system).toContain('photoBanner');
    expect(system).toContain('openToWork');
    expect(system).toContain('Respond in English');
    expect(user).toContain('Vasyl');
    expect(user).toContain('Senior engineer');
    expect(user).toContain('Kyiv');
    expect(user).toContain('Land a senior backend role at a fintech');
    expect(user).toContain('Audit state');
  });
  it('marks empty goals explicitly', () => {
    const p = profile();
    const { user } = buildProfileRewritePrompt({
      profile: p,
      audit: auditProfile(p),
      goals: null,
    });
    expect(user).toContain('not provided');
  });
  it('lists failed audit ids with severity', () => {
    const p = profile({ about: '', skills: ['a'], education: [] });
    const audit = auditProfile(p);
    const { user } = buildProfileRewritePrompt({ profile: p, audit, goals: null });
    expect(user).toContain('about (high)');
    expect(user).toContain('skills (high)');
    expect(user).toContain('education (high)');
  });
  it('reports FAIL (none) when all rules pass', () => {
    const p = profile();
    const { user } = buildProfileRewritePrompt({ profile: p, audit: auditProfile(p), goals: null });
    expect(user).toContain('FAIL: (none');
  });
});

describe('buildSsiStrategyPrompt', () => {
  it('emits SSI breakdown + posts + comments', () => {
    const p = profile();
    const { user, system } = buildSsiStrategyPrompt({
      profile: p,
      ssi: ssi(),
      goals: 'grow in eval space',
    });
    expect(system).toContain('growth strategist');
    expect(system).toContain('"ssi"');
    expect(system).toContain('engagementStrategy');
    expect(user).toContain('62/100');
    expect(user).toContain('engageWithInsights:   10/25');
    expect(user).toContain('Weakest pillar: engageWithInsights');
    expect(user).toContain('RAG pipeline');
    expect(user).toContain('eval harness');
    expect(user).toContain('grow in eval space');
  });
  it('skips SSI block when snapshot missing', () => {
    const p = profile();
    const { user } = buildSsiStrategyPrompt({ profile: p, ssi: null, goals: null });
    expect(user).toContain('no SSI snapshot captured yet');
  });
  it('filters reposts from own-posts section', () => {
    const p = profile();
    const { user } = buildSsiStrategyPrompt({ profile: p, ssi: ssi(), goals: null });
    expect(user).not.toContain('Repost of foo');
  });
});

describe('avoidStems grouping (concept rotation)', () => {
  it('renders prior suggestions grouped by checkId in copy editor prompt', () => {
    const p = profile();
    const { user } = buildProfileRewritePrompt({
      profile: p,
      audit: auditProfile(p),
      goals: null,
      avoidStems: [
        { checkId: 'photoBanner', stem: 'Banner with model architecture diagram' },
        { checkId: 'photoBanner', stem: 'Banner with RAG pipeline visualization' },
        { checkId: 'about', stem: 'AI engineer with 10 years shipping production systems' },
      ],
    });
    expect(user).toContain('Previously suggested by checkId');
    expect(user).toContain('[photoBanner]');
    expect(user).toContain('[about]');
    expect(user).toContain('model architecture diagram');
    expect(user).toContain('RAG pipeline');
    expect(user).toContain('propose a DIFFERENT concept');
  });
  it('renders avoid block in strategist prompt too', () => {
    const p = profile();
    const { user } = buildSsiStrategyPrompt({
      profile: p,
      ssi: ssi(),
      goals: null,
      avoidStems: [
        { checkId: 'ssi', stem: 'Comment on 2 RAG-eval posts per week' },
      ],
    });
    expect(user).toContain('[ssi]');
    expect(user).toContain('Comment on 2 RAG-eval posts');
    expect(user).toContain('DIFFERENT concept');
  });
});

describe('parseProfileRecommendations', () => {
  it('parses a well-formed payload', () => {
    const out = parseProfileRecommendations(copyResponse);
    expect(out).toHaveLength(3);
    expect(out![0].checkId).toBe('about');
  });
  it('accepts new SSI-strategy checkIds', () => {
    const out = parseProfileRecommendations(strategyResponse);
    expect(out).toHaveLength(2);
    expect(out!.map((r) => r.checkId)).toEqual(['ssi', 'engagementStrategy']);
  });
  it('drops entries with unknown checkIds', () => {
    const raw = JSON.stringify({
      recommendations: [
        { checkId: 'industry', diagnosis: 'x', suggestion: 'y', rationale: 'z' },
        { checkId: 'about', diagnosis: 'x', suggestion: 'y', rationale: 'z' },
      ],
    });
    const out = parseProfileRecommendations(raw);
    expect(out).toHaveLength(1);
    expect(out![0].checkId).toBe('about');
  });
  it('drops duplicates, keeping the first', () => {
    const raw = JSON.stringify({
      recommendations: [
        { checkId: 'about', diagnosis: 'first', suggestion: 'first', rationale: 'first' },
        { checkId: 'about', diagnosis: 'second', suggestion: 'second', rationale: 'second' },
      ],
    });
    const out = parseProfileRecommendations(raw);
    expect(out).toHaveLength(1);
    expect(out![0].diagnosis).toBe('first');
  });
  it('drops items with empty suggestion', () => {
    const raw = JSON.stringify({
      recommendations: [{ checkId: 'about', diagnosis: 'x', suggestion: '   ', rationale: 'z' }],
    });
    expect(parseProfileRecommendations(raw)).toBeNull();
  });
  it('truncates very long suggestion text', () => {
    const huge = 'x'.repeat(5000);
    const raw = JSON.stringify({
      recommendations: [{ checkId: 'about', diagnosis: 'd', suggestion: huge, rationale: 'r' }],
    });
    const out = parseProfileRecommendations(raw);
    expect(out![0].suggestion.length).toBeLessThan(huge.length);
  });
  it('tolerates ```json fences', () => {
    const raw = '```json\n' + copyResponse + '\n```';
    const out = parseProfileRecommendations(raw);
    expect(out).toHaveLength(3);
  });
  it('returns null on malformed JSON', () => {
    expect(parseProfileRecommendations('not json')).toBeNull();
  });
  it('returns null when recommendations key is missing', () => {
    expect(parseProfileRecommendations('{"foo":1}')).toBeNull();
  });
  it('caps single-payload recommendations at 12', () => {
    const valid = ['about', 'skills', 'education', 'location', 'connections', 'currentPosition', 'headline', 'photoBanner', 'openToWork', 'ssi', 'engagementStrategy', 'networkGrowth'];
    const raw = JSON.stringify({
      recommendations: valid.map((id) => ({ checkId: id, diagnosis: 'd', suggestion: 's', rationale: 'r' })),
    });
    const out = parseProfileRecommendations(raw);
    expect(out!.length).toBeLessThanOrEqual(12);
  });
});

describe('generateProfileRecommendations', () => {
  it('runs both calls in parallel and merges results', async () => {
    const provider = fakeProvider([copyResponse, strategyResponse]);
    const p = profile({ about: '' });
    const audit = auditProfile(p);
    const out = await generateProfileRecommendations({
      provider,
      profile: p,
      audit,
      goals: 'find senior role',
      ssi: ssi(),
    });
    expect(provider.calls).toBe(2);
    const ids = out.map((r) => r.checkId);
    expect(ids).toContain('about');
    expect(ids).toContain('ssi');
    expect(ids).toContain('engagementStrategy');
  });
  it('returns partial results when only one call succeeds', async () => {
    const provider = fakeProvider([copyResponse, 'garbage']);
    const p = profile();
    const audit = auditProfile(p);
    const out = await generateProfileRecommendations({
      provider,
      profile: p,
      audit,
      goals: null,
      ssi: ssi(),
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.map((r) => r.checkId)).toContain('about');
    expect(out.map((r) => r.checkId)).not.toContain('ssi');
  });
  it('throws ProfileRecommenderParseError when BOTH calls fail', async () => {
    const provider = fakeProvider(['garbage', 'also garbage']);
    const p = profile();
    const audit = auditProfile(p);
    await expect(
      generateProfileRecommendations({ provider, profile: p, audit, goals: null, ssi: null }),
    ).rejects.toBeInstanceOf(ProfileRecommenderParseError);
  });
});
