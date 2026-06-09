/**
 * Issue #64 — deterministic quality gates for generated LinkedIn comments.
 *
 * Pure functions, no I/O. Each predicate returns true when the gate is
 * VIOLATED. `runCommentGates` aggregates them into a pass/fail with the list of
 * failed gate ids; a failure feeds the existing generateWithRetry path in
 * background.ts (it does NOT auto-submit anything — LinkedIn ToS guardrail).
 *
 * Gates (from the issue):
 *   - no agreement openers (first sentence only)
 *   - length 200–600 chars
 *   - no hashtags, no emoji, no sign-offs
 *   - interrogative sentences must end with "?"
 */

export type CommentGateId =
  | 'agreement_opener'
  | 'length'
  | 'hashtag'
  | 'emoji'
  | 'sign_off'
  | 'missing_question_mark'
  | 'multiple_questions';

export interface CommentGateResult {
  passed: boolean;
  failures: CommentGateId[];
}

export const COMMENT_MIN_CHARS = 200;
export const COMMENT_MAX_CHARS = 600;

// Agreement platitudes that, when they open a comment, collapse to zero value
// (LinkedIn truncates comments to the first line in-feed).
const AGREEMENT_OPENERS = [
  'absolutely',
  'great post',
  'great share',
  'great point',
  "couldn't agree more",
  'couldnt agree more',
  'so true',
  'this resonates',
  'love this',
  'well said',
  'spot on',
  'totally agree',
  'completely agree',
  'thanks for sharing',
];

// Interrogative sentence leads — if a sentence starts with one of these it must
// terminate with "?".
const INTERROGATIVE_LEADS = [
  'how',
  'what',
  'why',
  'when',
  'where',
  'who',
  'whom',
  'whose',
  'which',
  'do',
  'does',
  'did',
  'is',
  'are',
  'am',
  'was',
  'were',
  'can',
  'could',
  'would',
  'will',
  'shall',
  'should',
  'have',
  'has',
  'had',
  'may',
  'might',
];

const HASHTAG_RE = /#[a-z0-9_]+/i;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
// Sign-offs typically appear at the very end of a comment.
const SIGN_OFF_RE = /(^|[\n\s])(cheers|best|regards|sincerely|warm regards|thanks|thank you|br)\b[,.! ]*$/i;

function firstSentence(reply: string): string {
  const trimmed = reply.trim();
  const match = trimmed.match(/^[^.!?]*/);
  return (match ? match[0] : trimmed).trim();
}

/** Splits into sentence-like chunks, KEEPING the trailing terminator if any. */
function sentences(reply: string): string[] {
  const chunks = reply.match(/[^.!?]+[.!?]?/g) ?? [];
  return chunks.map((c) => c.trim()).filter((c) => c.length > 0);
}

/** True if the comment opens with an agreement platitude. */
export function hasAgreementOpener(reply: string): boolean {
  const opener = firstSentence(reply).toLowerCase();
  return AGREEMENT_OPENERS.some(
    (p) => opener === p || opener.startsWith(p + ' ') || opener.startsWith(p + ',')
  );
}

/** True if the comment is shorter than 200 or longer than 600 chars. */
export function violatesLength(reply: string): boolean {
  const len = reply.trim().length;
  return len < COMMENT_MIN_CHARS || len > COMMENT_MAX_CHARS;
}

export function hasHashtag(reply: string): boolean {
  return HASHTAG_RE.test(reply);
}

export function hasEmoji(reply: string): boolean {
  return EMOJI_RE.test(reply);
}

export function hasSignOff(reply: string): boolean {
  return SIGN_OFF_RE.test(reply.trim());
}

/**
 * True if the comment stacks more than one question. Two+ questions read as an
 * interrogation/checklist — a LinkedIn anti-pattern. One sharp question lands
 * better, so we cap at one.
 */
export function hasMultipleQuestions(reply: string): boolean {
  return sentences(reply).filter((s) => s.endsWith('?')).length > 1;
}

/** True if any interrogative-led sentence does not end with "?". */
export function hasUnmarkedQuestion(reply: string): boolean {
  for (const s of sentences(reply)) {
    const firstWord = (s.toLowerCase().match(/^[a-z']+/) ?? [''])[0];
    if (INTERROGATIVE_LEADS.includes(firstWord) && !s.endsWith('?')) {
      return true;
    }
  }
  return false;
}

/**
 * Run every gate. `passed` is true only when no gate is violated. `failures`
 * lists the violated gate ids (for retry logging / telemetry).
 */
export function runCommentGates(reply: string): CommentGateResult {
  const failures: CommentGateId[] = [];
  if (hasAgreementOpener(reply)) failures.push('agreement_opener');
  if (violatesLength(reply)) failures.push('length');
  if (hasHashtag(reply)) failures.push('hashtag');
  if (hasEmoji(reply)) failures.push('emoji');
  if (hasSignOff(reply)) failures.push('sign_off');
  if (hasUnmarkedQuestion(reply)) failures.push('missing_question_mark');
  if (hasMultipleQuestions(reply)) failures.push('multiple_questions');
  return { passed: failures.length === 0, failures };
}
