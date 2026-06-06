/**
 * Issue #18 — AI feed scoring prompts.
 *
 * Pure builders for two strict-JSON prompts:
 *   - buildAiScoreBatchPrompt → score N feed posts 0..10 + 1–2 sentence "whyForYou"
 *
 * Mirrors the style of `src/prompt-builder.ts` (deterministic, no I/O).
 */

import type { UserProfile } from './lib/idb';
import { resolveTimestampMs } from './lib/relative-time';
import type { ParsedPost, ProfileContext } from './storage-schema';

const POST_TEXT_CAP = 280;
const TOP_SKILLS_CAP = 8;
const RECENT_THEMES_CAP = 6;

// IDB-profile background caps — keep additions under ~700 input tokens.
const EXPERIENCE_CAP = 3;
const EXPERIENCE_DESC_CAP = 150;
const RECENT_POSTS_CAP = 3;
const RECENT_POST_TEXT_CAP = 180;
const RECENT_COMMENTS_CAP = 3;
const RECENT_COMMENT_TEXT_CAP = 140;
const RECENT_COMMENT_ORIGINAL_CAP = 80;

function oneLine(s: string | undefined | null, cap: number): string {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim().slice(0, cap);
}

/**
 * Renders the rich IDB-side UserProfile (issue #16) as a "Your background"
 * prompt block: recent roles, the user's own recent posts (with engagement),
 * and recent comments (with the original post they replied to). Returns an
 * empty string when no profile is provided, so callers can interpolate
 * unconditionally.
 */
export function formatUserBackground(userProfile: UserProfile | null | undefined): string {
  if (!userProfile) return '';
  const sections: string[] = [];

  const experiences = (userProfile.experience ?? []).slice(0, EXPERIENCE_CAP);
  if (experiences.length > 0) {
    sections.push(
      'Background (most recent first):\n' +
        experiences
          .map((e) => {
            const head = `- ${oneLine(e.title, 80) || '(role)'} at ${oneLine(e.company, 80) || '(company)'}${
              e.dateRange ? ` (${oneLine(e.dateRange, 40)})` : ''
            }`;
            const desc = oneLine(e.description ?? '', EXPERIENCE_DESC_CAP);
            return desc ? `${head} — ${desc}` : head;
          })
          .join('\n')
    );
  }

  // Filter reposts FIRST — `recentPosts` includes both original posts and
  // reposts of others, but the surrounding "Your recent posts" framing
  // implies authorship. A repost surfaced as own work misleads the model.
  // Then sort by total engagement so we surface the user's most-resonant ones.
  const ownPosts = (userProfile.recentPosts ?? [])
    .filter((p) => p.isRepost !== true)
    .slice()
    .sort((a, b) => {
      const ea = (a.engagement?.likes ?? 0) + (a.engagement?.comments ?? 0);
      const eb = (b.engagement?.likes ?? 0) + (b.engagement?.comments ?? 0);
      return eb - ea;
    })
    .slice(0, RECENT_POSTS_CAP);
  if (ownPosts.length > 0) {
    sections.push(
      'Your recent posts (with engagement):\n' +
        ownPosts
          .map((p) => {
            // Defensive ?? 0 — schema says likes/comments are required when
            // engagement is present, but IDB persists across schema versions
            // so a stale row could violate the contract at runtime.
            const eng = p.engagement
              ? ` [${p.engagement.likes ?? 0}❤ ${p.engagement.comments ?? 0}💬]`
              : '';
            return `- "${oneLine(p.text, RECENT_POST_TEXT_CAP)}"${eng}`;
          })
          .join('\n')
    );
  }

  // Sort by parsed timestamp desc so "Recent comments" actually means recent.
  // Parser order is not guaranteed to be chronological.
  const ownComments = (userProfile.recentComments ?? [])
    .slice()
    .sort((a, b) => (resolveTimestampMs(b.timestamp) ?? 0) - (resolveTimestampMs(a.timestamp) ?? 0))
    .slice(0, RECENT_COMMENTS_CAP);
  if (ownComments.length > 0) {
    sections.push(
      'Your recent comments (and the post you replied to):\n' +
        ownComments
          .map(
            (c) =>
              `- on "${oneLine(c.originalPostText, RECENT_COMMENT_ORIGINAL_CAP)}" → "${oneLine(
                c.text,
                RECENT_COMMENT_TEXT_CAP
              )}"`
          )
          .join('\n')
    );
  }

  return sections.length > 0 ? `\n${sections.join('\n\n')}\n` : '';
}

function formatPostsForPrompt(posts: ParsedPost[], includeAuthorTitle: boolean): string {
  if (posts.length === 0) return '(none)';
  return posts
    .map((p, i) => {
      const text = (p.text || '').slice(0, POST_TEXT_CAP).replace(/\s+/g, ' ').trim();
      const authorBit =
        includeAuthorTitle && p.authorTitle ? `${p.authorName} · ${p.authorTitle}` : p.authorName;
      return `[${i + 1}] id=${p.id} author="${authorBit}" text="${text}"`;
    })
    .join('\n');
}

export interface BuildAiScoreBatchPromptInput {
  profile: ProfileContext;
  goals: string;
  posts: ParsedPost[];
  userProfile?: UserProfile | null;
}

export function buildAiScoreBatchPrompt(input: BuildAiScoreBatchPromptInput): {
  system: string;
  user: string;
} {
  const { profile, goals, posts, userProfile } = input;

  const system = [
    'You score LinkedIn feed posts for a specific user.',
    "Score each post 0..10 for how aligned it is with the user's positioning, background, and stated goals.",
    '10 = essential read for this user. 0 = irrelevant noise.',
    "Use the user's real work history, skills, and recent activity as grounding — not the positioning summary alone.",
    'For each post, write a 1–2 sentence "whyForYou" that:',
    "  - references at least one of the user's skills, themes, past roles, or stated goals,",
    '  - cites one concrete detail from the post (not a generic platitude),',
    '  - addresses the user in second person ("you").',
    'No marketing buzzwords. No restating the post.',
    'Output strict JSON only — no prose, no markdown fences:',
    '{"scores":[{"postId":"<urn>","aiScore":<int 0..10>,"whyForYou":"<text>"}, ...]}',
    'Exactly one entry per input post. Use the postId values given verbatim.',
  ].join('\n');

  const user = [
    `Profile positioning: ${profile.positioningSummary || '(none captured)'}`,
    `Top skills: ${(profile.topSkills ?? []).slice(0, TOP_SKILLS_CAP).join(', ') || '(none)'}`,
    `Recent themes: ${(profile.recentPostThemes ?? []).slice(0, RECENT_THEMES_CAP).join(', ') || '(none)'}`,
    `Goals: ${goals || profile.positioningSummary || '(none)'}`,
    formatUserBackground(userProfile),
    'Posts:',
    formatPostsForPrompt(posts, true),
    '',
    'Return the scores JSON now.',
  ].join('\n');

  return { system, user };
}
