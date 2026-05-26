/**
 * T101 — Relevance scorer (Phase B, US1).
 *
 * Pure functions, deterministic, zero I/O. Single export `scoreRelevance` plus
 * sub-scorers exported for unit-test coverage targeting (plan.md: ≥95% line +
 * branch).
 *
 * Formula (plan.md §"Relevance Scoring Algorithm"):
 *   score = (
 *     topicMatch     * 0.40 +   // Jaccard between post tokens and profile interests
 *     authorTier     * 0.20 +   // by follower count bucket
 *     relationship   * 0.15 +   // 1st/2nd/3rd/follow-only degree
 *     recency        * 0.10 +   // linear decay over 24h
 *     engagement     * 0.10 +   // log-normalized (likes + 5*comments)
 *     diversityBonus * 0.05     // 1 if author not seen recently
 *   ) * 100
 *
 * Penalties:
 *   - alreadyEngaged / isOwn / dismissed → score 0, category skip
 *   - obviousAiContent → score *= 0.5
 *
 * Buckets:
 *   - score ≥ 70 → engage_now
 *   - 40 ≤ score < 70 → consider
 *   - score < 40 → skip
 */

import type {
  ConnectionDegree,
  FollowerTier,
  ParsedPost,
  ProfileContext,
  RelevanceScore,
  ScoreCategory,
} from './storage-schema';

// ─── Token utils ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'over',
  'about',
  'have',
  'has',
  'had',
  'are',
  'was',
  'were',
  'will',
  'would',
  'could',
  'should',
  'our',
  'you',
  'your',
  'their',
  'they',
  'them',
  'his',
  'her',
  'its',
  'who',
  'what',
  'when',
  'where',
  'how',
  'why',
  'all',
  'any',
  'just',
  'than',
  'then',
  'there',
  'here',
  'now',
  'one',
  'two',
  'too',
  'but',
  'not',
  'also',
  'more',
  'most',
  'some',
  'such',
  'only',
  'own',
  'same',
  'each',
]);

/** Lowercase, drop punctuation, drop stop-words, drop tokens shorter than 3. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

/** |A ∩ B| / |A ∪ B|. Empty inputs → 0. Inputs are deduped internally. */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ─── Sub-scorers ────────────────────────────────────────────────────────────

export function authorTierScore(tier: FollowerTier): number {
  switch (tier) {
    case 'lt_1k':
      return 0.2;
    case '1k_10k':
      return 0.5;
    case '10k_100k':
      return 0.8;
    case 'gt_100k':
      return 1.0;
    case 'unknown':
      return 0.4;
  }
}

export function relationshipScore(degree: ConnectionDegree): number {
  switch (degree) {
    case '1st':
      return 1.0;
    case '2nd':
      return 0.6;
    case '3rd':
      return 0.3;
    case 'follow-only':
      return 0.4;
    case 'unknown':
      return 0.4;
  }
}

/**
 * Linear decay over 24 hours. 0h→1.0, 12h→0.5, 24h+→0.
 * Future timestamps (clock skew) clamp to 1.0.
 */
export function recencyScore(postedAt: number, now: number): number {
  const ageMs = now - postedAt;
  if (ageMs <= 0) return 1;
  const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
  if (ageMs >= TWENTY_FOUR_H) return 0;
  return 1 - ageMs / TWENTY_FOUR_H;
}

/**
 * Log-normalized engagement. Weighted units = likes + 5 * comments
 * (comments cost more, signal richer engagement). Capped at 1.0.
 */
export function engagementScore(likes: number, comments: number): number {
  const weighted = Math.max(0, likes) + 5 * Math.max(0, comments);
  if (weighted === 0) return 0;
  // log10(1 + weighted) / 4 — 10000 weighted units → ~1.0
  const raw = Math.log10(1 + weighted) / 4;
  return Math.min(1, raw);
}

/** 1.0 if authorUrn NOT in recent list (diverse), else 0.0. */
export function diversityBonus(authorUrn: string, recentlyDisplayedAuthors: string[]): number {
  return recentlyDisplayedAuthors.includes(authorUrn) ? 0 : 1;
}

// ─── AI-content heuristic ───────────────────────────────────────────────────

