/**
 * v0.5.3 — LinkedIn SSI page DOM parser (Phase C, US2, defensive rewrite).
 *
 * Operates on the DOM of https://www.linkedin.com/sales/ssi. The page shape
 * has shifted across LinkedIn redesigns; v0.4.0 hardcoded `.ssi-score-table__*`
 * selectors that no longer exist in 2026 (Bug Report 2026-05-15:
 * "Capture failed: Could not locate .ssi-score-table__current-ssi-score").
 *
 * This parser now does TWO passes:
 *   1. **Selector pass** — try documented LinkedIn classes (including legacy)
 *   2. **Text-pattern fallback** — find numbers near anchor strings like
 *      "out of 100" and the four canonical component titles.
 *
 * If neither pass yields a result, returns SsiParseError with the reason so
 * the popup can render an actionable chip + the user can run
 * scripts/dump-linkedin-ssi-dom.js to share real DOM for a canonical fix.
 */

import type { SsiSnapshot } from './storage-schema';

export type SsiParseReason = 'missing-total' | 'missing-component' | 'missing-rank' | 'malformed';

export interface SsiParseSuccess {
  ok: true;
  snapshot: SsiSnapshot;
}
export interface SsiParseError {
  ok: false;
  reason: SsiParseReason;
  message: string;
}
export type SsiParseResult = SsiParseSuccess | SsiParseError;

interface ParseOptions {
  /** Defaults to Date.now(). Override for deterministic tests. */
  now?: number;
}

function readText(el: Element | null): string {
  if (!el) return '';
  const aria = el.querySelector('[aria-hidden="true"]');
  const raw = (aria?.textContent ?? el.textContent ?? '').trim();
  return raw.replace(/\s+/g, ' ');
}

/**
 * Full text of the document. Document.textContent is null per spec, so we
 * have to ask body or documentElement (DocumentFragment doesn't have either,
 * fall back to its own textContent which IS populated for fragments).
 */
function getDocText(doc: Document | DocumentFragment): string {
  if ('body' in doc && doc.body) return doc.body.textContent ?? '';
  if ('documentElement' in doc && doc.documentElement) return doc.documentElement.textContent ?? '';
  return doc.textContent ?? '';
}

