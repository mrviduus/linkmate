/**
 * T011 — Storage schema (Phase A foundation).
 *
 * Single source of truth for chrome.storage.local layout used by SSI Growth Mode.
 * All keys are versioned (`linkmate.<area>.<vN>`); breaking changes bump SCHEMA_VERSION
 * and add a migration step in `migrateIfNeeded`.
 *
 * Caller boundaries (per Constitution v1.1 §IV):
 *   - background:       full access (orchestrates SSI capture, profile capture, queue state)
 *   - popup:            full access (renders SSI dashboard, profile tab, queue preferences)
 *   - content scripts:  read-only of profile / engaged / dismissed; never write directly,
 *                       always send a message to background which writes
 */

export const SCHEMA_VERSION = 2;

export const STORAGE_KEYS = {
  profile: 'linkmate.profile.v1',
  queueEngaged: 'linkmate.queue.engaged.v1',
  queueDismissed: 'linkmate.queue.dismissed.v1',
  queuePreferences: 'linkmate.queue.preferences.v1',
  ssiHistory: 'linkmate.ssi.history.v1',
  ssiLastError: 'linkmate.ssi.lastError.v1',
  connectionsSuggestions: 'linkmate.connections.suggestions.v1',
  connectionsDraftedThisWeek: 'linkmate.connections.draftedThisWeek.v1',
  provider: 'linkmate.provider.v1',
  installToken: 'linkmate.install.token.v1',
  cadenceTargets: 'linkmate.cadence.targets.v1',
  cadenceStreak: 'linkmate.cadence.streak.v1',
  recommenderCards: 'linkmate.recommender.cards.v1',
  retroLastShown: 'linkmate.retro.lastShown.v1',
  postDraftsState: 'linkmate.recommender.postDrafts.v1',
  captureFullProfile: 'linkmate.settings.captureFullProfile.v1',
  deepScrapeCancel: 'linkmate.deepScrape.cancel.v1',
  deepScrapeProgress: 'linkmate.deepScrape.progress.v1',
  onboardingCompleted: 'linkmate.settings.onboardingCompleted.v1',
  goalsOverride: 'linkmate.profile.goalsOverride.v1',
  profileAudit: 'linkmate.profile.audit.v1',
  schemaVersion: 'linkmate.schema.version',
} as const;

export const GOALS_OVERRIDE_MAX_LEN = 600;

export const MAX_SSI_SNAPSHOTS = 90;
export const ENGAGED_POST_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── Entity types ───────────────────────────────────────────────────────────

export interface ProfileContext {
  fullName: string;
  headline: string;
  about: string;
  topSkills: string[];
  recentPostThemes: string[];
  positioningSummary: string;
  capturedAt: number;
}

export type FollowerTier = 'unknown' | 'lt_1k' | '1k_10k' | '10k_100k' | 'gt_100k';
export type ConnectionDegree = '1st' | '2nd' | '3rd' | 'follow-only' | 'unknown';

export interface ParsedPost {
  id: string;
  authorUrn: string;
  authorName: string;
  authorTitle: string;
  followerTier: FollowerTier;
  degree: ConnectionDegree;
  text: string;
  postedAt: number;
  likeCount: number;
  commentCount: number;
  isOwn: boolean;
}

export type ToneKey = 'professional' | 'friendly' | 'enthusiastic' | 'thoughtful';
export type LengthKey = 'brief' | 'standard' | 'detailed';
export type ScoreCategory = 'engage_now' | 'consider' | 'skip';

export interface RelevanceScore {
  score: number; // 0..100
  reasons: string[];
  category: ScoreCategory;
}

export interface ScoredPost extends ParsedPost {
  relevance: RelevanceScore;
}

export interface DraftComment {
  postId: string;
  text: string;
  tone: ToneKey;
  length: LengthKey;
  generatedAt: number;
  model: string;
}

export interface EngagedPost {
  postId: string;
  engagedAt: number;
  expiresAt: number;
}

export interface SsiSnapshot {
  total: number;
  components: {
    establishBrand: number;
    findRightPeople: number;
    engageWithInsights: number;
    buildRelationships: number;
  };
  industryRank: string;
  networkRank: string;
  capturedAt: number;
}

export interface SsiLastError {
  message: string;
  capturedAt: number;
}

export type ConnectionStatus = 'pending' | 'drafted' | 'skipped';

export interface ConnectionSuggestion {
  profileUrl: string;
  name: string;
  title: string;
  company: string;
  personalizedNote: string;
  suggestedAt: number;
  status: ConnectionStatus;
}

