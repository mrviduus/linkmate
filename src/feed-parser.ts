/**
 * v0.5.9 — LinkedIn feed DOM parser (Chrome-MCP-verified rewrite).
 *
 * Pure function. Extracts ParsedPost[] from a /feed/ DOM.
 *
 * REAL DOM findings — verified via Chrome MCP browser-control on live
 * linkedin.com/feed/ on 2026-05-15:
 *
 *   - Posts are `<div componentkey="<base64-id>">` — NO data-urn, NO
 *     <article> tag, hash class names. The componentkey value is opaque
 *     (~30 chars, base64-ish) and unique per post.
 *   - Each post that's actually a post (vs a placeholder) contains a
 *     Reaction button (`button[aria-label^="Reaction button state"]`)
 *     and 3+ sibling buttons in the action bar.
 *   - Author link is `<a href="/in/<handle>/">` for personal posts OR
 *     `<a href="/company/<handle>/">` for company posts. The link's
 *     own textContent is often EMPTY (name rendered separately).
 *   - Post text is a `<p>` with substantial content (>=80 chars
 *     typically). Time / subtitle / counts are short `<p>` or `<span>`.
 *   - Engagement counts surface as text patterns:
 *       "117 reactions"  "6 comments"  "17 reposts"
 *     (each typically appears twice — once visible, once for a11y).
 *   - Time: short text like "5h •" / "2d •" — first regex match in post.
 *   - Follower tier: "300,747 followers" text near author.
 *   - Degree (1st/2nd/3rd): not always present; degraded gracefully.
 *
 * Caller (engagement-queue) only strictly needs id + text + authorUrn +
 * postedAt. Other fields (followerTier, degree, counts) degrade to
 * 'unknown' / 0 when not parseable; scorer handles missing data.
 */

import type { ConnectionDegree, FollowerTier, ParsedPost } from './storage-schema';

interface ParseOptions {
  /** Defaults to Date.now(). Override for deterministic tests. */
  now?: number;
}

/** Map "X followers" text → tier bucket. Stripping commas before parseInt. */
export function parseFollowerTier(text: string): FollowerTier {
  if (!text) return 'unknown';
  const match = text.match(/([\d,]+)\s+followers?/i);
  if (!match) return 'unknown';
  const n = parseInt(match[1].replace(/,/g, ''), 10);
  if (Number.isNaN(n)) return 'unknown';
  if (n < 1000) return 'lt_1k';
  if (n < 10_000) return '1k_10k';
  if (n < 100_000) return '10k_100k';
  return 'gt_100k';
}

/** Convert "30m" / "2h" / "1d" / "2w" → absolute ms timestamp from `now`. */
export function parseAgoToTimestamp(ago: string, now: number): number {
  if (!ago) return now;
  const m = ago.trim().match(/^(\d+)\s*([smhdw])\b/i);
  if (!m) return now;
  const value = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return now - value * (multipliers[unit] ?? 0);
}

export function parseDegree(text: string): ConnectionDegree {
  const t = (text || '').trim();
  if (/\b1st\b/i.test(t)) return '1st';
  if (/\b2nd\b/i.test(t)) return '2nd';
  if (/\b3rd\b/i.test(t)) return '3rd';
  if (/following/i.test(t)) return 'follow-only';
  return 'unknown';
}

function readText(el: Element | null): string {
  if (!el) return '';
  return (el.textContent ?? '').trim().replace(/\s+/g, ' ');
}

