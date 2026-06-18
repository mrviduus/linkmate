/**
 * Issue #18 follow-up — per-post inline chips on the LinkedIn feed.
 * Drives src/feed-post-overlay.ts. jsdom-based DOM smoke test.
 */

import { FeedPostOverlay, findFeedPostRoots } from '../src/feed-post-overlay';

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
  let aiScoreFeed: jest.Mock;

  beforeEach(() => {
    document.body.innerHTML = '';
    aiScoreFeed = jest.fn().mockResolvedValue({ ok: true, results: [] });
  });

  function makeOverlay() {
    return new FeedPostOverlay({
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
      expect(c.querySelector('.linkmate-post-chip__heuristic')).toBeNull();
      expect(c.querySelector('.linkmate-post-chip__ai')?.getAttribute('data-state')).toBe('loading');
    });
    overlay.unmount();
  });

  it('patches AI scores in place after the background returns', async () => {
    buildPostFixture('XYZ');
    aiScoreFeed.mockResolvedValueOnce({
      ok: true,
      results: [
        { postId: 'urn:li:component:XYZ', aiScore: 8, whyForYou: 'matches your AI work' },
      ],
    });
    const overlay = makeOverlay();
    overlay.mount();
    await new Promise((r) => setTimeout(r, 600));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const chip = document.querySelector('.linkmate-post-chip');
    expect(chip).not.toBeNull();
    const ai = chip!.querySelector('.linkmate-post-chip__ai');
    expect(chip!.querySelector('.linkmate-post-chip__heuristic')).toBeNull();
    expect(ai?.getAttribute('data-state')).toBe('ready');
    expect(ai?.textContent).toBe('🎯 8/10');
    expect(ai?.getAttribute('aria-label')).toBe('matches your AI work');
    overlay.unmount();
  });

  it('marks all AI chips "na" when aiScoreFeed returns no_key', async () => {
    buildPostFixture('K1');
    buildPostFixture('K2');
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
      expect(el.textContent).toBe('🎯 —');
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

  it('AI-scores every parsed visible post without heuristic filtering', async () => {
    buildPostFixture('LOW');
    buildPostFixture('HIGH');
    aiScoreFeed.mockResolvedValueOnce({
      ok: true,
      results: [
        { postId: 'urn:li:component:LOW', aiScore: 2, whyForYou: 'noise' },
        { postId: 'urn:li:component:HIGH', aiScore: 8, whyForYou: 'good' },
      ],
    });
    const overlay = makeOverlay();
    overlay.mount();
    await new Promise((r) => setTimeout(r, 600));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(aiScoreFeed).toHaveBeenCalledTimes(1);
    const aiInputIds = aiScoreFeed.mock.calls[0][0].map((p: { id: string }) => p.id);
    expect(aiInputIds).toContain('urn:li:component:LOW');
    expect(aiInputIds).toContain('urn:li:component:HIGH');
    // Both chips end in `ready` state with their AI scores.
    const skipChipAi = document
      .querySelector('.linkmate-post-chip[data-post-id="urn:li:component:LOW"]')
      ?.querySelector('.linkmate-post-chip__ai');
    expect(skipChipAi?.getAttribute('data-state')).toBe('ready');
    expect(skipChipAi?.textContent).toBe('🎯 2/10');
    const okChipAi = document
      .querySelector('.linkmate-post-chip[data-post-id="urn:li:component:HIGH"]')
      ?.querySelector('.linkmate-post-chip__ai');
    expect(okChipAi?.getAttribute('data-state')).toBe('ready');
    expect(okChipAi?.textContent).toBe('🎯 8/10');
    overlay.unmount();
  });

  it('decorates + scores both SDUI (componentkey) and legacy/profile (data-urn) posts', async () => {
    buildPostFixture('VISIBLE');

    // Profile-activity pages render the legacy shape (data-urn, no componentkey).
    // The overlay must decorate these too so the user's own posts get chips.
    const legacy = document.createElement('div');
    legacy.setAttribute('data-urn', 'urn:li:activity:LEGACY');
    legacy.className = 'feed-shared-update-v2';
    legacy.innerHTML = `
      <a class="update-components-actor__meta-link" href="/in/legacy-author/"></a>
      <span class="update-components-actor__title">Legacy Author</span>
      <span class="update-components-actor__description">Builder</span>
      <span class="update-components-actor__sub-description">1h</span>
      <div class="feed-shared-text">This legacy/profile post is now decorated by the overlay.</div>
    `;
    document.body.appendChild(legacy);

    aiScoreFeed.mockResolvedValueOnce({
      ok: true,
      results: [{ postId: 'urn:li:component:VISIBLE', aiScore: 7, whyForYou: 'visible fit' }],
    });

    const overlay = makeOverlay();
    overlay.mount();
    await new Promise((r) => setTimeout(r, 600));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(aiScoreFeed).toHaveBeenCalledTimes(1);
    const aiInputIds = aiScoreFeed.mock.calls[0][0].map((p: { id: string }) => p.id);
    expect(aiInputIds.sort()).toEqual(['urn:li:activity:LEGACY', 'urn:li:component:VISIBLE']);
    expect(document.querySelectorAll('.linkmate-post-chip')).toHaveLength(2);

    overlay.unmount();
  });

  it('chunks all visible posts into AI batches of 10', async () => {
    // 15 visible posts → 2 chunks (10 + 5).
    for (let i = 0; i < 15; i++) buildPostFixture(`P${i}`);
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

  it('Focus Top Post selects the highest ready AI score only', async () => {
    const lowPost = buildPostFixture('LOWFOCUS');
    const highPost = buildPostFixture('HIGHFOCUS');
    const scrollSpy = jest.fn();
    lowPost.scrollIntoView = scrollSpy;
    highPost.scrollIntoView = scrollSpy;
    aiScoreFeed.mockResolvedValueOnce({
      ok: true,
      results: [
        { postId: 'urn:li:component:LOWFOCUS', aiScore: 3, whyForYou: 'low fit' },
        { postId: 'urn:li:component:HIGHFOCUS', aiScore: 9, whyForYou: 'high fit' },
      ],
    });

    const overlay = makeOverlay();
    overlay.mount();
    await new Promise((r) => setTimeout(r, 600));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    document.querySelector<HTMLButtonElement>('.linkmate-focus-fab')?.click();

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(highPost.classList.contains('linkmate-priority-highlight')).toBe(true);
    expect(lowPost.classList.contains('linkmate-priority-highlight')).toBe(false);
    overlay.unmount();
  });

  it('Focus Top Post waits when no AI scores are ready', async () => {
    buildPostFixture('WAIT');
    aiScoreFeed.mockResolvedValueOnce({ ok: true, results: [] });

    const overlay = makeOverlay();
    overlay.mount();
    await new Promise((r) => setTimeout(r, 600));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    document.querySelector<HTMLButtonElement>('.linkmate-focus-fab')?.click();

    expect(document.body.textContent).toContain('Still scoring posts... Please wait.');
    overlay.unmount();
  });

  it('fires within SCAN_MAX_WAIT_MS even when mutations keep resetting the debounce (bug #3)', async () => {
    // Build a post BEFORE mount so the very first scheduled scan finds something.
    buildPostFixture('M1');
    let fakeNow = 1_000_000;
    const overlay = new FeedPostOverlay({
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
      if (aiScoreFeed.mock.calls.length > 0) break;
    }
    expect(aiScoreFeed).toHaveBeenCalled();
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
