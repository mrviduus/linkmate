/**
 * Issue #18 follow-up — per-post inline relevance chips on the LinkedIn feed.
 *
 * Sits alongside the EngagementQueue sidebar (which still ranks the top-10).
 * For EVERY post visible in the feed, injects a floating chip in the top-right
 * showing:
 *   - 🎯 <heuristic>/10 — instant, free, computed from ProfileContext
 *   - 🤖 <ai>/10 — batched OpenAI call, lazy, cached
 *   - Why for you — tooltip with the AI narrative
 *
 * Reuses `queue.scoreFeed` + `queue.aiScoreFeed` background handlers via deps,
 * so it benefits from the existing in-memory AI cache (1h TTL) — no extra
 * cost when the sidebar + overlay both ask for the same posts.
 *
 * Post root detection mirrors feed-parser.ts Strategy B: anchor on the
 * `Reaction button state` aria-label, walk up to the ancestor with a
 * `componentkey` attribute. Same heuristic as parseFeedDom so IDs line up.
 */

import { parseFeedDom } from './feed-parser';
import type { ParsedPost, ScoredPost } from './storage-schema';

// ─── Types shared with linkedin-content.ts deps ──────────────────────────

export type ScoreFeedResult =
  | { ok: true; scored: ScoredPost[] }
  | { ok: false; warning: string };

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
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}

const CHIP_CLASS = 'linkmate-post-chip';
const POST_ANCHOR_ATTR = 'data-linkmate-post-id';
const SCAN_DEBOUNCE_MS = 800;
// Hard cap so a constantly-mutating feed (LinkedIn animations / video players /
// hover state) can't keep starving the debounce. After this many ms since the
// FIRST mutation of a burst, we fire regardless of new mutations.
const SCAN_MAX_WAIT_MS = 3_000;
const REFRESH_INTERVAL_MS = 30_000;
// Server-side handleQueueAiScoreFeed slices to 10. The overlay chunks all
// non-skip posts into groups of this size and scores each chunk in parallel
// so EVERY visible post gets an AI score, not just the heuristic top-10.
const AI_BATCH_SIZE = 10;

export interface FeedPostOverlayDeps {
  scoreFeed: (posts: ParsedPost[]) => Promise<ScoreFeedResult>;
  aiScoreFeed: (posts: ParsedPost[]) => Promise<AiScoreFeedResult>;
  now?: () => number;
}

export class FeedPostOverlay {
  private observer: MutationObserver | null = null;
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
    this.observer = new MutationObserver(() => this.scheduleScan());
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
      if (this.knownIds.has(id)) continue;
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
      const posts = parseFeedDom(document);
      if (posts.length === 0) return;
      const scoreResult = await this.deps.scoreFeed(posts);
      if (!scoreResult.ok) {
        // Profile missing → leave chips in 'loading' state; sidebar warning covers the why.
        return;
      }
      this.applyHeuristicScores(scoreResult.scored);
      this.lastRefreshAt = this.deps.now();

      // AI scoring — score EVERY visible post, regardless of heuristic
      // category. The user explicitly opted in to "AI score on every post"
      // and the SW in-memory cache + the heuristic top-N ordering keep cost
      // bounded. (Sidebar still filters skip — its purpose is actionable
      // top-10 only.)
      if (this.aiUnavailable) {
        this.markAllAiUnavailable();
        return;
      }
      const eligible = scoreResult.scored
        .slice()
        .sort((a, b) => b.relevance.score - a.relevance.score);
      if (eligible.length === 0) return;

      // Chunk into AI_BATCH_SIZE-sized requests. Server-side handler slices to
      // 10 per call; we loop on the client so every visible non-skip post gets
      // scored. SW in-memory cache (1h) deduplicates re-scans cheaply.
      const chunks: typeof eligible[] = [];
      for (let i = 0; i < eligible.length; i += AI_BATCH_SIZE) {
        chunks.push(eligible.slice(i, i + AI_BATCH_SIZE));
      }
      const chunkResults = await Promise.all(chunks.map((c) => this.deps.aiScoreFeed(c)));

      // First, detect engine-unavailable verdict in ANY chunk — flips the
      // overlay into a terminal "AI off" state.
      const engineDown = chunkResults.find(
        (r) => !r.ok && (r.reason === 'no_key' || r.reason === 'no_profile'),
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
    // Use both `title` (a11y, screen readers, slow native tooltip) AND
    // `data-tooltip` (used by our CSS ::after pseudo-tooltip that appears
    // instantly on hover — see linkedin-styles.css).
    const initialHeuristicTip = 'Heuristic relevance — local, based on your profile';
    const initialAiTip = this.aiUnavailable
      ? 'AI score unavailable — check OpenAI key in Settings'
      : 'AI relevance — uses OpenAI + your profile + goals';
    chip.innerHTML = `
      <span class="${CHIP_CLASS}__heuristic" data-state="loading" data-tooltip="${esc(initialHeuristicTip)}" title="${esc(initialHeuristicTip)}">🎯 …</span>
      <span class="${CHIP_CLASS}__ai" data-state="${this.aiUnavailable ? 'na' : 'loading'}" data-tooltip="${esc(initialAiTip)}" title="${esc(initialAiTip)}">${this.aiUnavailable ? '🤖 —' : '🤖 …'}</span>
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
      ai.textContent = '🤖 —';
      if (title) {
        ai.setAttribute('title', title);
        ai.setAttribute('data-tooltip', title);
      }
    }
  }

  private applyHeuristicScores(scored: ScoredPost[]): void {
    for (const s of scored) {
      const chip = this.findChip(s.id);
      if (!chip) continue;
      const tenScore = Math.round(s.relevance.score / 10);
      const span = chip.querySelector<HTMLElement>(`.${CHIP_CLASS}__heuristic`);
      if (span) {
        span.setAttribute('data-state', 'ready');
        span.setAttribute('data-band', s.relevance.category);
        span.textContent = `🎯 ${tenScore}/10`;
        const tip = `Heuristic ${s.relevance.score}/100 · ${s.relevance.category}${
          s.relevance.reasons[0] ? ' · ' + s.relevance.reasons[0] : ''
        }`;
        span.setAttribute('title', tip);
        span.setAttribute('data-tooltip', tip);
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
      span.textContent = `🤖 ${r.aiScore}/10`;
      if (r.whyForYou) {
        span.setAttribute('title', r.whyForYou);
        span.setAttribute('data-tooltip', r.whyForYou);
      }
    }
  }

  private markAllAiUnavailable(): void {
    const tip = 'AI score unavailable — check OpenAI key in Settings';
    document
      .querySelectorAll<HTMLElement>(`.${CHIP_CLASS}__ai`)
      .forEach((el) => {
        el.setAttribute('data-state', 'na');
        el.textContent = '🤖 —';
        el.setAttribute('title', tip);
        el.setAttribute('data-tooltip', tip);
      });
  }

  private findChip(postId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(
      `.${CHIP_CLASS}[data-post-id="${CSS.escape(postId)}"]`,
    );
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
    'button[aria-label^="Reaction button state" i]',
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
