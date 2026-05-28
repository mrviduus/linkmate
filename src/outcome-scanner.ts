/**
 * Lazy outcome scanner — when linkedin-content.ts spots a post the user
 * previously commented on AND its comments thread is already expanded on
 * screen, try to find the user's own comment and read its engagement
 * metrics (likes + replies). On success, send `action.log.attachOutcome`
 * with source='auto'.
 *
 * Best-effort. LinkedIn DOM is obfuscated and changes frequently — if any
 * selector misses we silently skip and the manual "Did this work?" chip
 * still covers it.
 *
 * No background-tab spawning. No periodic re-scrape. Only fires when the
 * post is already painted on the user's screen.
 */

const SESSION_SCANNED = new Set<string>();
let cachedFullName: string | null | undefined; // undefined = not yet loaded

async function getProfileName(): Promise<string | null> {
  if (cachedFullName !== undefined) return cachedFullName;
  const { ['linkmate.profile.v1']: p } = await chrome.storage.local.get('linkmate.profile.v1');
  cachedFullName = (p as { fullName?: string } | undefined)?.fullName?.trim() || null;
  return cachedFullName;
}

interface PendingActionDTO {
  id: number;
  type: string;
  postId?: string;
  submitted: boolean;
}

interface ActionByPostResp {
  ok: boolean;
  rows?: PendingActionDTO[];
}

function firstInt(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Read like + reply counts off a single comment row. Best-effort selectors. */
function readCommentMetrics(commentRow: HTMLElement): { likes?: number; replies?: number } {
  const likes =
    firstInt(commentRow.querySelector<HTMLElement>('[aria-label*="reaction" i]')?.innerText) ??
    firstInt(
      commentRow.querySelector<HTMLElement>('.comments-comment-social-bar__reactions-count')
        ?.innerText
    ) ??
    undefined;
  const replies =
    firstInt(commentRow.querySelector<HTMLElement>('[aria-label*="repl" i]')?.innerText) ??
    firstInt(
      commentRow.querySelector<HTMLElement>('.comments-comment-social-bar__replies-count')
        ?.innerText
    ) ??
    undefined;
  return { likes: likes ?? undefined, replies: replies ?? undefined };
}

/** Find a comment in this post whose author display name matches `fullName`. */
function findOwnComment(post: HTMLElement, fullName: string): HTMLElement | null {
  const needle = fullName.toLowerCase();
  // Comment rows: try several known wrappers; fall back to any <article>-like region
  const rows = post.querySelectorAll<HTMLElement>(
    'article.comments-comment-entity, article.comments-comment-item, article[data-id*="urn:li:comment"], div.comments-comment-item'
  );
  for (const row of Array.from(rows)) {
    // Author name often in span.comments-post-meta__name-text or [aria-label*="View profile"]
    const author =
      row.querySelector<HTMLElement>('.comments-post-meta__name-text')?.innerText?.trim() ||
      row.querySelector<HTMLElement>('a[href*="/in/"] span[dir="ltr"]')?.innerText?.trim() ||
      row.querySelector<HTMLElement>('span.comments-post-meta__name')?.innerText?.trim() ||
      '';
    if (author && author.toLowerCase().includes(needle)) return row;
  }
  return null;
}

/**
 * Scan a post element for outcome attach opportunity.
 * Idempotent per session via SESSION_SCANNED.
 */
export async function scanPostForOutcome(post: HTMLElement, postId: string): Promise<void> {
  if (SESSION_SCANNED.has(postId)) return;

  const fullName = await getProfileName();
  if (!fullName) return; // can't identify user → bail

  // Check whether we have a pending action on this post
  const resp = await new Promise<ActionByPostResp>((resolve) => {
    chrome.runtime.sendMessage({ action: 'action.log.byPostId', postId }, (r) =>
      resolve(r ?? { ok: false })
    );
  });
  const rows = resp.rows ?? [];
  if (rows.length === 0) {
    SESSION_SCANNED.add(postId); // no action ever → don't recheck this session
    return;
  }
  // Among them, find ones lacking an outcome — easiest: query pending list
  const pending = await new Promise<{ ok: boolean; rows?: PendingActionDTO[] }>((resolve) => {
    chrome.runtime.sendMessage({ action: 'action.log.pending' }, (r) =>
      resolve(r ?? { ok: false })
    );
  });
  const pendingForPost = (pending.rows ?? []).find((a) => a.postId === postId);
  if (!pendingForPost) {
    SESSION_SCANNED.add(postId);
    return;
  }

  const commentEl = findOwnComment(post, fullName);
  if (!commentEl) return; // comments may not be expanded yet — try again next scan
  const metrics = readCommentMetrics(commentEl);
  if (metrics.likes === undefined && metrics.replies === undefined) return;

  await new Promise<void>((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: 'action.log.attachOutcome',
        input: {
          actionId: pendingForPost.id,
          source: 'auto',
          likes: metrics.likes,
          replies: metrics.replies,
        },
      },
      () => resolve()
    );
  });
  SESSION_SCANNED.add(postId);
  console.info('[linkmate] auto outcome attached', postId, metrics);
}

/** Test/reset hook. */
export function _resetScanner(): void {
  SESSION_SCANNED.clear();
  cachedFullName = undefined;
}