export interface QueuePreferences {
  defaultTone: ToneKey;
  defaultLength: LengthKey;
  autoRefreshMinutes: number;
  sidebarPosition: { top: number; right: number };
}

/**
 * Inference provider selection. Persisted per-browser-profile in
 * chrome.storage.local (never `sync` — the OpenAI API key is a per-device
 * secret).
 *
 * Modes:
 *   - 'managed' — default. Calls LinkMate's own proxy (api.textstack.app) with
 *     an anonymous install token instead of an API key; the OpenAI key lives on
 *     the proxy and a per-user $2 spend quota is enforced server-side.
 *   - 'openai' / 'groq' — BYOK ("bring your own key"), unlimited. Advanced
 *     fallback for users who hit the free quota or want their own provider.
 */
export type ProviderMode = 'managed' | 'openai' | 'groq';

export interface ProviderConfig {
  mode: ProviderMode;
  /** Managed (proxy) mode — no apiKey; auth is the install token at request time. */
  managed?: {
    model: string; // must be on the proxy whitelist, e.g. "gpt-4o-mini"
    baseUrl?: string;
  };
  openai?: {
    apiKey: string;
    model: string; // e.g. "gpt-4o-mini"
    baseUrl?: string;
  };
  groq?: {
    apiKey: string;
    model: string;
    baseUrl?: string;
  };
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  mode: 'managed',
  managed: { model: 'gpt-4o-mini' },
  openai: { apiKey: '', model: 'gpt-4o-mini' },
  groq: { apiKey: '', model: 'groq/compound' },
};

// ─── Storage helpers ────────────────────────────────────────────────────────

async function readKey<T>(key: string): Promise<T | null> {
  const result = (await chrome.storage.local.get(key)) as unknown as Record<string, T | undefined>;
  return result[key] ?? null;
}

async function writeKey(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

// ─── Profile ────────────────────────────────────────────────────────────────

/** Read the captured ProfileContext, or null if never captured. Call from any surface. */
export async function getProfile(): Promise<ProfileContext | null> {
  return readKey<ProfileContext>(STORAGE_KEYS.profile);
}

/** Persist a freshly captured ProfileContext. Should only be called from background. */
export async function setProfile(profile: ProfileContext): Promise<void> {
  await writeKey(STORAGE_KEYS.profile, profile);
}

// ─── SSI history ────────────────────────────────────────────────────────────

/** Return all stored SSI snapshots in insertion (chronological) order. */
export async function getSsiHistory(): Promise<SsiSnapshot[]> {
  return (await readKey<SsiSnapshot[]>(STORAGE_KEYS.ssiHistory)) ?? [];
}

/**
 * Append a snapshot, evicting the oldest if we exceed MAX_SSI_SNAPSHOTS.
 * Only background should call this (during the daily alarm or manual capture).
 */
export async function appendSsiSnapshot(snapshot: SsiSnapshot): Promise<void> {
  const history = await getSsiHistory();
  history.push(snapshot);
  while (history.length > MAX_SSI_SNAPSHOTS) {
    history.shift();
  }
  await writeKey(STORAGE_KEYS.ssiHistory, history);
}

// ─── Engaged posts ──────────────────────────────────────────────────────────

async function readEngagedRaw(): Promise<EngagedPost[]> {
  return (await readKey<EngagedPost[]>(STORAGE_KEYS.queueEngaged)) ?? [];
}

/** Return engaged posts whose TTL has not expired yet. Filters in-memory. */
export async function getEngagedPosts(): Promise<EngagedPost[]> {
  const now = Date.now();
  const all = await readEngagedRaw();
  return all.filter((e) => e.expiresAt > now);
}

/** Mark a postId as engaged with engagedAt=now and expiresAt=now+ENGAGED_POST_TTL_MS. */
export async function markEngaged(postId: string): Promise<void> {
  const now = Date.now();
  const existing = await readEngagedRaw();
  const filtered = existing.filter((e) => e.postId !== postId);
  filtered.push({ postId, engagedAt: now, expiresAt: now + ENGAGED_POST_TTL_MS });
  await writeKey(STORAGE_KEYS.queueEngaged, filtered);
}

/** True iff postId has a non-expired engaged record. */
export async function isEngaged(postId: string): Promise<boolean> {
  const active = await getEngagedPosts();
  return active.some((e) => e.postId === postId);
}

// ─── Provider config (v0.5.0) ────────────────────────────────────────────────

/** Read provider config; returns defaults when unset. */
export async function getProviderConfig(): Promise<ProviderConfig> {
  const stored = await readKey<ProviderConfig>(STORAGE_KEYS.provider);
  if (!stored) return { ...DEFAULT_PROVIDER_CONFIG };
  return stored;
}

/** Persist provider config. Background handles message. Popup-driven setter. */
export async function setProviderConfig(cfg: ProviderConfig): Promise<void> {
  await writeKey(STORAGE_KEYS.provider, cfg);
}

// ─── Install token (anonymous id for managed-mode quota) ─────────────────────
//
// A UUID generated once per install, stored only in chrome.storage.local. The
// managed proxy keys the per-user $2 quota off it. Not a secret and not synced
// (a fresh install legitimately starts a fresh allowance).

/** Read the install token, or null if not generated yet. */
export async function getInstallToken(): Promise<string | null> {
  return readKey<string>(STORAGE_KEYS.installToken);
}

/** Return the install token, generating + persisting one on first call. */
export async function ensureInstallToken(): Promise<string> {
  const existing = await getInstallToken();
  if (existing) return existing;
  const token = crypto.randomUUID();
  await writeKey(STORAGE_KEYS.installToken, token);
  return token;
}

// ─── SSI last-error chip ────────────────────────────────────────────────────

/** Read the most recent SSI capture failure (or null). Surfaced as popup chip. */
export async function getSsiLastError(): Promise<SsiLastError | null> {
  return readKey<SsiLastError>(STORAGE_KEYS.ssiLastError);
}

/** Persist a capture failure for the popup chip. Background calls this. */
export async function setSsiLastError(err: SsiLastError): Promise<void> {
  await writeKey(STORAGE_KEYS.ssiLastError, err);
}

/** Clear the SSI last-error chip after a successful capture. */
export async function clearSsiLastError(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.ssiLastError);
}

