/**
 * Issue #16 — IndexedDB store for the full LinkedIn UserProfile snapshot.
 *
 * Single-object store under fixed key 'current'. Each Capture overwrites.
 * Schema/version owned by src/lib/idb.ts (DB_VERSION=2, store 'userProfile').
 */

import { getDb, type UserProfile } from './lib/idb';

export const USER_PROFILE_KEY = 'current';
export const USER_PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

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
