// LinkedIn Content Script for LinkMate Extension
// Handles post detection, reply generation, and UI injection

import { FeedPostOverlay } from './feed-post-overlay';
import { scanPostForOutcome } from './outcome-scanner';
import type { AiScoreFeedResult, AiScoredPostDTO } from './feed-post-overlay';
import type { ParsedPost } from './storage-schema';
import { STORAGE_KEYS, getPaused } from './storage-schema';

console.log('LinkMate LinkedIn content script loaded');

interface LinkedInComment {
  id: string;
  text: string;
  likeCount: number;
  element: HTMLElement;
}

interface LinkedInPost {
  id: string;
  element: HTMLElement;
  textContent: string;
  hasReplyButton: boolean;
  comments?: LinkedInComment[];
}

class LinkedInLinkMate {
  private posts: Map<string, LinkedInPost> = new Map();
  private observer: MutationObserver | null = null;
  private isProcessing = false;
  private feedPostOverlay: FeedPostOverlay | null = null;
  private currentPath: string = '';
  private routePollIntervalId: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private lastDismissPing = 0;

  constructor() {
    this.showComplianceWarning();
    this.init();
  }

  private showComplianceWarning(): void {
    // T130 — extended for SSI Growth Mode (Phase B, US1).
    // Print once per tab: the content script re-inits across LinkedIn's frames
    // / reloads, which otherwise floods the console with this same notice.
    try {
      if (sessionStorage.getItem('linkmate.complianceWarned') === '1') return;
      sessionStorage.setItem('linkmate.complianceWarned', '1');
    } catch {
      /* sessionStorage unavailable (sandboxed frame) — fall through and warn */
    }
    console.warn(
      '⚠️ LinkMate Extension Notice (SSI Growth Mode):\n' +
        '• AI-drafted comments are SUGGESTIONS only — you must edit, paste, and submit them yourself.\n' +
        '• LinkMate never programmatically clicks LinkedIn submit, post, send, or like buttons.\n' +
        "• Automated interactions may violate LinkedIn's Terms of Service — review every draft before posting.\n" +
        '• All AI inference runs locally on your device; no LinkedIn content leaves your browser.\n' +
        'Use this extension responsibly and at your own risk.'
    );
  }

  /**
   * Mount the per-post inline relevance overlay on eligible surfaces (the feed
   * and profile/recent-activity pages). Each visible post gets a chip showing
   * the AI score. Drafts still happen via the in-post Reply button — handled
   * separately, and doesn't depend on this overlay.
   */
  private async mountOverlayIfEligible(): Promise<void> {
    // Score posts on the feed AND on profile pages (/in/<handle>/…, incl.
    // recent-activity) — that's where the user's own posts live, so they get
    // chips too. The AI path doesn't skip own posts; only the surface gated it.
    const onScoredSurface =
      location.pathname.startsWith('/feed') || /^\/in\//.test(location.pathname);
    // Global pause is the master switch. Mount only on a scored surface AND not
    // paused; otherwise tear the overlay down.
    const paused = await getPaused();
    if (onScoredSurface && !paused && !this.feedPostOverlay) {
      this.feedPostOverlay = new FeedPostOverlay({
        aiScoreFeed: async (posts: ParsedPost[]): Promise<AiScoreFeedResult> => {
          const resp = await this.sendQueueMessage<{
            ok?: boolean;
            results?: AiScoredPostDTO[];
            reason?: 'no_key' | 'no_profile' | 'parse' | 'network';
            error?: string;
          }>({ action: 'queue.aiScoreFeed', posts });
          if (!resp) {
            return { ok: false, reason: 'network' };
          }
          if (resp.ok === false) {
            return { ok: false, reason: resp.reason ?? 'network', error: resp.error };
          }
          return { ok: true, results: resp.results ?? [] };
        },
      });
      this.feedPostOverlay.mount();
    } else if ((!onScoredSurface || paused) && this.feedPostOverlay) {
      this.feedPostOverlay.unmount();
      this.feedPostOverlay = null;
    }
  }

