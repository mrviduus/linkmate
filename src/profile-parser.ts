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
