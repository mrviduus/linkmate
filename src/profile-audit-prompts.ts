/**
 * Issue #28 — profile audit AI prompts.
 *
 * Strict-JSON prompt builder for personalised LinkedIn profile rewrites.
 * Pure module — no I/O. Mirrors the style of `ai-feed-prompts.ts`.
 *
 * Output contract: `{recommendations: [{checkId, diagnosis, suggestion, rationale}]}`
 * with one entry per failed audit check, PLUS two advisory entries
 * (`photoBanner`, `openToWork`) appended unconditionally — those are
 * never DOM-detected in the MVP scope.
 */

import type { UserProfile } from './lib/idb';
import type { AuditReport } from './profile-audit';

const ABOUT_CAP = 1200;
const HEADLINE_CAP = 220;
const SKILL_LIST_CAP = 12;
const EXPERIENCE_CAP = 3;
const EXPERIENCE_DESC_CAP = 180;
const EDUCATION_CAP = 2;

function oneLine(s: string | undefined | null, cap: number): string {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim().slice(0, cap);
}

function formatProfileForRewrite(profile: UserProfile): string {
  const sections: string[] = [];
  sections.push(`Name: ${profile.name || '(unknown)'}`);
  sections.push(`Headline: ${oneLine(profile.headline, HEADLINE_CAP) || '(empty)'}`);
  if (profile.location) sections.push(`Location: ${profile.location}`);
  sections.push(
    `Skills (${(profile.skills ?? []).length}): ${(profile.skills ?? []).slice(0, SKILL_LIST_CAP).join(', ') || '(none)'}`
  );
  sections.push(`About: ${oneLine(profile.about, ABOUT_CAP) || '(empty)'}`);

  const exps = (profile.experience ?? []).slice(0, EXPERIENCE_CAP);
  if (exps.length > 0) {
    sections.push(
      'Experience (most recent first):\n' +
        exps
          .map((e) => {
            const head = `- ${oneLine(e.title, 80) || '(role)'} at ${
              oneLine(e.company, 80) || '(company)'
            }${e.dateRange ? ` (${oneLine(e.dateRange, 40)})` : ''}`;
            const desc = oneLine(e.description ?? '', EXPERIENCE_DESC_CAP);
            return desc ? `${head} — ${desc}` : head;
          })
          .join('\n')
    );
  }

  const edu = (profile.education ?? []).slice(0, EDUCATION_CAP);
  if (edu.length > 0) {
    sections.push(
      'Education:\n' +
        edu
          .map(
            (e) =>
              `- ${oneLine(e.school, 80)}${e.degree ? `, ${oneLine(e.degree, 60)}` : ''}${
                e.field ? `, ${oneLine(e.field, 60)}` : ''
              }${e.dateRange ? ` (${oneLine(e.dateRange, 40)})` : ''}`
          )
          .join('\n')
    );
  }

  return sections.join('\n');
}

function formatGaps(audit: AuditReport): string {
  if (audit.failed.length === 0) {
    return '(no rule-based gaps; respond only with advisory items for photoBanner and openToWork)';
  }
  return audit.checks
    .filter((c) => c.status === 'fail')
    .map((c) => `- ${c.id} (${c.severity}): ${c.label} — ${c.detail}`)
    .join('\n');
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
    'You are a LinkedIn profile coach for a specific user.',
    "Given the user's full profile and a list of detected gaps, return concrete,",
    'rewritten copy the user can paste into LinkedIn — not generic advice.',
    'For each gap produce: a 1-line diagnosis, the exact suggested replacement text',
    '(headline ≤ 220 chars, about ≤ 2000 chars, experience bullets ≤ 5 items × 220 chars),',
    "and a 1-sentence rationale tied to the user's actual background.",
    'After the gap-driven items, ALWAYS append exactly two advisory items:',
    '  - checkId "photoBanner": remind the user to verify a professional headshot',
    '    + an industry-relevant background banner are uploaded.',
    '  - checkId "openToWork": if the user is job-searching, suggest switching',
    '    public "Open to Work" frame to Recruiters Only — public flag can lower',
    '    leverage with recruiters.',
    'Respond in English.',
    'No marketing buzzwords. No em-dash padding. Do not restate the rule.',
    'Output strict JSON only — no prose, no markdown fences:',
    '{"recommendations":[{"checkId":"<id>","diagnosis":"<text>","suggestion":"<text>","rationale":"<text>"}, ...]}',
  ].join('\n');

  const goalsLine = (goals ?? '').trim();
  const user = [
    'User profile:',
    formatProfileForRewrite(profile),
    '',
    `Goals / what they're optimising for: ${goalsLine || '(not provided)'}`,
    '',
    'Detected gaps:',
    formatGaps(audit),
    '',
    'Return the recommendations JSON now.',
  ].join('\n');

  return { system, user };
}
