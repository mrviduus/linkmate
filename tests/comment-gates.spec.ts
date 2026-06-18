/**
 * Issue #64 — deterministic comment-gate evals. No LLM calls.
 * Every gate gets a good + bad example. The exact Feldera comment from the
 * issue must be rejected (agreement opener + under-length + dropped "?").
 */

import {
  runCommentGates,
  hasAgreementOpener,
  violatesLength,
  hasHashtag,
  hasEmoji,
  hasSignOff,
  hasUnmarkedQuestion,
  hasMultipleQuestions,
  COMMENT_MIN_CHARS,
  COMMENT_MAX_CHARS,
} from '../src/comment-gates';

// Real two-question output — passes every other gate but stacks questions,
// which reads as an interrogation. The multiple_questions gate catches it.
const TWO_QUESTIONS =
  'Calibration of LLM judges is often the bottleneck in evaluation—too loose inflates iteration noise, too strict stalls valid progress. Did your framework measure how calibration drift affected the tradeoff over months? Also, how does GEPA manage exploration versus exploitation at 100M-user scale?';

// A substantive, gate-passing comment (200–600 chars, no opener/hashtag/emoji,
// question ends with "?").
const GOOD =
  'Incremental view maintenance is the part most teams underestimate here — keeping results exact while only recomputing deltas is a different beast from cache invalidation. In our pipeline the real cost was state size under late-arriving events, not query latency. How are you handling out-of-order updates without resnapshotting the whole view?';

// The exact failing comment from issue #64.
const FELDERA =
  'Absolutely, the evolution to context engines is crucial. How do you envision balancing speed and accuracy in query execution to support real-time AI applications';

const pad = (n: number) => 'word '.repeat(Math.ceil(n / 5)).slice(0, n);

describe('hasAgreementOpener', () => {
  it.each([
    'Absolutely, this is the right call here.',
    'Great post on incremental compute.',
    "Couldn't agree more with the framing.",
    'So true — the state size is the real cost.',
    'This resonates with what we saw in prod.',
    'Love this breakdown of the tradeoffs.',
  ])('rejects opener: %s', (s) => {
    expect(hasAgreementOpener(s)).toBe(true);
  });

  it('passes a substantive opener', () => {
    expect(hasAgreementOpener(GOOD)).toBe(false);
    expect(hasAgreementOpener('Incremental view maintenance is underrated.')).toBe(false);
  });
});

describe('violatesLength', () => {
  it('rejects under 200 chars', () => {
    expect(violatesLength(pad(COMMENT_MIN_CHARS - 1))).toBe(true);
  });
  it('rejects over 600 chars', () => {
    expect(violatesLength(pad(COMMENT_MAX_CHARS + 1))).toBe(true);
  });
  it('passes within range', () => {
    expect(violatesLength(GOOD)).toBe(false);
    expect(violatesLength(pad(300))).toBe(false);
  });
});

describe('hasHashtag', () => {
  it('rejects hashtags', () => {
    expect(hasHashtag(GOOD + ' #ai')).toBe(true);
  });
  it('passes without hashtags', () => {
    expect(hasHashtag(GOOD)).toBe(false);
  });
});

describe('hasEmoji', () => {
  it('rejects emoji', () => {
    expect(hasEmoji(GOOD + ' 🚀')).toBe(true);
    expect(hasEmoji('Nice work 👍 on this')).toBe(true);
  });
  it('passes plain text incl. em dash', () => {
    expect(hasEmoji(GOOD)).toBe(false);
  });
});

describe('hasSignOff', () => {
  it.each([GOOD + ' Cheers', GOOD + ' Best,', GOOD + ' Regards.', GOOD + ' Thanks'])(
    'rejects sign-off: ...%s',
    (s) => {
      expect(hasSignOff(s)).toBe(true);
    }
  );
  it('passes without a sign-off', () => {
    expect(hasSignOff(GOOD)).toBe(false);
  });
});

describe('hasUnmarkedQuestion', () => {
  it('rejects an interrogative sentence missing "?"', () => {
    expect(hasUnmarkedQuestion('How do you handle out-of-order updates')).toBe(true);
    expect(hasUnmarkedQuestion(FELDERA)).toBe(true);
  });
  it('passes when the question ends with "?"', () => {
    expect(hasUnmarkedQuestion(GOOD)).toBe(false);
  });
  it('passes a purely declarative comment', () => {
    expect(
      hasUnmarkedQuestion('Incremental view maintenance keeps results exact under deltas.')
    ).toBe(false);
  });
});

describe('hasMultipleQuestions', () => {
  it('rejects two stacked questions', () => {
    expect(hasMultipleQuestions(TWO_QUESTIONS)).toBe(true);
  });
  it('passes a single question', () => {
    expect(hasMultipleQuestions(GOOD)).toBe(false);
  });
  it('passes a purely declarative comment', () => {
    expect(hasMultipleQuestions('Incremental view maintenance keeps results exact.')).toBe(false);
  });
});

describe('runCommentGates', () => {
  it('passes the substantive comment', () => {
    const r = runCommentGates(GOOD);
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('rejects a comment that stacks two questions', () => {
    const r = runCommentGates(TWO_QUESTIONS);
    expect(r.passed).toBe(false);
    expect(r.failures).toContain('multiple_questions');
  });

  it('rejects the Feldera comment from issue #64 (opener + length + question mark)', () => {
    const r = runCommentGates(FELDERA);
    expect(r.passed).toBe(false);
    expect(r.failures).toEqual(
      expect.arrayContaining(['agreement_opener', 'length', 'missing_question_mark'])
    );
  });

  it('aggregates multiple failures', () => {
    const r = runCommentGates('Great post! #ai 🚀');
    expect(r.passed).toBe(false);
    expect(r.failures).toEqual(
      expect.arrayContaining(['agreement_opener', 'length', 'hashtag', 'emoji'])
    );
  });
});
