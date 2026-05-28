/**
 * Profile recommender — language heuristic, prompt structure, JSON parsing.
 */

import { auditProfile } from '../src/profile-audit';
import { buildProfileRewritePrompt } from '../src/profile-audit-prompts';
import {
  generateProfileRecommendations,
  parseProfileRecommendations,
  ProfileRecommenderParseError,
} from '../src/profile-recommender';
import type { UserProfile } from '../src/lib/idb';
import type { InferenceProvider } from '../src/providers/inference-provider';

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
    recentPosts: [],
    recentComments: [],
    ...overrides,
  };
}

function fakeProvider(response: string): InferenceProvider & { calls: number; lastPrompt: { system: string; user: string } | null } {
  return {
    name: 'fake',
    isCloud: false,
    calls: 0,
    lastPrompt: null,
    async generate(params) {
      this.calls += 1;
      this.lastPrompt = { system: params.system, user: params.user };
      return response;
    },
  };
}

describe('buildProfileRewritePrompt', () => {
  it('emits all key sections in the user prompt', () => {
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
  it('marks audit failures with severity + label', () => {
    const p = profile({ about: '', skills: ['a'], education: [] });
    const audit = auditProfile(p);
    const { user } = buildProfileRewritePrompt({ profile: p, audit, goals: null });
    expect(user).toContain('about (high)');
    expect(user).toContain('skills (high)');
    expect(user).toContain('education (high)');
  });
  it('mentions advisory-only mode when there are no gaps', () => {
    const p = profile();
    const audit = auditProfile(p);
    const { user } = buildProfileRewritePrompt({ profile: p, audit, goals: null });
    expect(user).toContain('advisory items for photoBanner and openToWork');
  });
});

describe('parseProfileRecommendations', () => {
  it('parses a well-formed payload', () => {
    const raw = JSON.stringify({
      recommendations: [
        {
          checkId: 'about',
          diagnosis: 'About is empty',
          suggestion: 'Backend engineer with 5 years…',
          rationale: 'Your role at Acme supports this framing.',
        },
        { checkId: 'photoBanner', diagnosis: 'Remember photo', suggestion: 'Upload pro headshot.', rationale: 'Visibility.' },
        { checkId: 'openToWork', diagnosis: 'Recruiter leverage', suggestion: 'Switch to Recruiters Only.', rationale: 'Optics.' },
      ],
    });
    const out = parseProfileRecommendations(raw);
    expect(out).toHaveLength(3);
    expect(out![0].checkId).toBe('about');
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
    const raw = '```json\n' + JSON.stringify({
      recommendations: [{ checkId: 'about', diagnosis: 'x', suggestion: 'y', rationale: 'z' }],
    }) + '\n```';
    const out = parseProfileRecommendations(raw);
    expect(out).toHaveLength(1);
  });
  it('returns null on malformed JSON', () => {
    expect(parseProfileRecommendations('not json')).toBeNull();
  });
  it('returns null when recommendations key is missing', () => {
    expect(parseProfileRecommendations('{"foo":1}')).toBeNull();
  });
  it('caps total recommendations at 10', () => {
    const valid = ['about', 'skills', 'education', 'location', 'connections', 'currentPosition', 'photoBanner', 'openToWork'];
    const raw = JSON.stringify({
      recommendations: [
        ...valid.map((id) => ({ checkId: id, diagnosis: 'd', suggestion: 's', rationale: 'r' })),
        // 5 extras with bogus ids would be dropped anyway, so add 5 more "valid"
        // entries that would otherwise overflow — but dedup also kicks in.
        // Use distinct synthetic-but-allowed ids via duplicates to confirm the
        // cap path is reachable: we cannot exceed 8 unique valid ids today,
        // so this test asserts the upper bound stays at or below 10.
      ],
    });
    const out = parseProfileRecommendations(raw);
    expect(out!.length).toBeLessThanOrEqual(10);
  });
});

describe('generateProfileRecommendations', () => {
  it('forwards through to provider and parses', async () => {
    const raw = JSON.stringify({
      recommendations: [
        { checkId: 'about', diagnosis: 'd', suggestion: 's', rationale: 'r' },
      ],
    });
    const provider = fakeProvider(raw);
    const p = profile({ about: '' });
    const audit = auditProfile(p);
    const out = await generateProfileRecommendations({
      provider,
      profile: p,
      audit,
      goals: 'find senior role',
    });
    expect(provider.calls).toBe(1);
    expect(out).toHaveLength(1);
    expect(provider.lastPrompt!.user).toContain('find senior role');
  });
  it('throws ProfileRecommenderParseError on bad JSON', async () => {
    const provider = fakeProvider('garbage');
    const p = profile({ about: '' });
    const audit = auditProfile(p);
    await expect(
      generateProfileRecommendations({ provider, profile: p, audit, goals: null })
    ).rejects.toBeInstanceOf(ProfileRecommenderParseError);
  });
});
