/**
 * Issue #18 follow-up — per-post inline chips on the LinkedIn feed.
 * Drives src/feed-post-overlay.ts. jsdom-based DOM smoke test.
 */

import { FeedPostOverlay, findFeedPostRoots } from '../src/feed-post-overlay';
import type { ScoredPost } from '../src/storage-schema';

function buildPostFixture(componentkey: string, text = 'A test post'): HTMLElement {
  const post = document.createElement('div');
  post.setAttribute('componentkey', componentkey);
  // Strategy B needs ≥3 buttons + the Reaction anchor.
  for (let i = 0; i < 3; i++) {
    const b = document.createElement('button');
    b.setAttribute('aria-label', i === 0 ? 'Reaction button state: no reaction' : `btn-${i}`);
    post.appendChild(b);
  }
  // Add at least one /in/ link so parseFeedDom can pull authorName.
  const a = document.createElement('a');
  a.href = '/in/test-author/';
  const span = document.createElement('span');
  span.textContent = 'Test Author';
  a.appendChild(span);
  post.appendChild(a);
  const p = document.createElement('p');
  p.textContent = text;
  post.appendChild(p);
  document.body.appendChild(post);
  return post;
}

function makeScored(id: string, score: number, category: 'engage_now' | 'consider' | 'skip' = 'consider'): ScoredPost {
  return {
    id,
    authorUrn: 'urn:li:fsd_profile:x',
    authorName: 'Test Author',
    authorTitle: '',
    followerTier: 'unknown',
    degree: 'unknown',
    text: 'A',
    postedAt: Date.now(),
    likeCount: 0,
    commentCount: 0,
    isOwn: false,
    relevance: {
      score,
      reasons: ['topic match'],
      category,
    },
  };
}

describe('findFeedPostRoots', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('locates one root per post fixture and synthesises a urn:li:component id', () => {
    buildPostFixture('AAA');
    buildPostFixture('BBB');
    const roots = findFeedPostRoots();
    expect(roots).toHaveLength(2);
    expect(roots.map((r) => r.id).sort()).toEqual([
      'urn:li:component:AAA',
      'urn:li:component:BBB',
    ]);
  });

  it('skips posts without componentkey', () => {
    const post = document.createElement('div');
    for (let i = 0; i < 3; i++) {
      const b = document.createElement('button');
      b.setAttribute('aria-label', i === 0 ? 'Reaction button state: no reaction' : `btn-${i}`);
      post.appendChild(b);
    }
    document.body.appendChild(post);
    expect(findFeedPostRoots()).toHaveLength(0);
  });
});

