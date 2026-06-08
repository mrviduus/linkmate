/**
 * Issue #18 — AI feed analyzer.
 *
 * Orchestrates batched per-post AI scoring. Lives in the background SW.
 * Pure module — provider + clock injected so tests can drive deterministically.
 *
 * Caching:
 *   - in-memory `Map<postId, CachedScore>` scoped to this module
 *   - cacheKey = `${profile.capturedAt}|djb2(goals)|${userProfile?.capturedAt}`
 *     — clears on profile re-capture or goals change via clearAiCache()
 *   - TTL 1h, lazy eviction on lookup
 *
 * Strict-JSON parsing mirrors `recommender.parseCards` (anti-hallucination
 * postId guard, clamp + slice). Returns null on any total parse failure so
 * callers can fall back to "—" in UI.
 */

import { buildAiScoreBatchPrompt } from './ai-feed-prompts';
import type { UserProfile } from './lib/idb';
import type { InferenceProvider } from './providers/inference-provider';
import { isPromoContent, STALE_AGE_MS } from './relevance-scorer';
import type { ParsedPost, ProfileContext } from './storage-schema';

export interface AiScoredPost {
  postId: string;
  aiScore: number; // 0..10 (int)
  whyForYou: string; // ≤240 chars
}

export const AI_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
export const WHY_FOR_YOU_MAX_LEN = 240;
const SCORE_BATCH_MAX_TOKENS = 900;
const SCORE_BATCH_TIMEOUT_MS = 45_000;

/** 0..10 cap applied to stale posts in the overlay (mirrors the relevance-scorer floor). */
export const STALE_AI_SCORE_CAP = 3;
/** Promo multiplier for the 0..10 overlay score (mirrors PROMO_PENALTY_FACTOR). */
export const PROMO_AI_PENALTY_FACTOR = 0.4;

/**
 * Deterministic age/promo penalty for the AI overlay score, mirroring
 * relevance-scorer (issue #64). Applied as post-processing so the LLM can't
 * hand a 1-week-old product promo an 8/10.
 */
export function applyFeedPenalties(aiScore: number, post: ParsedPost, now: number): number {
  let score = aiScore;
  if (isPromoContent(post.text)) {
    score = Math.round(score * PROMO_AI_PENALTY_FACTOR);
  }
  if (now - post.postedAt > STALE_AGE_MS) {
    score = Math.min(score, STALE_AI_SCORE_CAP);
  }
  return Math.max(0, Math.min(10, score));
}

/** Apply penalties across a batch given the originating posts (by id). */
function penalizeScores(
  scores: AiScoredPost[],
  posts: ParsedPost[],
  now: number
): AiScoredPost[] {
  const byId = new Map(posts.map((p) => [p.id, p]));
  return scores.map((s) => {
    const post = byId.get(s.postId);
    if (!post) return s;
    return { ...s, aiScore: applyFeedPenalties(s.aiScore, post, now) };
  });
}

// ─── Cache (module-scope, in-memory) ───────────────────────────────────────

interface CachedScore {
  key: string;
  aiScore: number;
  whyForYou: string;
  expiresAt: number;
}

const scoreCache = new Map<string, CachedScore>();

export function clearAiCache(): void {
  scoreCache.clear();
}

/** Wall-clock indirection so tests can drive cache TTL deterministically via __testing__. */
let nowFn: () => number = () => Date.now();
function nowMs(): number {
  return nowFn();
}

// ─── Goals + cache key ──────────────────────────────────────────────────────

export function resolveGoals(profile: ProfileContext, override: string | null): string {
  const trimmed = (override ?? '').trim();
  if (trimmed.length > 0) return trimmed;
  return (profile.positioningSummary ?? '').trim();
}

/** djb2 — same family used elsewhere in the extension; sufficient for cache busting. */
export function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function buildCacheKey(
  profile: ProfileContext,
  goals: string,
  userProfile?: UserProfile | null
): string {
  // IDB-profile capturedAt is an ISO string; include it so a fresh full-
  // profile re-capture invalidates the cache without needing an explicit
  // clearAiCache() at every IDB write site.
  const idbStamp = userProfile?.capturedAt ?? '';
  return `${profile.capturedAt}|${djb2(goals)}|${idbStamp}`;
}

