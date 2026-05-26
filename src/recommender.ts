/**
 * Recommender orchestrator — daily AI-generated action cards + post drafts.
 *
 * Lives in the background service worker. Reads action log + profile + SSI
 * + topics, calls the active inference provider with a strict-JSON prompt,
 * parses + validates, persists cards. Popup reads via message handlers.
 *
 * Rule-based fallback when no profile or no API key — the popup always has
 * 3 cards to show, even on a fresh install.
 */

import { recent7d, topTopics } from './action-log';
import { weeklyProgress, weakestPillar } from './cadence';
import { getActiveProvider } from './providers';
import {
  buildPostDraftPrompt,
  buildRecommenderPrompt,
  buildWeeklyRetro,
  type BuildWeeklyRetroInput,
} from './prompt-builder';
import { getInsight } from './ssi-tracker';
import {
  getCadenceStreak,
  getProfile,
  getRecommenderCards,
  getRetroLastShown,
  getSsiHistory,
  setRecommenderCards,
  setRetroLastShown,
  type PillarKey,
  type ActionVerb,
  type RecommendCard,
  type RecommenderState,
} from './storage-schema';
import { knownTopics } from './topic-tagger';

const VALID_ACTIONS: ActionVerb[] = ['comment', 'post', 'invite', 'thread_reply'];
const VALID_PILLARS: PillarKey[] = ['brand', 'finding', 'engaging', 'building'];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Rule-based fallback cards ─────────────────────────────────────────────

const PILLAR_TO_ACTION: Record<PillarKey, ActionVerb> = {
  brand: 'post',
  finding: 'invite',
  engaging: 'comment',
  building: 'thread_reply',
};

const FALLBACK_TITLES: Record<PillarKey, string> = {
  brand: 'Publish an original post',
  finding: 'Send 1 connection invite',
  engaging: 'Comment on a relevant post',
  building: 'Reply in a comment thread',
};

const FALLBACK_REASONS: Record<PillarKey, string> = {
  brand: 'Brand pillar — original posts move it most.',
  finding: 'Finding pillar — outbound invites are the only signal LinkedIn rewards.',
  engaging: 'Engaging pillar — thoughtful comments outperform reactions 3-to-1.',
  building: 'Building pillar — back-and-forth replies signal real relationships.',
};

function ruleBasedCards(weakest: PillarKey, progress: Record<PillarKey, { done: number; target: number }>): RecommendCard[] {
  const order = (['brand', 'finding', 'engaging', 'building'] as PillarKey[]).sort((a, b) => {
    if (a === weakest) return -1;
    if (b === weakest) return 1;
    const aPct = progress[a].target === 0 ? 100 : (progress[a].done / progress[a].target) * 100;
    const bPct = progress[b].target === 0 ? 100 : (progress[b].done / progress[b].target) * 100;
    return aPct - bPct;
  });
  return order.slice(0, 3).map((p) => ({
    action: PILLAR_TO_ACTION[p],
    pillar: p,
    title: FALLBACK_TITLES[p],
    reason: FALLBACK_REASONS[p],
  }));
}

// ─── JSON parse + validate ─────────────────────────────────────────────────

interface RawCard {
  action?: string;
  pillar?: string;
  title?: string;
  reason?: string;
  postId?: string;
}

function parseCards(raw: string): RecommendCard[] | null {
  try {
    const parsed = JSON.parse(raw) as { cards?: RawCard[] };
    if (!parsed.cards || !Array.isArray(parsed.cards)) return null;
    const out: RecommendCard[] = [];
    for (const c of parsed.cards) {
      if (
        !c.action ||
        !c.pillar ||
        !c.title ||
        !c.reason ||
        !VALID_ACTIONS.includes(c.action as ActionVerb) ||
        !VALID_PILLARS.includes(c.pillar as PillarKey)
      ) {
        continue;
      }
      // Only accept postId if it matches LinkedIn's URN shape — guards
      // against AI hallucinated IDs that would dead-link the "Open" button.
      const postId =
        c.postId && /^urn:li:activity:\d+$/.test(c.postId) ? c.postId : undefined;
      out.push({
        action: c.action as ActionVerb,
        pillar: c.pillar as PillarKey,
        title: String(c.title).slice(0, 80),
        reason: String(c.reason).slice(0, 200),
        postId,
      });
    }
    return out.length > 0 ? out.slice(0, 3) : null;
  } catch {
    return null;
  }
}

// ─── Daily rank ─────────────────────────────────────────────────────────────

/**
 * Generate today's 3 recommendation cards. Persists to storage.
 * Falls back to rule-based when profile or provider unavailable.
 */
export async function rankDaily(): Promise<RecommenderState> {
  const [profile, progress, ssiHistory, topics, actions] = await Promise.all([
    getProfile(),
    weeklyProgress(),
    getSsiHistory(),
    topTopics(14, 5),
    recent7d(),
  ]);
  const weakest = weakestPillar(progress);

  // Build recent outcomes — for each recent action with topics, take the first topic.
  // (Outcomes attach asynchronously; we have topics on the action even before outcome lands.)
  const recentOutcomes = actions
    .filter((a) => a.submitted)
    .slice(-5)
    .map((a) => ({ topic: a.topics?.[0] }));

  let cards: RecommendCard[] | null = null;
  let source: 'ai' | 'rule' = 'rule';

  if (profile) {
    try {
      const provider = await getActiveProvider();
      const { system, user } = buildRecommenderPrompt({
        profile,
        cadence: { weakest, progress },
        topTopics: topics,
        recentOutcomes,
        ssiInsight: getInsight(ssiHistory),
      });
      const raw = await provider.generate({
        system,
        user,
        maxTokens: 600,
        temperature: 0.5,
        topP: 0.9,
      });
      cards = parseCards(raw);
      if (cards && cards.length === 3) source = 'ai';
      else cards = null;
    } catch (err) {
      console.warn('[linkmate] recommender AI call failed, falling back to rules:', err);
    }
  }

  if (!cards) cards = ruleBasedCards(weakest, progress);

  const state: RecommenderState = {
    generatedAt: Date.now(),
    cards,
    source,
  };
  await setRecommenderCards(state);
  return state;
}

