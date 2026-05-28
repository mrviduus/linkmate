/**
 * Issue #16 — IndexedDB store for the full LinkedIn UserProfile snapshot.
 *
 * Single-object store under fixed key 'current'. Each Capture overwrites.
 * Schema/version owned by src/lib/idb.ts (DB_VERSION=2, store 'userProfile').
 */

import { getDb, type UserProfile } from './lib/idb';
import type { ProfileContext } from './storage-schema';

export const USER_PROFILE_KEY = 'current';
export const USER_PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

const PROFILE_CTX_ABOUT_CAP = 1500;
const PROFILE_CTX_TOP_SKILLS_CAP = 10;

/**
 * Issue #18 follow-up — bridge the rich IDB UserProfile (issue #16) to the
 * slim ProfileContext shape that the engagement-queue heuristic scorer and
 * other legacy callers expect.
 *
 * Pure derivation; never throws. Used by background handlers when the
 * chrome.storage.local ProfileContext is missing but the IDB snapshot is
 * present (e.g. user has full-capture on but no OpenAI key, so the
 * positioning-summary step was skipped during capture).
 *
 *   - `positioningSummary` is left empty — AI prompts already fall back to
 *     `formatUserBackground(userProfile)` for grounding, and the heuristic
 *     scorer doesn't consume positioningSummary at all.
 *   - `recentPostThemes` is left empty — the rich `recentPosts` (with text +
 *     engagement) is far better signal and is passed separately to AI prompts
 *     via formatUserBackground.
 */
export function profileContextFromUserProfile(up: UserProfile): ProfileContext {
  const capturedAtMs = Date.parse(up.capturedAt);
  return {
    fullName: up.name ?? '',
    headline: up.headline ?? '',
    about: (up.about ?? '').slice(0, PROFILE_CTX_ABOUT_CAP),
    topSkills: (up.skills ?? []).slice(0, PROFILE_CTX_TOP_SKILLS_CAP),
    recentPostThemes: [],
    positioningSummary: '',
    capturedAt: Number.isFinite(capturedAtMs) ? capturedAtMs : Date.now(),
  };
}

export async function saveUserProfile(profile: UserProfile): Promise<void> {
  const db = await getDb();
  await db.put('userProfile', profile, USER_PROFILE_KEY);
}

export async function getUserProfile(): Promise<UserProfile | null> {
  const db = await getDb();
  const row = await db.get('userProfile', USER_PROFILE_KEY);
  return row ?? null;
}

export async function clearUserProfile(): Promise<void> {
  const db = await getDb();
  await db.delete('userProfile', USER_PROFILE_KEY);
}

export function isFresh(p: UserProfile, ttlMs = USER_PROFILE_TTL_MS, now = Date.now()): boolean {
  const t = Date.parse(p.capturedAt);
  if (!Number.isFinite(t)) return false;
  return now - t < ttlMs;
}

/**
 * Merge a fresh scrape with the existing IDB snapshot.
 *
 * Strategy:
 *   - Non-array fields (name, headline, about, skills, experience, …) come
 *     from `fresh` — latest scrape wins.
 *   - `recentPosts` / `recentComments` are merged by `id` (LinkedIn URN).
 *     Fresh entry wins on duplicate (fresher engagement metrics, edited text).
 *     Entries that exist only in `existing` are PRESERVED — this is the whole
 *     point of merge: accumulate history across scrapes even when LinkedIn
 *     stops showing old activity in the feed.
 *   - Order: fresh items first (in their scrape order), then leftover old
 *     items appended after.
 *
 * Pure function — no IDB calls. Pass `null` for `existing` on first capture.
 */
export function mergeUserProfile(
  existing: UserProfile | null,
  fresh: UserProfile
): UserProfile {
  if (!existing) return fresh;
  return {
    ...fresh,
    recentPosts: mergeById(fresh.recentPosts, existing.recentPosts),
    recentComments: mergeById(fresh.recentComments, existing.recentComments),
  };
}

function mergeById<T extends { id: string }>(fresh: T[], existing: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of fresh) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  for (const item of existing) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
