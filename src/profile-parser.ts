/**
 * v0.5.6 — LinkedIn profile DOM parser (real-DOM rewrite).
 *
 * Pure function. No imports of runtime values (only types).
 * Self-contained so it can be passed to chrome.scripting.executeScript({ func })
 * and serialized cleanly into the active tab context.
 *
 * Why this was rewritten (Bug Report 2026-05-15, second pass):
 * ----------------------------------------------------------------
 * The user pasted the actual /in/{handle}/ HTML. Key finding: LinkedIn migrated
 * to React Server-Driven UI in 2026. ALL CSS class names are auto-generated
 * hashes (e.g. `_75907f35`, `da7899c1`). Selectors like `.text-heading-xlarge`
 * and `#skills` do not exist anywhere. The DOM is otherwise standard:
 *   - `<h1>` for name (inside <main>, sticky-header h1 lives outside <main>)
 *   - `<p>` for headline ("AI Engineer | RAG · Agents · ...")
 *   - `<p>` for location ("Waterloo, Ontario, Canada")
 *   - `<p>` per company / school ("Pinnacle", "Kremenchuk State...")
 *   - `aria-label="${fullName}"` attribute on the topcard container — strong anchor
 *   - About / Skills / Activity sections live in initially-empty
 *     `<div componentkey="profileCardsAboveActivity..." or "...BelowActivityPart1..7">`
 *     placeholders, populated via async XHR after the user scrolls them in
 *     (handled by scrolling in profile-context.ts before this parser runs).
 *
 * Strategy:
 *   - Limit search to <main> (excludes sticky-header h1)
 *   - Name: `main h1` first match
 *   - Headline: longest <p> in the aria-label="${name}" container, OR first <p>
 *     elsewhere matching `| ... · ...` pattern (LinkedIn convention)
 *   - About / Skills / Activity: heading-based detection ("About", "Skills",
 *     "Activity" h2/h3 anchors → closest section/componentkey container)
 *
 * Fields default to empty; caller (profile-context) checks `parsedAnything` for
 * loud-fail UX. Never throws.
 */

import type { UserProfile } from './lib/idb';

export interface RawProfileFields {
  fullName: string;
  headline: string;
  about: string;
  topSkills: string[];
  recentPostThemes: string[];
}

export const ABOUT_MAX_CHARS = 1500;
export const MAX_TOP_SKILLS = 10;
export const MAX_RECENT_POST_THEMES = 5;
export const MAX_RECENT_POSTS = 10;
export const MAX_RECENT_COMMENTS = 15;
export const MIN_POST_TEXT_LEN = 20;

function readText(el: Element | null | undefined): string {
  if (!el) return '';
  return (el.textContent ?? '').trim().replace(/\s+/g, ' ');
}