// ─── Batched per-post scoring ──────────────────────────────────────────────

export interface AiScoreBatchInput {
  provider: InferenceProvider;
  profile: ProfileContext;
  goalsOverride: string | null;
  posts: ParsedPost[];
  userProfile?: UserProfile | null;
}

export async function aiScoreBatch(input: AiScoreBatchInput): Promise<AiScoredPost[]> {
  const { provider, profile, goalsOverride, posts, userProfile } = input;
  if (posts.length === 0) return [];

  const goals = resolveGoals(profile, goalsOverride);
  const key = buildCacheKey(profile, goals, userProfile);
  const now = nowMs();

  // Partition: cached vs needs scoring.
  const fromCache: AiScoredPost[] = [];
  const uncached: ParsedPost[] = [];
  for (const post of posts) {
    const hit = scoreCache.get(post.id);
    if (hit && hit.key === key && hit.expiresAt > now) {
      fromCache.push({ postId: post.id, aiScore: hit.aiScore, whyForYou: hit.whyForYou });
    } else {
      if (hit) scoreCache.delete(post.id); // lazy evict stale/wrong-key
      uncached.push(post);
    }
  }

  if (uncached.length === 0) return penalizeScores(fromCache, posts, now);

  const { system, user } = buildAiScoreBatchPrompt({
    profile,
    goals,
    posts: uncached,
    userProfile,
  });
  const raw = await provider.generate({
    system,
    user,
    maxTokens: SCORE_BATCH_MAX_TOKENS,
    temperature: 0.3,
    topP: 0.9,
    timeoutMs: SCORE_BATCH_TIMEOUT_MS,
  });

  const allowed = new Set(uncached.map((p) => p.id));
  const parsed = parseAiScores(raw, allowed);
  if (parsed === null) {
    // Total failure — propagate so caller can respond {ok:false,reason:'parse'}.
    throw new AiParseError('Malformed JSON from AI scorer');
  }

  // Cache and merge.
  const expiresAt = now + AI_CACHE_TTL_MS;
  for (const r of parsed) {
    scoreCache.set(r.postId, {
      key,
      aiScore: r.aiScore,
      whyForYou: r.whyForYou,
      expiresAt,
    });
  }
  return penalizeScores([...fromCache, ...parsed], posts, now);
}

export class AiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiParseError';
  }
}

// ─── Parser ────────────────────────────────────────────────────────────────

interface RawScore {
  postId?: unknown;
  aiScore?: unknown;
  whyForYou?: unknown;
}

export function parseAiScores(raw: string, allowed: Set<string>): AiScoredPost[] | null {
  try {
    const parsed = JSON.parse(raw) as { scores?: RawScore[] };
    if (!parsed.scores || !Array.isArray(parsed.scores)) return null;
    const out: AiScoredPost[] = [];
    const seen = new Set<string>();
    for (const s of parsed.scores) {
      const postId = typeof s.postId === 'string' ? s.postId : '';
      if (!postId || !allowed.has(postId) || seen.has(postId)) continue;
      const rawScore =
        typeof s.aiScore === 'number' && Number.isFinite(s.aiScore) ? s.aiScore : NaN;
      if (Number.isNaN(rawScore)) continue;
      const aiScore = Math.max(0, Math.min(10, Math.round(rawScore)));
      const whyForYou =
        typeof s.whyForYou === 'string' ? s.whyForYou.slice(0, WHY_FOR_YOU_MAX_LEN) : '';
      out.push({ postId, aiScore, whyForYou });
      seen.add(postId);
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// ─── Test hooks ────────────────────────────────────────────────────────────

export const __testing__ = {
  setNow(fn: () => number): void {
    nowFn = fn;
  },
  resetNow(): void {
    nowFn = () => Date.now();
  },
  cacheSize(): number {
    return scoreCache.size;
  },
};
