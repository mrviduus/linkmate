/**
 * Centralized LinkedIn DOM selectors. LinkedIn obfuscates class names that
 * rotate frequently — keep all DOM reads here so a breakage has one fix surface.
 * Prefer text-content and aria-* hooks over CSS classes.
 */

/** Find the first element whose visible text matches a substring (case-insensitive). */
export function findByText(root: ParentNode, tag: string, needle: string): HTMLElement | null {
  const lower = needle.toLowerCase();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(tag))) {
    if (el.innerText && el.innerText.toLowerCase().includes(lower)) return el;
  }
  return null;
}

/** Wait until predicate returns a truthy value or timeout (ms). */
export function waitFor<T>(predicate: () => T | null, timeoutMs = 8000, intervalMs = 250): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = predicate();
      if (v) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Pull the first number found in a string (handles "23 out of 25", "Score 67", etc). */
export function firstNum(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** SSI page pillar labels — match by text since DOM is heavily obfuscated. */
export const PILLAR_LABELS = {
  brand: ['establish your professional brand', 'professional brand'],
  finding: ['find the right people'],
  engaging: ['engage with insights'],
  building: ['build relationships'],
} as const;