describe('FeedPostOverlay', () => {
  let scoreFeed: jest.Mock;
  let aiScoreFeed: jest.Mock;

  beforeEach(() => {
    document.body.innerHTML = '';
    scoreFeed = jest.fn().mockResolvedValue({ ok: true, scored: [] });
    aiScoreFeed = jest.fn().mockResolvedValue({ ok: true, results: [] });
  });

  function makeOverlay() {
    return new FeedPostOverlay({
      scoreFeed,
      aiScoreFeed,
      now: () => 1_700_000_000_000,
    });
  }

  it('injects a placeholder chip into each visible post on mount', async () => {
    buildPostFixture('AAA');
    buildPostFixture('BBB');
    const overlay = makeOverlay();
    overlay.mount();
    // Initial scan is debounced at 500ms; flush.
    await new Promise((r) => setTimeout(r, 600));
    const chips = document.querySelectorAll('.linkmate-post-chip');
    expect(chips.length).toBe(2);
    chips.forEach((c) => {
      expect(c.querySelector('.linkmate-post-chip__heuristic')?.getAttribute('data-state')).toBe('loading');
      expect(c.querySelector('.linkmate-post-chip__ai')?.getAttribute('data-state')).toBe('loading');
    });
    overlay.unmount();
  });

  it('patches heuristic + AI scores in place after the background returns', async () => {
    buildPostFixture('XYZ');
    scoreFeed.mockResolvedValueOnce({
      ok: true,
      scored: [makeScored('urn:li:component:XYZ', 78, 'engage_now')],
    });
    aiScoreFeed.mockResolvedValueOnce({
      ok: true,
      results: [
        { postId: 'urn:li:component:XYZ', aiScore: 8, whyForYou: 'matches your AI work' },
      ],
    });
    const overlay = makeOverlay();
    overlay.mount();
    await new Promise((r) => setTimeout(r, 600));
    // Two async ticks: scoreFeed resolves → applyHeuristic; aiScoreFeed resolves → applyAi.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const chip = document.querySelector('.linkmate-post-chip');
    expect(chip).not.toBeNull();
    const heuristic = chip!.querySelector('.linkmate-post-chip__heuristic');
    const ai = chip!.querySelector('.linkmate-post-chip__ai');
    expect(heuristic?.getAttribute('data-state')).toBe('ready');
    expect(heuristic?.textContent).toBe('🎯 8/10'); // 78/10 rounded
    expect(heuristic?.getAttribute('data-band')).toBe('engage_now');
    expect(ai?.getAttribute('data-state')).toBe('ready');
    expect(ai?.textContent).toBe('🤖 8/10');
    expect(ai?.getAttribute('title')).toBe('matches your AI work');
    overlay.unmount();
  });

  it('marks all AI chips "na" when aiScoreFeed returns no_key', async () => {
    buildPostFixture('K1');
    buildPostFixture('K2');
    scoreFeed.mockResolvedValueOnce({
      ok: true,
      scored: [
        makeScored('urn:li:component:K1', 60, 'consider'),
        makeScored('urn:li:component:K2', 75, 'engage_now'),
      ],
    });
    aiScoreFeed.mockResolvedValueOnce({ ok: false, reason: 'no_key' });
    const overlay = makeOverlay();
    overlay.mount();
    await new Promise((r) => setTimeout(r, 600));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const aiChips = document.querySelectorAll<HTMLElement>('.linkmate-post-chip__ai');
    expect(aiChips.length).toBe(2);
    aiChips.forEach((el) => {
      expect(el.getAttribute('data-state')).toBe('na');
      expect(el.textContent).toBe('🤖 —');
    });
    overlay.unmount();
  });

  it('unmount removes every chip and the data-linkmate-post-id attribute', async () => {
    buildPostFixture('R1');
    const overlay = makeOverlay();
    overlay.mount();
    await new Promise((r) => setTimeout(r, 600));
    expect(document.querySelectorAll('.linkmate-post-chip').length).toBe(1);
    overlay.unmount();
    expect(document.querySelectorAll('.linkmate-post-chip').length).toBe(0);
    expect(document.querySelectorAll('[data-linkmate-post-id]').length).toBe(0);
  });

  // ─── Bug fixes ─────────────────────────────────────────────────────────

  it('AI-scores skip-category posts too — no heuristic filtering (user opted in to "Both inline always")', async () => {
    buildPostFixture('SKIP');
    buildPostFixture('OK');
    scoreFeed.mockResolvedValueOnce({
      ok: true,
      scored: [
        makeScored('urn:li:component:SKIP', 25, 'skip'),
        makeScored('urn:li:component:OK', 80, 'engage_now'),
      ],
    });
    aiScoreFeed.mockResolvedValueOnce({
      ok: true,
      results: [
        { postId: 'urn:li:component:SKIP', aiScore: 2, whyForYou: 'noise' },
        { postId: 'urn:li:component:OK', aiScore: 8, whyForYou: 'good' },
      ],
    });
    const overlay = makeOverlay();
    overlay.mount();
    await new Promise((r) => setTimeout(r, 600));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // Skip post MUST be sent to AI (no skip-filter anymore).
    expect(aiScoreFeed).toHaveBeenCalledTimes(1);
    const aiInputIds = aiScoreFeed.mock.calls[0][0].map((p: { id: string }) => p.id);
    expect(aiInputIds).toContain('urn:li:component:SKIP');
    expect(aiInputIds).toContain('urn:li:component:OK');
    // Both chips end in `ready` state with their AI scores.
    const skipChipAi = document
      .querySelector('.linkmate-post-chip[data-post-id="urn:li:component:SKIP"]')
      ?.querySelector('.linkmate-post-chip__ai');
    expect(skipChipAi?.getAttribute('data-state')).toBe('ready');
    expect(skipChipAi?.textContent).toBe('🤖 2/10');
    const okChipAi = document
      .querySelector('.linkmate-post-chip[data-post-id="urn:li:component:OK"]')
      ?.querySelector('.linkmate-post-chip__ai');
    expect(okChipAi?.getAttribute('data-state')).toBe('ready');
    expect(okChipAi?.textContent).toBe('🤖 8/10');
    overlay.unmount();
  });

  it('chunks ALL non-skip posts (not just top-10) into AI batches of 10 (bug #2)', async () => {
    // 15 non-skip posts → 2 chunks (10 + 5).
    for (let i = 0; i < 15; i++) buildPostFixture(`P${i}`);
    const scored = Array.from({ length: 15 }, (_, i) =>
      makeScored(`urn:li:component:P${i}`, 50 + i, 'consider'),
    );
    scoreFeed.mockResolvedValueOnce({ ok: true, scored });
    // aiScoreFeed will be called TWICE (one per chunk).
    aiScoreFeed.mockImplementation(async (posts) => ({
      ok: true,
      results: posts.map((p: { id: string }) => ({
        postId: p.id,
        aiScore: 5,
        whyForYou: 'x',
      })),
    }));
    const overlay = makeOverlay();
    overlay.mount();
    await new Promise((r) => setTimeout(r, 600));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(aiScoreFeed).toHaveBeenCalledTimes(2);
    expect(aiScoreFeed.mock.calls[0][0]).toHaveLength(10);
    expect(aiScoreFeed.mock.calls[1][0]).toHaveLength(5);
    // Every chip got a score — none stuck in loading.
    const aiChips = document.querySelectorAll<HTMLElement>('.linkmate-post-chip__ai');
    expect(aiChips.length).toBe(15);
    aiChips.forEach((el) => expect(el.getAttribute('data-state')).toBe('ready'));
    overlay.unmount();
  });

  it('fires within SCAN_MAX_WAIT_MS even when mutations keep resetting the debounce (bug #3)', async () => {
    // Build a post BEFORE mount so the very first scheduled scan finds something.
    buildPostFixture('M1');
    let fakeNow = 1_000_000;
    const overlay = new FeedPostOverlay({
      scoreFeed,
      aiScoreFeed,
      now: () => fakeNow,
    });
    overlay.mount();
    // Fire mutations every 100ms, advancing the clock. Without a max-wait the
    // scan would never run; with the cap it MUST fire within ~3s of the first.
    for (let i = 0; i < 40; i++) {
      fakeNow += 100;
      document.body.appendChild(document.createElement('div'));
      await new Promise((r) => setTimeout(r, 50));
      if (scoreFeed.mock.calls.length > 0) break;
    }
    expect(scoreFeed).toHaveBeenCalled();
    overlay.unmount();
  });

  it('restores original inline style.position on unmount (bug #4)', async () => {
    const post = buildPostFixture('POS');
    // Sanity: post has no inline position before mount.
    expect(post.style.position).toBe('');
    const overlay = makeOverlay();
    overlay.mount();
    await new Promise((r) => setTimeout(r, 600));
    // After mount we should have set position: relative (jsdom getComputedStyle
    // returns 'static' for a bare div).
    expect(post.style.position).toBe('relative');
    overlay.unmount();
    // Restored — empty inline style, falls back to whatever CSS says.
    expect(post.style.position).toBe('');
  });
});
