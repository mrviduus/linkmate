/**
 * LinkMate background service worker.
 *
 * Cloud-only: all inference goes through the OpenAI provider (BYOK).
 * Owns the message router for content scripts + popup, SSI capture
 * orchestration, the daily SSI alarm, and prompt customization storage.
 */

import { keepAlive } from './keep-alive';
import { buildPositioningPrompt, buildCommentPrompt } from './prompt-builder';
import type { RawProfileFields } from './profile-parser';
import { scoreRelevance } from './relevance-scorer';
import { runCommentGates } from './comment-gates';
import { getActiveProvider, MANAGED_BASE_URL, QuotaExceededError } from './providers';
import {
  getProfile,
  getEngagedPosts,
  getDismissedPostIds,
  markEngaged as storageMarkEngaged,
  addDismissedPostId,
  appendSsiSnapshot,
  getSsiHistory,
  setSsiLastError,
  clearSsiLastError,
  getProviderConfig,
  setProviderConfig,
  getInstallToken,
  ensureInstallToken,
  migrateIfNeeded,
  getCadenceTargets,
  setCadenceTargets,
  getCadenceStreak,
  getOnboardingCompleted,
  getGoalsOverride,
  setGoalsOverride,
  getPaused,
  STORAGE_KEYS,
} from './storage-schema';
import { aiScoreBatch, clearAiCache, AiParseError } from './ai-feed-analyzer';
import { getUserProfile, profileContextFromUserProfile } from './user-profile-store';
import { auditProfile, computeActivitySignals } from './profile-audit';
import {
  AVOID_STEM_HISTORY_CAP,
  AVOID_STEM_LEN,
  generateProfileRecommendations,
  ProfileRecommenderParseError,
} from './profile-recommender';
import {
  getProfileAuditState,
  setProfileAuditState,
} from './storage-schema';
import type { ProfileContext } from './storage-schema';

/**
 * Read the chrome.storage.local ProfileContext, falling back to deriving one
 * from the IDB UserProfile when ProfileContext is missing but a fresh full
 * capture exists. Lets the engagement queue work without requiring an OpenAI
 * key (positioning summary is the only thing the OpenAI step would add, and
 * the AI feed scorer doesn't need it — it grounds in UserProfile directly).
 *
 * Returns `{ profile, userProfile }` so callers that ALSO want the rich IDB
 * snapshot (e.g. AI scoring's formatUserBackground) skip a duplicate read.
 */
async function getProfileOrDerive(): Promise<{
  profile: ProfileContext | null;
  userProfile: Awaited<ReturnType<typeof getUserProfile>>;
}> {
  const [stored, up] = await Promise.all([getProfile(), getUserProfile().catch(() => null)]);
  if (stored) return { profile: stored, userProfile: up };
  if (up) return { profile: profileContextFromUserProfile(up), userProfile: up };
  return { profile: null, userProfile: null };
}
import type {
  ParsedPost,
  ScoredPost,
  ToneKey,
  LengthKey,
  SsiSnapshot,
  ProviderConfig,
  CadenceTargets,
} from './storage-schema';
import {
  append as logAppend,
  attachOutcome as logAttachOutcome,
  pendingOutcomes as logPendingOutcomes,
  getByPostId as logGetByPostId,
  topTopics as logTopTopics,
  type AppendInput,
} from './action-log';
import { maybeAdvanceStreak, weeklyProgress, weakestPillar } from './cadence';
import {
  dismissRetro,
  getCardsOrRefresh,
  getRetroIfDue,
  rankDaily,
  suggestPosts,
} from './recommender';

console.log('LinkMate background service worker loaded');

// ─── Onboarding — Option A welcome flow (issue #16) ────────────────────────
//
// On first install, open welcome.html in a new tab. The user explicitly opts
// in there before we touch their LinkedIn data. No auto-redirect or
// auto-capture on Chrome startup — that would surprise existing users.

function findWelcomePath(): string {
  const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
    web_accessible_resources?: Array<{ resources?: string[] }>;
  };
  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const r of entry.resources ?? []) {
      if (r.startsWith('welcome') && r.endsWith('.html')) return r;
    }
  }
  return 'welcome.html';
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;
  if (await getOnboardingCompleted()) return;
  try {
    await chrome.tabs.create({
      url: chrome.runtime.getURL(findWelcomePath()),
      active: true,
    });
  } catch (err) {
    console.warn('[LinkMate] failed to open welcome tab:', err);
  }
});

// Side panel: opens on the toolbar icon click, but ONLY on LinkedIn (plus the
// extension's own onboarding page). Everywhere else it's disabled so it neither
// opens nor lingers when you switch tabs.
const sidePanelApi = chrome.sidePanel as unknown as {
  setPanelBehavior: (o: { openPanelOnActionClick?: boolean }) => Promise<void>;
  setOptions: (o: { tabId?: number; enabled: boolean }) => Promise<void>;
};

// Disable the default "click toolbar icon → open panel everywhere" behaviour.
// We manually open it in the action.onClicked handler below, but only when
// the active tab is actually a LinkedIn page.
sidePanelApi
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch((err) => console.warn('[LinkMate] setPanelBehavior failed:', err));

function sidePanelAllowed(url?: string): boolean {
  if (!url) return false;
  if (url.startsWith('chrome-extension://')) return true; // welcome / onboarding
  try {
    return /(^|\.)linkedin\.com$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function syncSidePanelForTab(tabId: number, url?: string): Promise<void> {
  try {
    await sidePanelApi.setOptions({ tabId, enabled: sidePanelAllowed(url) });
  } catch (err) {
    console.warn('[LinkMate] sidePanel.setOptions failed:', err);
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' || info.url) void syncSidePanelForTab(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(
    (tab) => void syncSidePanelForTab(tabId, tab.url),
    () => {},
  );
});

// Toolbar icon click: open the side panel only when the active tab is LinkedIn.
// On non-LinkedIn tabs the click is intentionally a no-op for the side panel.
//
// IMPORTANT: sidePanel.open() must be called synchronously within the user
// gesture context that onClicked provides. Awaiting any Promise before calling
// open() causes Chrome to reject it ("not in response to a user gesture").
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !sidePanelAllowed(tab.url)) return;
  const sp = chrome.sidePanel as unknown as {
    open: (o: { tabId?: number }) => Promise<void>;
  };
  sp.open({ tabId: tab.id }).catch((err) =>
    console.warn('[LinkMate] action.onClicked open failed:', err)
  );
});

