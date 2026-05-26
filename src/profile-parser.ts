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
    // Drop the leading "About" heading from the captured text. LinkedIn's
    // textContent collapses without whitespace ("AboutAI Engineer …") so
    // \s+ wasn't matching — use \s* + word boundary.
    const cleaned = sectionText.replace(/^about\b\s*/i, '').trim();
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

/**
 * Locate the topcard container — LinkedIn 2026 marks it with a componentkey
 * containing the literal substring "Topcard". Multiple matches may exist
 * (header + mobile variant); pick the first non-empty one.
 */
function findTopcard(
  root: Element | Document | DocumentFragment
): Element | null {
  const candidates = Array.from(root.querySelectorAll('[componentkey*="Topcard" i]'));
  return candidates.find((el) => el.querySelector('h2')) ?? candidates[0] ?? null;
}

function parseTopcardMeta(
  topcard: Element
): { location?: string; connectionsCount?: number; followersCount?: number } {
  let location: string | undefined;
  let connectionsCount: number | undefined;
  let followersCount: number | undefined;

  const texts = Array.from(topcard.querySelectorAll('p, span, li'))
    .map((el) => readText(el))
    .filter((t) => t && t.length < 120);

  for (const t of texts) {
    if (!connectionsCount && /\bconnections?\b/i.test(t)) {
      const m = t.match(/([\d,.]+\+?)\s*connection/i);
      if (m) connectionsCount = parseIntFromLabel(m[1]);
    }
    if (!followersCount && /\bfollowers?\b/i.test(t)) {
      const m = t.match(/([\d,.KM]+)\s*follower/i);
      if (m) followersCount = parseIntFromLabel(m[1]);
    }
  }

  // Location: a short text line inside topcard, AFTER the name h2, that doesn't
  // contain headline markers (`|`, `·`) or status words (connections, etc.).
  // For Vasyl this is "Canada"; for others may be "Waterloo, Ontario, Canada".
  const all = Array.from(topcard.querySelectorAll('*'));
  const nameH2 = topcard.querySelector('h2');
  const startIdx = nameH2 ? all.indexOf(nameH2) : -1;
  const after = startIdx >= 0 ? all.slice(startIdx + 1) : all;
  for (const el of after) {
    const t = readText(el);
    if (!t || t.length > 80) continue;
    if (/connection|follower|contact info|premium|•|·|\|/i.test(t)) continue;
    // Allow single-token country names ("Canada") OR comma-separated city tuples.
    if (/^[A-Za-zА-Яа-яЇЄІїєі' .-]{2,}(,\s*[A-Za-zА-Яа-яЇЄІїєі' .-]{2,}){0,2}$/.test(t)) {
      location = t;
      break;
    }
  }
  return { location, connectionsCount, followersCount };
}

/**
 * Topcard chip line "Pinnacle · Kremenchuk State Polytechnical University" — the
 * current-company + current-school summary. Used as a fallback 1-entry
 * experience / education when /details/* sub-pages are empty.
 *
 * IMPORTANT: must exclude headlines like "AI Engineer | RAG · Agents · …".
 * Headlines contain `|`; the chip line never does.
 */
function parseTopcardChip(topcard: Element): { company?: string; school?: string } {
  const lines = Array.from(topcard.querySelectorAll('p'))
    .map((p) => readText(p))
    .filter(
      (t) =>
        t &&
        t.includes(' · ') &&
        !t.includes('|') &&
        t.length < 200 &&
        t.split(' · ').length === 2
    );
  for (const t of lines) {
    const [left, right] = t.split(' · ').map((s) => s.trim());
    if (left && right) return { company: left, school: right };
  }
  return {};
}

/**
 * Parse a fully-loaded LinkedIn profile page into a UserProfile.
 * Activity / experience / education subpages are merged by the caller.
 */
