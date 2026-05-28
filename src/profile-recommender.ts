/**
 * Issue #28 — profile audit AI orchestrator.
 *
 * Two parallel LLM calls:
 *   1. Copy editor — paste-ready rewrites for failing audit items + optional
 *      headline/about polish + photoBanner/openToWork advisory.
 *   2. SSI strategist — tactical actions grounded in the user's weakest SSI
 *      pillar and what they actually post/comment about.
 *
 * They run concurrently via Promise.allSettled so one failure doesn't blank
 * the entire result. Merged + deduped by checkId before returning.
 *
 * Pure module: provider + clock injected. Background SW owns persistence via
 * setProfileAuditState.
 */

import type { UserProfile } from './lib/idb';
import type { AuditReport } from './profile-audit';
import {
  buildProfileRewritePrompt,
  buildSsiStrategyPrompt,
} from './profile-audit-prompts';
import type { InferenceProvider } from './providers/inference-provider';
import type { ProfileRecommendation, SsiSnapshot } from './storage-schema';

const COPY_MAX_TOKENS = 900;
const STRATEGY_MAX_TOKENS = 700;
const REWRITE_TIMEOUT_MS = 45_000;
const SUGGESTION_MAX_LEN = 2200;
const DIAGNOSIS_MAX_LEN = 240;
const RATIONALE_MAX_LEN = 320;
const MAX_RECOMMENDATIONS = 12;
/** Stem length fed into "avoid these openings" on regenerate. Background
 *  uses this same length when truncating suggestions into the history. */
export const AVOID_STEM_LEN = 90;
/** Max number of avoid stems to keep across regenerations; bounds prompt size. */
export const AVOID_STEM_HISTORY_CAP = 30;
/** Base temp gives some variety; regenerate bumps further so output diverges. */
const BASE_TEMPERATURE = 0.7;
const REGENERATE_TEMPERATURE = 0.9;

const VALID_CHECK_IDS = new Set<ProfileRecommendation['checkId']>([
  'currentPosition',
  'education',
  'skills',
  'about',
  'location',
  'connections',
  'headline',
  'photoBanner',
  'openToWork',
  'ssi',
  'engagementStrategy',
  'networkGrowth',
]);

export class ProfileRecommenderParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileRecommenderParseError';
  }
}

export interface GenerateProfileRecommendationsInput {
  provider: InferenceProvider;
  profile: UserProfile;
  audit: AuditReport;
  goals: string | null;
  ssi: SsiSnapshot | null;
  /** Suggestion stems accumulated across previous regenerations. Fed to the
   *  LLM as an "avoid" list so each click produces fresh angles. Empty / omitted
   *  on the first call. Caller is responsible for accumulation + capping. */
  avoidStems?: string[];
}

/**
 * Runs both prompts in parallel. Returns the merged recommendation list.
 *
 * - If BOTH calls fail (parse or network), throws ProfileRecommenderParseError
 *   so the background handler can surface a single error to UI.
 * - If only one call succeeds, returns its results; the other is logged but
 *   doesn't block UX. This is intentional: partial advice beats no advice.
 */
export async function generateProfileRecommendations(
  input: GenerateProfileRecommendationsInput,
): Promise<ProfileRecommendation[]> {
  const { provider, profile, audit, goals, ssi, avoidStems } = input;

  const isRegenerate = (avoidStems ?? []).length > 0;
  const temperature = isRegenerate ? REGENERATE_TEMPERATURE : BASE_TEMPERATURE;

  const copyPrompt = buildProfileRewritePrompt({ profile, audit, goals, avoidStems });
  const strategyPrompt = buildSsiStrategyPrompt({ profile, ssi, goals, avoidStems });

  const [copyResult, strategyResult] = await Promise.allSettled([
    runOne(provider, copyPrompt, COPY_MAX_TOKENS, temperature),
    runOne(provider, strategyPrompt, STRATEGY_MAX_TOKENS, temperature),
  ]);

  const copy = unwrap(copyResult, 'copy');
  const strategy = unwrap(strategyResult, 'strategy');

  if (copy === null && strategy === null) {
    throw new ProfileRecommenderParseError('Both profile recommender calls failed');
  }

  // Merge: copy items first (failing audit + advisory), then SSI tactics.
  // Dedupe by checkId — copy wins on collision (shouldn't happen given
  // disjoint checkId pools, but defensive).
  const merged: ProfileRecommendation[] = [];
  const seen = new Set<string>();
  for (const r of [...(copy ?? []), ...(strategy ?? [])]) {
    if (seen.has(r.checkId)) continue;
    merged.push(r);
    seen.add(r.checkId);
    if (merged.length >= MAX_RECOMMENDATIONS) break;
  }
  return merged;
}

async function runOne(
  provider: InferenceProvider,
  prompt: { system: string; user: string },
  maxTokens: number,
  temperature: number,
): Promise<ProfileRecommendation[]> {
  const raw = await provider.generate({
    system: prompt.system,
    user: prompt.user,
    maxTokens,
    temperature,
    topP: 0.9,
    timeoutMs: REWRITE_TIMEOUT_MS,
  });
  const parsed = parseProfileRecommendations(raw);
  if (parsed === null) {
    throw new ProfileRecommenderParseError('Malformed JSON from profile recommender');
  }
  return parsed;
}

function unwrap(
  result: PromiseSettledResult<ProfileRecommendation[]>,
  label: string,
): ProfileRecommendation[] | null {
  if (result.status === 'fulfilled') return result.value;
  console.warn(`[linkmate] profile recommender ${label} call failed:`, result.reason);
  return null;
}

interface RawRecommendation {
  checkId?: unknown;
  diagnosis?: unknown;
  suggestion?: unknown;
  rationale?: unknown;
}

/**
 * Strict-JSON parser. Drops entries with unknown checkIds. Drops duplicates
 * within a single call (keeps the first). Trims long strings. Returns null
 * on any structural failure so the caller can surface a fallback in UI.
 */
export function parseProfileRecommendations(raw: string): ProfileRecommendation[] | null {
  try {
    const cleaned = stripCodeFences(raw);
    const obj = JSON.parse(cleaned) as { recommendations?: RawRecommendation[] };
    if (!obj.recommendations || !Array.isArray(obj.recommendations)) return null;
    const out: ProfileRecommendation[] = [];
    const seen = new Set<string>();
    for (const r of obj.recommendations) {
      const id = typeof r.checkId === 'string' ? r.checkId : '';
      if (!VALID_CHECK_IDS.has(id as ProfileRecommendation['checkId'])) continue;
      if (seen.has(id)) continue;
      const diagnosis = typeof r.diagnosis === 'string' ? r.diagnosis.slice(0, DIAGNOSIS_MAX_LEN) : '';
      const suggestion =
        typeof r.suggestion === 'string' ? r.suggestion.slice(0, SUGGESTION_MAX_LEN) : '';
      const rationale =
        typeof r.rationale === 'string' ? r.rationale.slice(0, RATIONALE_MAX_LEN) : '';
      if (suggestion.trim().length === 0) continue;
      out.push({
        checkId: id as ProfileRecommendation['checkId'],
        diagnosis,
        suggestion,
        rationale,
      });
      seen.add(id);
      if (out.length >= MAX_RECOMMENDATIONS) break;
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Tolerate occasional ```json fences from models that ignore the "no fences" instruction. */
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}
