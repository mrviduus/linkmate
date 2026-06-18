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
import { resolveTimestampMs } from './lib/relative-time';

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

// ─── Activity signals (separate from profile-completeness audit) ───────────
//
// The 6 audit checks above gate basic profile completeness. These signals
// surface ACTIVITY weakness — separate concept, doesn't count toward the
// audit score. Surfacing them resolves the "6/6 essentials but SSI 23"
// confusion: profile is complete, activity is not.

export type ActivitySignalId = 'ssi' | 'posts30d' | 'comments30d' | 'network500';
export type ActivitySignalStatus = 'ok' | 'low';

export interface ActivitySignal {
  id: ActivitySignalId;
  status: ActivitySignalStatus;
  label: string;
  detail: string;
  /** One-liner hint surfaced under the row when status is 'low'. */
  guidance: string;
}

const SSI_OK_THRESHOLD = 50;
const POSTS_30D_OK_THRESHOLD = 4;
const COMMENTS_30D_OK_THRESHOLD = 8;
const NETWORK_STRONG_THRESHOLD = 500;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function computeActivitySignals(
  profile: UserProfile,
  ssiTotal: number | null,
  now: number = Date.now(),
): ActivitySignal[] {
  const out: ActivitySignal[] = [];

  if (ssiTotal !== null) {
    const ok = ssiTotal >= SSI_OK_THRESHOLD;
    out.push({
      id: 'ssi',
      status: ok ? 'ok' : 'low',
      label: 'SSI score',
      detail: `${ssiTotal}/100 (target ≥${SSI_OK_THRESHOLD})`,
      guidance: ok
        ? ''
        : 'SSI below 50 caps LinkedIn feed reach. Post weekly + comment on industry leaders to lift it.',
    });
  }

  const threshold = now - THIRTY_DAYS_MS;
  const posts30d = countSinceTimestamp(
    profile.recentPosts ?? [],
    (p) => (p.isRepost ? null : p.timestamp),
    threshold,
    now,
  );
  out.push({
    id: 'posts30d',
    status: posts30d >= POSTS_30D_OK_THRESHOLD ? 'ok' : 'low',
    label: 'Posts in last 30d',
    detail: `${posts30d} (target ≥${POSTS_30D_OK_THRESHOLD})`,
    guidance:
      posts30d >= POSTS_30D_OK_THRESHOLD
        ? ''
        : 'Aim for 1 original post per week. Consistency builds the brand pillar.',
  });

  const comments30d = countSinceTimestamp(
    profile.recentComments ?? [],
    (c) => c.timestamp,
    threshold,
    now,
  );
  out.push({
    id: 'comments30d',
    status: comments30d >= COMMENTS_30D_OK_THRESHOLD ? 'ok' : 'low',
    label: 'Comments in last 30d',
    detail: `${comments30d} (target ≥${COMMENTS_30D_OK_THRESHOLD})`,
    guidance:
      comments30d >= COMMENTS_30D_OK_THRESHOLD
        ? ''
        : 'Comment ~2x/week on senior peers — biggest lever on engageWithInsights.',
  });

  // Connections >= 50 already gates audit.connections; here we additionally
  // surface the stronger 500+ target that actually moves SSI's network pillar.
  const n = profile.connectionsCount ?? 0;
  out.push({
    id: 'network500',
    status: n >= NETWORK_STRONG_THRESHOLD ? 'ok' : 'low',
    label: 'Network depth',
    detail: n >= NETWORK_STRONG_THRESHOLD ? '500+' : `${n} (target ≥${NETWORK_STRONG_THRESHOLD})`,
    guidance:
      n >= NETWORK_STRONG_THRESHOLD
        ? ''
        : 'Grow to 500+ connections — unlocks "500+" social proof and stronger SSI network rank.',
  });

  return out;
}

function countSinceTimestamp<T>(
  items: T[],
  getTs: (item: T) => string | null | undefined,
  thresholdMs: number,
  now: number,
): number {
  let n = 0;
  for (const it of items) {
    const ts = getTs(it);
    if (!ts) continue;
    const t = resolveTimestampMs(ts, now);
    if (t !== null && t >= thresholdMs) n++;
  }
  return n;
}
