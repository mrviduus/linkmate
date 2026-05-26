/**
 * T021 — Prompt builder (Phase A foundation).
 *
 * Pure, deterministic prompt templates for LinkedIn engagement drafts.
 * No side effects, no I/O, no OpenAI calls — that's the caller's job.
 *
 * Three exports:
 *   - buildCommentPrompt  → engagement-queue draft for a feed post
 *   - buildConnectionNotePrompt → ≤300-char connection note for a target profile
 *   - buildPositioningPrompt → 2-sentence positioning summary used in every other prompt
 *
 * All return { system, user } so callers can pass each to the provider as separate roles.
 */

import type { ProfileContext, ParsedPost, ToneKey, LengthKey } from './storage-schema';

export const TONE_KEYS: ToneKey[] = ['professional', 'friendly', 'enthusiastic', 'thoughtful'];
export const LENGTH_KEYS: LengthKey[] = ['brief', 'standard', 'detailed'];

const TONE_DESCRIPTION: Record<ToneKey, string> = {
  professional: 'professional — confident, neutral, expert. No fluff, no buzzwords.',
  friendly: 'friendly — warm and conversational, like talking to a respected colleague.',
  enthusiastic:
    'enthusiastic — high-energy and optimistic. Use exclamation marks sparingly (max 1).',
  thoughtful:
    'thoughtful — reflective and nuanced. Add a perspective the post itself did not cover.',
};

const LENGTH_CONSTRAINT: Record<LengthKey, string> = {
  brief: 'brief — 1 to 2 sentences, maximum 25 words total.',
  standard: 'standard — 3 to 4 sentences, between 30 and 50 words.',
  detailed: 'detailed — 5 to 7 sentences, between 60 and 90 words.',
};

const ONE_SHOT_EXAMPLE = `
Example:
Post: "Just shipped our first agent that uses MCP — tool composition is finally clicking."
Reply: Spent the last month wiring MCP into a C# server and the composability point is exactly right; the win is that the tools become reasoning surface area, not just I/O. What kinds of tools surprised you most when you composed them?
`.trim();

const DO_NOT_RULES = `
Do NOT:
- start with "Great post", "Thanks for sharing", "Love this", or any generic praise
- sign with your name or add "—<name>" at the end
- use emojis unless the original post uses them
- restate or summarize the post text — assume the reader just read it
- use marketing buzzwords ("synergy", "leverage", "unlock", "game-changer")
- begin with "I" (start with the substance, not yourself)
`.trim();

// ─── buildCommentPrompt ─────────────────────────────────────────────────────

export interface BuildCommentPromptInput {
  profile: ProfileContext;
  post: ParsedPost;
  tone: ToneKey;
  length: LengthKey;
}

export function buildCommentPrompt(input: BuildCommentPromptInput): {
  system: string;
  user: string;
} {
  const { profile, post, tone, length } = input;

  const system = [
    `You are drafting a LinkedIn comment for ${profile.fullName || 'the user'}.`,
    `Their positioning: ${profile.positioningSummary}`,
    '',
    `Tone: ${TONE_DESCRIPTION[tone]}`,
    `Length: ${LENGTH_CONSTRAINT[length]}`,
    '',
    DO_NOT_RULES,
    '',
    ONE_SHOT_EXAMPLE,
    '',
    'Output the reply text only. No preamble, no explanation, no quotes.',
  ].join('\n');

  const user = [
    `Post by ${post.authorName}${post.authorTitle ? ` (${post.authorTitle})` : ''}:`,
    '"""',
    post.text,
    '"""',
    '',
    'Write the reply.',
  ].join('\n');

  return { system, user };
}

// ─── buildConnectionNotePrompt ──────────────────────────────────────────────

export interface BuildConnectionNotePromptInput {
  profile: ProfileContext;
  target: {
    name: string;
    title: string;
    recentActivity: string;
  };
}