function parseCount(text: string): number {
  if (!text) return 0;
  const m = text.match(/[\d,]+/);
  if (!m) return 0;
  const n = parseInt(m[0].replace(/,/g, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Extract "/in/{handle}/" or "/company/{handle}/" → URN string. */
function authorUrnFromHref(href: string): string {
  const inMatch = href.match(/\/in\/([^/?#]+)/);
  if (inMatch) return `urn:li:profile:${inMatch[1]}`;
  const companyMatch = href.match(/\/company\/([^/?#]+)/);
  if (companyMatch) return `urn:li:company:${companyMatch[1]}`;
  return '';
}

/**
 * v0.5.9 main entry. Finds posts via componentkey (the 2026 SDUI marker)
 * AND falls back to legacy data-urn for older page caches.
 */
export function parseFeedDom(
  doc: Document | DocumentFragment,
  options: ParseOptions = {}
): ParsedPost[] {
  const now = options.now ?? Date.now();
  const out: ParsedPost[] = [];
  const seen = new Set<Element>();

  // Strategy A (legacy / older caches): direct data-urn / class selectors
  const legacy = doc.querySelectorAll(
    '[data-urn^="urn:li:activity"], .feed-shared-update-v2[data-urn]'
  );
  for (const el of Array.from(legacy)) {
    if (seen.has(el)) continue;
    seen.add(el);
    const post = parseLegacyPost(el, now);
    if (post) out.push(post);
  }

  // Strategy B (2026 SDUI): find posts via Reaction button → walk up to
  // the containing <div componentkey="..."> post.
  const reactionButtons = doc.querySelectorAll('button[aria-label^="Reaction button state" i]');
  for (const rxBtn of Array.from(reactionButtons)) {
    let cur: HTMLElement | null = rxBtn as HTMLElement;
    let postEl: Element | null = null;
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
    const post = parseSduiPost(postEl, now);
    if (post) out.push(post);
  }

  return out;
}

// ─── Strategy A — legacy data-urn posts ─────────────────────────────────────

function parseLegacyPost(el: Element, now: number): ParsedPost | null {
  const dataUrn = el.getAttribute('data-urn') ?? '';
  if (!dataUrn) return null;

  const authorLink = el.querySelector('.update-components-actor__meta-link');
  const authorHref = authorLink?.getAttribute('href') ?? '';
  const authorUrn = authorUrnFromHref(authorHref);

  const authorName = readText(el.querySelector('.update-components-actor__title'));
  const authorTitle = readText(el.querySelector('.update-components-actor__description'));
  const subDescription = readText(el.querySelector('.update-components-actor__sub-description'));
  const followerTier = parseFollowerTier(subDescription);
  const agoMatch = subDescription.match(/(\d+\s*[smhdw])/i);
  const postedAt = parseAgoToTimestamp(agoMatch?.[1] ?? '', now);
  const degreeText = readText(
    el.querySelector('.update-components-actor__supplementary-actor-info')
  );
  const degree = parseDegree(degreeText);
  const isOwn = degreeText.trim().toLowerCase() === 'you';

  const textEl =
    el.querySelector('.feed-shared-text') ??
    el.querySelector('.feed-shared-update-v2__description') ??
    el.querySelector('.update-components-text');
  const text = readText(textEl);

  const likeCount = parseCount(readText(el.querySelector('.social-counts-reactions__count')));
  const commentCount = parseCount(
    readText(el.querySelector('.social-details-social-counts__comments'))
  );

  return {
    id: dataUrn,
    authorUrn,
    authorName,
    authorTitle,
    followerTier,
    degree,
    text,
    postedAt,
    likeCount,
    commentCount,
    isOwn,
  };
}

// ─── Strategy B — 2026 SDUI posts ───────────────────────────────────────────

function parseSduiPost(el: Element, now: number): ParsedPost | null {
  // ID: use componentkey value — opaque base64-like, unique per post
  const componentkey = el.getAttribute('componentkey') ?? '';
  if (!componentkey) return null;
  const id = `urn:li:component:${componentkey}`;

  // Author: iterate /in/ and /company/ links — many /in/ links are mention
  // tags inside the post body with empty parent spans. Pick the FIRST link
  // whose parent yields a real name-like span.
  const candidateLinks = Array.from(el.querySelectorAll('a[href*="/in/"], a[href*="/company/"]'));
  let profileLink: Element | null = null;
  let authorName = '';
  for (const link of candidateLinks) {
    const parent = link.parentElement ?? link;
    const spans = Array.from(parent.querySelectorAll('span'));
    for (const span of spans) {
      const t = readText(span);
      if (t.length >= 2 && t.length <= 80 && !/^\d/.test(t) && !/^·/.test(t)) {
        profileLink = link;
        authorName = t;
        break;
      }
    }
    if (profileLink) break;
  }
  // Last-resort: first /in/ or /company/ link even without name (degrade
  // gracefully so authorUrn still resolves).
  if (!profileLink && candidateLinks.length > 0) {
    profileLink = candidateLinks[0];
    authorName = readText(profileLink);
  }
  const authorHref = profileLink?.getAttribute('href') ?? '';
  const authorUrn = authorUrnFromHref(authorHref);

  // Time: short text matching N[smhdw]
  let postedAt = now;
  const allTexts = Array.from(el.querySelectorAll('span, p, time'));
  for (const t of allTexts) {
    const txt = readText(t);
    if (/^\d+\s*[smhdw]\b/i.test(txt)) {
      const m = txt.match(/(\d+\s*[smhdw])/i);
      if (m) {
        postedAt = parseAgoToTimestamp(m[1], now);
        break;
      }
    }
  }

  // Follower tier from "X followers" text anywhere in post
  let followerTier: FollowerTier = 'unknown';
  for (const span of allTexts) {
    const txt = readText(span);
    if (/\b\d[\d,]*\s+followers?/i.test(txt)) {
      followerTier = parseFollowerTier(txt);
      break;
    }
  }

  // Degree from "· 1st" / "· 2nd" / "· 3rd" patterns
  let degree: ConnectionDegree = 'unknown';
  for (const span of allTexts) {
    const txt = readText(span);
    if (/\b(1st|2nd|3rd)\b/i.test(txt) && txt.length < 60) {
      degree = parseDegree(txt);
      break;
    }
  }

  // Post text: longest <p> in the post that's not the time/counts pattern
  let text = '';
  const paragraphs = el.querySelectorAll('p');
  for (const p of Array.from(paragraphs)) {
    const t = readText(p);
    if (t.length < 30) continue;
    if (/^\d+\s*[smhdw]\b/i.test(t)) continue; // time
    if (/^\d[\d,]*\s+(reactions?|comments?|reposts?)/i.test(t)) continue; // counts
    if (t.length > text.length) text = t;
  }

  // Engagement counts — scan for text patterns
  let likeCount = 0;
  let commentCount = 0;
  for (const span of allTexts) {
    const txt = readText(span);
    if (likeCount === 0) {
      const m = txt.match(/(\d[\d,]*)\s+reactions?/i);
      if (m) likeCount = parseCount(m[1]);
    }
    if (commentCount === 0) {
      const m = txt.match(/(\d[\d,]*)\s+comments?/i);
      if (m) commentCount = parseCount(m[1]);
    }
    if (likeCount && commentCount) break;
  }

  const isOwn = degree === 'unknown' && /\byou\b/i.test(readText(el).slice(0, 200));

  return {
    id,
    authorUrn,
    authorName,
    authorTitle: '',
    followerTier,
    degree,
    text,
    postedAt,
    likeCount,
    commentCount,
    isOwn,
  };
}
