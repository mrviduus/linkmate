/**
 * T120 — Engagement Queue spec (Phase B, US1). jsdom-driven.
 * Drives src/engagement-queue.ts (T121). Injectable deps for testability.
 */

import { EngagementQueue, QUEUE_REFRESH_THROTTLE_MS } from '../src/engagement-queue';
import type { ParsedPost, ScoredPost } from '../src/storage-schema';

function makeParsedPost(overrides: Partial<ParsedPost> = {}): ParsedPost {
  return {
    id: 'urn:li:activity:1',
    authorUrn: 'urn:li:profile:a',
    authorName: 'Alex Test',
    authorTitle: 'Engineer',
    followerTier: '10k_100k',
    degree: '1st',
    text: 'A test post about agents and RAG.',
    postedAt: Date.now() - 60 * 60 * 1000,
    likeCount: 100,
    commentCount: 10,
    isOwn: false,
    ...overrides,
  };
}

function makeScoredPost(p: ParsedPost, score = 75): ScoredPost {
  return {
    ...p,
    relevance: {
      score,
      reasons: ['topic match (45%)', 'high-tier author (10k_100k)'],
      category: score >= 70 ? 'engage_now' : score >= 40 ? 'consider' : 'skip',
    },
  };
}

describe('EngagementQueue (T120)', () => {
  let container: HTMLElement;
  let scoreFeed: jest.Mock;
  let draftComment: jest.Mock;
  let markEngaged: jest.Mock;
  let dismiss: jest.Mock;
  let copyToClipboard: jest.Mock;
  let openPost: jest.Mock;
  let currentNow: number;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);

    currentNow = 1_700_000_000_000;

    scoreFeed = jest.fn().mockImplementation(async (posts: ParsedPost[]) => ({
      ok: true,
      scored: posts.map((p, i) => makeScoredPost(p, 80 - i * 10)),
    }));
    draftComment = jest.fn().mockResolvedValue('Generated draft text.');
    markEngaged = jest.fn().mockResolvedValue(undefined);
    dismiss = jest.fn().mockResolvedValue(undefined);
    copyToClipboard = jest.fn().mockResolvedValue(undefined);
    openPost = jest.fn();
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  function newQueue() {
    return new EngagementQueue({
      scoreFeed,
      draftComment,
      markEngaged,
      dismiss,
      copyToClipboard,
      openPost,
      now: () => currentNow,
    });
  }

  describe('mount / unmount', () => {
    it('mount creates a single root element inside the container', () => {
      const q = newQueue();
      q.mount(container);
      const root = container.querySelector('.linkmate-queue');
      expect(root).not.toBeNull();
      expect(container.querySelectorAll('.linkmate-queue')).toHaveLength(1);
    });

    it('mount is idempotent — calling twice does not duplicate the root', () => {
      const q = newQueue();
      q.mount(container);
      q.mount(container);
      expect(container.querySelectorAll('.linkmate-queue')).toHaveLength(1);
    });

    it('unmount removes the root element', () => {
      const q = newQueue();
      q.mount(container);
      q.unmount();
      expect(container.querySelector('.linkmate-queue')).toBeNull();
    });

    it('unmount before mount is a no-op (does not throw)', () => {
      const q = newQueue();
      expect(() => q.unmount()).not.toThrow();
    });
  });

  describe('refresh — rendering', () => {
    it('calls scoreFeed and renders one tile per scored post (top 10 only)', async () => {
      const q = newQueue();
      q.mount(container);
      const posts = Array.from({ length: 12 }, (_, i) =>
        makeParsedPost({ id: `urn:li:activity:${i}`, authorUrn: `urn:li:profile:${i}` }),
      );
      await q.refresh(posts);

      expect(scoreFeed).toHaveBeenCalledTimes(1);
      const tiles = container.querySelectorAll('.linkmate-queue__tile');
      expect(tiles.length).toBeLessThanOrEqual(10);
      expect(tiles.length).toBeGreaterThan(0);
    });

    it('filters out posts with category=skip', async () => {
      scoreFeed.mockImplementationOnce(async (posts: ParsedPost[]) => ({
        ok: true,
        scored: [
          makeScoredPost(posts[0], 80),
          makeScoredPost(posts[1], 25), // skip
          makeScoredPost(posts[2], 55),
        ],
      }));
      const q = newQueue();
      q.mount(container);
      await q.refresh([makeParsedPost(), makeParsedPost({ id: 'b', authorUrn: 'b' }), makeParsedPost({ id: 'c', authorUrn: 'c' })]);
      const tiles = container.querySelectorAll('.linkmate-queue__tile');
      expect(tiles).toHaveLength(2);
    });

    it('each tile shows score, author name, and one of the why-reasons', async () => {
      const q = newQueue();
      q.mount(container);
      await q.refresh([makeParsedPost()]);
      const tile = container.querySelector('.linkmate-queue__tile');
      expect(tile?.textContent).toMatch(/80/);
      expect(tile?.textContent).toMatch(/Alex Test/);
      expect(tile?.textContent).toMatch(/topic match|high-tier/i);
    });

    it('drafts each visible post on render', async () => {
      const q = newQueue();
      q.mount(container);
      await q.refresh([makeParsedPost()]);
      // initial drafts requested once per visible tile
      expect(draftComment).toHaveBeenCalled();
      const draftAreas = container.querySelectorAll('.linkmate-queue__draft');
      expect(draftAreas.length).toBeGreaterThan(0);
    });
  });

  describe('refresh — missing-profile / warning surface', () => {
    it('renders a warning tile when scoreFeed returns ok=false', async () => {
      scoreFeed.mockImplementationOnce(async () => ({
        ok: false,
        warning: 'Capture your profile first to see ranked posts.',
      }));
      const q = newQueue();
      q.mount(container);
      await q.refresh([makeParsedPost()]);

      const warning = container.querySelector('.linkmate-queue__warning');
      expect(warning).not.toBeNull();
      expect(warning?.textContent).toMatch(/Capture your profile/);
      const tiles = container.querySelectorAll('.linkmate-queue__tile');
      expect(tiles).toHaveLength(0);
      // No drafting attempted when there are no tiles
      expect(draftComment).not.toHaveBeenCalled();
    });
  });

  describe('refresh — 5-minute throttle', () => {
    it('a second refresh within QUEUE_REFRESH_THROTTLE_MS does NOT call scoreFeed again', async () => {
      const q = newQueue();
      q.mount(container);
      await q.refresh([makeParsedPost()]);
      expect(scoreFeed).toHaveBeenCalledTimes(1);

      // 4 minutes later — within throttle window
      currentNow += 4 * 60 * 1000;
      await q.refresh([makeParsedPost({ id: 'urn:li:activity:99' })]);
      expect(scoreFeed).toHaveBeenCalledTimes(1);
    });

    it('a refresh after QUEUE_REFRESH_THROTTLE_MS DOES call scoreFeed again', async () => {
      const q = newQueue();
      q.mount(container);
      await q.refresh([makeParsedPost()]);
      currentNow += QUEUE_REFRESH_THROTTLE_MS + 1000;
      await q.refresh([makeParsedPost()]);
      expect(scoreFeed).toHaveBeenCalledTimes(2);
    });
  });

  describe('tile actions', () => {
    it('clicking regenerate calls draftComment again with same post', async () => {
      const q = newQueue();
      q.mount(container);
      await q.refresh([makeParsedPost()]);
      const initialCalls = draftComment.mock.calls.length;
      const regenBtn = container.querySelector('[data-action="regenerate"]') as HTMLButtonElement;
      regenBtn.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(draftComment.mock.calls.length).toBe(initialCalls + 1);
    });

    it('clicking copy invokes copyToClipboard AND markEngaged AND openPost', async () => {
      const q = newQueue();
      q.mount(container);
      await q.refresh([makeParsedPost({ id: 'urn:li:activity:copy-target' })]);
      const copyBtn = container.querySelector('[data-action="copy"]') as HTMLButtonElement;
      copyBtn.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(copyToClipboard).toHaveBeenCalledTimes(1);
      expect(markEngaged).toHaveBeenCalledWith('urn:li:activity:copy-target');
      expect(openPost).toHaveBeenCalledWith('urn:li:activity:copy-target');
    });

    it('clicking hide invokes dismiss and removes the tile from the DOM', async () => {
      const q = newQueue();
      q.mount(container);
      await q.refresh([makeParsedPost({ id: 'urn:li:activity:hide-me' })]);
      const before = container.querySelectorAll('.linkmate-queue__tile').length;
      const hideBtn = container.querySelector('[data-action="hide"]') as HTMLButtonElement;
      hideBtn.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(dismiss).toHaveBeenCalledWith('urn:li:activity:hide-me');
      const after = container.querySelectorAll('.linkmate-queue__tile').length;
      expect(after).toBe(before - 1);
    });
  });

  describe('tone / length controls', () => {
    it('changing tone triggers a regenerate for all visible tiles', async () => {
      const q = newQueue();
      q.mount(container);
      await q.refresh([makeParsedPost()]);
      const before = draftComment.mock.calls.length;

      const toneSelect = container.querySelector('.linkmate-queue__tone') as HTMLSelectElement;
      toneSelect.value = 'enthusiastic';
      toneSelect.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 0));

      // Each visible tile re-drafted
      expect(draftComment.mock.calls.length).toBeGreaterThan(before);
      // The last draft request used tone=enthusiastic
      const lastCall = draftComment.mock.calls[draftComment.mock.calls.length - 1][0];
      expect(lastCall.tone).toBe('enthusiastic');
    });

    it('changing length triggers a regenerate and propagates the new length', async () => {
      const q = newQueue();
      q.mount(container);
      await q.refresh([makeParsedPost()]);
      const lengthSelect = container.querySelector('.linkmate-queue__length') as HTMLSelectElement;
      lengthSelect.value = 'detailed';
      lengthSelect.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 0));
      const lastCall = draftComment.mock.calls[draftComment.mock.calls.length - 1][0];
      expect(lastCall.length).toBe('detailed');
    });
  });
});