// On SW startup: default the panel OFF globally, then enable it on existing
// LinkedIn tabs.
(async () => {
  try {
    await sidePanelApi.setOptions({ enabled: false });
  } catch (err) {
    console.warn('[LinkMate] sidePanel global disable failed:', err);
  }
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id !== undefined) void syncSidePanelForTab(t.id, t.url);
    }
  } catch {
    /* tabs query best-effort */
  }
})();

// Issue #16 — content-script forwards the first user gesture on a LinkedIn
// profile page so we can open the side panel without the user clicking the
// extension icon. Chrome preserves the user-gesture token across this hop.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action === 'sidepanel.openFromGesture' && sender.tab?.id !== undefined) {
    const tabId = sender.tab.id;
    const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
      side_panel?: { default_path?: string };
    };
    const sidePanelPath = manifest.side_panel?.default_path ?? 'popup.html';
    const sp = chrome.sidePanel as unknown as {
      setOptions: (o: { tabId?: number; path?: string; enabled?: boolean }) => Promise<void>;
      open: (o: { tabId?: number; windowId?: number }) => Promise<void>;
    };
    void (async () => {
      try {
        await sp.setOptions({
          tabId,
          path: `${sidePanelPath}?targetTab=${tabId}&auto=1`,
          enabled: true,
        });
        await sp.open({ tabId });
        sendResponse({ ok: true });
      } catch (err) {
        console.warn('[LinkMate] sidepanel.openFromGesture failed:', err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // keep channel open for async sendResponse
  }
  return undefined;
});

// ─── AI generation parameters ───────────────────────────────────────────────

let aiTemperature = 0.85;
let aiMaxTokens = 150;

async function loadAIParameters(): Promise<void> {
  try {
    const result = await chrome.storage.sync.get(['aiTemperature', 'aiMaxTokens']);
    aiTemperature = result.aiTemperature || 0.85;
    aiMaxTokens = result.aiMaxTokens || 150;
    console.log(`🎛️ AI Parameters: temperature=${aiTemperature}, maxTokens=${aiMaxTokens}`);
  } catch (error) {
    console.error('Failed to load AI parameters, using defaults:', error);
  }
}
loadAIParameters();

// ─── Response validation ────────────────────────────────────────────────────

interface ValidationResult {
  valid: boolean;
  reason?: 'too_short' | 'too_long' | 'no_punctuation' | 'has_preamble' | 'generic';
  score?: number;
}

function validateReplyQuality(reply: string): ValidationResult {
  const trimmedReply = reply.trim();
  const wordCount = trimmedReply.split(/\s+/).length;

  if (wordCount < 10) return { valid: false, reason: 'too_short', score: 20 };
  if (wordCount > 80) return { valid: false, reason: 'too_long', score: 40 };
  if (!/[.!?]$/.test(trimmedReply)) return { valid: false, reason: 'no_punctuation', score: 50 };

  const preamblePatterns = [
    /^here['']?s\s/i,
    /^here\s+is\s/i,
    /^this\s+is\s/i,
    /^i['']?ve\s+rewritten/i,
    /^response:/i,
    /^reply:/i,
  ];
  for (const pattern of preamblePatterns) {
    if (pattern.test(trimmedReply)) return { valid: false, reason: 'has_preamble', score: 60 };
  }

  const genericPatterns = [
    /^(great|nice|good|excellent)\s+(post|share|article)[!.]/i,
    /^thanks?\s+for\s+sharing[!.]/i,
    /^(totally|completely)\s+agree[!.]/i,
  ];
  for (const pattern of genericPatterns) {
    if (pattern.test(trimmedReply)) return { valid: false, reason: 'generic', score: 45 };
  }

  let score = 70;
  if (trimmedReply.includes('?')) score += 10;
  if (/\d+(%|x|\s+(percent|times|increase|decrease))/i.test(trimmedReply)) score += 10;
  if (wordCount >= 15 && wordCount <= 40) score += 10;
  return { valid: true, score: Math.min(100, score) };
}

// ─── Prompts ────────────────────────────────────────────────────────────────

const FEW_SHOT_EXAMPLES = `
EXAMPLE 1:
Post: "Just launched our new product after 6 months of development!"
Reply: "The timing couldn't be better given the Q4 market trends. What was the biggest technical challenge your team overcame during development?"

EXAMPLE 2:
Post: "Remote work is killing company culture."
Reply: "Interesting perspective. We've actually seen the opposite—our async standups improved transparency by 40%. What specific cultural elements are you seeing decline?"

EXAMPLE 3:
Post: "AI will replace 80% of jobs in the next 5 years."
Reply: "That timeline seems aggressive based on current adoption curves. I've found AI augments rather than replaces roles—what industries are you seeing this happen fastest?"

EXAMPLE 4:
Post: "Finally hit our Q3 revenue target! Team effort pays off."
Reply: "Congrats on the milestone! Were there any unexpected strategies that moved the needle more than anticipated?"

EXAMPLE 5:
Post: "The key to successful leadership is transparency and communication."
Reply: "This resonates strongly. How do you balance transparency with keeping strategic plans confidential during competitive periods?"
`;

const DEFAULT_PROMPTS = {
  withComments: `You are a LinkedIn engagement expert. Respond DIRECTLY with the reply text only - no preambles, no explanations.

CRITICAL: Output 1-2 impactful sentences (maximum 40 words total). Start immediately with your response.

${FEW_SHOT_EXAMPLES}

SMART ANALYSIS:
- Study the top-performing comments' tone, style, and engagement patterns
- Identify what makes them successful: specific insights, relatable experiences, thought-provoking questions, or timely perspectives
- Notice if they use data, personal anecdotes, industry insights, or call-to-action phrases

YOUR REPLY STRATEGY:
- Match the energy level of top comments while adding your unique perspective
- If top comments ask questions → ask a related but different question
- If top comments share experiences → reference a contrasting or complementary experience
- If top comments provide insights → add supporting data or a fresh angle
- Use power words that drive engagement: "Actually...", "Interestingly...", "What if...", "I've found..."

ENGAGEMENT MULTIPLIERS:
- End with a question when possible (drives responses)
- Reference specific details from the original post
- Use "we" language to create community feeling
- Be conversational but professional`,

  standard: `You are a LinkedIn expert. Respond DIRECTLY with the reply text only - no preambles, no explanations.

CRITICAL: Output 1-2 impactful sentences (maximum 40 words total). Start immediately with your response.

${FEW_SHOT_EXAMPLES}

HIGH-IMPACT REPLY FORMULA:
1. Hook: Start with something attention-grabbing ("Actually...", "This reminds me...", "What's interesting...")
2. Value: Add genuine insight, experience, or perspective
3. Connection: End with a question or call-to-action when appropriate

PROVEN ENGAGEMENT PATTERNS:
- Share a micro-insight: "I've seen this approach increase results by 40% in my experience."
- Ask a strategic question: "What's been your biggest challenge implementing this strategy?"
- Provide a contrasting view: "While I agree, I'd add that timing is equally crucial here."
- Reference specific data/experience: "This aligns with the 70% increase we saw after..."

PROFESSIONAL TONE GUIDE:
- Confident but not arrogant
- Helpful but not promotional
- Personal but not oversharing
- Engaging but not casual

AVOID:
- Generic praise ("Great post!", "Thanks for sharing!")
- Multiple sentences or explanations
- Obvious statements everyone would agree with
- Self-promotional content`,
};

async function getUserPrompt(type: 'withComments' | 'standard'): Promise<string> {
  try {
    const result = await chrome.storage.sync.get(['customPrompts']);
    const customPrompts = result.customPrompts || {};
    if (customPrompts[type] && customPrompts[type].trim().length > 0) {
      return customPrompts[type];
    }
    return DEFAULT_PROMPTS[type];
  } catch (error) {
    console.error('Error reading custom prompt, using default:', error);
    return DEFAULT_PROMPTS[type];
  }
}

// ─── Reply post-processing ──────────────────────────────────────────────────

const PREAMBLE_PATTERNS = [
  /^Here'?s? (?:a |the |your |my )?(?:professional |rewritten |revised |improved )?(?:LinkedIn |response|reply|version|comment).*?:\s*/i,
  /^This (?:is |would be |could be )?(?:a |the |your |my )?(?:LinkedIn |response|reply).*?:\s*/i,
  /^(?:Sure|Certainly|Absolutely)[,!]?\s*(?:here'?s?|this is).*?:\s*/i,
  /^I'?(?:ve|ll|d)? (?:rewritten|revised|created|generated|made).*?:\s*/i,
  /^(?:Response|Reply|Comment|Answer):\s*/i,
  /^Here you go:\s*/i,
  /^.*?(?:meets?|meeting|fulfill?s?) (?:the |your )?requirements?.*?:\s*/i,
];

function cleanReply(text: string): string {
  let cleaned = text.trim();
  for (const pattern of PREAMBLE_PATTERNS) cleaned = cleaned.replace(pattern, '');
  const contentLines = cleaned.split('\n').filter((line) => {
    const lower = line.toLowerCase().trim();
    return (
      !lower.startsWith('here') &&
      !lower.includes('rewritten') &&
      !lower.includes('requirements') &&
      !lower.includes('professional linkedin')
    );
  });
  return contentLines.join(' ').trim();
}

function trimToTwoSentences(reply: string): string {
  const sentences = reply.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const max = sentences.slice(0, 2).join('. ').trim();
  return max + (reply.endsWith('?') ? '' : '.');
}

// ─── SSI alarm constant (hoisted; install listener references it below) ────

const SSI_ALARM_NAME = 'linkmate.ssi.daily';
const SSI_CAPTURE_TIMEOUT_MS = 30_000;
const SSI_URL = 'https://www.linkedin.com/sales/ssi';

// ─── Install / lifecycle ────────────────────────────────────────────────────

const RECOMMENDER_ALARM_NAME = 'linkmate.recommender.daily';

/** Register alarms defensively at every SW startup. chrome.alarms.create
 *  with the same name+period is a no-op for an existing alarm, so this is
 *  cheap. Belt-and-suspenders vs an `onInstalled` we might miss. */
chrome.alarms.create(SSI_ALARM_NAME, { periodInMinutes: 1440 });
chrome.alarms.create(RECOMMENDER_ALARM_NAME, { periodInMinutes: 1440 });

chrome.runtime.onInstalled.addListener((details) => {
  console.log('Extension installed:', details.reason);
  chrome.storage.local.set({ hasUsedExtension: true });
});

/** Run storage migrations + mint the anonymous install token at every SW
 *  startup. migrateIfNeeded is idempotent; ensureInstallToken is a no-op once
 *  set. This guarantees managed mode has a token before any generate() call. */
migrateIfNeeded()
  .then(() => ensureInstallToken())
  .catch((err) => console.warn('[LinkMate] migration/install-token init failed:', err));

// ─── Global pause (master killswitch) ───────────────────────────────────────
//
// When paused we block every *active* feature (LLM calls, SSI capture, profile
// scraping) at this single choke point — content scripts have already torn
// their UI down, this guards popup-triggered + stray actions too. Pure reads
// (history/config/audit) stay open so the side panel still shows cached data.

let isPaused = false;
getPaused()
  .then((v) => {
    isPaused = v;
  })
  .catch(() => {});

const PAUSED_BLOCKED_ACTIONS = new Set([
  'generateLinkedInReply',
  'generateLinkedInReplyWithComments',
  'queue.scoreFeed',
  'queue.draftComment',
  'queue.aiScoreFeed',
  'profile.audit.rewrite',
  'recommender.refresh',
  'recommender.suggestPosts',
  'ssi.captureNow',
  'profile.capture',
]);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(STORAGE_KEYS.paused in changes)) return;
  const next = Boolean(changes[STORAGE_KEYS.paused].newValue);
  const wasPaused = isPaused;
  isPaused = next;
  // Resume → auto-refresh: pull a fresh SSI snapshot and re-rank recommendations
  // immediately so the panel reflects current state without waiting for alarms.
  if (wasPaused && !next) {
    startSsiCapture()
      .then(async (snap) => {
        await appendSsiSnapshot(snap);
        await clearSsiLastError();
        rankDaily().catch((err) => console.warn('Resume recommender refresh failed:', err));
      })
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        await setSsiLastError({ message: msg, capturedAt: Date.now() });
      });
  }
});

