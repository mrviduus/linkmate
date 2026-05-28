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
const PAST_ROLE_LIST_CAP = 3;

// SSI-strategy prompt caps.
const POST_TEXT_CAP = 150;
const POST_LIST_CAP = 3;
const COMMENT_TEXT_CAP = 110;
const COMMENT_ORIG_CAP = 60;
const COMMENT_LIST_CAP = 3;

// Shared "banned phrases" black-list — keeps copy out of LinkedIn cliché
// territory. The LLM sees this verbatim in BOTH prompts.
const BANNED_PHRASES = [
  'passionate', 'results-driven', 'team player', 'go-getter', 'synergy',
  'dynamic professional', 'proven track record', 'leverage (as verb)',
  'detail-oriented', 'strategic thinker', 'self-starter', 'thought leader',
  'changing the world', 'movers and shakers',
].join(', ');

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

  const allRoles = profile.experience ?? [];
  const current = allRoles[0];
  if (current) {
    const head = `- ${oneLine(current.title, 80) || '(role)'} at ${
      oneLine(current.company, 80) || '(company)'
    }${current.dateRange ? ` (${oneLine(current.dateRange, 40)})` : ''}`;
    const desc = oneLine(current.description ?? '', CURRENT_ROLE_DESC_CAP);
    sections.push(`Current role:\n${desc ? `${head} — ${desc}` : head}`);
  }
  // Past trajectory (titles + companies only — no descriptions) gives the LLM
  // narrative context for the rewrite without bloating tokens. Helps it spot
  // a story arc like "QA → Backend → ML → AI Engineer".
  const past = allRoles.slice(1, 1 + PAST_ROLE_LIST_CAP);
  if (past.length > 0) {
    sections.push(
      'Career trajectory (older first → newer):\n' +
        past
          .slice()
          .reverse()
          .map(
            (e) =>
              `- ${oneLine(e.title, 80) || '(role)'} at ${oneLine(e.company, 80) || '(company)'}${
                e.dateRange ? ` (${oneLine(e.dateRange, 40)})` : ''
              }`,
          )
          .join('\n'),
    );
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
  /** Previous suggestion stems to steer the model away from on regenerate. */
  avoidStems?: string[];
}

export function buildProfileRewritePrompt(input: BuildProfileRewritePromptInput): {
  system: string;
  user: string;
} {
  const { profile, audit, goals, avoidStems } = input;

  const system = [
    'ROLE: You are a senior LinkedIn profile copy editor reviewing one specific user\'s profile.',
    'This is career-impacting work — the user will paste your copy into LinkedIn verbatim.',
    'Generic, recycled advice is harmful. Every recommendation must reference at least one',
    'concrete detail from the user data below (a specific skill, project, company, year, role).',
    '',
    'LINKEDIN COPY BEST PRACTICES (apply these implicitly, never cite them):',
    '- Headline (≤220 chars): pattern is "[Specialty] | [Concrete value to a stakeholder]',
    '  | [Optional: years of experience or signature project]." Avoid the job title alone.',
    '- About (≤2000 chars): line 1 IS the preview — must hook in ≤180 chars stating who they help',
    '  and the outcome they create. Then 2-4 short paragraphs: what they do, proof (metrics or named',
    '  projects), and one CTA (book a call, DM about X). No "I am passionate about" openers.',
    '- Experience bullets: STAR-shape — what was the situation, what did THEY do, what was the',
    '  measurable result. Numbers beat adjectives. Verbs lead each bullet.',
    `- Banned phrases (never use, never recommend): ${BANNED_PHRASES}.`,
    '',
    'OUTPUT RULES:',
    '1. For each FAIL audit item: write a from-scratch rewrite the user can paste directly.',
    '2. ALWAYS evaluate the headline (emit a "headline" item) unless the current one already',
    '   follows the pattern above AND cites a concrete specialty. Headline is the highest-leverage',
    '   field on LinkedIn — never skip without a specific reason.',
    '3. For other PASS items: only emit a recommendation if you can name a SPECIFIC fix',
    '   (verb X → Y, add metric Z, cut buzzword W). If you cannot, skip that item entirely.',
    '4. ALWAYS emit "photoBanner" — but tailor it to the user\'s industry/skills',
    '   (e.g. for an AI engineer: "background banner showing model architecture, prompt flow,',
    '   or your tooling stack"; not "industry-relevant banner").',
    '5. Emit "openToWork" ONLY if the user\'s goals mention job-hunting or the headline indicates',
    '   active search. Otherwise skip it — irrelevant advice destroys trust.',
    '',
    'EVERY ITEM:',
    '{"checkId","diagnosis","suggestion","rationale"}',
    '- diagnosis (≤140 chars): name the specific weakness — quote the offending phrase if present.',
    '- suggestion: paste-ready copy. Headline ≤220 chars. About ≤2000. Bullets ≤5 × 220 chars.',
    '- rationale (≤140 chars): MUST cite ONE concrete user detail (skill, role, company, year).',
    '  Generic "ties to your background" is forbidden.',
    '',
    'BEFORE EMITTING each item, silently ask: "Could this exact text apply to any senior person?"',
    'If yes, rewrite to anchor it in user-specific evidence.',
    '',
    'Respond in English. Output strict JSON only — no prose, no markdown fences:',
    '{"recommendations":[{"checkId":"<id>","diagnosis":"<t>","suggestion":"<t>","rationale":"<t>"}]}',
  ].join('\n');

  const goalsLine = oneLine(goals ?? '', GOALS_CAP);
  const userParts: string[] = [
    '=== Profile ===',
    formatProfileForRewrite(profile),
    '',
    `=== Goals === ${goalsLine || '(not provided)'}`,
    '',
    '=== Audit state ===',
    formatAuditState(audit),
  ];
  if (avoidStems && avoidStems.length > 0) {
    userParts.push('', '=== Previous suggestion openings (write FRESH angles, do not repeat these) ===');
    for (const s of avoidStems) userParts.push(`- ${oneLine(s, 100)}`);
  }
  userParts.push('', 'Return the recommendations JSON now.');
  return { system, user: userParts.join('\n') };
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
  avoidStems?: string[];
}

