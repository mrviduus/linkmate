/**
 * Cadence — rolling 7d quota tracking + streak math.
 *
 * Reads action log + targets, computes per-pillar progress, identifies the
 * weakest pillar (gap = target - actual), and updates the streak counter
 * on week-boundary crossings.
 *
 * Pure-ish: depends on action-log (IDB read) + storage-schema (chrome.storage),
 * but has no UI. Popup + recommender consume the returned shape.
 */

import { recent7d } from './action-log';
import {
  getCadenceStreak,
  getCadenceTargets,
  setCadenceStreak,
  type CadenceTargets,
} from './storage-schema';
import type { Pillar } from './lib/idb';

export type WeeklyProgress = Record<Pillar, { done: number; target: number; pct: number }>;

/** Compute pillar-wise progress over the past 7d. Only counts submitted=true actions. */
export async function weeklyProgress(): Promise<WeeklyProgress> {
  const [targets, actions] = await Promise.all([getCadenceTargets(), recent7d()]);
  const counts: Record<Pillar, number> = { brand: 0, finding: 0, engaging: 0, building: 0 };
  for (const a of actions) {
    if (!a.submitted) continue;
    counts[a.pillar] += 1;
  }
  return {
    brand: pack(counts.brand, targets.brand),
    finding: pack(counts.finding, targets.finding),
    engaging: pack(counts.engaging, targets.engaging),
    building: pack(counts.building, targets.building),
  };
}

function pack(done: number, target: number): { done: number; target: number; pct: number } {
  const pct = target === 0 ? 100 : Math.min(100, Math.round((done / target) * 100));
  return { done, target, pct };
}

/** Pillar with lowest pct of target met. Ties broken by larger absolute gap. */
export function weakestPillar(progress: WeeklyProgress): Pillar {
  const pillars: Pillar[] = ['brand', 'finding', 'engaging', 'building'];
  return pillars.reduce((min, p) => {
    const a = progress[p];
    const b = progress[min];
    if (a.pct < b.pct) return p;
    if (a.pct === b.pct && a.target - a.done > b.target - b.done) return p;
    return min;
  }, pillars[0]);
}

/** True iff every pillar with a positive target has hit it. */
export function allQuotasHit(progress: WeeklyProgress, targets: CadenceTargets): boolean {
  const keys: Pillar[] = ['brand', 'finding', 'engaging', 'building'];
  return keys.every((k) => targets[k] === 0 || progress[k].done >= progress[k].target);
}

/**
 * Streak update: called at most once per 7d boundary. Hard cutoff — first miss
 * resets streak to 0. Window "ends" at the moment of the check; next check
 * eligible after `lastWindowEnd + 7d`.
 */
export async function maybeAdvanceStreak(now = Date.now()): Promise<{
  streak: number;
  advanced: boolean;
}> {
  const [streak, targets, progress] = await Promise.all([
    getCadenceStreak(),
    getCadenceTargets(),
    weeklyProgress(),
  ]);
  const SEVEN = 7 * 24 * 60 * 60 * 1000;
  if (streak.lastWindowEnd !== 0 && now - streak.lastWindowEnd < SEVEN) {
    return { streak: streak.count, advanced: false };
  }
  if (allQuotasHit(progress, targets)) {
    const next = { count: streak.count + 1, lastWindowEnd: now };
    await setCadenceStreak(next);
    return { streak: next.count, advanced: true };
  } else {
    const next = { count: 0, lastWindowEnd: now };
    await setCadenceStreak(next);
    return { streak: 0, advanced: true };
  }
}