// ─── Message router ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'linkedinContentScriptReady') {
    sendResponse({ engineReady: true, cloudMode: true });
    return false;
  }

  // Master killswitch — short-circuit active features while paused.
  if (isPaused && PAUSED_BLOCKED_ACTIONS.has(request.action)) {
    sendResponse({ ok: false, paused: true, error: 'LinkMate is paused.' });
    return false;
  }

  if (request.action === 'generateLinkedInReply') {
    handleLinkedInReply(request.postContent, sendResponse);
    return true;
  }

  if (request.action === 'generateLinkedInReplyWithComments') {
    handleLinkedInReplyWithComments(request.postContent, request.topComments, sendResponse);
    return true;
  }

  if (request.action === 'checkEngineStatus') {
    (async () => {
      const cfg = await getProviderConfig();
      if (cfg.mode === 'managed') {
        const token = await ensureInstallToken();
        const ready = !!token;
        sendResponse({
          engineReady: ready,
          initializing: false,
          currentModel: cfg.managed?.model ?? 'gpt-4o-mini',
          healthy: ready,
          cached: true,
          cacheMessage: ready ? 'LinkMate free AI ready' : 'Initializing…',
        });
        return;
      }
      const byokKey = cfg.mode === 'groq' ? cfg.groq?.apiKey : cfg.openai?.apiKey;
      const hasKey = !!byokKey;
      const label = cfg.mode === 'groq' ? 'Groq' : 'OpenAI';
      sendResponse({
        engineReady: hasKey,
        initializing: false,
        currentModel: (cfg.mode === 'groq' ? cfg.groq?.model : cfg.openai?.model) ?? null,
        healthy: hasKey,
        cached: true,
        cacheMessage: hasKey ? `${label} configured` : `Add ${label} API key in popup`,
      });
    })();
    return true;
  }

  if (request.action === 'getPrompts') {
    chrome.storage.sync.get(['customPrompts'], (result) => {
      sendResponse({ prompts: result.customPrompts || {}, defaults: DEFAULT_PROMPTS });
    });
    return true;
  }

  if (request.action === 'savePrompts') {
    if (!request.prompts || typeof request.prompts !== 'object') {
      sendResponse({ success: false, error: 'Invalid prompts structure' });
      return true;
    }
    const validatedPrompts = {
      standard: request.prompts.standard || '',
      withComments: request.prompts.withComments || '',
    };
    chrome.storage.sync.set({ customPrompts: validatedPrompts }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'resetPrompts') {
    chrome.storage.sync.remove('customPrompts', () => sendResponse({ success: true }));
    return true;
  }

  if (request.action === 'updateAIParameters') {
    if (typeof request.temperature === 'number') aiTemperature = request.temperature;
    if (typeof request.maxTokens === 'number') aiMaxTokens = request.maxTokens;
    sendResponse({ success: true, temperature: aiTemperature, maxTokens: aiMaxTokens });
    return false;
  }

  if (request.action === 'popupReady') return false;

  // Engagement Queue handlers.
  if (request.action === 'queue.scoreFeed') {
    handleQueueScoreFeed(request.posts as ParsedPost[], sendResponse);
    return true;
  }
  if (request.action === 'queue.draftComment') {
    handleQueueDraftComment(
      request.post as ParsedPost,
      request.tone as ToneKey,
      request.length as LengthKey,
      sendResponse
    );
    return true;
  }
  if (request.action === 'queue.markEngaged') {
    storageMarkEngaged(request.postId as string)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'queue.dismiss') {
    addDismissedPostId(request.postId as string)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'queue.aiScoreFeed') {
    handleQueueAiScoreFeed(request.posts as ParsedPost[], sendResponse);
    return true;
  }
  if (request.action === 'profile.audit.get') {
    handleProfileAuditGet(sendResponse);
    return true;
  }
  if (request.action === 'profile.audit.rewrite') {
    handleProfileAuditRewrite(Boolean(request.regenerate), sendResponse);
    return true;
  }
  if (request.action === 'settings.getGoalsOverride') {
    getGoalsOverride()
      .then((value) => sendResponse({ ok: true, value }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'settings.setGoalsOverride') {
    setGoalsOverride(String(request.value ?? ''))
      .then(() => {
        clearAiCache();
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Provider config handlers.
  if (request.action === 'provider.get') {
    getProviderConfig()
      .then((cfg) => sendResponse({ ok: true, config: cfg }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'provider.set') {
    setProviderConfig(request.config as ProviderConfig)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'quota.get') {
    handleQuotaGet(sendResponse);
    return true;
  }

  // ─── Action log + cadence handlers ────────────────────────────────────────
  if (request.action === 'action.log.append') {
    logAppend(request.input as AppendInput)
      .then((id) => sendResponse({ ok: true, id }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'action.log.weeklyProgress') {
    weeklyProgress()
      .then((p) => sendResponse({ ok: true, progress: p, weakest: weakestPillar(p) }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'action.log.pending') {
    logPendingOutcomes()
      .then((rows) => sendResponse({ ok: true, rows }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'action.log.attachOutcome') {
    logAttachOutcome(request.input)
      .then((id) => sendResponse({ ok: true, id }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'action.log.byPostId') {
    logGetByPostId(request.postId as string)
      .then((rows) => sendResponse({ ok: true, rows }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'action.log.topTopics') {
    logTopTopics(request.days as number | undefined, request.n as number | undefined)
      .then((topics) => sendResponse({ ok: true, topics }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'cadence.getTargets') {
    getCadenceTargets()
      .then((t) => sendResponse({ ok: true, targets: t }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'cadence.setTargets') {
    setCadenceTargets(request.targets as CadenceTargets)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'recommender.getCards') {
    getCardsOrRefresh()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'recommender.refresh') {
    rankDaily()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'recommender.suggestPosts') {
    suggestPosts()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'recommender.getRetro') {
    getRetroIfDue()
      .then((retro) => sendResponse({ ok: true, retro }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (request.action === 'recommender.dismissRetro') {
    dismissRetro()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (request.action === 'cadence.streak') {
    Promise.all([getCadenceStreak(), maybeAdvanceStreak()])
      .then(([prior, advance]) =>
        sendResponse({ ok: true, count: advance.streak, advanced: advance.advanced, prior })
      )
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // SSI tracker handlers.
  if (request.action === 'ssi.captureNow') {
    startSsiCapture()
      .then(async (snap) => {
        await appendSsiSnapshot(snap);
        await clearSsiLastError();
        sendResponse({ ok: true, snapshot: snap });
      })
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        await setSsiLastError({ message: msg, capturedAt: Date.now() });
        sendResponse({ ok: false, error: msg });
      });
    return true;
  }
  if (request.action === 'ssi.getHistory') {
    getSsiHistory()
      .then((snapshots) => {
        const days = request.days as number | undefined;
        if (days && days > 0) {
          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
          sendResponse({ snapshots: snapshots.filter((s) => s.capturedAt >= cutoff) });
        } else {
          sendResponse({ snapshots });
        }
      })
      .catch((err) => sendResponse({ snapshots: [], error: String(err) }));
    return true;
  }
  if (request.action === 'ssi.snapshotReady') {
    if (request.snapshot && pendingSsiCapture) {
      const cap = pendingSsiCapture;
      pendingSsiCapture = null;
      clearTimeout(cap.timeoutId);
      cap.resolve(request.snapshot as SsiSnapshot);
      sendResponse({ stored: true });
    } else if (request.error && pendingSsiCapture) {
      const cap = pendingSsiCapture;
      pendingSsiCapture = null;
      clearTimeout(cap.timeoutId);
      cap.reject(new Error(String(request.error)));
      sendResponse({ stored: false });
    } else {
      sendResponse({ stored: false });
    }
    return false;
  }

  if (request.action === 'profile.capture') {
    handleProfileCapture(request.fields as RawProfileFields, sendResponse);
    return true;
  }

  if (request.type === 'SUCCESS_REDIRECT') {
    chrome.tabs.create({ url: 'https://www.linkedin.com/' });
    return false;
  }
});

// ─── SSI Capture ────────────────────────────────────────────────────────────

interface PendingSsiCapture {
  tabId: number;
  resolve: (snap: SsiSnapshot) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}
let pendingSsiCapture: PendingSsiCapture | null = null;

async function startSsiCapture(): Promise<SsiSnapshot> {
  if (pendingSsiCapture) throw new Error('SSI capture already in progress');
  keepAlive.start();
  let createdTabId: number | undefined;
  let onUpdatedListener: ((tabId: number, info: chrome.tabs.TabChangeInfo) => void) | null = null;
  try {
    const tab = await chrome.tabs.create({ url: SSI_URL, active: false });
    if (!tab.id) throw new Error('Failed to create background tab');
    createdTabId = tab.id;

    const snapshot = await new Promise<SsiSnapshot>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingSsiCapture = null;
        reject(new Error(`SSI capture timed out after ${SSI_CAPTURE_TIMEOUT_MS / 1000}s`));
      }, SSI_CAPTURE_TIMEOUT_MS);
      pendingSsiCapture = { tabId: tab.id!, resolve, reject, timeoutId };

      onUpdatedListener = (tabId, changeInfo) => {
        if (tabId !== createdTabId) return;
        const url = changeInfo.url;
        if (!url) return;
        const isAwayFromSsi =
          !url.startsWith('https://www.linkedin.com/sales/ssi') &&
          (url.includes('/login') || url.includes('/uas/login') || url.includes('/checkpoint'));
        if (isAwayFromSsi && pendingSsiCapture) {
          const cap = pendingSsiCapture;
          pendingSsiCapture = null;
          clearTimeout(cap.timeoutId);
          cap.reject(new Error('Not signed in to LinkedIn — sign in and try again.'));
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdatedListener);
    });
    return snapshot;
  } finally {
    if (onUpdatedListener) {
      try {
        chrome.tabs.onUpdated.removeListener(onUpdatedListener);
      } catch {
        /* ignore */
      }
    }
    if (createdTabId !== undefined) {
      try {
        await chrome.tabs.remove(createdTabId);
      } catch {
        /* tab may already be gone */
      }
    }
    pendingSsiCapture = null;
    keepAlive.stop();
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  // Paused = no background work either.
  if (isPaused) {
    console.log('⏸ LinkMate paused — skipping alarm', alarm.name);
    return;
  }
  if (alarm.name === SSI_ALARM_NAME) {
    console.log('⏰ SSI daily alarm fired');
    startSsiCapture()
      .then(async (snap) => {
        await appendSsiSnapshot(snap);
        await clearSsiLastError();
        console.log(`✅ SSI snapshot captured: total=${snap.total}`);
        // Chain recommender refresh — fresh SSI improves the prompt context.
        rankDaily().catch((err) => console.warn('Post-SSI recommender refresh failed:', err));
      })
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('⚠️ SSI daily capture failed:', msg);
        await setSsiLastError({ message: msg, capturedAt: Date.now() });
      });
    return;
  }
  if (alarm.name === RECOMMENDER_ALARM_NAME) {
    console.log('⏰ Recommender daily alarm fired');
    rankDaily().catch((err) => console.warn('Recommender daily refresh failed:', err));
    return;
  }
});

// ─── Engagement Queue handlers ──────────────────────────────────────────────

async function handleQueueScoreFeed(
  posts: ParsedPost[],
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const { profile } = await getProfileOrDerive();
    if (!profile) {
      sendResponse({
        ok: false,
        error: 'No profile yet. Click Capture Profile in the side panel to start.',
      });
      return;
    }
    const [engaged, dismissed] = await Promise.all([getEngagedPosts(), getDismissedPostIds()]);
    const engagedIds = new Set(engaged.map((e) => e.postId));
    const dismissedIds = new Set(dismissed);
    const recentlyDisplayedAuthors: string[] = [];
    const scored: ScoredPost[] = posts.map((p) => ({
      ...p,
      relevance: scoreRelevance({
        post: p,
        profile,
        signals: {
          alreadyEngaged: engagedIds.has(p.id),
          dismissed: dismissedIds.has(p.id),
          recentlyDisplayedAuthors,
        },
      }),
    }));
    sendResponse({ ok: true, scored });
  } catch (err) {
    console.error('queue.scoreFeed failed:', err);
    sendResponse({ ok: false, error: String(err) });
  }
}

async function handleQueueDraftComment(
  post: ParsedPost,
  tone: ToneKey,
  length: LengthKey,
  sendResponse: (response: unknown) => void
): Promise<void> {
  keepAlive.start();
  try {
    const profile = await getProfile();
    if (!profile) {
      sendResponse({ ok: false, error: 'No profile captured.' });
      return;
    }
    const provider = await getActiveProvider();
    const { system, user } = buildCommentPrompt({ profile, post, tone, length });
    const draft = await provider.generate({
      system,
      user,
      maxTokens: aiMaxTokens,
      temperature: aiTemperature,
      topP: 0.9,
    });
    sendResponse({ ok: true, draft, provider: provider.name, isCloud: provider.isCloud });
  } catch (err) {
    console.error('queue.draftComment failed:', err);
    sendResponse({ ok: false, error: String(err) });
  } finally {
    keepAlive.stop();
  }
}

async function handleProfileCapture(
  fields: RawProfileFields,
  sendResponse: (response: unknown) => void
): Promise<void> {
  keepAlive.start();
  try {
    const provider = await getActiveProvider();
    const { system, user } = buildPositioningPrompt({
      headline: fields.headline,
      about: fields.about,
      topSkills: fields.topSkills,
      recentPostThemes: fields.recentPostThemes,
    });
    const positioningSummary = await provider.generate({
      system,
      user,
      maxTokens: 120,
      temperature: 0.4,
      topP: 0.9,
    });
    // Profile re-captured → AI feed scoring cache is stale relative to the
    // new `capturedAt` and may also be relative to new skills/themes. Drop it.
    clearAiCache();
    sendResponse({
      ok: true,
      positioningSummary,
      provider: provider.name,
      isCloud: provider.isCloud,
    });
  } catch (err) {
    console.error('profile.capture failed:', err);
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    keepAlive.stop();
  }
}

// ─── Issue #18 — AI feed scoring (per-post chips) ─────────────────────────

const SCORE_BATCH_TOP_N = 10;

async function handleQueueAiScoreFeed(
  posts: ParsedPost[],
  sendResponse: (response: unknown) => void
): Promise<void> {
  const top = (posts ?? []).slice(0, SCORE_BATCH_TOP_N);
  if (top.length === 0) {
    sendResponse({ ok: true, results: [] });
    return;
  }
  keepAlive.start();
  try {
    const { profile, userProfile } = await getProfileOrDerive();
    if (!profile) {
      sendResponse({ ok: false, reason: 'no_profile' });
      return;
    }
    let provider;
    try {
      provider = await getActiveProvider();
    } catch {
      sendResponse({ ok: false, reason: 'no_key' });
      return;
    }
    const goalsOverride = await getGoalsOverride();
    try {
      const results = await aiScoreBatch({
        provider,
        profile,
        goalsOverride,
        posts: top,
        userProfile,
      });
      sendResponse({ ok: true, results });
    } catch (err) {
      if (err instanceof AiParseError) {
        console.warn('[linkmate] queue.aiScoreFeed parse failure:', err.message);
        sendResponse({ ok: false, reason: 'parse' });
      } else {
        console.warn('[linkmate] queue.aiScoreFeed failed:', err);
        sendResponse({ ok: false, reason: 'network', error: String(err) });
      }
    }
  } finally {
    keepAlive.stop();
  }
}

// ─── Issue #28 — profile audit + AI rewrite suggestions ───────────────────

async function handleProfileAuditGet(
  sendResponse: (response: unknown) => void,
): Promise<void> {
  try {
    const up = await getUserProfile().catch(() => null);
    if (!up) {
      sendResponse({ ok: true, state: null });
      return;
    }
    const audit = auditProfile(up);
    const [stored, ssiHistory] = await Promise.all([
      getProfileAuditState().catch(() => null),
      getSsiHistory().catch(() => []),
    ]);
    const ssi = ssiHistory.length > 0 ? ssiHistory[ssiHistory.length - 1] : null;
    // Don't pair a freshly-captured profile with a stale SSI snapshot — a 2-week-old
    // score next to today's activity reads as current and misleads the user. Suppress
    // SSI older than 14d so the signal row drops out rather than showing wrong data.
    const SSI_STALE_MS = 14 * 24 * 60 * 60 * 1000;
    const ssiFresh = ssi && Date.now() - ssi.capturedAt <= SSI_STALE_MS ? ssi : null;
    const activitySignals = computeActivitySignals(up, ssiFresh?.total ?? null);
    const recommendations =
      stored && stored.profileCapturedAt === up.capturedAt ? stored.recommendations : null;
    const recommendationsAt =
      stored && stored.profileCapturedAt === up.capturedAt ? stored.recommendationsAt : 0;
    const avoidStems =
      stored && stored.profileCapturedAt === up.capturedAt ? stored.avoidStems ?? [] : [];
    sendResponse({
      ok: true,
      state: {
        profileCapturedAt: up.capturedAt,
        audit,
        recommendations,
        recommendationsAt,
        ssi,
        avoidStems,
        activitySignals,
      },
    });
  } catch (err) {
    console.warn('[linkmate] profile.audit.get failed:', err);
    sendResponse({ ok: false, error: String(err) });
  }
}

async function handleProfileAuditRewrite(
  regenerate: boolean,
  sendResponse: (response: unknown) => void,
): Promise<void> {
  keepAlive.start();
  try {
    const up = await getUserProfile().catch(() => null);
    if (!up) {
      sendResponse({ ok: false, reason: 'no_profile' });
      return;
    }
    let provider;
    try {
      provider = await getActiveProvider();
    } catch {
      sendResponse({ ok: false, reason: 'no_key' });
      return;
    }
    const audit = auditProfile(up);
    const [goals, ssiHistory, storedAudit] = await Promise.all([
      getGoalsOverride(),
      getSsiHistory().catch(() => []),
      getProfileAuditState().catch(() => null),
    ]);
    const ssi = ssiHistory.length > 0 ? ssiHistory[ssiHistory.length - 1] : null;
    // Only carry stems forward if the profile snapshot hasn't changed. A new
    // capture should start with a blank slate so the LLM gets fresh framing.
    const carriedStems =
      regenerate && storedAudit && storedAudit.profileCapturedAt === up.capturedAt
        ? storedAudit.avoidStems ?? []
        : [];
    try {
      const recommendations = await generateProfileRecommendations({
        provider,
        profile: up,
        audit,
        goals,
        ssi,
        avoidStems: carriedStems,
      });
      const newEntries = recommendations
        .map((r) => ({
          checkId: r.checkId,
          stem: r.suggestion.slice(0, AVOID_STEM_LEN).trim(),
        }))
        .filter((e) => e.stem.length > 0);
      // Dedupe by stem (same wording is useless to send twice). Most recent
      // wins. Cap to AVOID_STEM_HISTORY_CAP to keep prompt size bounded.
      const merged = dedupeEntriesKeepLast([...carriedStems, ...newEntries]).slice(
        -AVOID_STEM_HISTORY_CAP,
      );
      const state = {
        profileCapturedAt: up.capturedAt,
        audit,
        recommendations,
        recommendationsAt: Date.now(),
        avoidStems: merged,
      };
      await setProfileAuditState(state);
      // Include live-derived fields (ssi + activitySignals) in the wire
      // response so the popup can update the header + signal rows without
      // a second round-trip.
      const activitySignals = computeActivitySignals(up, ssi?.total ?? null);
      sendResponse({ ok: true, state: { ...state, ssi, activitySignals } });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        sendResponse({ ok: false, reason: 'quota', error: err.message });
      } else if (err instanceof ProfileRecommenderParseError) {
        console.warn('[linkmate] profile.audit.rewrite parse failure:', err.message);
        sendResponse({ ok: false, reason: 'parse' });
      } else {
        console.warn('[linkmate] profile.audit.rewrite failed:', err);
        sendResponse({ ok: false, reason: 'network', error: String(err) });
      }
    }
  } finally {
    keepAlive.stop();
  }
}

/** Keep last occurrence of each duplicate stem; preserves insertion order otherwise. */
function dedupeEntriesKeepLast<T extends { stem: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (seen.has(e.stem)) continue;
    seen.add(e.stem);
    out.unshift(e);
  }
  return out;
}

// ─── Reply generation (standard + with comments) ────────────────────────────

async function generateWithRetry(systemPrompt: string, userPrompt: string): Promise<string> {
  const provider = await getActiveProvider();
  const raw = await provider.generate({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: aiMaxTokens,
    temperature: aiTemperature,
    topP: 0.9,
    stop: ['\n\n', '\n\n\n'],
  });
  const firstReply = trimToTwoSentences(cleanReply(raw));
  const firstValidation = validateReplyQuality(firstReply);
  const firstGates = runCommentGates(firstReply);
  const firstOk =
    (firstValidation.valid || (firstValidation.score ?? 0) >= 60) && firstGates.passed;
  if (firstOk) return firstReply;
  if (!firstGates.passed) {
    console.log('[LinkMate] comment gates failed, retrying:', firstGates.failures.join(', '));
  }

  const retry = await provider.generate({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: aiMaxTokens,
    temperature: Math.min(1.0, aiTemperature + 0.15),
    topP: 0.9,
    stop: ['\n\n', '\n\n\n'],
  });
  const retryReply = trimToTwoSentences(cleanReply(retry));
  const retryValidation = validateReplyQuality(retryReply);
  const retryGates = runCommentGates(retryReply);

  // Prefer the candidate that passes the deterministic gates; if both or neither
  // pass, fall back to the higher validation score.
  if (retryGates.passed && !firstGates.passed) return retryReply;
  if (firstGates.passed && !retryGates.passed) return firstReply;
  return retryValidation.valid || (retryValidation.score ?? 0) > (firstValidation.score ?? 0)
    ? retryReply
    : firstReply;
}

// ─── Self-check gate (issue #64 step 3) ─────────────────────────────────────
//
// After generating, ask the provider which SPECIFIC claim in the post the
// comment addresses. If it can't point to one (NONE / not actually in the post),
// the comment is keyword-matching, not understanding — regenerate once, then
// surface with a warning flag. Behind a sync pref, default ON. Never auto-submits.

const SELF_CHECK_DEFAULT = true;

async function getCommentSelfCheckEnabled(): Promise<boolean> {
  try {
    const r = await chrome.storage.sync.get(['commentSelfCheck']);
    return r.commentSelfCheck === undefined ? SELF_CHECK_DEFAULT : !!r.commentSelfCheck;
  } catch {
    return SELF_CHECK_DEFAULT;
  }
}

/** True if at least `min` consecutive words of `quote` appear in `post`. */
function quoteGroundedInPost(quote: string, post: string, min = 3): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const p = norm(post);
  const words = norm(quote).split(' ').filter(Boolean);
  if (words.length === 0) return false;
  if (words.length <= min) return p.includes(words.join(' '));
  for (let i = 0; i + min <= words.length; i++) {
    if (p.includes(words.slice(i, i + min).join(' '))) return true;
  }
  return false;
}

async function selfCheckSpecificity(
  postContent: string,
  comment: string
): Promise<{ addressed: boolean; evidence: string }> {
  const provider = await getActiveProvider();
  const raw = await provider.generate({
    system:
      'You verify whether a LinkedIn comment engages a specific claim in a post. ' +
      'Reply with a SHORT exact quote (max 15 words) copied from the POST that the COMMENT directly addresses. ' +
      'If the comment is generic and addresses no specific claim, reply with the single word NONE. ' +
      'Output the quote or NONE only — no other text.',
    user: `POST:\n"""\n${postContent}\n"""\n\nCOMMENT:\n"""\n${comment}\n"""\n\nWhich specific claim from the POST does the COMMENT address?`,
    maxTokens: 40,
    temperature: 0,
    topP: 1,
  });
  const ans = raw.trim().replace(/^["']|["']$/g, '');
  const isNone = ans.length === 0 || /^none\b/i.test(ans);
  const addressed = !isNone && quoteGroundedInPost(ans, postContent);
  return { addressed, evidence: ans };
}

/**
 * Generate a comment, then run the optional self-check. Regenerates once if the
 * comment doesn't address a specific claim; if it still can't be verified,
 * returns a `warning` flag so the UI can mark it (no blocking, no auto-submit).
 */
async function generateComment(
  systemPrompt: string,
  userPrompt: string,
  postContent: string
): Promise<{ reply: string; warning?: string }> {
  const reply = await generateWithRetry(systemPrompt, userPrompt);
  let enabled = false;
  try {
    enabled = await getCommentSelfCheckEnabled();
  } catch {
    enabled = false;
  }
  if (!enabled) return { reply };

  try {
    const first = await selfCheckSpecificity(postContent, reply);
    if (first.addressed) return { reply };

    const reply2 = await generateWithRetry(systemPrompt, userPrompt);
    const second = await selfCheckSpecificity(postContent, reply2);
    if (second.addressed) return { reply: reply2 };
    return { reply: reply2, warning: 'unverified_specificity' };
  } catch (err) {
    // Self-check failures must never block the draft — return the first reply.
    console.warn('[LinkMate] self-check skipped:', err);
    return { reply };
  }
}

/**
 * Report the managed free-tier balance for the popup. Only meaningful in
 * managed mode; BYOK is unlimited. Fails soft — UI shows "—" on error rather
 * than blocking, and never surfaces the install token.
 */
async function handleQuotaGet(sendResponse: (response: unknown) => void): Promise<void> {
  try {
    const cfg = await getProviderConfig();
    if (cfg.mode !== 'managed') {
      sendResponse({ ok: true, unlimited: true });
      return;
    }
    const token = await getInstallToken();
    if (!token) {
      sendResponse({ ok: false, error: 'No install token yet' });
      return;
    }
    const baseUrl = cfg.managed?.baseUrl ?? MANAGED_BASE_URL;
    const res = await fetch(`${baseUrl}/quota`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      sendResponse({ ok: false, error: `Quota check failed (${res.status})` });
      return;
    }
    const data = (await res.json()) as {
      usedUSD?: number;
      limitUSD?: number;
      remainingUSD?: number;
    };
    sendResponse({
      ok: true,
      unlimited: false,
      usedUSD: data.usedUSD ?? 0,
      limitUSD: data.limitUSD ?? 0,
      remainingUSD: data.remainingUSD ?? 0,
    });
  } catch (err) {
    sendResponse({ ok: false, error: String(err) });
  }
}

async function handleLinkedInReplyWithComments(
  postContent: string,
  topComments: Array<{ text: string; likeCount: number }>,
  sendResponse: (response: unknown) => void
) {
  try {
    const systemPrompt = await getUserPrompt('withComments');
    const topCommentsContext =
      topComments.length > 0
        ? `\n\nTOP PERFORMING COMMENTS (study these patterns):\n${topComments
            .slice(0, 5)
            .map(
              (c, i) =>
                `Comment ${i + 1} (${c.likeCount} likes):\n"${c.text}"\nEngagement factor: ${
                  c.likeCount > 100
                    ? 'Viral'
                    : c.likeCount > 50
                      ? 'High'
                      : c.likeCount > 20
                        ? 'Medium'
                        : 'Standard'
                }\n`
            )
            .join(
              '\n'
            )}\nKEY PATTERN: Notice what makes these comments successful and apply similar strategies.`
        : '\n\nNo high-engagement comments available. Focus on adding unique value and asking thoughtful questions.';

    const userPrompt = `Generate a professional LinkedIn reply to this post:

POST CONTENT:
"${postContent}"
${topCommentsContext}

CRITICAL REQUIREMENTS:
- 1-2 impactful sentences (maximum 40 words total)
- No introductory phrases like "Great post!"
- Add genuine value or ask a thoughtful question
- Be conversational and engaging
- DO NOT include any preambles like "Here's a reply:" or explanations
- Start your response immediately with the actual content

Write your reply directly (no preambles):`;

    const { reply: finalReply, warning } = await generateComment(
      systemPrompt,
      userPrompt,
      postContent
    );
    sendResponse({
      reply: finalReply,
      basedOnComments: true,
      commentCount: topComments.length,
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    console.error('handleLinkedInReplyWithComments failed:', error);
    sendResponse({ error: 'Failed to generate reply', fallback: true });
  }
}

async function handleLinkedInReply(postContent: string, sendResponse: (response: unknown) => void) {
  try {
    const systemPrompt = await getUserPrompt('standard');

    const postLength = postContent.length;
    const hasQuestion = postContent.includes('?');
    const hasData = /\d+%|\d+\s*(million|billion|thousand)|\$\d+/i.test(postContent);

    const contextHints = `
POST ANALYSIS:
- Length: ${postLength < 100 ? 'Brief' : postLength < 300 ? 'Medium' : 'Detailed'}
- Type: ${hasQuestion ? 'Question/Discussion' : hasData ? 'Data/Insights' : 'Thought/Opinion'}
- Engagement opportunity: ${hasQuestion ? 'Answer the question' : 'Add perspective'}`;

    const userPrompt = `Generate a professional LinkedIn reply to this post:

"${postContent}"
${contextHints}

CRITICAL REQUIREMENTS:
- 1-2 impactful sentences (maximum 40 words total)
- No introductory phrases like "Great post!"
- Add genuine value or ask a thoughtful question
- Be conversational and engaging
- DO NOT include any preambles like "Here's a reply:" or explanations
- Start your response immediately with the actual content

Write your reply directly (no preambles):`;

    const { reply: finalReply, warning } = await generateComment(
      systemPrompt,
      userPrompt,
      postContent
    );
    sendResponse({ reply: finalReply, ...(warning ? { warning } : {}) });
  } catch (error) {
    console.error('handleLinkedInReply failed:', error);
    const fallbackReplies = [
      "Insightful perspective! What's been your experience with this approach?",
      "This resonates strongly with what we're seeing in the field.",
      'Excellent points - particularly about the implementation challenges.',
      'Appreciate you sharing this data-driven analysis!',
      'Interesting take - how do you see this evolving in the next year?',
    ];
    sendResponse({
      reply: fallbackReplies[Math.floor(Math.random() * fallbackReplies.length)],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
