/**
 * Issue #28 — profile audit AI prompts.
 *
 * Two specialised strict-JSON prompts running in parallel:
 *   - buildProfileRewritePrompt: copy editor — produces paste-ready rewrites
 *     for failing audit items + always-on photoBanner/openToWork advisory.
 *     Static profile only; no SSI, no posts (they're noise for this task).
 *   - buildSsiStrategyPrompt: growth strategist — produces concrete tactical
 *     actions tied to the user's weakest SSI pillar + what they actually
 *     post/comment about. No profile rewrites here; that's the other call.
 *
 * Pure module — no I/O. Caller merges both responses for the UI.
 */

import type { UserProfile } from './lib/idb';
import type { AuditReport } from './profile-audit';
import type { SsiSnapshot } from './storage-schema';

// ── Caps (trimmed from initial version — only the highest-signal slices) ──
const ABOUT_CAP = 700;
const HEADLINE_CAP = 220;
const SKILL_LIST_CAP = 10;
const CURRENT_ROLE_DESC_CAP = 180;
const EDU_CAP = 1;
const GOALS_CAP = 240;

// SSI-strategy prompt caps.
const POST_TEXT_CAP = 150;
const POST_LIST_CAP = 3;
const COMMENT_TEXT_CAP = 110;
const COMMENT_ORIG_CAP = 60;
const COMMENT_LIST_CAP = 3;

function oneLine(s: string | undefined | null, cap: number): string {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim().slice(0, cap);
}

/**
 * Compact profile snapshot for the copy-editor call. Drops past experience
 * beyond the current role and keeps about/skills under tight caps — the
 * LLM doesn't need the full résumé to rewrite a headline.
 */
function formatProfileForRewrite(profile: UserProfile): string {
  const sections: string[] = [];
  sections.push(`Name: ${profile.name || '(unknown)'}`);
  sections.push(`Headline: ${oneLine(profile.headline, HEADLINE_CAP) || '(empty)'}`);
  if (profile.location) sections.push(`Location: ${profile.location}`);
  sections.push(
    `Skills (${(profile.skills ?? []).length}): ${
      (profile.skills ?? []).slice(0, SKILL_LIST_CAP).join(', ') || '(none)'
    }`,
  );
  sections.push(`About: ${oneLine(profile.about, ABOUT_CAP) || '(empty)'}`);

  const current = (profile.experience ?? [])[0];
  if (current) {
    const head = `- ${oneLine(current.title, 80) || '(role)'} at ${
      oneLine(current.company, 80) || '(company)'
    }${current.dateRange ? ` (${oneLine(current.dateRange, 40)})` : ''}`;
    const desc = oneLine(current.description ?? '', CURRENT_ROLE_DESC_CAP);
    sections.push(`Current role:\n${desc ? `${head} — ${desc}` : head}`);
  }

  const edu = (profile.education ?? []).slice(0, EDU_CAP);
  if (edu.length > 0) {
    sections.push(
      'Education:\n' +
        edu
          .map(
            (e) =>
              `- ${oneLine(e.school, 80)}${e.degree ? `, ${oneLine(e.degree, 60)}` : ''}${
                e.field ? `, ${oneLine(e.field, 60)}` : ''
              }`,
          )
          .join('\n'),
    );
  }
  return sections.join('\n');
}

function formatAuditState(audit: AuditReport): string {
  const failed = audit.checks.filter((c) => c.status === 'fail');
  const passed = audit.checks.filter((c) => c.status === 'pass').map((c) => c.id);
  const lines: string[] = [];
  if (failed.length === 0) {
    lines.push('FAIL: (none — every rule passes)');
  } else {
    lines.push('FAIL (rewrite required):');
    for (const c of failed) lines.push(`- ${c.id} (${c.severity}): ${c.label} — ${c.detail}`);
  }
  lines.push(`PASS (suggest a polish only if obviously improvable): ${passed.join(', ') || '(none)'}`);
  return lines.join('\n');
}

export interface BuildProfileRewritePromptInput {
  profile: UserProfile;
  audit: AuditReport;
  goals: string | null;
}

export function buildProfileRewritePrompt(input: BuildProfileRewritePromptInput): {
  system: string;
  user: string;
} {
  const { profile, audit, goals } = input;

  const system = [
    'You are a senior LinkedIn profile copy editor for a specific user.',
    "Return concrete, paste-ready rewrites — not generic 'add a summary' advice.",
    'For each FAIL item: rewrite from scratch with copy the user can paste directly.',
    'For PASS items: only emit a recommendation if the existing copy is clearly improvable',
    '  (vague verb, buzzwords, missing concrete impact). Otherwise skip that item.',
    'You may additionally emit a "headline" item with a sharper rewrite when warranted',
    '  (max 220 chars; LinkedIn cap). And an "about" rewrite up to 2000 chars when relevant.',
    'Always append these two advisory items:',
    '  - "photoBanner": one line on professional headshot + industry-relevant banner.',
    '  - "openToWork": only suggest switching public frame to Recruiters Only if it is likely on.',
    'Each item: {checkId, diagnosis (≤140 chars), suggestion (paste-ready), rationale (≤140 chars, ties to user\'s actual role/skills)}.',
    'No buzzwords. No em-dash padding. No restating the rule.',
    'Respond in English. Output strict JSON only — no prose, no markdown fences:',
    '{"recommendations":[{"checkId":"<id>","diagnosis":"<t>","suggestion":"<t>","rationale":"<t>"}]}',
  ].join('\n');

  const goalsLine = oneLine(goals ?? '', GOALS_CAP);
  const user = [
    '=== Profile ===',
    formatProfileForRewrite(profile),
    '',
    `=== Goals === ${goalsLine || '(not provided)'}`,
    '',
    '=== Audit state ===',
    formatAuditState(audit),
    '',
    'Return the recommendations JSON now.',
  ].join('\n');

  return { system, user };
}