export function buildSsiStrategyPrompt(input: BuildSsiStrategyPromptInput): {
  system: string;
  user: string;
} {
  const { profile, ssi, goals, avoidStems } = input;

  const system = [
    'ROLE: You are a LinkedIn growth strategist coaching one specific user this week.',
    'Career-impacting — recommendations must be concrete, falsifiable actions with numbers.',
    'Vague tactics like "engage authentically" or "post more often" are harmful and forbidden.',
    '',
    'WHAT MOVES EACH SSI PILLAR (apply these implicitly):',
    '- establishBrand (≤25): profile completeness, posting cadence, posts with media/articles,',
    '  consistent topic focus. Lever: 1 original post / week with media + 1 article / month.',
    '- findRightPeople (≤25): targeted connection invites with notes, LinkedIn Recruiter / Sales',
    '  Nav-style searches, following industry hashtags. Lever: 5 targeted invites / week to people',
    '  in the user\'s target industry, with a 1-line personalised note citing a shared topic.',
    '- engageWithInsights (≤25): commenting on others\' posts with original takes, reacting,',
    '  sharing with commentary. Lever: 2 substantive comments / week on senior peers\' posts',
    '  (3+ sentences, original POV, no "great post!" replies).',
    '- buildRelationships (≤25): connection acceptance ratio, DMs to existing connections,',
    '  replies to your own content. Lever: DM 2 existing connections / week with a specific',
    '  conversation starter tied to their recent activity.',
    '',
    'OUTPUT RULES:',
    'Produce 2–3 items. Allowed checkIds:',
    '  - "ssi": the one tactical action that moves the WEAKEST pillar this week. Must name the',
    '    pillar, cite its current /25 score, and give an exact weekly count (e.g. "Comment on 2',
    '    posts from senior eng-lead voices about <user topic>"). Tie it to the lever above.',
    '  - "engagementStrategy": a content/engagement bet grounded in the user\'s OWN top post or',
    '    a recurring theme from their comments. MUST quote (in ≤80 chars) at least one specific',
    '    post or comment from their history and explain how to double down on what worked.',
    '  - "networkGrowth": a who/how-to-connect action. Emit ONLY if connectionsCount < 500 OR',
    '    findRightPeople < 15. Name a SPECIFIC archetype (role/seniority/industry) to target.',
    '',
    'BANNED actions (never recommend): "post more often", "engage authentically", "be consistent",',
    '"build your personal brand", "leverage your network", "share insights regularly".',
    `BANNED phrases (never use): ${BANNED_PHRASES}.`,
    '',
    'EVERY ITEM:',
    '{"checkId","diagnosis","suggestion","rationale"}',
    '- diagnosis (≤140 chars): name the specific gap with a number — e.g. "engageWithInsights',
    '  10/25 is the weakest pillar; you\'ve made 1 comment in 30d."',
    '- suggestion (≤500 chars): step-by-step weekly action. Include exact counts, target audience,',
    '  and a topic angle drawn from the user\'s skills or posts.',
    '- rationale (≤140 chars): cite ONE SSI number AND/OR one specific post/comment of theirs.',
    '  Generic rationale is forbidden.',
    '',
    'If SSI snapshot is missing: emit ONLY an "engagementStrategy" item grounded in the user\'s',
    'recent posts/comments; skip "ssi" and "networkGrowth".',
    '',
    'Respond in English. Output strict JSON only — no prose, no markdown fences:',
    '{"recommendations":[{"checkId":"<id>","diagnosis":"<t>","suggestion":"<t>","rationale":"<t>"}]}',
  ].join('\n');

  const goalsLine = oneLine(goals ?? '', GOALS_CAP);
  const userParts: string[] = [
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
  ];
  if (avoidStems && avoidStems.length > 0) {
    userParts.push('', '=== Previous tactic openings (propose FRESH actions, do not repeat these) ===');
    for (const s of avoidStems) userParts.push(`- ${oneLine(s, 100)}`);
  }
  userParts.push('', 'Return the recommendations JSON now.');
  return { system, user: userParts.join('\n') };
}