const AI_BUZZWORDS = [
  'leverage',
  'synergies',
  'synergy',
  'transformative',
  'game-changer',
  'game changer',
  'unlock potential',
  'paradigm shift',
  'cutting-edge',
  'best-in-class',
  'next-level',
];

/**
 * Heuristic detector for AI-generated / spammy marketing posts. Triggers if:
 * - "Here are N (key) (takeaways|insights|tips)" intro
 * - "ever-evolving landscape" / "today's ever-changing"
 * - ≥2 buzzwords from AI_BUZZWORDS
 */
export function obviousAiContent(text: string): boolean {
  if (!text || text.length < 20) return false;
  const lower = text.toLowerCase();

  if (/here are \d+\s+(key\s+)?(takeaways|insights|tips|reasons|ways|things)/i.test(text)) {
    return true;
  }
  if (/ever[- ]evolving (landscape|world|environment)/i.test(text)) return true;
  if (/in today['']?s ever[- ]changing/i.test(text)) return true;

  let buzzwordHits = 0;
  for (const word of AI_BUZZWORDS) {
    if (lower.includes(word)) buzzwordHits++;
    if (buzzwordHits >= 2) return true;
  }
  return false;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export interface ScoringSignals {
  alreadyEngaged: boolean;
  dismissed: boolean;
  recentlyDisplayedAuthors: string[];
}

export interface ScoringInput {
  post: ParsedPost;
  profile: ProfileContext;
  signals: ScoringSignals;
  /** Defaults to Date.now() — override only for deterministic tests. */
  now?: number;
}

const WEIGHTS = {
  topicMatch: 0.4,
  authorTier: 0.2,
  relationship: 0.15,
  recency: 0.1,
  engagement: 0.1,
  diversity: 0.05,
} as const;

function bucket(score: number): ScoreCategory {
  if (score >= 70) return 'engage_now';
  if (score >= 40) return 'consider';
  return 'skip';
}

export function scoreRelevance(input: ScoringInput): RelevanceScore {
  const { post, profile, signals } = input;
  const now = input.now ?? Date.now();

  // Hard filters first — no need to compute the full formula.
  if (signals.alreadyEngaged) {
    return { score: 0, reasons: ['already engaged'], category: 'skip' };
  }
  if (post.isOwn) {
    return { score: 0, reasons: ['own post'], category: 'skip' };
  }
  if (signals.dismissed) {
    return { score: 0, reasons: ['dismissed'], category: 'skip' };
  }

  // Components
  const postTokens = tokenize(post.text);
  const profileTokens = [
    ...profile.topSkills.flatMap(tokenize),
    ...profile.recentPostThemes.flatMap(tokenize),
  ];
  const topicMatch = jaccard(postTokens, profileTokens);

  const tier = authorTierScore(post.followerTier);
  const rel = relationshipScore(post.degree);
  const rec = recencyScore(post.postedAt, now);
  const eng = engagementScore(post.likeCount, post.commentCount);
  const div = diversityBonus(post.authorUrn, signals.recentlyDisplayedAuthors);

  let score =
    (topicMatch * WEIGHTS.topicMatch +
      tier * WEIGHTS.authorTier +
      rel * WEIGHTS.relationship +
      rec * WEIGHTS.recency +
      eng * WEIGHTS.engagement +
      div * WEIGHTS.diversity) *
    100;

  const reasons: string[] = [];
  if (topicMatch >= 0.15) reasons.push(`topic match (${(topicMatch * 100).toFixed(0)}%)`);
  if (tier >= 0.8) reasons.push(`high-tier author (${post.followerTier})`);
  if (rel >= 0.6) reasons.push(`close connection (${post.degree})`);
  if (rec >= 0.7) reasons.push('fresh post');
  if (eng >= 0.5) reasons.push('high engagement');
  if (div === 0) reasons.push('author shown recently');

  if (obviousAiContent(post.text)) {
    score *= 0.5;
    reasons.push('AI-like phrasing penalty');
  }

  // Clamp to [0, 100] for safety
  score = Math.max(0, Math.min(100, score));

  return {
    score: Math.round(score * 10) / 10, // 1 decimal place
    reasons,
    category: bucket(score),
  };
}
