/**
 * Issue #28 — profile audit AI rewrite orchestrator.
 *
 * Runs ONE LLM call per "Get AI rewrites" click (batched, not per-check) —
 * mirrors the feed-scorer batching pattern in `ai-feed-analyzer.ts`. The
 * recommender consumes the deterministic `AuditReport` produced by
 * `profile-audit.ts`; it never tries to detect gaps itself.
 *
 * Pure module: provider injected, no DOM, no chrome.storage. Background SW
 * holds the storage side via `setProfileAuditState`.
 */

import type { UserProfile } from './lib/idb';
import type { AuditReport } from './profile-audit';
import { buildProfileRewritePrompt } from './profile-audit-prompts';
import type { InferenceProvider } from './providers/inference-provider';
import type { ProfileRecommendation } from './storage-schema';

const REWRITE_MAX_TOKENS = 1200;
const REWRITE_TIMEOUT_MS = 45_000;
const SUGGESTION_MAX_LEN = 2200;
const DIAGNOSIS_MAX_LEN = 240;
const RATIONALE_MAX_LEN = 320;
const MAX_RECOMMENDATIONS = 10;

const VALID_CHECK_IDS = new Set<ProfileRecommendation['checkId']>([
  'currentPosition',
  'education',
  'skills',
  'about',
  'location',
  'connections',
  'photoBanner',
  'openToWork',
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
}

export async function generateProfileRecommendations(
  input: GenerateProfileRecommendationsInput
): Promise<ProfileRecommendation[]> {
  const { provider, profile, audit, goals } = input;
  const { system, user } = buildProfileRewritePrompt({ profile, audit, goals });
  const raw = await provider.generate({
    system,
    user,
    maxTokens: REWRITE_MAX_TOKENS,
    temperature: 0.4,
    topP: 0.9,
    timeoutMs: REWRITE_TIMEOUT_MS,
  });
  const parsed = parseProfileRecommendations(raw);
  if (parsed === null) {
    throw new ProfileRecommenderParseError('Malformed JSON from profile recommender');
  }
  return parsed;
}

interface RawRecommendation {
  checkId?: unknown;
  diagnosis?: unknown;
  suggestion?: unknown;
  rationale?: unknown;
}

/**
 * Strict-JSON parser. Drops entries with unknown checkIds. Drops duplicates
 * (keeps the first). Trims long strings. Returns null on any structural
 * failure so the caller can surface a fallback in UI.
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
