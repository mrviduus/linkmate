/**
 * Feed assistant — injects a "Draft comment" button into each post's action
 * bar. On click, extracts post text, asks background for 3 drafts via OpenAI,
 * renders a popover, and (on selection) fills LinkedIn's comment editor.
 *
 * Semi-auto: never auto-submits. User reviews and clicks Post manually.
 */

import { bumpProgress } from '../lib/storage';
import type { Msg } from '../lib/types';

const BTN_MARKER = 'data-linkmate-btn';
const POST_SELECTOR = 'div.feed-shared-update-v2, div[data-urn^="urn:li:activity:"]';

function extractAuthor(post: HTMLElement): string {
  // Author name often lives in a span with class containing "actor" or aria-label
  const cand =
    post.querySelector<HTMLElement>('.update-components-actor__title span[dir="ltr"]') ||
    post.querySelector<HTMLElement>('.update-components-actor__name') ||
    post.querySelector<HTMLElement>('[data-test-id="post-author-name"]') ||
    post.querySelector<HTMLElement>('a[href*="/in/"] span[dir="ltr"]');
  return cand?.innerText?.trim().split('\n')[0] ?? '';
}

function extractBody(post: HTMLElement): string {
  const cand =
    post.querySelector<HTMLElement>('.feed-shared-update-v2__description .break-words') ||
    post.querySelector<HTMLElement>('.update-components-text') ||
    post.querySelector<HTMLElement>('[data-test-id="post-text"]') ||
    post.querySelector<HTMLElement>('.feed-shared-inline-show-more-text');
  return cand?.innerText?.trim() ?? '';
}

function findCommentEditor(post: HTMLElement): HTMLElement | null {
  // LinkedIn renders the comment composer as a contenteditable Quill div.
  return (
    post.querySelector<HTMLElement>('div.ql-editor[contenteditable="true"]') ||
    post.querySelector<HTMLElement>('div[contenteditable="true"][role="textbox"]') ||
    null
  );
}

function findCommentButton(post: HTMLElement): HTMLElement | null {
  // The post's own "Comment" action button — text or aria-label match.
  const buttons = Array.from(post.querySelectorAll<HTMLElement>('button'));
  return (
    buttons.find((b) => /^comment$/i.test(b.innerText?.trim() ?? '')) ||
    buttons.find((b) => /comment/i.test(b.getAttribute('aria-label') ?? '')) ||
    null
  );
}

async function fillEditor(editor: HTMLElement, text: string) {
  editor.focus();
  // Quill listens for input events; setting innerText alone won't trigger save.
  editor.innerHTML = `<p>${escapeHtml(text)}</p>`;
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  // Place caret at end
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

function makeButton(post: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.setAttribute(BTN_MARKER, '1');
  btn.type = 'button';
  btn.textContent = '✨ Draft';
  btn.title = 'LinkMate: draft a comment with AI';
  Object.assign(btn.style, {
    marginLeft: '8px',
    padding: '4px 10px',
    fontSize: '12px',
    fontWeight: '600',
    color: '#0a66c2',
    background: 'rgba(10,102,194,0.08)',
    border: '1px solid rgba(10,102,194,0.25)',
    borderRadius: '16px',
    cursor: 'pointer',
    lineHeight: '1.4',
  } as CSSStyleDeclaration);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void onDraftClick(post, btn);
  });
  return btn;
}

async function onDraftClick(post: HTMLElement, anchor: HTMLElement) {
  const author = extractAuthor(post);
  const body = extractBody(post);
  if (!body) {
    showPopover(anchor, [], 'Could not read post text.');
    return;
  }

  showPopover(anchor, [], 'Drafting…');

  const msg: Msg = { type: 'DRAFT_COMMENTS', postAuthor: author, postBody: body };
  chrome.runtime.sendMessage(msg, (resp: { drafts: string[]; error?: string }) => {
    if (chrome.runtime.lastError) {
      showPopover(anchor, [], chrome.runtime.lastError.message ?? 'Extension error');
      return;
    }
    if (resp.error || !resp.drafts?.length) {
      showPopover(anchor, [], resp.error ?? 'No drafts');
      return;
    }
    showPopover(anchor, resp.drafts, null, async (text) => {
      // Open comment composer if not already open
      const editor =
        findCommentEditor(post) ??
        (await openCommentComposer(post));
      if (editor) {
        await fillEditor(editor, text);
      } else {
        await copyToClipboard(text);
      }
      void bumpProgress('comments');
      closePopover();
    });
  });
}