/** Read cached cards. If stale (>24h) or missing, regenerate. */
export async function getCardsOrRefresh(): Promise<RecommenderState> {
  const cached = await getRecommenderCards();
  if (cached && Date.now() - cached.generatedAt < 24 * 60 * 60 * 1000) return cached;
  return rankDaily();
}

// ─── Suggest-a-post ─────────────────────────────────────────────────────────

export interface PostDraft {
  angle: 'story' | 'hot_take' | 'lesson';
  topic: string;
  body: string;
}

interface RawDraft {
  angle?: string;
  topic?: string;
  body?: string;
}

const VALID_ANGLES = new Set(['story', 'hot_take', 'lesson']);

function parseDrafts(raw: string): PostDraft[] | null {
  try {
    const parsed = JSON.parse(raw) as { drafts?: RawDraft[] };
    if (!parsed.drafts || !Array.isArray(parsed.drafts)) return null;
    const out: PostDraft[] = [];
    for (const d of parsed.drafts) {
      if (!d.angle || !d.body || !d.topic || !VALID_ANGLES.has(d.angle)) continue;
      out.push({
        angle: d.angle as PostDraft['angle'],
        topic: String(d.topic).slice(0, 40),
        body: String(d.body).slice(0, 2000),
      });
    }
    return out.length > 0 ? out.slice(0, 3) : null;
  } catch {
    return null;
  }
}

/** Generate 3 post drafts. AI-only — no rule-based fallback (graceful error to UI). */
export async function suggestPosts(): Promise<{ ok: true; drafts: PostDraft[] } | { ok: false; error: string }> {
  const profile = await getProfile();
  if (!profile) return { ok: false, error: 'No profile captured. Use Capture Profile first.' };
  const [progress, topics] = await Promise.all([weeklyProgress(), topTopics(14, 8)]);
  const weakest = weakestPillar(progress);
  const userTopicSet = new Set(topics.map((t) => t.topic));
  const underweightTopics = knownTopics().filter((t) => !userTopicSet.has(t)).slice(0, 6);

  let provider;
  try {
    provider = await getActiveProvider();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const { system, user } = buildPostDraftPrompt({
    profile,
    weakest,
    topTopics: topics,
    underweightTopics,
  });
  try {
    const raw = await provider.generate({
      system,
      user,
      maxTokens: 1500,
      temperature: 0.75,
      topP: 0.9,
    });
    const drafts = parseDrafts(raw);
    if (!drafts) return { ok: false, error: 'AI returned malformed JSON.' };
    return { ok: true, drafts };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Weekly retro ──────────────────────────────────────────────────────────

/**
 * Returns a retro string IF a fresh 7d window has elapsed since last shown.
 * Null when not eligible — popup hides the retro card.
 */
export async function getRetroIfDue(now = Date.now()): Promise<string | null> {
  const lastShown = await getRetroLastShown();
  if (lastShown !== 0 && now - lastShown < SEVEN_DAYS_MS) return null;
  const [progress, streak, ssiHistory] = await Promise.all([
    weeklyProgress(),
    getCadenceStreak(),
    getSsiHistory(),
  ]);
  // Skip retro until we have at least 2 SSI snapshots — otherwise the delta
  // is meaningless and the user sees "Last week: 0/x ❌" on day-one.
  if (ssiHistory.length < 2) return null;
  const ssiDelta = ssiDeltaFromHistory(ssiHistory);
  const input: BuildWeeklyRetroInput = {
    weekStartTs: now - SEVEN_DAYS_MS,
    prevProgress: progress,
    ssiDelta,
    streak: streak.count,
  };
  return buildWeeklyRetro(input);
}

export async function dismissRetro(): Promise<void> {
  await setRetroLastShown(Date.now());
}

function ssiDeltaFromHistory(
  history: Array<{ capturedAt: number; components: { establishBrand: number; findRightPeople: number; engageWithInsights: number; buildRelationships: number } }>,
): { brand?: number; finding?: number; engaging?: number; building?: number } {
  if (history.length < 2) return {};
  const latest = history[history.length - 1];
  const cutoff = latest.capturedAt - SEVEN_DAYS_MS;
  // Find the latest snapshot older than 7d → that's the "week ago" baseline.
  let prev = history[0];
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].capturedAt <= cutoff) {
      prev = history[i];
      break;
    }
  }
  return {
    brand: round1(latest.components.establishBrand - prev.components.establishBrand),
    finding: round1(latest.components.findRightPeople - prev.components.findRightPeople),
    engaging: round1(latest.components.engageWithInsights - prev.components.engageWithInsights),
    building: round1(latest.components.buildRelationships - prev.components.buildRelationships),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