export function buildConnectionNotePrompt(input: BuildConnectionNotePromptInput): {
  system: string;
  user: string;
} {
  const { profile, target } = input;

  const system = [
    `You are drafting a LinkedIn connection request note for ${profile.fullName || 'the user'}.`,
    `Their positioning: ${profile.positioningSummary}`,
    '',
    'Constraints:',
    '- LinkedIn caps notes at 300 characters. Stay strictly under 300 characters.',
    "- Reference one concrete detail from the target's recent activity.",
    '- Do not pitch, do not ask for anything, do not flatter.',
    '- Sound like a peer reaching out, not a recruiter or salesperson.',
    '- One short paragraph. No greeting line ("Hi <name>,"), no sign-off.',
    '',
    'Output the note text only. No preamble, no quotes.',
  ].join('\n');

  const user = [
    `Target: ${target.name} — ${target.title}`,
    `Recent activity: ${target.recentActivity}`,
    '',
    'Write the note.',
  ].join('\n');

  return { system, user };
}

// ─── buildPositioningPrompt ─────────────────────────────────────────────────

export interface BuildPositioningPromptInput {
  headline: string;
  about: string;
  topSkills: string[];
  recentPostThemes: string[];
}

export function buildPositioningPrompt(input: BuildPositioningPromptInput): {
  system: string;
  user: string;
} {
  const system = [
    'You write tight positioning summaries for professionals.',
    'Output exactly 2 sentences. Maximum 40 words total.',
    'Sentence 1: what they do and for whom.',
    'Sentence 2: what makes their angle distinct (skill, focus, or approach).',
    'No buzzwords. No first person. No "passionate about". Write in third person, present tense.',
    'Output the 2 sentences only. No preamble, no explanation.',
  ].join('\n');

  const user = [
    `Headline: ${input.headline}`,
    `About: ${input.about}`,
    `Top skills: ${input.topSkills.join(', ')}`,
    `Recent post themes: ${input.recentPostThemes.join(', ')}`,
    '',
    'Write the positioning summary.',
  ].join('\n');

  return { system, user };
}

// ─── Phase C: Recommender + Post-draft + Weekly retro ──────────────────────

export interface BuildRecommenderPromptInput {
  profile: ProfileContext;
  cadence: {
    weakest: 'brand' | 'finding' | 'engaging' | 'building';
    progress: Record<
      'brand' | 'finding' | 'engaging' | 'building',
      { done: number; target: number }
    >;
  };
  topTopics: Array<{ topic: string; count: number }>;
  recentOutcomes: Array<{ topic?: string; likes?: number; replies?: number }>;
  ssiInsight: string;
  candidatePosts?: Array<{ id: string; authorName: string; text: string; topics?: string[] }>;
}

export function buildRecommenderPrompt(input: BuildRecommenderPromptInput): {
  system: string;
  user: string;
} {
  const system = [
    'You are a LinkedIn growth coach.',
    'Output 3 concrete actions for the user to take today, each tied to a specific SSI pillar.',
    'Bias toward the weakest pillar but mix in 1 action from another pillar to avoid burnout.',
    'For each action, write a 1-sentence reason that names a concrete signal from the data.',
    'Output strict JSON only — no prose, no markdown fences:',
    '{"cards": [{"action": "comment"|"post"|"invite"|"thread_reply", "pillar": "brand"|"finding"|"engaging"|"building", "title": "<imperative <=8 words>", "reason": "<one sentence>", "postId": "<urn or omit>"}]}',
    'Exactly 3 cards. No more, no fewer.',
  ].join('\n');

  const recentOutcomesLine =
    input.recentOutcomes.length === 0
      ? 'No outcomes tracked yet.'
      : input.recentOutcomes
          .slice(0, 5)
          .map(
            (o, i) =>
              `  ${i + 1}. topic=${o.topic ?? '?'} likes=${o.likes ?? '?'} replies=${o.replies ?? '?'}`,
          )
          .join('\n');

  const topicsLine =
    input.topTopics.length === 0
      ? 'No topics tracked.'
      : input.topTopics.map((t) => `${t.topic}(${t.count})`).join(', ');

  const candidatesLine =
    !input.candidatePosts || input.candidatePosts.length === 0
      ? 'No candidate feed posts.'
      : input.candidatePosts
          .slice(0, 6)
          .map(
            (p) =>
              `  - id=${p.id} author="${p.authorName}" topics=[${(p.topics ?? []).join(',')}] text="${p.text.slice(0, 140)}"`,
          )
          .join('\n');

  const user = [
    `Profile positioning: ${input.profile.positioningSummary}`,
    `Weakest pillar: ${input.cadence.weakest}`,
    `Cadence (done/target this week):`,
    `  brand=${input.cadence.progress.brand.done}/${input.cadence.progress.brand.target}`,
    `  finding=${input.cadence.progress.finding.done}/${input.cadence.progress.finding.target}`,
    `  engaging=${input.cadence.progress.engaging.done}/${input.cadence.progress.engaging.target}`,
    `  building=${input.cadence.progress.building.done}/${input.cadence.progress.building.target}`,
    `Topic distribution (last 14d): ${topicsLine}`,
    `Recent outcomes:`,
    recentOutcomesLine,
    `SSI trend: ${input.ssiInsight}`,
    `Candidate feed posts:`,
    candidatesLine,
    '',
    'Return the 3-card JSON now.',
  ].join('\n');

  return { system, user };
}

