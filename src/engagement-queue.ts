/**
 * T121 — Engagement Queue UI (Phase B, US1).
 *
 * Vanilla-DOM sidebar mounted on linkedin.com/feed/. Renders top-N
 * relevance-scored posts with editable AI drafts. NEVER programmatically
 * clicks LinkedIn submit/post/send buttons (Constitution §I, §VI).
 *
 * Deps are injected for testability; in production these wrap chrome.runtime
 * message-passing into background.ts handlers (T124).
 *
 * Refresh is throttled to once per QUEUE_REFRESH_THROTTLE_MS (5 minutes).
 */

import type { ParsedPost, ScoredPost, ToneKey, LengthKey } from './storage-schema';

export const QUEUE_REFRESH_THROTTLE_MS = 5 * 60 * 1000;
export const QUEUE_MAX_VISIBLE = 10;

export interface DraftRequest {
  post: ParsedPost;
  tone: ToneKey;
  length: LengthKey;
}

/**
 * scoreFeed returns a result object so the queue can surface a CTA when
 * scoring is not possible (e.g. no profile captured yet) instead of silently
 * rendering an empty list.
 */
export type ScoreFeedResult = { ok: true; scored: ScoredPost[] } | { ok: false; warning: string };

export interface EngagementQueueDeps {
  scoreFeed?: (posts: ParsedPost[]) => Promise<ScoreFeedResult>;
  draftComment?: (req: DraftRequest) => Promise<string>;
  markEngaged?: (postId: string) => Promise<void>;
  dismiss?: (postId: string) => Promise<void>;
  copyToClipboard?: (text: string) => Promise<void>;
  openPost?: (postId: string) => void;
  now?: () => number;
}

function defaultCopyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.resolve();
}

