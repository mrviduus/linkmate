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
import { getActiveProvider } from './providers';
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
} from './storage-schema';
import type {
  ParsedPost,
  ScoredPost,
  ToneKey,
  LengthKey,
  SsiSnapshot,
  ProviderConfig,
} from './storage-schema';

console.log('LinkMate background service worker loaded');

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
  if (!/[.!?]$/.test(trimmedReply))
    return { valid: false, reason: 'no_punctuation', score: 50 };

  const preamblePatterns = [
    /^here['']?s\s/i,
    /^here\s+is\s/i,
    /^this\s+is\s/i,
    /^i['']?ve\s+rewritten/i,
    /^response:/i,
    /^reply:/i,
  ];
  for (const pattern of preamblePatterns) {
    if (pattern.test(trimmedReply))
      return { valid: false, reason: 'has_preamble', score: 60 };
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

// ─── Install / lifecycle ────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log('Extension installed:', details.reason);
  chrome.storage.local.set({ hasUsedExtension: true });
  chrome.alarms.create(SSI_ALARM_NAME, { periodInMinutes: 1440 });
  console.log(`⏰ Registered daily SSI alarm: ${SSI_ALARM_NAME} (every 1440 min)`);
});

// ─── Message router ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'linkedinContentScriptReady') {
    sendResponse({ engineReady: true, cloudMode: true });
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
    getProviderConfig().then((cfg) => {
      const hasKey = !!cfg.openai?.apiKey;
      sendResponse({
        engineReady: hasKey,
        initializing: false,
        currentModel: cfg.openai?.model ?? null,
        healthy: hasKey,
        cached: true,
        cacheMessage: hasKey ? 'OpenAI configured' : 'Add OpenAI API key in popup',
      });
    });
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
      sendResponse,
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
const SSI_CAPTURE_TIMEOUT_MS = 30_000;
const SSI_ALARM_NAME = 'linkmate.ssi.daily';
const SSI_URL = 'https://www.linkedin.com/sales/ssi';

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
  if (alarm.name !== SSI_ALARM_NAME) return;
  console.log('⏰ SSI daily alarm fired');
  startSsiCapture()
    .then(async (snap) => {
      await appendSsiSnapshot(snap);
      await clearSsiLastError();
      console.log(`✅ SSI snapshot captured: total=${snap.total}`);
    })
    .catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('⚠️ SSI daily capture failed:', msg);
      await setSsiLastError({ message: msg, capturedAt: Date.now() });
    });
});

// ─── Engagement Queue handlers ──────────────────────────────────────────────

async function handleQueueScoreFeed(
  posts: ParsedPost[],
  sendResponse: (response: unknown) => void,
): Promise<void> {
  try {
    const profile = await getProfile();
    if (!profile) {
      sendResponse({
        ok: false,
        error: 'No profile captured. Open popup → Capture Profile first.',
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
  sendResponse: (response: unknown) => void,
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
  sendResponse: (response: unknown) => void,
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

// ─── Reply generation (standard + with comments) ────────────────────────────

async function generateWithRetry(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
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
  if (firstValidation.valid || (firstValidation.score ?? 0) >= 60) return firstReply;

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
  return retryValidation.valid || (retryValidation.score ?? 0) > (firstValidation.score ?? 0)
    ? retryReply
    : firstReply;
}

async function handleLinkedInReplyWithComments(
  postContent: string,
  topComments: Array<{ text: string; likeCount: number }>,
  sendResponse: (response: unknown) => void,
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
                }\n`,
            )
            .join(
              '\n',
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

    const finalReply = await generateWithRetry(systemPrompt, userPrompt);
    sendResponse({
      reply: finalReply,
      basedOnComments: true,
      commentCount: topComments.length,
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

    const finalReply = await generateWithRetry(systemPrompt, userPrompt);
    sendResponse({ reply: finalReply });
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