// ─── SSI strategy prompt ────────────────────────────────────────────────────

function formatSsi(ssi: SsiSnapshot | null): string {
  if (!ssi) return '(no SSI snapshot captured yet)';
  const c = ssi.components;
  const pairs = Object.entries(c) as Array<[keyof typeof c, number]>;
  pairs.sort((a, b) => a[1] - b[1]);
  const weakest = pairs[0]?.[0] ?? 'unknown';
  return [
    `Total: ${ssi.total}/100 (industry ${ssi.industryRank}, network ${ssi.networkRank})`,
    `- establishBrand:       ${c.establishBrand}/25`,
    `- findRightPeople:      ${c.findRightPeople}/25`,
    `- engageWithInsights:   ${c.engageWithInsights}/25`,
    `- buildRelationships:   ${c.buildRelationships}/25`,
    `Weakest pillar: ${weakest}`,
  ].join('\n');
}

function formatOwnPosts(profile: UserProfile): string {
  const ownPosts = (profile.recentPosts ?? [])
    .filter((p) => p.isRepost !== true)
    .slice()
    .sort((a, b) => {
      const ea = (a.engagement?.likes ?? 0) + (a.engagement?.comments ?? 0);
      const eb = (b.engagement?.likes ?? 0) + (b.engagement?.comments ?? 0);
      return eb - ea;
    })
    .slice(0, POST_LIST_CAP);
  if (ownPosts.length === 0) return '(no recent posts captured)';
  return ownPosts
    .map((p) => {
      const eng = p.engagement
        ? ` [${p.engagement.likes ?? 0}❤ ${p.engagement.comments ?? 0}💬]`
        : '';
      return `- "${oneLine(p.text, POST_TEXT_CAP)}"${eng}`;
    })
    .join('\n');
}

function formatOwnComments(profile: UserProfile): string {
  const cs = (profile.recentComments ?? [])
    .slice()
    .sort((a, b) => {
      const tb = Date.parse(b.timestamp);
      const ta = Date.parse(a.timestamp);
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    })
    .slice(0, COMMENT_LIST_CAP);
  if (cs.length === 0) return '(no recent comments captured)';
  return cs
    .map(
      (c) =>
        `- on "${oneLine(c.originalPostText, COMMENT_ORIG_CAP)}" → "${oneLine(c.text, COMMENT_TEXT_CAP)}"`,
    )
    .join('\n');
}

export interface BuildSsiStrategyPromptInput {
  profile: UserProfile;
  ssi: SsiSnapshot | null;
  goals: string | null;
}

export function buildSsiStrategyPrompt(input: BuildSsiStrategyPromptInput): {
  system: string;
  user: string;
} {
  const { profile, ssi, goals } = input;

  const system = [
    "You are a LinkedIn growth strategist. Read the user's SSI breakdown and what they actually post/comment about.",
    'Produce 2–3 concrete tactical recommendations targeting their weakest SSI pillar AND the strongest revealed theme in their activity.',
    'Allowed checkIds:',
    '  - "ssi": one action tied to the weakest pillar. Be specific (which pillar, why, what to do this week).',
    '  - "engagementStrategy": one action grounded in their recent comments/posts — e.g. a topic to double down on, a sub-community to engage, a content angle that resonated.',
    '  - "networkGrowth": one action for who/how to connect — only if their pillar weakness or activity makes it useful.',
    "Each item's suggestion must be an action the user can take this week (e.g. 'Post 1 lesson-style update on RAG eval, citing your work at <company>'),",
    'NOT a profile rewrite (the other call handles copy).',
    'Each item: {checkId, diagnosis (≤140 chars), suggestion (paste-ready or step-by-step ≤500 chars), rationale (≤140 chars referencing concrete SSI numbers or specific post/comment)}.',
    'If SSI is missing, emit only an "engagementStrategy" item based on what they post about; skip the rest.',
    'No buzzwords. No em-dash padding. Respond in English.',
    'Output strict JSON only:',
    '{"recommendations":[{"checkId":"<id>","diagnosis":"<t>","suggestion":"<t>","rationale":"<t>"}]}',
  ].join('\n');

  const goalsLine = oneLine(goals ?? '', GOALS_CAP);
  const user = [
    `Name: ${profile.name || '(unknown)'}`,
    `Headline: ${oneLine(profile.headline, HEADLINE_CAP) || '(empty)'}`,
    '',
    '=== SSI breakdown ===',
    formatSsi(ssi),
    '',
    '=== Top own posts (sorted by engagement) ===',
    formatOwnPosts(profile),
    '',
    '=== Recent comments (sorted by date) ===',
    formatOwnComments(profile),
    '',
    `=== Goals === ${goalsLine || '(not provided)'}`,
    '',
    'Return the recommendations JSON now.',
  ].join('\n');

  return { system, user };
}
