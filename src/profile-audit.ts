/**
 * Profile audit — deterministic rule engine that flags LinkedIn "All-Star"
 * completeness gaps in the captured IDB UserProfile.
 *
 * Pure module: no network, no storage, no DOM. Trivially unit-testable.
 *
 * MVP scope (issue #28 — profile audit + AI rewrites):
 *   - Works on existing UserProfile fields only — no parser changes.
 *   - Photo / banner / openToWork are NOT detected in DOM; the LLM
 *     recommender appends advisory items for those independent of the score.
 *   - Industry is intentionally not checked (rarely surfaced in public DOM).
 */

import type { UserProfile } from './lib/idb';

export type AuditStatus = 'pass' | 'fail';
export type AuditSeverity = 'high' | 'med';

export type AuditCheckId =
  | 'currentPosition'
  | 'education'
  | 'skills'
  | 'about'
  | 'location'
  | 'connections';

export interface AuditCheck {
  id: AuditCheckId;
  status: AuditStatus;
  severity: AuditSeverity;
  label: string;
  detail: string;
}

export interface AuditReport {
  /** Each rule, in display order. */
  checks: AuditCheck[];
  /** Count of `pass` checks. */
  passed: number;
  /** Total number of checks. */
  total: number;
  /** 0..100 — used purely for the progress bar color, not a leaderboard. */
  score: number;
  /** Stable list of failed ids — used by the recommender to scope LLM rewrites. */
  failed: AuditCheckId[];
}

const ABOUT_MIN_CHARS = 50;
const SKILLS_MIN = 5;
const CONNECTIONS_MIN = 50;

export function auditProfile(profile: UserProfile): AuditReport {
  const checks: AuditCheck[] = [
    auditCurrentPosition(profile),
    auditEducation(profile),
    auditSkills(profile),
    auditAbout(profile),
    auditLocation(profile),
    auditConnections(profile),
  ];
  const passed = checks.filter((c) => c.status === 'pass').length;
  const total = checks.length;
  const score = Math.round((passed / total) * 100);
  const failed = checks.filter((c) => c.status === 'fail').map((c) => c.id);
  return { checks, passed, total, score, failed };
}

function auditCurrentPosition(p: UserProfile): AuditCheck {
  const top = (p.experience ?? [])[0];
  const title = (top?.title ?? '').trim();
  const company = (top?.company ?? '').trim();
  const ok = title.length > 0 && company.length > 0;
  return {
    id: 'currentPosition',
    severity: 'high',
    status: ok ? 'pass' : 'fail',
    label: 'Current position',
    detail: ok ? `${title} · ${company}` : 'no current role listed',
  };
}

function auditEducation(p: UserProfile): AuditCheck {
  const edu = (p.education ?? []).filter((e) => (e.school ?? '').trim().length > 0);
  const ok = edu.length > 0;
  return {
    id: 'education',
    severity: 'high',
    status: ok ? 'pass' : 'fail',
    label: 'Education',
    detail: ok ? `${edu[0].school}` : 'no school listed',
  };
}

function auditSkills(p: UserProfile): AuditCheck {
  const count = (p.skills ?? []).filter((s) => s.trim().length > 0).length;
  const ok = count >= SKILLS_MIN;
  return {
    id: 'skills',
    severity: 'high',
    status: ok ? 'pass' : 'fail',
    label: 'Skills',
    detail: ok ? `${count} listed` : `only ${count}/${SKILLS_MIN}`,
  };
}

function auditAbout(p: UserProfile): AuditCheck {
  const len = (p.about ?? '').trim().length;
  const ok = len >= ABOUT_MIN_CHARS;
  return {
    id: 'about',
    severity: 'high',
    status: ok ? 'pass' : 'fail',
    label: 'About section',
    detail: ok ? `${len} chars` : len === 0 ? 'empty' : `only ${len} chars`,
  };
}

function auditLocation(p: UserProfile): AuditCheck {
  const loc = (p.location ?? '').trim();
  const ok = loc.length > 0;
  return {
    id: 'location',
    severity: 'med',
    status: ok ? 'pass' : 'fail',
    label: 'Location',
    detail: ok ? loc : 'not set',
  };
}

function auditConnections(p: UserProfile): AuditCheck {
  const n = p.connectionsCount ?? 0;
  const ok = n >= CONNECTIONS_MIN;
  return {
    id: 'connections',
    severity: 'med',
    status: ok ? 'pass' : 'fail',
    label: 'Connections',
    detail: ok ? `${n >= 500 ? '500+' : n}` : `${n}/${CONNECTIONS_MIN}`,
  };
}