function defaultOpenPost(postId: string): void {
  // The activity id format is `urn:li:activity:<digits>`; the canonical post
  // URL is /feed/update/{urn}/. LinkedIn accepts the URN raw — no URL-encoding
  // needed (the `:` is valid in path segments and LinkedIn renders the URL
  // back this way in its own UI). We do NOT navigate — only open in a new
  // tab so the user must click Submit themselves.
  if (typeof window !== 'undefined') {
    window.open(`https://www.linkedin.com/feed/update/${postId}/`, '_blank');
  }
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
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

export class EngagementQueue {
  private root: HTMLElement | null = null;
  private toneSelect: HTMLSelectElement | null = null;
  private lengthSelect: HTMLSelectElement | null = null;
  private listEl: HTMLElement | null = null;

  private currentScored: ScoredPost[] = [];
  private lastRefreshAt = 0;
  private currentTone: ToneKey = 'friendly';
  private currentLength: LengthKey = 'standard';

  private readonly deps: Required<Pick<EngagementQueueDeps, 'now'>> & EngagementQueueDeps;

  constructor(deps: EngagementQueueDeps = {}) {
    this.deps = {
      now: () => Date.now(),
      ...deps,
    };
  }

  mount(container: Element): void {
    if (this.root && container.contains(this.root)) return;

    const root = document.createElement('aside');
    root.className = 'linkmate-queue';
    root.setAttribute('role', 'complementary');
    root.setAttribute('aria-label', 'LinkMate Engagement Queue');
    root.innerHTML = `
      <header class="linkmate-queue__header">
        <span class="linkmate-queue__title">LinkMate · Engagement Queue</span>
        <button class="linkmate-queue__close" type="button" aria-label="Close queue">×</button>
      </header>
      <div class="linkmate-queue__controls">
        <label class="linkmate-queue__control">
          <span>Tone</span>
          <select class="linkmate-queue__tone">
            <option value="professional">Professional</option>
            <option value="friendly" selected>Friendly</option>
            <option value="enthusiastic">Enthusiastic</option>
            <option value="thoughtful">Thoughtful</option>
          </select>
        </label>
        <label class="linkmate-queue__control">
          <span>Length</span>
          <select class="linkmate-queue__length">
            <option value="brief">Brief</option>
            <option value="standard" selected>Standard</option>
            <option value="detailed">Detailed</option>
          </select>
        </label>
      </div>
      <div class="linkmate-queue__list" role="list"></div>
    `;
    container.appendChild(root);

    this.root = root;
    this.toneSelect = root.querySelector('.linkmate-queue__tone') as HTMLSelectElement;
    this.lengthSelect = root.querySelector('.linkmate-queue__length') as HTMLSelectElement;
    this.listEl = root.querySelector('.linkmate-queue__list') as HTMLElement;

    this.toneSelect.addEventListener('change', () => {
      this.currentTone = this.toneSelect!.value as ToneKey;
      void this.regenerateAllVisible();
    });
    this.lengthSelect.addEventListener('change', () => {
      this.currentLength = this.lengthSelect!.value as LengthKey;
      void this.regenerateAllVisible();
    });

    root.querySelector('.linkmate-queue__close')?.addEventListener('click', () => this.unmount());

    // Delegated handler for tile actions
    this.listEl.addEventListener('click', (ev) => {
      const btn = (ev.target as Element).closest<HTMLButtonElement>('[data-action]');
      if (!btn) return;
      const tile = btn.closest('.linkmate-queue__tile') as HTMLElement | null;
      const postId = tile?.getAttribute('data-post-id') ?? '';
      if (!postId) return;
      const action = btn.getAttribute('data-action');
      if (action === 'regenerate') void this.regenerateOne(postId);
      else if (action === 'copy') void this.copyAndEngage(postId);
      else if (action === 'hide') void this.hideOne(postId);
    });
  }

  unmount(): void {
    if (this.root?.parentElement) {
      this.root.parentElement.removeChild(this.root);
    }
    this.root = null;
    this.toneSelect = null;
    this.lengthSelect = null;
    this.listEl = null;
    this.currentScored = [];
  }

  async refresh(posts: ParsedPost[]): Promise<void> {
    if (!this.root || !this.listEl) return;
    const now = this.deps.now();
    if (now - this.lastRefreshAt < QUEUE_REFRESH_THROTTLE_MS && this.lastRefreshAt !== 0) {
      // Throttled — do not re-score. (Caller can wait or invoke fresh-only flow.)
      return;
    }
    this.lastRefreshAt = now;

    const result: ScoreFeedResult = this.deps.scoreFeed
      ? await this.deps.scoreFeed(posts)
      : { ok: true, scored: [] };

    if (!result.ok) {
      this.currentScored = [];
      this.renderWarning(result.warning);
      return;
    }

    this.currentScored = result.scored
      .filter((s) => s.relevance.category !== 'skip')
      .sort((a, b) => b.relevance.score - a.relevance.score)
      .slice(0, QUEUE_MAX_VISIBLE);

    this.renderList();
    await this.regenerateAllVisible();
  }

  private renderWarning(message: string): void {
    if (!this.listEl) return;
    // Inline SVG icon — the sidebar is injected into the LinkedIn page which
    // does NOT load Font Awesome (FA is only in popup.html), so `<i class="fa ...">`
    // would render as a 0×0 element. SVG ships its own glyph (Bug #2 fix).
    this.listEl.innerHTML = `
      <div class="linkmate-queue__warning" role="status">
        <svg class="linkmate-queue__warning-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
          <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 5a1.25 1.25 0 110 2.5A1.25 1.25 0 0112 7zm1 11h-2v-7h2v7z"/>
        </svg>
        <div class="linkmate-queue__warning-text">${esc(message)}</div>
      </div>
    `;
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = this.currentScored.map((s, i) => this.renderTile(s, i + 1)).join('');
  }

  private renderTile(s: ScoredPost, rank: number): string {
    const reason = s.relevance.reasons[0] ?? '';
    return `
      <article class="linkmate-queue__tile" data-post-id="${esc(s.id)}" role="listitem">
        <header class="linkmate-queue__tile-header">
          <span class="linkmate-queue__rank">#${rank}</span>
          <span class="linkmate-queue__score" data-category="${s.relevance.category}">${s.relevance.score}</span>
          <span class="linkmate-queue__category">${esc(s.relevance.category)}</span>
        </header>
        <div class="linkmate-queue__tile-author">
          ${esc(s.authorName || 'Unknown')}${s.authorTitle ? ` · ${esc(s.authorTitle)}` : ''}
        </div>
        <div class="linkmate-queue__tile-why">Why: ${esc(reason)}</div>
        <textarea class="linkmate-queue__draft" aria-label="Editable draft reply">Drafting…</textarea>
        <div class="linkmate-queue__tile-actions">
          <button type="button" data-action="regenerate">↻ Regenerate</button>
          <button type="button" data-action="copy" class="linkmate-queue__copy">📋 Copy &amp; Open</button>
          <button type="button" data-action="hide" class="linkmate-queue__hide">Hide</button>
        </div>
      </article>
    `;
  }

  private getTile(postId: string): HTMLElement | null {
    return this.listEl?.querySelector(
      `.linkmate-queue__tile[data-post-id="${CSS.escape(postId)}"]`
    ) as HTMLElement | null;
  }

  private getDraftEl(postId: string): HTMLTextAreaElement | null {
    return this.getTile(postId)?.querySelector(
      '.linkmate-queue__draft'
    ) as HTMLTextAreaElement | null;
  }

  private async regenerateOne(postId: string): Promise<void> {
    if (!this.deps.draftComment) return;
    const scored = this.currentScored.find((s) => s.id === postId);
    if (!scored) return;
    const draftEl = this.getDraftEl(postId);
    if (draftEl) draftEl.value = 'Drafting…';
    try {
      const draft = await this.deps.draftComment({
        post: scored,
        tone: this.currentTone,
        length: this.currentLength,
      });
      if (draftEl) draftEl.value = draft;
    } catch (err) {
      if (draftEl) draftEl.value = `[Draft failed: ${String(err)}]`;
    }
  }

  private async regenerateAllVisible(): Promise<void> {
    await Promise.all(this.currentScored.map((s) => this.regenerateOne(s.id)));
  }

  private async copyAndEngage(postId: string): Promise<void> {
    const draftEl = this.getDraftEl(postId);
    const text = draftEl?.value ?? '';
    const copy = this.deps.copyToClipboard ?? defaultCopyToClipboard;
    const open = this.deps.openPost ?? defaultOpenPost;
    try {
      await copy(text);
    } catch {
      // ignore — clipboard may be denied; user still gets the new tab
    }
    if (this.deps.markEngaged) {
      try {
        await this.deps.markEngaged(postId);
      } catch {
        /* swallow */
      }
    }
    open(postId);
    // Remove the tile from the visible list (engaged → out of queue for 30 days)
    this.currentScored = this.currentScored.filter((s) => s.id !== postId);
    this.getTile(postId)?.remove();
  }

  private async hideOne(postId: string): Promise<void> {
    if (this.deps.dismiss) {
      try {
        await this.deps.dismiss(postId);
      } catch {
        /* swallow */
      }
    }
    this.currentScored = this.currentScored.filter((s) => s.id !== postId);
    this.getTile(postId)?.remove();
  }
}
