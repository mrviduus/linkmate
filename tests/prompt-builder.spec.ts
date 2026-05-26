/**
 * T020 — Prompt builder spec (Phase A foundation).
 * Drives src/prompt-builder.ts (T021). Pure functions, no side effects.
 */

import {
  buildCommentPrompt,
  buildConnectionNotePrompt,
  buildPositioningPrompt,
  TONE_KEYS,
  LENGTH_KEYS,
} from '../src/prompt-builder';
import type { ProfileContext, ParsedPost, ToneKey, LengthKey } from '../src/storage-schema';

const fixtureProfile = (): ProfileContext => ({
  fullName: 'Vasyl Vdovychenko',
  headline: 'AI Engineer | RAG | Agents | TypeScript',
  about: 'I build local-first LLM systems.',
  topSkills: ['TypeScript', 'WebLLM', 'RAG'],
  recentPostThemes: ['agents', 'rag', 'local llms'],
  positioningSummary: 'AI engineer focused on local-first LLM apps and tool-using agents.',
  capturedAt: 1_700_000_000_000,
});

const fixturePost = (): ParsedPost => ({
  id: 'urn:li:activity:7000000000000000001',
  authorUrn: 'urn:li:person:abc',
  authorName: 'Andrej Karpathy',
  authorTitle: 'Building Eureka Labs',
  followerTier: 'gt_100k',
  degree: '1st',
  text: 'MCP is going to reshape how we build agents — tool composition is finally first-class.',
  postedAt: Date.now() - 2 * 60 * 60 * 1000,
  likeCount: 4200,
  commentCount: 312,
  isOwn: false,
});

describe('prompt-builder (T020)', () => {
  describe('exported constants', () => {
    it('TONE_KEYS contains the 4 spec tones', () => {
      expect(TONE_KEYS).toEqual(
        expect.arrayContaining(['professional', 'friendly', 'enthusiastic', 'thoughtful']),
      );
      expect(TONE_KEYS).toHaveLength(4);
    });

    it('LENGTH_KEYS contains the 3 spec lengths', () => {
      expect(LENGTH_KEYS).toEqual(expect.arrayContaining(['brief', 'standard', 'detailed']));
      expect(LENGTH_KEYS).toHaveLength(3);
    });
  });

  describe('buildCommentPrompt', () => {
    const profile = fixtureProfile();
    const post = fixturePost();

    it('returns { system, user } both non-empty', () => {
      const out = buildCommentPrompt({ profile, post, tone: 'professional', length: 'standard' });
      expect(typeof out.system).toBe('string');
      expect(typeof out.user).toBe('string');
      expect(out.system.length).toBeGreaterThan(0);
      expect(out.user.length).toBeGreaterThan(0);
    });

    it('system prompt includes the profile positioning summary verbatim', () => {
      const out = buildCommentPrompt({ profile, post, tone: 'professional', length: 'standard' });
      expect(out.system).toContain(profile.positioningSummary);
    });

    it('applies the tone keyword in the system prompt', () => {
      for (const tone of TONE_KEYS) {
        const out = buildCommentPrompt({ profile, post, tone, length: 'standard' });
        expect(out.system.toLowerCase()).toContain(tone);
      }
    });

    it('applies the length constraint in the system prompt', () => {
      for (const length of LENGTH_KEYS) {
        const out = buildCommentPrompt({ profile, post, tone: 'professional', length });
        expect(out.system.toLowerCase()).toContain(length);
      }
    });

    it('contains anti-genericism "do not" rules', () => {
      const out = buildCommentPrompt({ profile, post, tone: 'professional', length: 'standard' });
      const sys = out.system.toLowerCase();
      expect(sys).toContain('do not');
      expect(sys).toMatch(/great post|thanks for sharing/i);
      expect(sys).toMatch(/sign|name/i);
    });

    it('includes a 1-shot example (Post: / Reply: format)', () => {
      const out = buildCommentPrompt({ profile, post, tone: 'professional', length: 'standard' });
      expect(out.system).toMatch(/Post:/);
      expect(out.system).toMatch(/Reply:/);
    });

    it('user prompt includes the post text and author', () => {
      const out = buildCommentPrompt({ profile, post, tone: 'professional', length: 'standard' });
      expect(out.user).toContain(post.text);
      expect(out.user).toContain(post.authorName);
    });

    it('snapshots the full prompt for every (tone × length) combination', () => {
      for (const tone of TONE_KEYS) {
        for (const length of LENGTH_KEYS) {
          const out = buildCommentPrompt({ profile, post, tone, length });
          expect({ tone, length, system: out.system, user: out.user }).toMatchSnapshot(
            `tone=${tone}, length=${length}`,
          );
        }
      }
    });

    it('is deterministic: same input → same output', () => {
      const a = buildCommentPrompt({ profile, post, tone: 'friendly', length: 'brief' });
      const b = buildCommentPrompt({ profile, post, tone: 'friendly', length: 'brief' });
      expect(a).toEqual(b);
    });
  });

  describe('buildConnectionNotePrompt', () => {
    it('returns { system, user } and references target name + recent activity', () => {
      const out = buildConnectionNotePrompt({
        profile: fixtureProfile(),
        target: {
          name: 'Jane Recruiter',
          title: 'AI Talent Lead at TargetCo',
          recentActivity: 'Posted about hiring 5 ML engineers Q1 2026.',
        },
      });
      expect(out.user).toContain('Jane Recruiter');
      expect(out.user).toContain('AI Talent Lead');
      expect(out.user).toContain('hiring 5 ML engineers');
    });

    it('system prompt enforces the 300-char LinkedIn note limit', () => {
      const out = buildConnectionNotePrompt({
        profile: fixtureProfile(),
        target: { name: 'X', title: 'Y', recentActivity: 'Z' },
      });
      expect(out.system).toMatch(/300\s*(char|character)/i);
    });

    it('includes profile positioning summary so the note reads as the user', () => {
      const profile = fixtureProfile();
      const out = buildConnectionNotePrompt({
        profile,
        target: { name: 'X', title: 'Y', recentActivity: 'Z' },
      });
      expect(out.system).toContain(profile.positioningSummary);
    });
  });

  describe('buildPositioningPrompt', () => {
    it('asks for a 2-sentence positioning summary', () => {
      const out = buildPositioningPrompt({
        headline: 'AI Engineer | RAG',
        about: 'I build local LLM systems.',
        topSkills: ['TypeScript', 'WebLLM'],
        recentPostThemes: ['agents', 'rag'],
      });
      expect(out.system.toLowerCase()).toMatch(/2\s*(sentence|sentences)/);
    });

    it('user prompt includes headline, about, skills, themes', () => {
      const out = buildPositioningPrompt({
        headline: 'My Headline',
        about: 'My about.',
        topSkills: ['TS', 'PY'],
        recentPostThemes: ['theme1', 'theme2'],
      });
      expect(out.user).toContain('My Headline');
      expect(out.user).toContain('My about.');
      expect(out.user).toContain('TS');
      expect(out.user).toContain('theme1');
    });
  });

  it('handles empty profile fields without throwing', () => {
    const emptyProfile: ProfileContext = {
      fullName: '',
      headline: '',
      about: '',
      topSkills: [],
      recentPostThemes: [],
      positioningSummary: '',
      capturedAt: 0,
    };
    expect(() =>
      buildCommentPrompt({
        profile: emptyProfile,
        post: fixturePost(),
        tone: 'professional' as ToneKey,
        length: 'standard' as LengthKey,
      }),
    ).not.toThrow();
  });
});