  private sendQueueMessage<T = unknown>(message: object): Promise<T | undefined> {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response: T) => {
          if (chrome.runtime.lastError) {
            console.warn('Queue message error:', chrome.runtime.lastError);
            resolve(undefined);
            return;
          }
          resolve(response);
        });
      } catch (err) {
        console.warn('Queue message threw:', err);
        resolve(undefined);
      }
    });
  }

  private watchRouteChanges(): void {
    // LinkedIn is an SPA. Prefer the Navigation API (Chrome 102+) which fires
    // exactly once per route change; fall back to a 5s pathname poll on older
    // engines. Either way we mount/unmount the queue when the user moves
    // between /feed/ and other surfaces.
    this.currentPath = location.pathname;

    const checkAndRemount = () => {
      if (location.pathname !== this.currentPath) {
        this.currentPath = location.pathname;
        void this.mountOverlayIfEligible();
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.navigation not in @types/dom yet
    const nav = (window as any).navigation as
      | { addEventListener?: (type: string, listener: () => void) => void }
      | undefined;
    if (nav && typeof nav.addEventListener === 'function') {
      nav.addEventListener('navigate', () => {
        // setTimeout 0 lets location.pathname reflect the new route before we read it.
        setTimeout(checkAndRemount, 0);
      });
      return;
    }

    // Fallback polling — bumped from 1.5s to 5s; route changes are not latency-critical.
    this.routePollIntervalId = setInterval(checkAndRemount, 5000);
  }

  private notifyBackgroundReady(): void {
    console.log('\ud83d\udd14 Notifying background that LinkedIn content script is ready...');
    chrome.runtime.sendMessage(
      {
        action: 'linkedinContentScriptReady',
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error('Failed to notify background:', chrome.runtime.lastError);
          // Retry notification after a short delay
          setTimeout(() => this.notifyBackgroundReady(), 2000);
        } else if (response?.engineReady) {
          console.log('\u2705 Background confirmed: AI engine is ready');
        } else {
          console.log('\u26a0\ufe0f Background response:', response);
        }
      }
    );
  }

  private init(): void {
    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => void this.setup());
    } else {
      void this.setup();
    }
  }

  private async setup(): Promise<void> {
    // Notify background that LinkedIn content script is ready
    this.notifyBackgroundReady();

    this.paused = await getPaused();
    this.watchRouteChanges();
    this.watchForPanelDismiss();

    // Global pause is the master switch — flip all on-page features live.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && STORAGE_KEYS.paused in changes) {
        this.applyPaused(Boolean(changes[STORAGE_KEYS.paused].newValue));
      }
    });

    // Listen for messages from background/popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'generateReply') {
        this.handleGenerateReply(request.postId, request.postContent);
        sendResponse({ status: 'processing' });
      }
      return true;
    });

    // Listen for content requests from popup
    chrome.runtime.onConnect.addListener((port) => {
      port.onMessage.addListener((_msg) => {
        port.postMessage({ contents: document.body.innerText });
      });
    });

    // Only spin up the feature machinery when not paused.
    if (!this.paused) this.activateFeatures();
  }

  /** Start post detection + the feed overlay. Idempotent-ish via observePosts guard. */
  private activateFeatures(): void {
    this.observePosts();
    this.processVisiblePosts();
    void this.mountOverlayIfEligible();
  }

  /** Master switch handler: pause tears every injected UI down; resume rebuilds it. */
  private applyPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.observer?.disconnect();
      this.observer = null;
      this.feedPostOverlay?.unmount();
      this.feedPostOverlay = null;
      this.removeInjectedUi();
      this.posts.clear();
    } else {
      this.activateFeatures();
    }
  }

  /** Remove every LinkMate element we injected into the page (reply buttons,
   *  panels, toasts). Chips + FAB are handled by FeedPostOverlay.unmount(). */
  private removeInjectedUi(): void {
    // Each AI-reply button sits in a wrapper created solely for it.
    document.querySelectorAll('.linkmate-generate-btn').forEach((b) => b.parentElement?.remove());
    document.querySelectorAll('.linkmate-panel, .linkmate-toast').forEach((el) => el.remove());
  }

  /**
   * When the user starts working with the LinkedIn page (a real click that
   * isn't on LinkMate's own injected UI), ping the side panel so it fades out.
   * Throttled; harmless no-op when the panel isn't open. The panel ignores
   * pings within its open grace window so the gesture that opened it doesn't
   * immediately close it.
   */
  private watchForPanelDismiss(): void {
    document.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (
          target?.closest?.(
            '.linkmate-fab-container, .linkmate-generate-btn, .linkmate-panel, .linkmate-post-chip, .linkmate-toast'
          )
        ) {
          return; // clicks on our own UI shouldn't dismiss the panel
        }
        const now = Date.now();
        if (now - this.lastDismissPing < 800) return; // throttle bursts
        this.lastDismissPing = now;
        try {
          chrome.runtime.sendMessage({ action: 'sidepanel.dismiss' }, () => {
            void chrome.runtime.lastError; // swallow "no receiver" when panel is closed
          });
        } catch {
          /* extension context reloaded — ignore */
        }
      },
      true
    );
  }

  private observePosts(): void {
    const feedContainer =
      document.querySelector('main[role="main"]') ||
      document.querySelector('.scaffold-layout__main') ||
      document.body;

    this.observer = new MutationObserver((_mutations) => {
      // Debounce processing to avoid excessive calls
      this.debounce(() => this.processVisiblePosts(), 500)();
    });

    this.observer.observe(feedContainer, {
      childList: true,
      subtree: true,
    });
  }

  private processVisiblePosts(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // v0.5.8 — Post discovery rewritten after Chrome-MCP-verified DOM inspection.
      //
      // LinkedIn 2026 feed has NEITHER data-urn NOR <article> tags on posts.
      // Posts are <div componentkey="<base64-id>"> with hash class names.
      // The reliable way to find posts: locate action bars (which contain a
      // Reaction button — a11y-stable aria-label) and walk up to the post
      // container.
      //
      // We INVERT discovery: find all Reaction buttons → walk up to post → process.

      const seen = new Set<Element>();

      // Strategy A (legacy / older caches): direct post selectors
      const legacyPostSelectors = [
        '[data-urn*="urn:li:activity"]',
        '[data-id*="urn:li:activity"]',
        '[data-activity-urn]',
        'article[data-urn]',
        '.feed-shared-update-v2',
        'div[class*="occludable-update"]',
        '.feed-shared-update',
        '[data-test-id="main-feed-activity-card"]',
      ];
      legacyPostSelectors.forEach((selector) => {
        const posts = document.querySelectorAll(selector);
        posts.forEach((post) => {
          if (seen.has(post)) return;
          seen.add(post);
          this.processPost(post as HTMLElement);
        });
      });

      // Strategy B (2026 SDUI): find action bars via Reaction button, walk up
      // to the containing <div componentkey="..."> post.
      const reactionButtons = document.querySelectorAll(
        'button[aria-label^="Reaction button state" i]'
      );
      reactionButtons.forEach((rxBtn) => {
        // Walk up until we hit a div that has componentkey AND contains the
        // entire post (heuristic: stop when we hit a parent with componentkey
        // attribute set, since each post is wrapped in one).
        let cur: HTMLElement | null = rxBtn as HTMLElement;
        let depth = 0;
        while (cur && cur !== document.body && depth < 15) {
          cur = cur.parentElement;
          depth++;
          if (!cur) break;
          if (cur.getAttribute('componentkey')) {
            // Verify it actually looks like a post — contains an action bar (3+ buttons)
            if (cur.querySelectorAll('button').length >= 3 && !seen.has(cur)) {
              seen.add(cur);
              this.processPost(cur);
            }
            break;
          }
        }
      });
    } finally {
      this.isProcessing = false;
    }
  }

  private processPost(postElement: HTMLElement): void {
    const postId = this.getPostId(postElement);
    if (!postId || this.posts.has(postId)) return;

    const textContent = this.extractPostText(postElement);
    if (!textContent || textContent.length < 10) return; // Skip very short posts

    const post: LinkedInPost = {
      id: postId,
      element: postElement,
      textContent: textContent.substring(0, 500), // Limit text length
      hasReplyButton: false,
    };

    this.posts.set(postId, post);
    this.injectReplyButton(post);
    // Lazy outcome auto-attach: if user previously commented on this post and
    // their comment is on-screen, scrape engagement metrics. No-op otherwise.
    void scanPostForOutcome(postElement, postId);
  }

  private getPostId(element: HTMLElement): string | null {
    const componentkey = element.getAttribute('componentkey');
    return (
      element.getAttribute('data-id') ||
      element.getAttribute('data-urn') ||
      element.getAttribute('data-activity-urn') ||
      (componentkey ? `urn:li:component:${componentkey}` : '') ||
      element.id ||
      `post-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
  }

  private extractPostText(postElement: HTMLElement): string {
    // Strategy A — legacy class names (still seen in older page caches).
    const contentSelectors = [
      '.feed-shared-text',
      '[data-test-id="main-feed-activity-content"]',
      '.feed-shared-update-v2__description',
      '.feed-shared-text__text-view',
      'span[dir="ltr"]',
      '.feed-shared-update-v2__commentary',
      '.update-components-text',
    ];

    for (const selector of contentSelectors) {
      const contentElement = postElement.querySelector(selector);
      if (contentElement?.textContent) {
        const text = contentElement.textContent.trim();
        if (text.length > 10) {
          return text;
        }
      }
    }

    // Strategy B (2026 SDUI) — class names are auto-generated hashes. Use
    // the longest <p> in the post that isn't time / engagement counts.
    let best = '';
    const paragraphs = postElement.querySelectorAll('p');
    paragraphs.forEach((p) => {
      const t = (p.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (t.length < 30) return;
      if (/^\d+\s*[smhdw]\b/i.test(t)) return; // time stamps
      if (/^\d[\d,]*\s+(reactions?|comments?|reposts?)/i.test(t)) return; // counts
      if (t.length > best.length) best = t;
    });
    return best;
  }

  private extractComments(postElement: HTMLElement): LinkedInComment[] {
    const comments: LinkedInComment[] = [];
    const seen = new Set<Element>();

    // Strategy A — legacy class names.
    const commentSelectors = [
      '.comments-comment-item',
      '[data-test-id="comments-comment-item"]',
      '.comment-item',
      'article[class*="comments-comment-item"]',
    ];

    for (const selector of commentSelectors) {
      const commentElements = postElement.querySelectorAll(selector);
      commentElements.forEach((commentEl: Element) => {
        if (seen.has(commentEl)) return;
        seen.add(commentEl);
        const comment = this.extractCommentData(commentEl as HTMLElement);
        if (comment) comments.push(comment);
      });
    }

    // Strategy B (2026 SDUI) — each comment wrapped in
    // <div componentkey="replaceableComment_urn:li:comment:...">.
    const sduiComments = postElement.querySelectorAll('[componentkey^="replaceableComment_"]');
    sduiComments.forEach((commentEl: Element) => {
      if (seen.has(commentEl)) return;
      seen.add(commentEl);
      const comment = this.extractCommentData(commentEl as HTMLElement);
      if (comment) comments.push(comment);
    });

    return comments.sort((a, b) => b.likeCount - a.likeCount);
  }

  private extractCommentData(commentElement: HTMLElement): LinkedInComment | null {
    // Strategy A — legacy text containers.
    const textSelectors = [
      '.comments-comment-item__main-content',
      '.comments-comment-texteditor',
      '[data-test-id="comment-text"]',
      '.comments-comment-item-content-body',
    ];

    let commentText = '';
    for (const selector of textSelectors) {
      const textEl = commentElement.querySelector(selector);
      if (textEl?.textContent) {
        commentText = textEl.textContent.trim();
        break;
      }
    }

    // Strategy B (2026 SDUI) — longest <p> in the row that isn't the
    // author byline / timestamp.
    if (!commentText) {
      let best = '';
      commentElement.querySelectorAll('p').forEach((p) => {
        const t = (p.textContent ?? '').trim().replace(/\s+/g, ' ');
        if (t.length < 5) return;
        if (/^\d+\s*[smhdw]\b/i.test(t)) return; // timestamp
        if (t.length > best.length) best = t;
      });
      commentText = best;
    }

    if (!commentText) return null;

    const likeCount = this.extractLikeCount(commentElement);

    // Prefer the SDUI URN baked into componentkey for stable dedup.
    const ck = commentElement.getAttribute('componentkey') ?? '';
    const id =
      ck && ck.startsWith('replaceableComment_')
        ? ck.replace(/^replaceableComment_/, '')
        : `comment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    return {
      id,
      text: commentText,
      likeCount,
      element: commentElement,
    };
  }

  private extractLikeCount(commentElement: HTMLElement): number {
    // Strategy A — legacy class names.
    const likeSelectors = [
      '.social-counts-reactions__count',
      '[data-test-id="social-actions__reaction-count"]',
      '.reactions-react-button span[aria-hidden="true"]',
      '.comments-comment-social-bar__reactions-count',
    ];

    for (const selector of likeSelectors) {
      const likeEl = commentElement.querySelector(selector);
      if (likeEl?.textContent) {
        return this.parseLikeCount(likeEl.textContent);
      }
    }

    // Strategy B (2026 SDUI) — the reactions button parent holds the count
    // (e.g. "0", "12", "1.2K") right next to the button.
    const rxBtn = commentElement.querySelector('button[aria-label="Open reactions menu"]');
    const parentText = rxBtn?.parentElement?.textContent?.trim();
    if (parentText && /\d/.test(parentText)) {
      return this.parseLikeCount(parentText);
    }

    return 0;
  }

  private parseLikeCount(text: string): number {
    text = text.trim().toLowerCase();

    // Handle K (thousands) and M (millions)
    if (text.includes('k')) {
      return Math.round(parseFloat(text.replace('k', '')) * 1000);
    }
    if (text.includes('m')) {
      return Math.round(parseFloat(text.replace('m', '')) * 1000000);
    }

    return parseInt(text, 10) || 0;
  }

  private injectReplyButton(post: LinkedInPost): void {
    const actionContainer = this.findActionContainer(post.element);
    if (!actionContainer) return;

    // Check if button already exists
    if (actionContainer.querySelector('.linkmate-generate-btn')) return;

    // Create reply button
    const replyButton = this.createReplyButton(post.id);

    // Insert the button as the last action button in the action bar
    actionContainer.appendChild(replyButton);

    post.hasReplyButton = true;
  }

  /**
   * v0.5.8 — Find the action bar (Like/Comment/Repost/Send toolbar) inside a post.
   *
   * REAL DOM findings — re-verified via Chrome MCP on live linkedin.com/feed/
   * after the 2026 SDUI redesign:
   *   - Like button:    aria-label="Reaction button state: <state>"  +  text=COUNT ("40")
   *   - Reactions menu: aria-label="Open reactions menu"             +  text=""
   *   - Comment button: aria-label="Comment"                         +  text=COUNT ("63")
   *   - Repost button:  aria-label="Repost"                          +  text=COUNT ("1")
   *
   * Note the flip from earlier builds: Comment/Repost now DO carry aria-labels,
   * and the buttons' inner text is the engagement count, not the word
   * "Comment"/"Repost". So a textContent==="Comment" match no longer works —
   * we anchor on aria-labels instead.
   *
   * Strategy:
   *   1. Anchor on the Reaction button via its stable a11y label
   *      `aria-label^="Reaction button state"` (LinkedIn ships per-state labels
   *      so screen readers can announce "Like", "Celebrate", etc.)
   *   2. Walk up to the parent containing 3-8 sibling buttons (action bar)
   *   3. Fallback: anchor on the Comment button via aria-label="Comment".
   */
  private findActionContainer(post: HTMLElement): Element | null {
    // Legacy class selectors — cheap to check, harmless if absent
    const staleSelectors = [
      '.feed-shared-social-actions',
      '.social-details-social-activity',
      '[data-test-id="social-actions"]',
      '.feed-shared-social-action-bar',
      '.social-actions-buttons',
    ];
    for (const sel of staleSelectors) {
      const el = post.querySelector(sel);
      if (el) return el;
    }

    const walkUpToActionBar = (start: HTMLElement): Element | null => {
      let parent: HTMLElement | null = start.parentElement;
      let depth = 0;
      while (parent && parent !== post && depth < 8) {
        if (parent.getAttribute('role') === 'toolbar') return parent;
        const buttonCount = parent.querySelectorAll(':scope > * button, :scope > button').length;
        if (buttonCount >= 3 && buttonCount <= 8) return parent;
        parent = parent.parentElement;
        depth++;
      }
      return null;
    };

    // Strategy A: Reaction button (Like) by stable aria-label prefix
    const reactionBtn = post.querySelector(
      'button[aria-label^="Reaction button state" i], button[aria-label="Open reactions menu"]'
    );
    if (reactionBtn) {
      const bar = walkUpToActionBar(reactionBtn as HTMLElement);
      if (bar) return bar;
    }

    // Strategy B: anchor on the Comment button. 2026 SDUI gives it
    // aria-label="Comment" (its text is the count now, not the word).
    const commentBtn = post.querySelector('button[aria-label="Comment" i]');
    if (commentBtn) {
      const bar = walkUpToActionBar(commentBtn as HTMLElement);
      if (bar) return bar;
      return commentBtn.parentElement;
    }

    return null;
  }

  private createReplyButton(postId: string): HTMLElement {
    // Create the action button container following LinkedIn's structure
    const actionButtonContainer = document.createElement('div');
    actionButtonContainer.className =
      'feed-shared-social-action-bar__action-button feed-shared-social-action-bar--new-padding';

    const button = document.createElement('button');
    button.className =
      'linkmate-generate-btn artdeco-button artdeco-button--muted artdeco-button--3 artdeco-button--tertiary social-actions-button flex-wrap';
    button.setAttribute('aria-label', 'Generate AI reply with LinkMate');
    button.setAttribute('type', 'button');
    button.innerHTML = `
      <svg role="none" aria-hidden="true" class="artdeco-button__icon linkmate-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.94-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
      </svg>
      <span class="artdeco-button__text">
        <span class="artdeco-button__text social-action-button__text linkmate-button-text">AI reply</span>
      </span>
    `;

    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleGenerateClick(postId);
    });

    // Add keyboard accessibility
    button.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.handleGenerateClick(postId);
      }
    });

    actionButtonContainer.appendChild(button);
    return actionButtonContainer;
  }

  private handleGenerateClick(postId: string): void {
    const post = this.posts.get(postId);
    if (!post) return;

    // Show loading state
    this.updateButtonState(postId, 'loading');

    // Extract comments for smart analysis
    const comments = this.extractComments(post.element);
    post.comments = comments;

    // Get top performing comments (with likes > 0)
    const topComments = comments
      .filter((c) => c.likeCount > 0)
      .slice(0, 5) // Get top 5 comments
      .map((c) => ({
        text: c.text.substring(0, 200), // Limit text length
        likeCount: c.likeCount,
      }));

    // Check if we should use smart comment analysis
    const useSmartAnalysis = topComments.length >= 2; // Need at least 2 liked comments

    // First check engine status with error handling and auto-initialization
    try {
      chrome.runtime.sendMessage(
        {
          action: 'checkEngineStatus',
        },
        (statusResponse) => {
          if (chrome.runtime.lastError) {
            console.warn('Extension context issue:', chrome.runtime.lastError);
            // Try to re-initialize the connection
            this.notifyBackgroundReady();
            this.showToast('Reconnecting to AI engine...', 'error');
            // Retry after a short delay
            setTimeout(() => this.handleGenerateClick(postId), 2000);
            return;
          }

          if (!statusResponse?.engineReady) {
            // Engine not ready, notify background to initialize
            this.showToast('Initializing AI model. This may take a moment...', 'error');
            this.notifyBackgroundReady();
          } else if (statusResponse?.initializing) {
            this.showToast('AI model is loading. Please wait...', 'error');
          }
        }
      );
    } catch (error) {
      console.error('Error checking engine status:', error);
      this.showToast('Extension error. Please refresh the page.', 'error');
      this.updateButtonState(postId, 'error');
      return;
    }

    // Add timeout for generation request
    const requestTimeout = setTimeout(() => {
      this.showToast('Request timed out. AI model may still be loading.', 'error');
      this.updateButtonState(postId, 'error');
    }, 30000); // 30 second timeout

    if (useSmartAnalysis) {
      // Show user that we're using smart analysis
      this.showToast('Analyzing top-performing comments for better reply...', 'success');

      // Send request with comment analysis
      try {
        chrome.runtime.sendMessage(
          {
            action: 'generateLinkedInReplyWithComments',
            postId: postId,
            postContent: post.textContent,
            topComments: topComments,
          },
          (response) => {
            clearTimeout(requestTimeout);
            if (chrome.runtime.lastError) {
              console.warn('Runtime error:', chrome.runtime.lastError);
              this.showToast('Extension connection lost. Please refresh the page.', 'error');
              this.updateButtonState(postId, 'error');
              return;
            }
            this.handleReplyResponse(postId, response);
          }
        );
      } catch (error) {
        clearTimeout(requestTimeout);
        console.error('Error sending smart analysis request:', error);
        this.showToast('Failed to generate reply. Please try again.', 'error');
        this.updateButtonState(postId, 'error');
      }
    } else {
      // Fall back to regular generation
      try {
        chrome.runtime.sendMessage(
          {
            action: 'generateLinkedInReply',
            postId: postId,
            postContent: post.textContent,
          },
          (response) => {
            clearTimeout(requestTimeout);
            if (chrome.runtime.lastError) {
              console.warn('Runtime error:', chrome.runtime.lastError);
              this.showToast('Extension connection lost. Please refresh the page.', 'error');
              this.updateButtonState(postId, 'error');
              return;
            }
            this.handleReplyResponse(postId, response);
          }
        );
      } catch (error) {
        clearTimeout(requestTimeout);
        console.error('Error sending generation request:', error);
        this.showToast('Failed to generate reply. Please try again.', 'error');
        this.updateButtonState(postId, 'error');
      }
    }
  }

  private handleReplyResponse(
    postId: string,
    response: {
      reply?: string;
      error?: string;
      fallback?: boolean;
      basedOnComments?: boolean;
      commentCount?: number;
      isInitializing?: boolean;
    }
  ): void {
    const post = this.posts.get(postId);
    if (!post) return;

    try {
      if (chrome.runtime.lastError) {
        console.error('Chrome runtime error:', chrome.runtime.lastError);
        this.updateButtonState(postId, 'error');
        this.showToast('Extension connection lost. Please refresh the page.', 'error');
        return;
      }

      if (!response) {
        this.updateButtonState(postId, 'error');
        this.showToast('No response received from AI service', 'error');
        return;
      }

      if (response?.reply) {
        this.showReplyPanel(post, response.reply);
        this.updateButtonState(postId, 'success');

        // Show special message if based on comment analysis
        if (response.basedOnComments) {
          this.showToast(
            `Smart reply generated based on ${response.commentCount} top comments!`,
            'success'
          );
        }

        // Show initialization warning if applicable
        if (response.error && response.isInitializing) {
          this.showToast(
            'AI is still loading. This reply is a suggestion. Try again for AI-powered responses.',
            'error'
          );
        }
      } else if (response?.error) {
        console.error('Reply generation error:', response.error);
        this.updateButtonState(postId, 'error');

        // Provide user-friendly error messages
        let errorMessage = response.error;
        if (response.error.includes('timeout')) {
          errorMessage = 'AI model is still loading. Please wait and try again.';
        } else if (response.error.includes('Engine initialization')) {
          errorMessage = 'AI model failed to load. Please reload the extension.';
        } else if (response.error.includes('Extension context')) {
          errorMessage = 'Extension needs to be reloaded. Please refresh the page.';
        }

        this.showToast(errorMessage, 'error');
      } else {
        this.updateButtonState(postId, 'error');
        this.showToast('Unexpected response format', 'error');
      }
    } catch (error) {
      console.error('Error handling reply response:', error);
      this.updateButtonState(postId, 'error');
      this.showToast('Failed to process response. Please try again.', 'error');
    }
  }

  private updateButtonState(
    postId: string,
    state: 'loading' | 'success' | 'error' | 'default'
  ): void {
    const post = this.posts.get(postId);
    if (!post) return;

    const button = post.element.querySelector('.linkmate-generate-btn');
    if (!button) return;

    // Reset classes
    button.classList.remove('loading', 'success', 'error');

    switch (state) {
      case 'loading':
        button.classList.add('loading');
        (button as HTMLButtonElement).disabled = true;
        button.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="linkmate-icon spinning">
            <path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z"/>
          </svg>
          <span>Generating...</span>
        `;
        break;
      case 'success':
        button.classList.add('success');
        (button as HTMLButtonElement).disabled = false;
        setTimeout(() => this.updateButtonState(postId, 'default'), 2000);
        break;
      case 'error':
        button.classList.add('error');
        (button as HTMLButtonElement).disabled = false;
        button.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="linkmate-icon">
            <path d="M12,2C17.53,2 22,6.47 22,12C22,17.53 17.53,22 12,22C6.47,22 2,17.53 2,12C2,6.47 6.47,2 12,2m3.59,5L12,10.59 8.41,7 7,8.41l3.59,3.59L7,15.59 8.41,17 12,13.41l3.59,3.59L17,15.59l-3.59-3.59L17,8.41 15.59,7z"/>
          </svg>
          <span>Retry</span>
        `;
        setTimeout(() => this.updateButtonState(postId, 'default'), 3000);
        break;
      default:
        (button as HTMLButtonElement).disabled = false;
        button.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="linkmate-icon">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
          </svg>
          <span>Reply</span>
        `;
    }
  }

  private showReplyPanel(post: LinkedInPost, generatedReply: string): void {
    // Remove existing panel if any
    const existingPanel = post.element.querySelector('.linkmate-panel');
    existingPanel?.remove();

    // Check if reply was based on comment analysis
    const hasCommentAnalysis =
      post.comments && post.comments.filter((c) => c.likeCount > 0).length > 0;
    const commentCount = post.comments ? post.comments.filter((c) => c.likeCount > 0).length : 0;

    // Create new panel
    const panel = document.createElement('div');
    panel.className = 'linkmate-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Generated reply panel');
    panel.innerHTML = `
      <div class="linkmate-panel-content">
        ${
          hasCommentAnalysis
            ? `
          <div class="linkmate-smart-indicator">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M9 11H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2zm2-7h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z"/>
            </svg>
            Smart reply based on ${commentCount} top comments
          </div>
        `
            : ''
        }
        <div class="linkmate-reply-text" role="textbox" aria-readonly="true" tabindex="0">${this.escapeHtml(generatedReply)}</div>
        <div class="linkmate-panel-actions">
          <button class="linkmate-btn linkmate-regenerate" data-action="regenerate" aria-label="Regenerate reply">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
            </svg>
            Regenerate
          </button>
          <button class="linkmate-btn linkmate-copy" data-action="copy" aria-label="Copy reply to clipboard">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
            </svg>
            Copy
          </button>
          <button class="linkmate-btn linkmate-insert" data-action="insert" aria-label="Insert reply into comment box">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
            </svg>
            Insert
          </button>
          <button class="linkmate-btn linkmate-close" data-action="close" aria-label="Close reply panel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/>
            </svg>
            Close
          </button>
        </div>
      </div>
    `;

    // Add event listeners for panel actions
    panel.querySelectorAll('.linkmate-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const action = (e.currentTarget as HTMLElement).dataset.action;
        this.handlePanelAction(action!, post, generatedReply, panel);
      });
    });

    // Insert panel after the post content
    const insertLocation =
      post.element.querySelector('.feed-shared-update-v2__content') ||
      post.element.querySelector('.update-components-text') ||
      post.element;

    if (insertLocation.parentElement) {
      insertLocation.parentElement.insertBefore(panel, insertLocation.nextSibling);
    } else {
      post.element.appendChild(panel);
    }

    // Animate panel appearance
    requestAnimationFrame(() => {
      panel.classList.add('linkmate-panel-show');
    });
  }

  private handlePanelAction(
    action: string,
    post: LinkedInPost,
    reply: string,
    panel: HTMLElement
  ): void {
    switch (action) {
      case 'regenerate':
        this.handleGenerateClick(post.id);
        break;
      case 'copy':
        this.copyToClipboard(reply);
        this.logReplyAction(post.id, reply);
        break;
      case 'insert':
        this.insertIntoCommentBox(post, reply);
        this.logReplyAction(post.id, reply);
        break;
      case 'close':
        this.closeReplyPanel(panel);
        break;
    }
  }

  /** Action log: record that the user committed to a generated reply on a post. */
  private logReplyAction(postId: string, draftText: string): void {
    const post = this.posts.get(postId);
    chrome.runtime.sendMessage(
      {
        action: 'action.log.append',
        input: {
          type: 'comment',
          postId,
          draftText,
          submitted: true,
          sourceText: post?.textContent ?? draftText,
        },
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('[linkmate] action.log.append failed', chrome.runtime.lastError.message);
        }
      }
    );
  }

  private closeReplyPanel(panel: HTMLElement): void {
    panel.classList.remove('linkmate-panel-show');
    panel.classList.add('linkmate-panel-hiding');

    setTimeout(() => {
      panel.remove();
    }, 300);
  }

  private copyToClipboard(text: string): void {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        this.showToast('Reply copied to clipboard!', 'success');
      })
      .catch((err) => {
        console.error('Failed to copy:', err);
        this.showToast('Failed to copy reply', 'error');
      });
  }

  /**
   * Find the Comment action button. In 2026 LinkedIn this button has NO
   * aria-label — only inner text "Comment" (same finding as findActionContainer).
   * The old `aria-label*="Comment"` selector matched nothing here, which is why
   * Insert reported "Could not find comment button". Fall back to legacy
   * aria-label forms, but exclude per-comment kebab menus ("View more options…").
   */
  private findCommentButton(post: HTMLElement): HTMLButtonElement | null {
    const buttons = Array.from(post.querySelectorAll('button'));
    const byText = buttons.find((b) => (b.textContent ?? '').trim() === 'Comment');
    if (byText) return byText as HTMLButtonElement;
    const byAria = buttons.find((b) => {
      const label = (b.getAttribute('aria-label') ?? '').toLowerCase();
      return label.includes('comment') && !/(more|options|view|delete|edit|report)/.test(label);
    });
    return (byAria as HTMLButtonElement) ?? null;
  }

  private findCommentBox(post: HTMLElement): HTMLElement | null {
    const commentSelectors = [
      '.ql-editor[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      '.comments-comment-box__form [contenteditable="true"]',
      '.mentions-texteditor__contenteditable',
      'textarea[placeholder*="omment" i]',
    ];
    for (const selector of commentSelectors) {
      const el = post.querySelector(selector) as HTMLElement | null;
      if (el) return el;
    }
    return null;
  }

  private fillCommentBox(box: HTMLElement, reply: string): void {
    if (box.tagName === 'TEXTAREA') {
      (box as HTMLTextAreaElement).value = reply;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      box.focus();
      box.textContent = reply;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('blur', { bubbles: true }));
    }
    box.focus();
    this.showToast('Reply inserted! You can edit before posting.', 'success');
  }

  private insertIntoCommentBox(post: LinkedInPost, reply: string): void {
    // If the comment box is already open, fill it directly — re-clicking the
    // Comment button would toggle it closed.
    const existing = this.findCommentBox(post.element);
    if (existing) {
      this.fillCommentBox(existing, reply);
      return;
    }

    const commentButton = this.findCommentButton(post.element);
    if (!commentButton) {
      this.showToast('Could not find comment button', 'error');
      return;
    }
    commentButton.click();

    // LinkedIn mounts the editor asynchronously — poll for it instead of a
    // single fixed timeout that raced on slower loads.
    let tries = 0;
    const maxTries = 20; // ~3s at 150ms
    const poll = window.setInterval(() => {
      const box = this.findCommentBox(post.element);
      if (box) {
        window.clearInterval(poll);
        this.fillCommentBox(box, reply);
      } else if (++tries >= maxTries) {
        window.clearInterval(poll);
        this.showToast('Could not find comment box. Try clicking comment first.', 'error');
      }
    }, 150);
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
    }, 4000);
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic constraint idiom
  private debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number
  ): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout;
    return (...args: Parameters<T>) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  }

  private handleGenerateReply(postId: string, _postContent: string): void {
    // This will be called from background script for additional processing
    const post = this.posts.get(postId);
    if (post) {
      this.updateButtonState(postId, 'loading');
    }
  }

  // Public method to clean up when page unloads
  public destroy(): void {
    if (this.observer) {
      this.observer.disconnect();
    }
    this.posts.clear();
  }
}

// Initialize when on LinkedIn
if (window.location.hostname.includes('linkedin.com')) {
  const linkedInLinkMate = new LinkedInLinkMate();

  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    linkedInLinkMate.destroy();
  });

  // Issue #16: side panel can't open without user gesture. On any LinkedIn
  // profile page (/in/<handle>/), the first click/scroll/keydown forwards a
  // message to background, which opens the side panel on behalf of the user.
  // Gated behind onboardingCompleted so we don't auto-open before consent.
  void (async () => {
    const PROFILE_RE = /^\/in\/[^/?#]+\/?$/;
    if (!PROFILE_RE.test(window.location.pathname)) return;
    const ONBOARDED_KEY = 'linkmate.settings.onboardingCompleted.v1';
    const stored = await chrome.storage.local.get(ONBOARDED_KEY);
    if (!stored[ONBOARDED_KEY]) return;
    let fired = false;
    const open = () => {
      if (fired) return;
      fired = true;
      try {
        chrome.runtime.sendMessage({ action: 'sidepanel.openFromGesture' });
      } catch {
        /* extension reload race; ignore */
      }
      window.removeEventListener('click', open, true);
      window.removeEventListener('keydown', open, true);
      window.removeEventListener('scroll', open, true);
    };
    window.addEventListener('click', open, { capture: true });
    window.addEventListener('keydown', open, { capture: true });
    // Passive so we don't block the compositor on every scroll event before
    // the first gesture fires.
    window.addEventListener('scroll', open, { capture: true, passive: true });
  })();
}

// Debug function to test if custom prompts are being used
function testCustomPrompts() {
  console.log('🧪 Testing custom prompts integration...');

  // Create a test post content
  const testPostContent = 'This is a test post to verify custom prompts are working correctly.';

  chrome.runtime.sendMessage(
    {
      action: 'generateLinkedInReply',
      postContent: testPostContent,
    },
    (response) => {
      console.log('📬 Test response received:', response);
      if (response?.reply) {
        console.log('✅ Reply generated:', response.reply);
        alert(
          `Test successful! Generated reply:\n\n${response.reply}\n\nCheck the console for details about which prompt was used.`
        );
      } else {
        console.error('❌ Test failed:', response);
        alert('Test failed! Check console for details.');
      }
    }
  );
}

// Function to verify prompts are stored correctly
function verifyStoredPrompts() {
  console.log('🔍 Verifying stored prompts...');

  chrome.runtime.sendMessage({ action: 'verifyPrompts' }, (response) => {
    console.log('📊 Verification Response:', response);

    if (response?.hasCustomPrompts) {
      console.log('✅ Custom prompts ARE stored');
      console.log('🎯 Using custom standard:', response.isUsingCustomStandard);
      console.log('🎯 Using custom comments:', response.isUsingCustomComments);
      alert(
        `Verification Results:\n✅ Custom prompts found!\n🎯 Standard: ${response.isUsingCustomStandard ? 'CUSTOM' : 'DEFAULT'}\n🎯 Comments: ${response.isUsingCustomComments ? 'CUSTOM' : 'DEFAULT'}`
      );
    } else {
      console.warn('⚠️ No custom prompts found - using defaults');
      alert(
        '⚠️ No custom prompts found.\nGo to LinkMate settings and save some custom prompts first!'
      );
    }
  });
}

// Make the test functions available globally for debugging
/* eslint-disable @typescript-eslint/no-explicit-any -- intentional global for DevTools */
(window as any).testLinkMatePrompts = testCustomPrompts;
(window as any).verifyLinkMatePrompts = verifyStoredPrompts;
/* eslint-enable @typescript-eslint/no-explicit-any */

console.log('💡 LinkMate Debug Functions Available:');
console.log('   - window.testLinkMatePrompts() - Test prompt generation');
console.log('   - window.verifyLinkMatePrompts() - Verify stored prompts');