export function parseUserProfile(
  doc: Document | DocumentFragment,
  profileUrl: string
): UserProfile {
  const base = parseProfileDom(doc);
  const root: Document | DocumentFragment | Element = doc.querySelector('main') ?? doc;
  const topcard = findTopcard(root);

  // Name: LinkedIn 2026 dropped <h1> from the topcard. The first <h2> inside
  // the topcard is the visible name. Fall back to parseProfileDom result or
  // og:title meta as last resort.
  let name = topcard?.querySelector('h2') ? readText(topcard.querySelector('h2')) : '';
  if (!name) name = base.fullName;
  if (!name) {
    const og = doc.querySelector('meta[property="og:title"]');
    name = og?.getAttribute('content')?.split('|')[0].trim() ?? '';
  }

  const meta = topcard ? parseTopcardMeta(topcard) : {};
  const chip = topcard ? parseTopcardChip(topcard) : {};

  let experience = parseExperience(root);
  if (experience.length === 0 && chip.company) {
    experience = [{ company: chip.company, title: '', dateRange: '' }];
  }
  let education = parseEducation(root);
  if (education.length === 0 && chip.school) {
    education = [{ school: chip.school }];
  }

  return {
    capturedAt: new Date().toISOString(),
    profileUrl,
    name,
    headline: base.headline,
    location: meta.location,
    connectionsCount: meta.connectionsCount,
    followersCount: meta.followersCount,
    about: base.about || undefined,
    skills: base.topSkills,
    experience,
    education,
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
  // LinkedIn 2026 exposes engagement counts as aria-label on the
  // reactions / comments / reposts pills — e.g. "18 reactions", "5 comments".
  // Body text is too noisy ("18 ... Like" mashed together) to regex reliably.
  const labels = Array.from(scope.querySelectorAll('[aria-label]'))
    .map((el) => el.getAttribute('aria-label') ?? '')
    .filter((s) => s.length < 80);
  let likes: number | undefined;
  let comments: number | undefined;
  let reposts: number | undefined;
  for (const a of labels) {
    if (likes === undefined) {
      const m = a.match(/^([\d,.KM]+)\s*(?:reactions?|likes?)$/i);
      if (m) likes = parseIntFromLabel(m[1]);
    }
    if (comments === undefined) {
      const m = a.match(/^([\d,.KM]+)\s*comments?$/i);
      if (m) comments = parseIntFromLabel(m[1]);
    }
    if (reposts === undefined) {
      const m = a.match(/^([\d,.KM]+)\s*reposts?$/i);
      if (m) reposts = parseIntFromLabel(m[1]);
    }
  }
  if (likes === undefined && comments === undefined && reposts === undefined) return undefined;
  return { likes: likes ?? 0, comments: comments ?? 0, reposts: reposts ?? 0 };
}

/**
 * Extract the post body from an activity card.
 * Live DOM has author name (~32 chars) duplicated as `[dir="ltr"]`, plus the
 * actual post text (~hundreds of chars) also as `[dir="ltr"]`. Strategy:
 * dedupe, then pick the LONGEST text — that's the post body.
 */
function pickPostBody(card: Element): string {
  const dirLtrs = Array.from(card.querySelectorAll('[dir="ltr"]'))
    .map((el) => readText(el))
    .filter((t) => t.length > 0);
  if (dirLtrs.length === 0) return '';
  const unique = Array.from(new Set(dirLtrs)).sort((a, b) => b.length - a.length);
  return unique[0] ?? '';
}

function pickRelativeTime(card: Element): string {
  // LinkedIn renders "7mo • 7 months ago • Visible to anyone …" as one <span>.
  // Look for the short form: "<digits><h|m|d|w|mo|y> •".
  const spans = Array.from(card.querySelectorAll('span'));
  for (const s of spans) {
    const t = readText(s);
    if (/\b\d+\s*(mo|h|m|d|w|s|y)\b\s*[•·]/i.test(t)) {
      const m = t.match(/(\d+\s*(?:mo|h|m|d|w|s|y))/i);
      return m ? m[1] : t.slice(0, 40);
    }
  }
  return '';
}

export function parseRecentPosts(doc: Document | DocumentFragment): UserProfile['recentPosts'] {
  const out: UserProfile['recentPosts'] = [];
  const updates = doc.querySelectorAll(
    '[data-urn^="urn:li:activity"], [data-id^="urn:li:activity"]'
  );
  for (const el of Array.from(updates)) {
    const id = extractUrn(el);
    if (out.find((p) => p.id === id)) continue;
    const text = pickPostBody(el);
    if (text.length < MIN_POST_TEXT_LEN) continue;
    const timestamp = pickRelativeTime(el);
    const isRepost =
      !!el.querySelector('[aria-label*="reposted" i]') ||
      /\breposted\b/i.test(readText(el).slice(0, 200));
    const engagement = parseEngagement(el);
    out.push({ id, text, timestamp, engagement, isRepost });
    if (out.length >= MAX_RECENT_POSTS) break;
  }
  if (out.length === 0) warnMiss('recentPosts');
  return out;
}

/**
 * Parse the user's recent comments. Each card on the recent-activity/comments
 * page bundles the parent post plus the user's reply (and sometimes other
 * authors' comments). Strategy:
 *   - parent post body = LONGEST unique `[dir="ltr"]` (this is the post they
 *     commented on)
 *   - user's comment   = LAST unique `[dir="ltr"]` after author lines —
 *     in the DOM, the user's own reply is rendered chronologically last
 *   - original author  = first /in/* link that isn't the profile's own handle
 *
 * Caller passes `selfHandle` extracted from the canonical profileUrl
 * (e.g. "vasyl-vdovychenko"). Empty string disables self-filtering.
 */
export function parseRecentComments(
  doc: Document | DocumentFragment,
  selfHandle = ''
): UserProfile['recentComments'] {
  const out: UserProfile['recentComments'] = [];
  const cards = doc.querySelectorAll(
    '[data-urn^="urn:li:activity"], [data-id^="urn:li:activity"]'
  );
  for (const card of Array.from(cards)) {
    const id = extractUrn(card);
    if (out.find((c) => c.id === id)) continue;

    const dirLtrs = Array.from(card.querySelectorAll('[dir="ltr"]'))
      .map((el) => readText(el))
      .filter((t) => t.length > 0);
    const unique = Array.from(new Set(dirLtrs));
    if (unique.length < 2) continue;

    // Parent post = longest text. User's comment = a different text from the
    // end of DOM order (last one in `unique`).
    const sortedByLen = [...unique].sort((a, b) => b.length - a.length);
    const originalPostText = sortedByLen[0];
    const text = [...unique].reverse().find((t) => t !== originalPostText) ?? '';
    if (!originalPostText || !text || text === originalPostText) continue;

    // Original author: first /in/* link whose handle is NOT the self handle.
    const links = Array.from(card.querySelectorAll('a[href*="/in/"]')) as HTMLAnchorElement[];
    let originalAuthor = '';
    for (const a of links) {
      const handle = (a.pathname.match(/^\/in\/([^/?#]+)/) ?? [])[1];
      if (!handle) continue;
      if (selfHandle && handle.toLowerCase() === selfHandle.toLowerCase()) continue;
      const name = readText(a) || a.getAttribute('aria-label');
      if (name) {
        originalAuthor = name;
        break;
      }
    }

    if (!originalAuthor) {
      warnMiss('recentComments.originalAuthor');
      continue;
    }

    const timestamp = pickRelativeTime(card);

    out.push({ id, text, timestamp, originalPostText, originalAuthor });
    if (out.length >= MAX_RECENT_COMMENTS) break;
  }
  if (out.length === 0) warnMiss('recentComments');
  return out;
}