// ─── Dismissed posts ────────────────────────────────────────────────────────

/** Return all dismissed post IDs (forever; user explicitly hid them). */
export async function getDismissedPostIds(): Promise<string[]> {
  return (await readKey<string[]>(STORAGE_KEYS.queueDismissed)) ?? [];
}

/** Add a postId to the dismissed list (idempotent — duplicates ignored). */
export async function addDismissedPostId(postId: string): Promise<void> {
  const current = await getDismissedPostIds();
  if (current.includes(postId)) return;
  current.push(postId);
  await writeKey(STORAGE_KEYS.queueDismissed, current);
}

/** True iff postId is in the dismissed list. */
export async function isDismissed(postId: string): Promise<boolean> {
  const list = await getDismissedPostIds();
  return list.includes(postId);
}

// ─── Migration ──────────────────────────────────────────────────────────────

/**
 * Read stored schema version, run any pending migrations, and write the current version.
 * Idempotent. Call from background on install/startup.
 * Migration scaffolding is empty at v1 — the file structure is ready for future bumps.
 */
export async function migrateIfNeeded(): Promise<void> {
  const stored = await readKey<number>(STORAGE_KEYS.schemaVersion);
  const currentStored = stored ?? 0;
  if (currentStored >= SCHEMA_VERSION) return;

  // v1 → v2: introduce managed (proxy) mode + anonymous install token.
  if (currentStored < 2) {
    await ensureInstallToken();
    const cfg = await readKey<ProviderConfig>(STORAGE_KEYS.provider);
    if (cfg) {
      // Existing BYOK users keep their working key + mode; only users without
      // a key are moved onto the free managed tier. Backfill the managed block
      // so the settings UI can render it either way.
      const hasOwnKey = !!cfg.openai?.apiKey?.trim() || !!cfg.groq?.apiKey?.trim();
      const next: ProviderConfig = {
        ...cfg,
        managed: cfg.managed ?? { model: 'gpt-4o-mini' },
        mode: hasOwnKey ? cfg.mode : 'managed',
      };
      await writeKey(STORAGE_KEYS.provider, next);
    }
    // No stored config → getProviderConfig() already returns the managed default.
  }

  await writeKey(STORAGE_KEYS.schemaVersion, SCHEMA_VERSION);
}

// ─── Cadence targets + streak (weekly quotas) ───────────────────────────────

export interface CadenceTargets {
  /** Original posts per rolling 7d. */
  brand: number;
  /** Connection invites sent per rolling 7d. */
  finding: number;
  /** Comments on others' posts per rolling 7d. */
  engaging: number;
  /** Thread replies / congrats DMs per rolling 7d. */
  building: number;
}

export const DEFAULT_CADENCE_TARGETS: CadenceTargets = {
  brand: 1,
  finding: 5,
  engaging: 3,
  building: 2,
};

/** Streak = consecutive past 7d-windows where ALL 4 quotas were hit. */
export interface CadenceStreak {
  count: number;
  /** Timestamp of the last 7d window we credited. ms epoch. */
  lastWindowEnd: number;
}