function readNumber(el: Element | null): number | null {
  const text = readText(el);
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = parseFloat(match[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Find a number near an anchor text within any element's textContent.
 * Used as fallback when class-based selectors fail — looks for patterns like
 * "8.78 | Establish your professional brand" where the score is inline with
 * the title.
 *
 * Walks elements in document order and picks the SMALLEST containing element
 * whose text matches the anchor — that minimizes the chance of catching a
 * stray number from elsewhere in the page.
 */
function findNumberNearText(
  doc: Document | DocumentFragment,
  anchorRe: RegExp,
  numberRe = /-?\d+(?:\.\d+)?/
): number | null {
  const all = doc.querySelectorAll('*');
  let bestMatch: { el: Element; depth: number } | null = null;
  for (const el of Array.from(all)) {
    const txt = el.textContent ?? '';
    if (!anchorRe.test(txt)) continue;
    if (!numberRe.test(txt)) continue;
    // Prefer the deepest (smallest) element that contains both anchor + number.
    let depth = 0;
    let cur: Element | null = el;
    while (cur) {
      cur = cur.parentElement;
      depth++;
    }
    if (!bestMatch || depth > bestMatch.depth) {
      bestMatch = { el, depth };
    }
  }
  if (!bestMatch) return null;
  const m = (bestMatch.el.textContent ?? '').match(numberRe);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

const COMPONENT_PATTERNS: Array<[RegExp, keyof SsiSnapshot['components']]> = [
  [/establish\s+(?:your\s+)?professional\s+brand/i, 'establishBrand'],
  [/find\s+the\s+right\s+people/i, 'findRightPeople'],
  [/engage\s+with\s+insights/i, 'engageWithInsights'],
  [/build\s+relationships/i, 'buildRelationships'],
];

function err(reason: SsiParseReason, message: string): SsiParseError {
  return { ok: false, reason, message };
}

// ─── Total score ────────────────────────────────────────────────────────────

function extractTotal(doc: Document | DocumentFragment): number | null {
  // Pass 1: documented selectors (legacy + current candidates)
  const selectorCandidates = [
    '.ssi-score-table__current-ssi-score', // v0.4.0 hardcode
    '.ssi-score-summary__current-score', // probable 2025 rename
    '[data-test-id="ssi-current-score"]', // data-test pattern
    '.text-display-1', // generic LinkedIn big number
    '.ssi-page-container .text-display-1',
  ];
  for (const sel of selectorCandidates) {
    const el = doc.querySelector(sel);
    const n = readNumber(el);
    if (n !== null && n >= 0 && n <= 100) return n;
  }

  // Pass 2: text-pattern fallback — find "<number> out of 100"
  const allText = doc.querySelector('main')?.textContent ?? getDocText(doc);
  // Match patterns like "23 / 100", "18 out of 100", "Score: 42"
  const patterns = [
    /(\d{1,3})\s*\/\s*100\b/,
    /(\d{1,3})\s+out\s+of\s+100/i,
    /current\s+(?:ssi\s+)?score[:\s]+(\d{1,3})/i,
  ];
  for (const re of patterns) {
    const m = allText.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 0 && n <= 100) return n;
    }
  }
  return null;
}

// ─── Component scores ───────────────────────────────────────────────────────

function extractComponents(doc: Document | DocumentFragment): {
  values: Partial<SsiSnapshot['components']>;
  cardsSeen: number;
} {
  const values: Partial<SsiSnapshot['components']> = {};

  // Pass 1: documented card-based DOM
  const cardSelectors = [
    '.ssi-component-card',
    '.ssi-component',
    '[data-test-id^="ssi-component"]',
  ];
  let cards: Element[] = [];
  for (const sel of cardSelectors) {
    cards = Array.from(doc.querySelectorAll(sel));
    if (cards.length >= 4) break;
  }

  for (const card of cards) {
    const titleEl =
      card.querySelector('.ssi-component-card__title') ??
      card.querySelector('h3') ??
      card.querySelector('h4');
    const valueEl =
      card.querySelector('.ssi-score-table__component-value') ??
      card.querySelector('.ssi-component__value') ??
      card.querySelector('.text-heading-large') ??
      card;
    const title = readText(titleEl);
    const value = readNumber(valueEl);
    if (value === null) continue;
    for (const [pattern, key] of COMPONENT_PATTERNS) {
      if (pattern.test(title)) {
        values[key] = value;
        break;
      }
    }
  }

  // Pass 2: text-pattern fallback — for each component, find its title in page
  // and grab the nearest number ≤25. The LinkedIn SSI page often renders like:
  //   "8.78 | Establish your professional brand"
  // so the number is co-located with the title text inside the same container.
  for (const [pattern, key] of COMPONENT_PATTERNS) {
    if (values[key] !== undefined) continue;
    const n = findNumberNearText(doc, pattern);
    if (n !== null && n >= 0 && n <= 25) {
      values[key] = n;
    }
  }

  return { values, cardsSeen: cards.length };
}

// ─── Industry / Network rank ────────────────────────────────────────────────

function extractRanks(doc: Document | DocumentFragment): {
  industryRank: string;
  networkRank: string;
} {
  // Pass 1: documented ranking-statement elements
  const rankEls = doc.querySelectorAll('.ssi-ranking-statement, .ssi-ranking');
  if (rankEls.length >= 2) {
    return {
      industryRank: readText(rankEls[0]),
      networkRank: readText(rankEls[1]),
    };
  }

  // Pass 2: text-pattern — find the two "top X%" mentions near "industry" and "network"
  const text = getDocText(doc);
  const industryMatch = text.match(/top\s+(\d{1,3})\s*%[^.]*?industry/i);
  const networkMatch = text.match(/top\s+(\d{1,3})\s*%[^.]*?network/i);
  return {
    industryRank: industryMatch ? `Top ${industryMatch[1]}% in your industry` : '',
    networkRank: networkMatch ? `Top ${networkMatch[1]}% in your network` : '',
  };
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export function parseSsiDom(
  doc: Document | DocumentFragment,
  options: ParseOptions = {}
): SsiParseResult {
  const now = options.now ?? Date.now();

  const total = extractTotal(doc);
  if (total === null) {
    return err(
      'missing-total',
      "Could not locate SSI total. LinkedIn's SSI page DOM may have changed — please run scripts/dump-linkedin-ssi-dom.js in DevTools on /sales/ssi and share the JSON."
    );
  }

  const { values: components, cardsSeen } = extractComponents(doc);
  const requiredKeys: Array<keyof SsiSnapshot['components']> = [
    'establishBrand',
    'findRightPeople',
    'engageWithInsights',
    'buildRelationships',
  ];
  const missing = requiredKeys.filter((k) => components[k] === undefined);
  if (missing.length > 0) {
    return err(
      'missing-component',
      `Missing component scores: ${missing.join(', ')} (saw ${cardsSeen} card elements). Total=${total} parsed OK. Please run scripts/dump-linkedin-ssi-dom.js to help us fix.`
    );
  }

  const { industryRank, networkRank } = extractRanks(doc);
  if (!industryRank || !networkRank) {
    // Rank failure is non-fatal — return snapshot with empty ranks rather
    // than discarding the parsed components.
    return {
      ok: true,
      snapshot: {
        total,
        components: components as SsiSnapshot['components'],
        industryRank: industryRank || 'unknown',
        networkRank: networkRank || 'unknown',
        capturedAt: now,
      },
    };
  }

  return {
    ok: true,
    snapshot: {
      total,
      components: components as SsiSnapshot['components'],
      industryRank,
      networkRank,
      capturedAt: now,
    },
  };
}
