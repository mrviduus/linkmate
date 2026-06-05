/**
 * Issue #18 follow-up — per-post inline relevance chips on the LinkedIn feed.
 *
 * For EVERY post visible in the feed, injects a floating chip in the top-right
 * showing:
 *   - 🎯 <ai>/10 — batched OpenAI call, lazy, cached
 *   - Why for you — tooltip with the AI narrative
 *
 * Reuses the `queue.aiScoreFeed` background handler via deps, so it benefits
 * from the existing in-memory AI cache (1h TTL).
 *
 * Post root detection mirrors feed-parser.ts Strategy B: anchor on the
 * `Reaction button state` aria-label, walk up to the ancestor with a
 * `componentkey` attribute. Same DOM walk as parseFeedDom so IDs line up.
 */

import { parseFeedDom } from './feed-parser';
import type { ParsedPost } from './storage-schema';

// ─── Types shared with linkedin-content.ts deps ──────────────────────────

export interface AiScoredPostDTO {
  postId: string;
  aiScore: number;
  whyForYou: string;
}

export type AiScoreFeedResult =
  | { ok: true; results: AiScoredPostDTO[] }
  | { ok: false; reason: 'no_key' | 'no_profile' | 'parse' | 'network'; error?: string };

/** Escape any user-/model-supplied string before interpolating into innerHTML. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

const CHIP_CLASS = 'linkmate-post-chip';
const FOCUS_BTN_CLASS = 'linkmate-focus-fab';
const POST_ANCHOR_ATTR = 'data-linkmate-post-id';
const SCAN_DEBOUNCE_MS = 800;
// Hard cap so a constantly-mutating feed (LinkedIn animations / video players /
// hover state) can't keep starving the debounce. After this many ms since the
// FIRST mutation of a burst, we fire regardless of new mutations.
const SCAN_MAX_WAIT_MS = 3_000;
const REFRESH_INTERVAL_MS = 30_000;
// Server-side handleQueueAiScoreFeed slices to 10. The overlay chunks all
// visible posts into groups of this size and scores each chunk so every
// visible post gets an AI score.
const AI_BATCH_SIZE = 10;

export interface FeedPostOverlayDeps {
  aiScoreFeed: (posts: ParsedPost[]) => Promise<AiScoreFeedResult>;
  now?: () => number;
}

export class FeedPostOverlay {
  private observer: MutationObserver | null = null;
  private fabContainer: HTMLElement | null = null;
  private focusBtn: HTMLButtonElement | null = null;
  private skipBtn: HTMLButtonElement | null = null;
  private collapseBtn: HTMLButtonElement | null = null;
  private skippedPostIds = new Set<string>();
  private lastFocusedPostId: string | null = null;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private knownIds = new Set<string>();
  private lastRefreshAt = 0;
  private aiUnavailable = false;
  private inFlight = false;
  /**
   * Timestamp of the first mutation in the current debounce burst. Used to
   * enforce SCAN_MAX_WAIT_MS so a noisy DOM (continuous animations / video
   * frames) cannot keep resetting the debounce timer forever.
   */
  private firstMutationAt: number | null = null;
  /**
   * Tracks every post root whose inline `style.position` we mutated to
   * `relative`, with the value it had BEFORE we changed it (empty string if
   * unset). unmount() restores each entry so we never leave a stray inline
   * style on LinkedIn's DOM.
   */
  private originalPositions = new Map<HTMLElement, string>();

  private readonly deps: Required<Pick<FeedPostOverlayDeps, 'now'>> & FeedPostOverlayDeps;

  constructor(deps: FeedPostOverlayDeps) {
    this.deps = { now: () => Date.now(), ...deps };
  }

  mount(): void {
    if (this.observer) return;

    // Inject the Floating Action Button for Focus Top Post first
    // so its DOM insertion doesn't trigger the MutationObserver we are about to start.
    this.injectFocusButton();

    this.observer = new MutationObserver((mutations) => {
      // Filter out mutations that only involve LinkMate elements (chips, toasts, FAB)
      // to prevent unnecessary re-scans and infinite mutation loops.
      const interesting = mutations.some((m) => {
        // If target is one of our elements, ignore it
        const target = m.target as HTMLElement;
        if (
          target.classList?.contains(CHIP_CLASS) ||
          target.classList?.contains(FOCUS_BTN_CLASS) ||
          target.classList?.contains('linkmate-toast') ||
          target.closest?.(`.${CHIP_CLASS}`) ||
          target.closest?.(`.${FOCUS_BTN_CLASS}`) ||
          target.closest?.('.linkmate-toast')
        ) {
          return false;
        }

        // Check added nodes
        for (let i = 0; i < m.addedNodes.length; i++) {
          const node = m.addedNodes[i] as HTMLElement;
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (
              node.classList?.contains(CHIP_CLASS) ||
              node.classList?.contains(FOCUS_BTN_CLASS) ||
              node.classList?.contains('linkmate-toast')
            ) {
              continue;
            }
            return true;
          }
        }
        return m.removedNodes.length > 0;
      });

      if (interesting) {
        this.scheduleScan();
      }
    });

    this.observer.observe(document.body, { childList: true, subtree: true });

    // First pass — feed posts usually present before content_script fires.
    this.scheduleScan(500);
    // Long-poll fallback: re-evaluate every 30s for posts that scrolled in
    // without a mutation we caught (Mutation events on virtualised lists can
    // be sparse). AI cache absorbs the repeated queries cheaply.
    this.periodicTimer = setInterval(() => this.scheduleScan(0), REFRESH_INTERVAL_MS);
  }

  unmount(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.fabContainer?.remove();
    this.fabContainer = null;
    this.focusBtn = null;
    this.skipBtn = null;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.rescanTimer = null;
    this.periodicTimer = null;
    this.firstMutationAt = null;
    // Remove every chip we injected.
    document.querySelectorAll<HTMLElement>(`.${CHIP_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll<HTMLElement>(`[${POST_ANCHOR_ATTR}]`).forEach((el) => {
      el.removeAttribute(POST_ANCHOR_ATTR);
    });
    // Restore every inline `style.position` we mutated. Empty string means the
    // element didn't have an inline value before us → clear the property so
    // computed style falls back to its CSS source.
    this.originalPositions.forEach((orig, el) => {
      if (orig) el.style.position = orig;
      else el.style.removeProperty('position');
    });
    this.originalPositions.clear();
    this.knownIds.clear();
  }

  private scheduleScan(delay = SCAN_DEBOUNCE_MS): void {
    const now = this.deps.now();
    // Track when this burst started so we can enforce SCAN_MAX_WAIT_MS.
    if (this.firstMutationAt === null) this.firstMutationAt = now;
    const elapsedSinceBurst = now - this.firstMutationAt;
    const remainingMax = SCAN_MAX_WAIT_MS - elapsedSinceBurst;
    const effectiveDelay = Math.max(0, Math.min(delay, remainingMax));
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      this.firstMutationAt = null;
      void this.scanAndScore();
    }, effectiveDelay);
  }

  private async scanAndScore(): Promise<void> {
    if (this.inFlight) return;
    // Phase 1 — inject placeholder chips for every visible post we don't know about.
    const roots = findFeedPostRoots();
    let injectedNew = false;
    for (const { element, id } of roots) {
      const alreadyDecorated = element.hasAttribute(POST_ANCHOR_ATTR);
      if (alreadyDecorated) continue;
      this.knownIds.add(id);
      this.injectPlaceholderChip(element, id);
      injectedNew = true;
    }
    // Phase 2 — when we have new posts (or we haven't refreshed recently),
    // re-score. Sidebar's 5-min throttle is more conservative; chips need
    // to feel fresh so we drop the throttle to 8s here.
    const now = this.deps.now();
    if (!injectedNew && now - this.lastRefreshAt < 8_000) return;
    this.inFlight = true;
    try {
      const parsedPosts = parseFeedDom(document);
      const postsById = new Map(parsedPosts.map((post) => [post.id, post]));
      const visiblePosts: ParsedPost[] = [];
      const missingPostIds = new Set<string>();

      for (const root of roots) {
        const post = postsById.get(root.id);
        if (post) visiblePosts.push(post);
        else missingPostIds.add(root.id);
      }

      if (missingPostIds.size > 0) {
        this.markIdsAi(
          missingPostIds,
          'na',
          'AI score unavailable — could not parse this visible post'
        );
      }

      if (visiblePosts.length === 0) return;
      this.lastRefreshAt = this.deps.now();

      // AI scoring — score every visible post. The SW in-memory cache keeps
      // repeated scans cheap while avoiding the old local pre-sort.
      if (this.aiUnavailable) {
        this.markAllAiUnavailable();
        return;
      }

      // Chunk into AI_BATCH_SIZE-sized requests. Server-side handler slices to
      // 10 per call; we loop on the client so every visible post gets
      // scored. SW in-memory cache (1h) deduplicates re-scans cheaply.
      const chunks: ParsedPost[][] = [];
      for (let i = 0; i < visiblePosts.length; i += AI_BATCH_SIZE) {
        chunks.push(visiblePosts.slice(i, i + AI_BATCH_SIZE));
      }

      const chunkResults: AiScoreFeedResult[] = [];
      for (const chunk of chunks) {
        const res = await this.deps.aiScoreFeed(chunk);
        chunkResults.push(res);
      }

      // First, detect engine-unavailable verdict in ANY chunk — flips the
      // overlay into a terminal "AI off" state.
      const engineDown = chunkResults.find(
        (r) => !r.ok && (r.reason === 'no_key' || r.reason === 'no_profile')
      );
      if (engineDown) {
        this.aiUnavailable = true;
        this.markAllAiUnavailable();
        return;
      }

      // Apply each successful chunk; for chunks that failed (parse/network),
      // mark just those posts' chips `na` so they don't pulse forever either.
      // Tooltip carries the actual reason+error so the user (and us via MCP)
      // can see exactly what failed without opening SW DevTools.
      chunkResults.forEach((r, idx) => {
        if (r.ok) {
          this.applyAiScores(r.results);
        } else {
          const failedIds = new Set(chunks[idx].map((s) => s.id));
          const detail = r.error ? ` — ${r.error}` : '';
          this.markIdsAi(failedIds, 'na', `AI scoring failed (${r.reason})${detail}`);
        }
      });
    } catch {
      /* swallow — next scan will retry */
    } finally {
      this.inFlight = false;
    }
  }

  private injectPlaceholderChip(element: HTMLElement, id: string): void {
    element.setAttribute(POST_ANCHOR_ATTR, id);
    // Ensure the chip can absolute-position against the post root.
    //   - If inline `position` is empty, set `relative` (safe even when CSS
    //     already provides relative/absolute — inline overrides identically).
    //   - If inline `position` is the literal string `static`, override to
    //     `relative` (rare on LinkedIn but possible).
    //   - Otherwise (inline already non-static), leave it alone.
    // We avoid getComputedStyle here to skip the forced-layout cost on every
    // post; unmount() restores the original inline value either way.
    if (!this.originalPositions.has(element)) {
      const inline = element.style.position;
      if (!inline || inline === 'static') {
        this.originalPositions.set(element, inline); // '' or 'static'
        element.style.position = 'relative';
      }
    }
    // Don't double-inject if a previous mount left a chip behind.
    if (element.querySelector(`:scope > .${CHIP_CLASS}`)) return;
    const chip = document.createElement('div');
    chip.className = CHIP_CLASS;
    chip.setAttribute('data-post-id', id);
    // `data-tooltip` drives our styled CSS ::after tooltip; `aria-label` covers
    // screen readers. We deliberately avoid `title` — it adds a SECOND native
    // browser tooltip on hover (double tooltip bug).
    const initialAiTip = this.aiUnavailable
      ? 'AI score unavailable — check OpenAI key in Settings'
      : 'AI relevance — uses OpenAI + your profile + goals';
    chip.innerHTML = `
      <span class="${CHIP_CLASS}__ai" data-state="${this.aiUnavailable ? 'na' : 'loading'}" data-tooltip="${esc(initialAiTip)}" aria-label="${esc(initialAiTip)}">${this.aiUnavailable ? '🎯 —' : '🎯 …'}</span>
    `;
    element.appendChild(chip);
  }

  /** Bulk-mark AI chips for a given set of post IDs to a terminal state. */
  private markIdsAi(ids: Set<string>, state: 'na', title: string): void {
    for (const id of ids) {
      const chip = this.findChip(id);
      if (!chip) continue;
      const ai = chip.querySelector<HTMLElement>(`.${CHIP_CLASS}__ai`);
      if (!ai) continue;
      ai.setAttribute('data-state', state);
      ai.textContent = '🎯 —';
      if (title) {
        ai.setAttribute('aria-label', title);
        ai.setAttribute('data-tooltip', title);
      }
    }
  }

  private applyAiScores(results: AiScoredPostDTO[]): void {
    for (const r of results) {
      const chip = this.findChip(r.postId);
      if (!chip) continue;
      const span = chip.querySelector<HTMLElement>(`.${CHIP_CLASS}__ai`);
      if (!span) continue;
      span.setAttribute('data-state', 'ready');
      span.textContent = `🎯 ${r.aiScore}/10`;
      // Prefer the AI's reason; otherwise a plain explainer so the score isn't
      // a cryptic number floating on the post.
      const tip = r.whyForYou || `Relevance ${r.aiScore}/10 — higher = more worth engaging`;
      span.setAttribute('aria-label', tip);
      span.setAttribute('data-tooltip', tip);
    }
  }

  private markAllAiUnavailable(): void {
    const tip = 'AI score unavailable — check OpenAI key in Settings';
    document.querySelectorAll<HTMLElement>(`.${CHIP_CLASS}__ai`).forEach((el) => {
      el.setAttribute('data-state', 'na');
      el.textContent = '🎯 —';
      el.setAttribute('aria-label', tip);
      el.setAttribute('data-tooltip', tip);
    });
  }

  private findChip(postId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(
      `.${CHIP_CLASS}[data-post-id="${postId.replace(/"/g, '\\"')}"]`
    );
  }

  private injectFocusButton(): void {
    if (document.querySelector('.linkmate-fab-container')) return;

    const container = document.createElement('div');
    container.className = 'linkmate-fab-container';

    // Restore saved coordinates from localStorage if present
    const savedPos = localStorage.getItem('linkmate-fab-pos');
    if (savedPos) {
      try {
        const { left, top } = JSON.parse(savedPos);
        if (left && top) {
          container.style.left = left;
          container.style.top = top;
          container.style.bottom = 'auto';
          container.style.right = 'auto';
        }
      } catch {
        /* fallback to stylesheet bottom/right default */
      }
    }

    const dragHandle = document.createElement('div');
    dragHandle.className = 'linkmate-fab-drag-handle';
    dragHandle.title = 'Drag to reposition';
    dragHandle.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        <path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
      </svg>
    `;

    const focusBtn = document.createElement('button');
    focusBtn.className = FOCUS_BTN_CLASS;
    focusBtn.type = 'button';
    focusBtn.setAttribute('aria-label', 'Focus top scored post');
    focusBtn.innerHTML = `
      <svg class="linkmate-focus-icon animate-pulse" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10 10-4.49 10-10S17.51 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm3-8c0 1.66-1.34 3-3 3s-3-1.34-3-3 1.34-3 3-3 3 1.34 3 3z"/>
      </svg>
      <span>⚡ Focus Top Post</span>
    `;
    focusBtn.addEventListener('click', () => this.handleFocusClick(false));

    const skipBtn = document.createElement('button');
    skipBtn.className = 'linkmate-skip-fab';
    skipBtn.type = 'button';
    skipBtn.setAttribute('aria-label', 'Skip to next scored post');
    skipBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
      </svg>
      <span>Skip</span>
    `;
    skipBtn.addEventListener('click', () => this.handleSkipClick());

    // Collapse toggle — shrinks the bar to a small puck so it never nags.
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'linkmate-fab-collapse';
    collapseBtn.type = 'button';
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleFabCollapsed();
    });

    container.appendChild(dragHandle);
    container.appendChild(focusBtn);
    container.appendChild(skipBtn);
    container.appendChild(collapseBtn);
    document.body.appendChild(container);

    this.fabContainer = container;
    this.focusBtn = focusBtn;
    this.skipBtn = skipBtn;
    this.collapseBtn = collapseBtn;

    // Restore collapsed state (persisted across reloads).
    this.applyFabCollapsed(localStorage.getItem('linkmate-fab-collapsed') === '1');

    // Draggable functionality
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    const onMouseDown = (e: MouseEvent) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = container.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      dragHandle.style.cursor = 'grabbing';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      container.style.left = `${initialLeft + dx}px`;
      container.style.top = `${initialTop + dy}px`;
      container.style.right = 'auto';
      container.style.bottom = 'auto';
    };

    const onMouseUp = () => {
      isDragging = false;
      dragHandle.style.cursor = 'grab';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      localStorage.setItem(
        'linkmate-fab-pos',
        JSON.stringify({
          left: container.style.left,
          top: container.style.top,
        })
      );
    };

    const onTouchStart = (e: TouchEvent) => {
      isDragging = true;
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      const rect = container.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      document.addEventListener('touchend', onTouchEnd);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isDragging) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      container.style.left = `${initialLeft + dx}px`;
      container.style.top = `${initialTop + dy}px`;
      container.style.right = 'auto';
      container.style.bottom = 'auto';
      e.preventDefault();
    };

    const onTouchEnd = () => {
      isDragging = false;
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      localStorage.setItem(
        'linkmate-fab-pos',
        JSON.stringify({
          left: container.style.left,
          top: container.style.top,
        })
      );
    };

    dragHandle.addEventListener('mousedown', onMouseDown);
    dragHandle.addEventListener('touchstart', onTouchStart, { passive: true });
  }

  private toggleFabCollapsed(): void {
    const next = !this.fabContainer?.classList.contains('linkmate-fab--collapsed');
    this.applyFabCollapsed(next);
    localStorage.setItem('linkmate-fab-collapsed', next ? '1' : '0');
  }

  /** Collapsed = a small puck (just the toggle); expanded = the full bar. */
  private applyFabCollapsed(collapsed: boolean): void {
    if (!this.fabContainer || !this.collapseBtn) return;
    this.fabContainer.classList.toggle('linkmate-fab--collapsed', collapsed);
    this.collapseBtn.setAttribute('aria-label', collapsed ? 'Expand LinkMate' : 'Collapse');
    this.collapseBtn.title = collapsed ? 'Expand LinkMate' : 'Collapse';
    // Bolt when collapsed (invites expand), chevron-right when expanded.
    this.collapseBtn.innerHTML = collapsed
      ? '<span aria-hidden="true">⚡</span>'
      : `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>`;
  }

  private handleSkipClick(): void {
    if (this.lastFocusedPostId) {
      this.skippedPostIds.add(this.lastFocusedPostId);
      console.log(`[Focus Top Post] Skipped post: ${this.lastFocusedPostId}`);
    }
    this.handleFocusClick(true);
  }

  private handleFocusClick(isSkip = false): void {
    console.log('[Focus Top Post] Button clicked!');
    const chips = Array.from(document.querySelectorAll<HTMLElement>(`.${CHIP_CLASS}`));
    console.log(`[Focus Top Post] Found ${chips.length} chips on the page.`);
    if (chips.length === 0) {
      this.showToast('No posts found on screen.', 'error');
      return;
    }

    let bestChip: HTMLElement | null = null;
    let bestScore = -1;

    for (const chip of chips) {
      const postId = chip.getAttribute('data-post-id');
      if (!postId) continue;

      if (this.skippedPostIds.has(postId)) {
        continue;
      }

      if (isSkip && postId === this.lastFocusedPostId) {
        continue;
      }

      const aiSpan = chip.querySelector<HTMLElement>(`.${CHIP_CLASS}__ai`);

      let aiScore = -1;

      if (aiSpan && aiSpan.getAttribute('data-state') === 'ready') {
        const match = aiSpan.textContent?.match(/(\d+)\/10/);
        if (match) aiScore = parseInt(match[1], 10);
      }

      console.log(`[Focus Top Post] Chip ${postId} -> AI: ${aiScore}`);

      if (aiScore > bestScore) {
        bestScore = aiScore;
        bestChip = chip;
      }
    }

    if (!bestChip || bestScore === -1) {
      console.log(
        '[Focus Top Post] No valid best chip found. Scores might be all negative or loading.'
      );
      if (isSkip) {
        if (this.skippedPostIds.size > 0) {
          console.log('[Focus Top Post] All posts skipped. Wrapping around...');
          this.skippedPostIds.clear();
          this.lastFocusedPostId = null;
          this.handleFocusClick(false);
          this.showToast('Resetting and wrapping around feed...');
          return;
        }
      }
      this.showToast('Still scoring posts... Please wait.');
      return;
    }

    const postId = bestChip.getAttribute('data-post-id');
    console.log(`[Focus Top Post] Best chip selected: ${postId} with AI score ${bestScore}`);

    if (!postId) return;

    this.lastFocusedPostId = postId;

    const postEl = document.querySelector<HTMLElement>(
      `[${POST_ANCHOR_ATTR}="${postId.replace(/"/g, '\\"')}"]`
    );
    if (postEl) {
      console.log(`[Focus Top Post] Post element found for scroll. Scrolling...`);
      postEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      postEl.classList.add('linkmate-priority-highlight');
      setTimeout(() => {
        postEl.classList.remove('linkmate-priority-highlight');
      }, 3000);

      this.showToast(`Focused post (${bestScore}/10)`);
    } else {
      console.warn(
        `[Focus Top Post] Could not find post root element matching [${POST_ANCHOR_ATTR}="${postId}"]!`
      );
      this.showToast('Could not find the post on screen.', 'error');
    }
  }

  private showToast(message: string, type: 'success' | 'error' = 'success'): void {
    const toast = document.createElement('div');
    toast.className = `linkmate-toast linkmate-toast-${type}`;
    toast.textContent = message;
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'polite');

    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('linkmate-toast-show');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('linkmate-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
}

/**
 * Mirrors feed-parser.ts Strategy B but returns the DOM element alongside the
 * synthesized post id, so the overlay can attach chips to real elements.
 */
export function findFeedPostRoots(): Array<{ element: HTMLElement; id: string }> {
  const out: Array<{ element: HTMLElement; id: string }> = [];
  const seen = new Set<Element>();
  const reactionButtons = document.querySelectorAll(
    'button[aria-label^="Reaction button state" i]'
  );
  for (const rxBtn of Array.from(reactionButtons)) {
    let cur: HTMLElement | null = rxBtn as HTMLElement;
    let postEl: HTMLElement | null = null;
    for (let d = 0; d < 15 && cur; d++) {
      cur = cur.parentElement;
      if (!cur) break;
      if (cur.getAttribute('componentkey') && cur.querySelectorAll('button').length >= 3) {
        postEl = cur;
        break;
      }
    }
    if (!postEl || seen.has(postEl)) continue;
    seen.add(postEl);
    const componentkey = postEl.getAttribute('componentkey');
    if (!componentkey) continue;
    out.push({ element: postEl, id: `urn:li:component:${componentkey}` });
  }
  return out;
}
