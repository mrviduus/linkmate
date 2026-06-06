/**
 * Single source of truth for turning LinkedIn timestamps into epoch ms.
 *
 * LinkedIn renders timestamps in several shapes, often RELATIVE:
 *   - abbreviated: "3d", "1w", "7mo", "5h", "2y", "10m" (minutes), "30s"
 *   - word form:   "3 days ago", "1 week", "7 months ago"
 *   - absolute:    "May 5, 2026", "2026-05-05"
 *
 * `Date.parse` returns NaN for the relative forms — using it directly silently
 * zeroed activity counts and broke "sort by recency". Every consumer that has a
 * scraped timestamp string should resolve it through `resolveTimestampMs`.
 */

const MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000, // ~30 days
  y: 31_536_000_000, // ~365 days
} as const;

/** Returns epoch ms for a LinkedIn timestamp string, or null if unparseable. */
export function resolveTimestampMs(raw: string | null | undefined, now: number = Date.now()): number | null {
  if (!raw) return null;
  const s = raw.trim();

  // Leading "<n><unit-word>" — relative time. We match the unit as letters then
  // classify, so "mo"(month) vs "m"(minute) and word forms all resolve right.
  const rel = /^(\d+)\s*([a-z]+)/i.exec(s);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const u = rel[2].toLowerCase();
    let unitMs: number | null = null;
    if (u === 'mo' || u === 'mos' || u.startsWith('month')) unitMs = MS.mo;
    else if (u === 'y' || u.startsWith('yr') || u.startsWith('year')) unitMs = MS.y;
    else if (u === 'w' || u.startsWith('wk') || u.startsWith('week')) unitMs = MS.w;
    else if (u === 'd' || u.startsWith('day')) unitMs = MS.d;
    else if (u === 'h' || u.startsWith('hr') || u.startsWith('hour')) unitMs = MS.h;
    else if (u === 'm' || u.startsWith('min')) unitMs = MS.m;
    else if (u === 's' || u.startsWith('sec')) unitMs = MS.s;
    if (unitMs !== null && Number.isFinite(n)) return now - n * unitMs;
    // matched digits but not a known unit (e.g. "5 May 2026") → fall through.
  }

  const abs = Date.parse(s);
  return Number.isFinite(abs) ? abs : null;
}
