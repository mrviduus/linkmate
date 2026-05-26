/**
 * T021 — Prompt builder (Phase A foundation).
 *
 * Pure, deterministic prompt templates for LinkedIn engagement drafts.
 * No side effects, no I/O, no WebLLM calls — that's the caller's job.
 *
 * Three exports:
 *   - buildCommentPrompt  → engagement-queue draft for a feed post
 *   - buildConnectionNotePrompt → ≤300-char connection note for a target profile
 *   - buildPositioningPrompt → 2-sentence positioning summary used in every other prompt
 *
 * All return { system, user } so callers can pass each to WebLLM as separate roles.
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