export async function getCadenceTargets(): Promise<CadenceTargets> {
  const stored = await readKey<CadenceTargets>(STORAGE_KEYS.cadenceTargets);
  return stored ?? { ...DEFAULT_CADENCE_TARGETS };
}

export async function setCadenceTargets(t: CadenceTargets): Promise<void> {
  await writeKey(STORAGE_KEYS.cadenceTargets, t);
}

export async function getCadenceStreak(): Promise<CadenceStreak> {
  const stored = await readKey<CadenceStreak>(STORAGE_KEYS.cadenceStreak);
  return stored ?? { count: 0, lastWindowEnd: 0 };
}

export async function setCadenceStreak(s: CadenceStreak): Promise<void> {
  await writeKey(STORAGE_KEYS.cadenceStreak, s);
}

// ─── Recommender cards (Phase C) ────────────────────────────────────────────

export type ActionVerb = 'comment' | 'post' | 'invite' | 'thread_reply';
export type PillarKey = 'brand' | 'finding' | 'engaging' | 'building';

export interface RecommendCard {
  action: ActionVerb;
  pillar: PillarKey;
  title: string;
  reason: string;
  postId?: string;
}

export interface RecommenderState {
  generatedAt: number;
  cards: RecommendCard[];
  source: 'ai' | 'rule';
}

export async function getRecommenderCards(): Promise<RecommenderState | null> {
  return readKey<RecommenderState>(STORAGE_KEYS.recommenderCards);
}

export async function setRecommenderCards(s: RecommenderState): Promise<void> {
  await writeKey(STORAGE_KEYS.recommenderCards, s);
}

/** Timestamp of the last weekly retro the user has dismissed/seen. */
export async function getRetroLastShown(): Promise<number> {
  return (await readKey<number>(STORAGE_KEYS.retroLastShown)) ?? 0;
}

export async function setRetroLastShown(ts: number): Promise<void> {
  await writeKey(STORAGE_KEYS.retroLastShown, ts);
}

// ─── Post-drafts modal state (survives popup close mid-call) ───────────────

export interface PostDraft {
  angle: 'story' | 'hot_take' | 'lesson';
  topic: string;
  body: string;
}

export type PostDraftsState =
  | { status: 'idle' }
  | { status: 'inFlight'; startedAt: number }
  | { status: 'ready'; finishedAt: number; drafts: PostDraft[] }
  | { status: 'error'; finishedAt: number; error: string };

export async function getPostDraftsState(): Promise<PostDraftsState> {
  return (await readKey<PostDraftsState>(STORAGE_KEYS.postDraftsState)) ?? { status: 'idle' };
}

export async function setPostDraftsState(s: PostDraftsState): Promise<void> {
  await writeKey(STORAGE_KEYS.postDraftsState, s);
}

// ─── Settings: capture-full-profile toggle (Issue #16) ──────────────────────

/**
 * Whether the popup's Capture Profile button should also scrape activity
 * (recent posts + recent comments via the user's active tab). Default OFF so
 * existing users who upgrade don't get silent full-scrape behaviour — only
 * users who explicitly click Get Started in the welcome flow opt in.
 */
export async function getCaptureFullProfile(): Promise<boolean> {
  const stored = await readKey<boolean>(STORAGE_KEYS.captureFullProfile);
  return stored ?? false;
}

export async function setCaptureFullProfile(value: boolean): Promise<void> {
  await writeKey(STORAGE_KEYS.captureFullProfile, value);
}

// ─── Deep scrape live progress + cancel signal ──────────────────────────────
//
// Inject script (running on the LinkedIn tab) and popup (running in the side
// panel) coordinate via chrome.storage.local — neither side has a direct
// channel to the other. Inject polls `cancel` between iterations; popup
// observes `progress` via chrome.storage.onChanged.

export type DeepScrapeProgress = {
  phase: 'profile' | 'posts' | 'comments';
  iter: number;
  items: number;
  height: number;
  /** Wall-clock when this update was written, used to detect stale UI. */
  ts: number;
};

export async function getDeepScrapeProgress(): Promise<DeepScrapeProgress | null> {
  return readKey<DeepScrapeProgress>(STORAGE_KEYS.deepScrapeProgress);
}

export async function setDeepScrapeProgress(p: DeepScrapeProgress | null): Promise<void> {
  if (p === null) {
    await chrome.storage.local.remove(STORAGE_KEYS.deepScrapeProgress);
    return;
  }
  await writeKey(STORAGE_KEYS.deepScrapeProgress, p);
}