async function openCommentComposer(post: HTMLElement): Promise<HTMLElement | null> {
  const cmt = findCommentButton(post);
  if (!cmt) return null;
  cmt.click();
  // Wait briefly for the composer to render
  for (let i = 0; i < 20; i++) {
    const ed = findCommentEditor(post);
    if (ed) return ed;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

let popoverEl: HTMLDivElement | null = null;

function closePopover() {
  popoverEl?.remove();
  popoverEl = null;
}

function showPopover(
  anchor: HTMLElement,
  drafts: string[],
  status: string | null,
  onPick?: (text: string) => void,
) {
  closePopover();
  const pop = document.createElement('div');
  popoverEl = pop;
  Object.assign(pop.style, {
    position: 'absolute',
    zIndex: '999999',
    width: '320px',
    background: 'white',
    boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
    border: '1px solid #e5e7eb',
    borderRadius: '10px',
    padding: '10px',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '13px',
    color: '#0b1419',
  } as CSSStyleDeclaration);

  const rect = anchor.getBoundingClientRect();
  pop.style.top = `${window.scrollY + rect.bottom + 6}px`;
  pop.style.left = `${window.scrollX + rect.left}px`;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;';
  const title = document.createElement('span');
  title.textContent = 'LinkMate drafts';
  title.style.cssText = 'font-weight:600;font-size:12px;color:#5e6d77;';
  const close = document.createElement('button');
  close.textContent = '✕';
  close.style.cssText = 'border:none;background:transparent;cursor:pointer;color:#5e6d77;font-size:14px;';
  close.addEventListener('click', closePopover);
  header.append(title, close);
  pop.append(header);

  if (status) {
    const s = document.createElement('div');
    s.textContent = status;
    s.style.cssText = 'padding:8px 4px;color:#5e6d77;';
    pop.append(s);
  }

  drafts.forEach((d) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.textContent = d;
    Object.assign(row.style, {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      padding: '8px 10px',
      margin: '4px 0',
      border: '1px solid #e5e7eb',
      borderRadius: '8px',
      background: 'white',
      cursor: 'pointer',
      fontSize: '13px',
      lineHeight: '1.4',
      whiteSpace: 'normal',
    } as CSSStyleDeclaration);
    row.addEventListener('mouseenter', () => (row.style.background = '#f3f6f8'));
    row.addEventListener('mouseleave', () => (row.style.background = 'white'));
    row.addEventListener('click', () => onPick?.(d));
    pop.append(row);
  });

  document.body.append(pop);

  // Dismiss on outside click
  setTimeout(() => {
    const dismiss = (e: MouseEvent) => {
      if (popoverEl && !popoverEl.contains(e.target as Node)) {
        closePopover();
        document.removeEventListener('mousedown', dismiss, true);
      }
    };
    document.addEventListener('mousedown', dismiss, true);
  }, 0);
}

function injectIntoPost(post: HTMLElement) {
  if (post.querySelector(`[${BTN_MARKER}]`)) return;
  const cmt = findCommentButton(post);
  if (!cmt) return;
  const bar = cmt.parentElement;
  if (!bar) return;
  bar.appendChild(makeButton(post));
}

function scan() {
  document.querySelectorAll<HTMLElement>(POST_SELECTOR).forEach(injectIntoPost);
}

const observer = new MutationObserver(() => scan());
observer.observe(document.body, { childList: true, subtree: true });
scan();