export function parseProfileDom(doc: Document | DocumentFragment): RawProfileFields {
  // LinkedIn 2026 puts the sticky-header h1 OUTSIDE <main>. Limiting search to
  // <main> means we get the topcard h1 (the visually-large one with the name).
  // Fallback to whole doc if <main> isn't present (degraded mode / older DOM).
  const root: Document | DocumentFragment | Element = doc.querySelector('main') ?? doc;

  // ─── Name ────────────────────────────────────────────────────────────────
  // First h1 inside <main>. LinkedIn's topcard puts the name here regardless of
  // class name churn.
  const fullName = readText(root.querySelector('h1'));

  // ─── Headline ────────────────────────────────────────────────────────────
  // Strategy A: find the topcard container with aria-label === fullName, then
  // pick the LONGEST <p> inside that's not the location pattern.
  // Strategy B (fallback): any <p> in root containing LinkedIn headline
  // markers ("|" or " · ") and is longer than a location string.
  let headline = '';
  if (fullName) {
    const topcardAnchor = Array.from(root.querySelectorAll('div[aria-label]')).find(
      (d) => d.getAttribute('aria-label') === fullName
    );
    if (topcardAnchor) {
      const paragraphs = Array.from(topcardAnchor.querySelectorAll('p'));
      for (const p of paragraphs) {
        const t = readText(p);
        if (t.length < 25) continue;
        // Skip locations ("City, Region, Country" pattern)
        if (
          /^[A-Za-zА-Яа-яЇЄІїєі' -]+,\s*[A-Za-zА-Яа-яЇЄІїєі' -]+,\s*[A-Za-zА-Яа-яЇЄІїєі' -]+$/.test(
            t
          )
        )
          continue;
        if (t.length > headline.length) headline = t;
      }
    }
  }
  if (!headline) {
    const all = root.querySelectorAll('p');
    for (const p of Array.from(all)) {
      const t = readText(p);
      if (t.length < 30 || t.length > 300) continue;
      if (!(t.includes('|') || t.includes(' · '))) continue;
      // Skip "Pinnacle · Kremenchuk State..." style (current company line)
      if (t.split(' · ').length === 2 && !t.includes('|') && t.length < 100) continue;
      headline = t;
      break;
    }
  }

  // Headings cached for the next three sections.
  const headings = Array.from(root.querySelectorAll('h2, h3'));

  // ─── About ───────────────────────────────────────────────────────────────
  // Find an h2/h3 with text exactly "About" → grab the containing
  // section / div[componentkey]'s text (less the heading).
  let about = '';
  for (const h of headings) {
    if (!/^about$/i.test(readText(h))) continue;
    const section = h.closest('section, div[componentkey]');
    if (!section) continue;
    const sectionText = readText(section);
    // Drop the leading "About" heading from the captured text.
    const cleaned = sectionText.replace(/^about\s+/i, '').trim();
    about = cleaned.slice(0, ABOUT_MAX_CHARS);
    break;
  }
  if (!about) {
    // Fallback: scan componentkey placeholders for ones that mention "About"
    const placeholders = root.querySelectorAll('[componentkey]');
    for (const card of Array.from(placeholders)) {
      const t = readText(card);
      if (t.length > 80 && /\babout\b/i.test(t)) {
        about = t.slice(0, ABOUT_MAX_CHARS);
        break;
      }
    }
  }

  // ─── Skills ──────────────────────────────────────────────────────────────
  const topSkills: string[] = [];
  const skillsHeading = headings.find((h) => /^skills$/i.test(readText(h)));
  if (skillsHeading) {
    const section = skillsHeading.closest('section, div[componentkey]');
    if (section) {
      // Skills typically render as h3/h4 or items with aria-label attribute.
      const items = section.querySelectorAll('h3, h4, [aria-label]');
      for (const item of Array.from(items)) {
        const s =
          item.tagName === 'H3' || item.tagName === 'H4'
            ? readText(item)
            : (item.getAttribute('aria-label') ?? '').trim();
        if (!s) continue;
        if (s.length < 2 || s.length > 80) continue;
        if (/^skills?$/i.test(s)) continue;
        if (topSkills.includes(s)) continue;
        topSkills.push(s);
        if (topSkills.length >= MAX_TOP_SKILLS) break;
      }
    }
  }

  // ─── Recent post themes / Activity ───────────────────────────────────────
  const recentPostThemes: string[] = [];
  const activityHeading = headings.find((h) => /^(activity|posts)$/i.test(readText(h)));
  if (activityHeading) {
    const section = activityHeading.closest('section, div[componentkey]');
    if (section) {
      const texts = section.querySelectorAll('p, span');
      for (const t of Array.from(texts)) {
        const s = readText(t);
        if (!s) continue;
        if (s.length < 30 || s.length > 500) continue;
        if (/^activity$|^posts$|^show all/i.test(s)) continue;
        if (recentPostThemes.includes(s)) continue;
        recentPostThemes.push(s);
        if (recentPostThemes.length >= MAX_RECENT_POST_THEMES) break;
      }
    }
  }

  return { fullName, headline, about, topSkills, recentPostThemes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #16 — extended scrape (location, counts, experience, education,
// certifications, languages). Reuses parseProfileDom for the 3 base fields.
// ─────────────────────────────────────────────────────────────────────────────

function warnMiss(field: string): void {
  if (typeof console !== 'undefined') console.warn(`[LinkMate miss: ${field}]`);
}

function parseIntFromLabel(text: string): number | undefined {
  // "500+ connections", "1,234 followers", "1.2K followers" — best-effort.
  const m = text.match(/([\d.,]+)\s*([KMkm])?/);
  if (!m) return undefined;
  const raw = m[1].replace(/,/g, '');
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  const mult = m[2]?.toUpperCase() === 'K' ? 1000 : m[2]?.toUpperCase() === 'M' ? 1_000_000 : 1;
  return Math.round(n * mult);
}

function findSection(root: Element | Document | DocumentFragment, re: RegExp): Element | null {
  const headings = Array.from(root.querySelectorAll('h2, h3'));
  for (const h of headings) {
    if (re.test(readText(h))) {
      const section = h.closest('section, div[componentkey]');
      if (section) return section;
    }
  }
  return null;
}

function dedupeListItems(section: Element): Element[] {
  // Top-level <li> only (avoid nested role bullet sub-items duplicating).
  const lis = Array.from(section.querySelectorAll('li'));
  return lis.filter((li) => {
    const parentLi = li.parentElement?.closest('li');
    return !parentLi || !section.contains(parentLi);
  });
}

function visibleSpanLines(el: Element): string[] {
  // LinkedIn renders each text fragment as <span aria-hidden="true"> with a
  // visually-hidden duplicate <span class="visually-hidden">. Use the
  // aria-hidden ones to avoid double text.
  const spans = Array.from(el.querySelectorAll('span[aria-hidden="true"]'));
  const lines: string[] = [];
  for (const s of spans) {
    const t = readText(s);
    if (!t) continue;
    if (lines[lines.length - 1] === t) continue;
    lines.push(t);
  }
  return lines;
}

function parseExperience(root: Element | Document | DocumentFragment): UserProfile['experience'] {
  const section = findSection(root, /^experience$/i);
  if (!section) {
    warnMiss('experience');
    return [];
  }
  const out: UserProfile['experience'] = [];
  for (const li of dedupeListItems(section)) {
    const lines = visibleSpanLines(li);
    if (lines.length === 0) continue;
    // Heuristic: first line = title, second = company (often "Company · Type"),
    // third = dateRange (often "MMM YYYY - Present · Xy Xmo"), fourth = location.
    const [title, company, dateRange, location, ...rest] = lines;
    if (!title || !company) continue;
    const description = rest.filter((l) => l.length > 20).join('\n').slice(0, 1000) || undefined;
    out.push({
      title,
      company: company.split(' · ')[0],
      dateRange: dateRange ?? '',
      location: location || undefined,
      description,
    });
  }
  return out;
}

function parseEducation(root: Element | Document | DocumentFragment): UserProfile['education'] {
  const section = findSection(root, /^education$/i);
  if (!section) {
    warnMiss('education');
    return [];
  }
  const out: UserProfile['education'] = [];
  for (const li of dedupeListItems(section)) {
    const lines = visibleSpanLines(li);
    if (lines.length === 0) continue;
    const [school, degreeLine, dateRange] = lines;
    if (!school) continue;
    // degreeLine often "Bachelor's degree, Computer Science"
    let degree: string | undefined;
    let field: string | undefined;
    if (degreeLine) {
      const parts = degreeLine.split(/, ?/);
      degree = parts[0]?.trim() || undefined;
      field = parts.slice(1).join(', ').trim() || undefined;
    }
    out.push({ school, degree, field, dateRange: dateRange || undefined });
  }
  return out;
}

function parseCertifications(
  root: Element | Document | DocumentFragment
): UserProfile['certifications'] {
  const section = findSection(root, /^licenses\s*&?\s*certifications?$|^certifications?$/i);
  if (!section) return [];
  const out: NonNullable<UserProfile['certifications']> = [];
  for (const li of dedupeListItems(section)) {
    const lines = visibleSpanLines(li);
    if (!lines[0]) continue;
    out.push({ name: lines[0], issuer: lines[1] || undefined, date: lines[2] || undefined });
  }
  return out;
}

function parseLanguages(root: Element | Document | DocumentFragment): string[] {
  const section = findSection(root, /^languages?$/i);
  if (!section) return [];
  const out: string[] = [];
  for (const li of dedupeListItems(section)) {
    const lines = visibleSpanLines(li);
    if (lines[0] && !out.includes(lines[0])) out.push(lines[0]);
  }
  return out;
}

function parseTopcardMeta(
  root: Element | Document | DocumentFragment,
  fullName: string
): { location?: string; connectionsCount?: number; followersCount?: number } {
  let location: string | undefined;
  let connectionsCount: number | undefined;
  let followersCount: number | undefined;

  const topcard =
    Array.from(root.querySelectorAll('div[aria-label]')).find(
      (d) => d.getAttribute('aria-label') === fullName
    ) ?? null;

  const scan = topcard ?? root;
  const lines = Array.from(scan.querySelectorAll('p, span, li'));
  for (const el of lines) {
    const t = readText(el);
    if (!t) continue;
    if (
      !location &&
      /^[A-Za-zА-Яа-яЇЄІїєі' .-]+,\s*[A-Za-zА-Яа-яЇЄІїєі' .-]+(,\s*[A-Za-zА-Яа-яЇЄІїєі' .-]+)?$/.test(
        t
      ) &&
      t.length < 100
    ) {
      location = t;
    }
    if (!connectionsCount && /\bconnections?\b/i.test(t)) {
      connectionsCount = parseIntFromLabel(t);
    }
    if (!followersCount && /\bfollowers?\b/i.test(t)) {
      followersCount = parseIntFromLabel(t);
    }
  }
  return { location, connectionsCount, followersCount };
}

/**
 * Parse a fully-loaded LinkedIn profile page into a UserProfile.
 * `profileUrl` is the canonical URL caller already knows (from active tab).
 * Activity arrays (`recentPosts`, `recentComments`) come from the recent-activity
 * pages — populated separately and merged by the caller.
 */
export function parseUserProfile(
  doc: Document | DocumentFragment,
  profileUrl: string
): UserProfile {
  const base = parseProfileDom(doc);
  const root: Document | DocumentFragment | Element = doc.querySelector('main') ?? doc;
  const meta = parseTopcardMeta(root, base.fullName);

  return {
    capturedAt: new Date().toISOString(),
    profileUrl,
    name: base.fullName,
    headline: base.headline,
    location: meta.location,
    connectionsCount: meta.connectionsCount,
    followersCount: meta.followersCount,
    about: base.about || undefined,
    skills: base.topSkills,
    experience: parseExperience(root),
    education: parseEducation(root),
    certifications: parseCertifications(root),
    languages: parseLanguages(root),
    recentPosts: [],
    recentComments: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recent-activity parsers — operate on /in/<handle>/recent-activity/{all,comments}/
// ─────────────────────────────────────────────────────────────────────────────

function extractUrn(el: Element): string {
  const direct = el.getAttribute('data-urn') ?? el.getAttribute('data-id');
  if (direct) return direct;
  const child = el.querySelector('[data-urn], [data-id]');
  if (child) {
    return (
      child.getAttribute('data-urn') ??
      child.getAttribute('data-id') ??
      `gen:${Math.random().toString(36).slice(2, 10)}`
    );
  }
  return `gen:${Math.random().toString(36).slice(2, 10)}`;
}

function parseEngagement(scope: Element): { likes: number; comments: number; reposts: number } | undefined {
  // Look for "social-action" or generic count spans.
  const text = readText(scope);
  const likesM = text.match(/([\d.,KM]+)\s*(reactions?|likes?)/i);
  const commentsM = text.match(/([\d.,KM]+)\s*comments?/i);
  const repostsM = text.match(/([\d.,KM]+)\s*reposts?/i);
  if (!likesM && !commentsM && !repostsM) return undefined;
  const likes = likesM ? parseIntFromLabel(likesM[1]) : undefined;
  const comments = commentsM ? parseIntFromLabel(commentsM[1]) : undefined;
  const reposts = repostsM ? parseIntFromLabel(repostsM[1]) : undefined;
  if (likes === undefined && comments === undefined && reposts === undefined) return undefined;
  return { likes: likes ?? 0, comments: comments ?? 0, reposts: reposts ?? 0 };
}

export function parseRecentPosts(doc: Document | DocumentFragment): UserProfile['recentPosts'] {
  const out: UserProfile['recentPosts'] = [];
  const updates = doc.querySelectorAll(
    'div.feed-shared-update-v2, [data-urn^="urn:li:activity"], [data-id^="urn:li:activity"]'
  );
  for (const el of Array.from(updates)) {
    const id = extractUrn(el);
    if (out.find((p) => p.id === id)) continue;
    // Post body
    const textEl =
      el.querySelector('[data-test-id="main-feed-activity-card__commentary"]') ??
      el.querySelector('.feed-shared-update-v2__description') ??
      el.querySelector('.update-components-text') ??
      el.querySelector('[dir="ltr"]');
    const text = textEl ? readText(textEl) : '';
    if (text.length < MIN_POST_TEXT_LEN) continue;
    const tsEl = el.querySelector('time, [aria-label*="ago" i]');
    const timestamp = tsEl ? readText(tsEl) || tsEl.getAttribute('datetime') || '' : '';
    const isRepost =
      !!el.querySelector('.update-components-header__text-view, [data-test-id*="repost" i]') ||
      /reposted/i.test(readText(el).slice(0, 200));
    const engagement = parseEngagement(el);
    out.push({ id, text, timestamp, engagement, isRepost });
    if (out.length >= MAX_RECENT_POSTS) break;
  }
  if (out.length === 0) warnMiss('recentPosts');
  return out;
}

export function parseRecentComments(
  doc: Document | DocumentFragment
): UserProfile['recentComments'] {
  const out: UserProfile['recentComments'] = [];
  // LinkedIn renders each comment card with the parent post above it.
  const cards = doc.querySelectorAll(
    '.profile-creator-shared-feed-update__container, [data-urn^="urn:li:activity"], li.profile-creator-shared-feed-update__container'
  );
  for (const card of Array.from(cards)) {
    const id = extractUrn(card);
    if (out.find((c) => c.id === id)) continue;

    // Comment body — last/innermost "commentary" block.
    const commentBlocks = card.querySelectorAll(
      '.comments-comment-item-content-body, .comments-comment-item__main-content, .feed-shared-update-v2__commentary'
    );
    const commentEl =
      commentBlocks[commentBlocks.length - 1] ?? card.querySelector('[dir="ltr"]');
    const text = commentEl ? readText(commentEl) : '';
    if (!text) continue;

    // Parent post — first "commentary" block, or update-components-text.
    const parentBlocks = card.querySelectorAll(
      '.feed-shared-update-v2__description, .update-components-text'
    );
    const parentEl = parentBlocks[0];
    const originalPostText = parentEl ? readText(parentEl) : '';

    // Original author — actor name in the parent block.
    const actorEl =
      card.querySelector(
        '.update-components-actor__title, .feed-shared-actor__name, [data-test-id="main-feed-activity-card__entity-lockup-name"]'
      ) ?? null;
    const originalAuthor = actorEl ? readText(actorEl) : '';

    if (!originalPostText || !originalAuthor) {
      warnMiss('recentComments.parentPost');
      continue;
    }

    const tsEl = card.querySelector('time, [aria-label*="ago" i]');
    const timestamp = tsEl ? readText(tsEl) || tsEl.getAttribute('datetime') || '' : '';

    out.push({ id, text, timestamp, originalPostText, originalAuthor });
    if (out.length >= MAX_RECENT_COMMENTS) break;
  }
  if (out.length === 0) warnMiss('recentComments');
  return out;
}