export async function getDeepScrapeCancel(): Promise<boolean> {
  return (await readKey<boolean>(STORAGE_KEYS.deepScrapeCancel)) ?? false;
}

export async function setDeepScrapeCancel(value: boolean): Promise<void> {
  await writeKey(STORAGE_KEYS.deepScrapeCancel, value);
}

// ─── Onboarding — completed-once flag (issue #16 Option-A welcome flow) ────

/** True after the user has accepted/skipped the welcome screen. Default false. */
export async function getOnboardingCompleted(): Promise<boolean> {
  return (await readKey<boolean>(STORAGE_KEYS.onboardingCompleted)) ?? false;
}

export async function setOnboardingCompleted(value: boolean): Promise<void> {
  await writeKey(STORAGE_KEYS.onboardingCompleted, value);
}

// ─── Settings: goals override (issue #18) ──────────────────────────────────

/**
 * Optional user-entered "what I'm looking for" string used by AI feed scoring
 * + Analyze Feed. Falls back to `ProfileContext.positioningSummary` when null.
 * Capped at GOALS_OVERRIDE_MAX_LEN to keep prompt budget bounded.
 */
export async function getGoalsOverride(): Promise<string | null> {
  const stored = await readKey<string>(STORAGE_KEYS.goalsOverride);
  if (typeof stored !== 'string') return null;
  return stored.length === 0 ? null : stored.slice(0, GOALS_OVERRIDE_MAX_LEN);
}

export async function setGoalsOverride(value: string): Promise<void> {
  const trimmed = (value ?? '').slice(0, GOALS_OVERRIDE_MAX_LEN);
  if (trimmed.length === 0) {
    await chrome.storage.local.remove(STORAGE_KEYS.goalsOverride);
    return;
  }
  await writeKey(STORAGE_KEYS.goalsOverride, trimmed);
}

// ─── Profile audit + AI rewrites (issue #28) ────────────────────────────────

export type ProfileAuditCheckId =
  | 'currentPosition'
  | 'education'
  | 'skills'
  | 'about'
  | 'location'
  | 'connections';

export interface ProfileAuditCheck {
  id: ProfileAuditCheckId;
  status: 'pass' | 'fail';
  severity: 'high' | 'med';
  label: string;
  detail: string;
}

export interface ProfileAuditSummary {
  checks: ProfileAuditCheck[];
  passed: number;
  total: number;
  score: number;
  failed: ProfileAuditCheckId[];
}

/**
 * checkId union:
 *   - the 6 audit ids (rule-based gap rewrites)
 *   - 'headline' / 'photoBanner' / 'openToWork' (copy-editor advisory)
 *   - 'ssi' / 'engagementStrategy' / 'networkGrowth' (SSI-strategy tactics)
 */
export type ProfileRecommendationCheckId =
  | ProfileAuditCheckId
  | 'headline'
  | 'photoBanner'
  | 'openToWork'
  | 'ssi'
  | 'engagementStrategy'
  | 'networkGrowth';

export interface ProfileRecommendation {
  checkId: ProfileRecommendationCheckId;
  diagnosis: string;
  suggestion: string;
  rationale: string;
}

export interface ProfileAuditState {
  /** ISO timestamp of the IDB UserProfile this audit was computed against. */
  profileCapturedAt: string;
  audit: ProfileAuditSummary;
  /** AI recommendations, null until the user clicks "Get AI rewrites". */
  recommendations: ProfileRecommendation[] | null;
  /** ms epoch when recommendations were generated; 0 if never. */
  recommendationsAt: number;
  /** Suggestion stems grouped by checkId, accumulated across regenerations.
   *  Fed back to the LLM as an "avoid" list grouped by checkId so each click
   *  produces fresh concepts (not just rephrased openings). Reset to []
   *  whenever profileCapturedAt changes. Capped to keep the prompt bounded. */
  avoidStems: AvoidEntry[];
}

export interface AvoidEntry {
  checkId: ProfileRecommendationCheckId;
  stem: string;
}

// Activity signals are derived live (cheap) and not persisted in storage
// alongside the audit state; background recomputes on every audit.get call.
// Re-export types here only so popup/background share the wire shape.
export type {
  ActivitySignal,
  ActivitySignalId,
  ActivitySignalStatus,
} from './profile-audit';

export async function getProfileAuditState(): Promise<ProfileAuditState | null> {
  return readKey<ProfileAuditState>(STORAGE_KEYS.profileAudit);
}

export async function setProfileAuditState(state: ProfileAuditState): Promise<void> {
  await writeKey(STORAGE_KEYS.profileAudit, state);
}

export async function clearProfileAuditState(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.profileAudit);
}