export interface BuildPostDraftPromptInput {
  profile: ProfileContext;
  weakest: 'brand' | 'finding' | 'engaging' | 'building';
  topTopics: Array<{ topic: string; count: number }>;
  underweightTopics: string[];
}

export function buildPostDraftPrompt(input: BuildPostDraftPromptInput): {
  system: string;
  user: string;
} {
  const system = [
    'You write LinkedIn post drafts for a professional.',
    'Output 3 distinct drafts. Each: 3–5 sentences, opening hook, concrete data or experience, end with one question.',
    'No hashtags. No emojis. No "Excited to share". Conversational but professional.',
    'Each draft targets a different angle (story, hot take, lesson learned).',
    'Output strict JSON only — no prose, no markdown fences:',
    '{"drafts": [{"angle": "story"|"hot_take"|"lesson", "topic": "<topic name>", "body": "<post text>"}]}',
    'Exactly 3 drafts.',
  ].join('\n');

  const topicsLine =
    input.topTopics.length === 0 ? 'none tracked' : input.topTopics.map((t) => t.topic).join(', ');
  const gapsLine = input.underweightTopics.length === 0 ? 'none' : input.underweightTopics.join(', ');

  const user = [
    `Profile positioning: ${input.profile.positioningSummary}`,
    `Headline: ${input.profile.headline}`,
    `Top skills: ${input.profile.topSkills.slice(0, 8).join(', ')}`,
    `User's frequent topics: ${topicsLine}`,
    `Topic gaps to explore: ${gapsLine}`,
    `Weakest SSI pillar: ${input.weakest}`,
    '',
    'Return the 3-draft JSON now.',
  ].join('\n');

  return { system, user };
}

export interface BuildWeeklyRetroInput {
  weekStartTs: number;
  prevProgress: Record<
    'brand' | 'finding' | 'engaging' | 'building',
    { done: number; target: number }
  >;
  ssiDelta: { brand?: number; finding?: number; engaging?: number; building?: number };
  streak: number;
}

const PILLAR_LABEL: Record<'brand' | 'finding' | 'engaging' | 'building', string> = {
  brand: 'posts',
  finding: 'invites',
  engaging: 'comments',
  building: 'thread replies',
};

/**
 * Rule-based weekly retro line — no AI. Pure function for cheap rendering.
 * Returns a one-sentence narrative for the popup retro card.
 */
export function buildWeeklyRetro(input: BuildWeeklyRetroInput): string {
  const pillars: Array<'brand' | 'finding' | 'engaging' | 'building'> = [
    'brand',
    'finding',
    'engaging',
    'building',
  ];
  const parts: string[] = [];
  for (const p of pillars) {
    const { done, target } = input.prevProgress[p];
    if (target === 0) continue;
    const mark = done >= target ? '✅' : '❌';
    parts.push(`${done}/${target} ${PILLAR_LABEL[p]} ${mark}`);
  }
  const ssiPieces = pillars
    .map((p) => {
      const d = input.ssiDelta[p];
      if (d === undefined || d === 0) return null;
      const sign = d > 0 ? '+' : '';
      return `${p} ${sign}${d.toFixed(1)}`;
    })
    .filter((x): x is string => x !== null);
  const ssiPart = ssiPieces.length > 0 ? ` · SSI ${ssiPieces.join(', ')}` : '';
  const streakPart =
    input.streak > 0 ? ` · Streak: ${input.streak} week${input.streak === 1 ? '' : 's'}` : '';
  return `Last week: ${parts.join(' · ')}${ssiPart}${streakPart}`;
}
