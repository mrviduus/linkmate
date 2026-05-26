/**
 * v0.5.6 — Profile parser spec, real-DOM rewrite.
 *
 * Old fixture-driven tests (using `.text-heading-xlarge`, `#about`, `#skills`)
 * were synthetic and didn't reflect LinkedIn's 2026 Server-Driven UI. Real
 * LinkedIn DOM uses bare `<h1>` / `<p>` / `<h2>` with hash-based class names,
 * `aria-label="${fullName}"` topcard anchor, and `[componentkey]` placeholders
 * for async-loaded sections. This spec drives parser against fixtures shaped
 * like the real thing.
 */

import { parseProfileDom } from '../src/profile-parser';

function parse(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return parseProfileDom(doc);
}

describe('profile-parser (v0.5.6 real-DOM)', () => {
  describe('topcard — what loads on initial page render', () => {
    const HTML = `
      <main>
        <section>
          <div aria-label="Vasyl Vdovychenko">
            <h1 class="d8d5bbbc b46cb6f5">Vasyl Vdovychenko</h1>
            <p class="d8d5bbbc _2f6a5622">AI Engineer | RAG · Agents · LLM Infrastructure | 10+ years in software engineering</p>
            <p class="d8d5bbbc bab73015">Pinnacle · Kremenchuk State Polytechnical University</p>
            <p class="d8d5bbbc bab73015">Waterloo, Ontario, Canada</p>
          </div>
        </section>
      </main>
    `;

    it('extracts fullName from main h1', () => {
      const f = parse(HTML);
      expect(f.fullName).toBe('Vasyl Vdovychenko');
    });

    it('extracts headline as the longest non-location <p> in the aria-label topcard', () => {
      const f = parse(HTML);
      expect(f.headline).toContain('AI Engineer');
      expect(f.headline).toContain('RAG');
      expect(f.headline).toContain('LLM Infrastructure');
    });

    it('skips the "City, Region, Country" location pattern from headline', () => {
      const f = parse(HTML);
      expect(f.headline).not.toBe('Waterloo, Ontario, Canada');
    });

    it('ignores the sticky-header h1 OUTSIDE <main>', () => {
      const html = `
        <body>
          <header><h1>Sticky Header Name (wrong)</h1></header>
          <main>
            <section><div aria-label="Real Name"><h1>Real Name</h1>
              <p>AI Engineer | RAG | Agents</p>
            </div></section>
          </main>
        </body>
      `;
      const f = parse(html);
      expect(f.fullName).toBe('Real Name');
    });
  });

  describe('headline fallback — when topcard aria-label anchor is absent', () => {
    it('picks any <p> with LinkedIn headline markers ("|" or " · ")', () => {
      const html = `
        <main>
          <h1>Some Name</h1>
          <p>AI Engineer | RAG · Agents · LLM Infrastructure</p>
        </main>
      `;
      const f = parse(html);
      expect(f.headline).toContain('AI Engineer');
    });
  });

  describe('About section — heading-anchor strategy', () => {
    it('extracts text from the section containing the "About" h2', () => {
      const html = `
        <main>
          <h1>Name</h1>
          <section>
            <h2>About</h2>
            <p>Senior AI engineer building local-first systems and agent frameworks.</p>
          </section>
        </main>
      `;
      const f = parse(html);
      expect(f.about).toContain('local-first');
      expect(f.about).toContain('agent frameworks');
    });

    it('truncates About text to ABOUT_MAX_CHARS (1500)', () => {
      const long = 'lorem '.repeat(500); // ~3000 chars
      const html = `
        <main>
          <h1>X</h1>
          <section><h2>About</h2><p>${long}</p></section>
        </main>
      `;
      const f = parse(html);
      expect(f.about.length).toBe(1500);
    });
  });

  describe('Skills section — heading-anchor strategy', () => {
    it('extracts skill names from h3/h4 within the Skills section', () => {
      const html = `
        <main>
          <h1>Name</h1>
          <section>
            <h2>Skills</h2>
            <ul>
              <li><h3>TypeScript</h3></li>
              <li><h3>Python</h3></li>
              <li><h3>RAG</h3></li>
            </ul>
          </section>
        </main>
      `;
      const f = parse(html);
      expect(f.topSkills).toEqual(['TypeScript', 'Python', 'RAG']);
    });

    it('caps at MAX_TOP_SKILLS=10 even when more present', () => {
      const items = Array.from({ length: 20 }, (_, i) => `<li><h3>Skill ${i}</h3></li>`).join('');
      const html = `
        <main>
          <h1>X</h1>
          <section><h2>Skills</h2><ul>${items}</ul></section>
        </main>
      `;
      const f = parse(html);
      expect(f.topSkills).toHaveLength(10);
      expect(f.topSkills[0]).toBe('Skill 0');
      expect(f.topSkills[9]).toBe('Skill 9');
    });

    it('returns empty skills when no Skills heading exists', () => {
      const f = parse('<main><h1>X</h1></main>');
      expect(f.topSkills).toEqual([]);
    });
  });

  describe('Activity / recent post themes — heading-anchor strategy', () => {
    it('extracts <p> snippets from the section containing "Activity" h2', () => {
      const html = `
        <main>
          <h1>Name</h1>
          <section>
            <h2>Activity</h2>
            <p>Excited to share that LinkMate v0.5 ships OpenAI BYOK!</p>
            <p>Deep-dive into LinkedIn DOM parsing under React SDUI churn.</p>
          </section>
        </main>
      `;
      const f = parse(html);
      expect(f.recentPostThemes.length).toBeGreaterThanOrEqual(2);
      expect(f.recentPostThemes[0]).toContain('LinkMate');
    });
  });

  describe('robustness', () => {
    it('does not throw on completely empty DOM', () => {
      expect(() => parse('<main></main>')).not.toThrow();
    });

    it('returns all empty fields when DOM has no <main>', () => {
      // No <main> means we fall back to whole doc — sticky h1 / aria-label etc.
      // not present → all empty
      const f = parse('<div>nothing useful</div>');
      expect(f.fullName).toBe('');
      expect(f.headline).toBe('');
      expect(f.about).toBe('');
      expect(f.topSkills).toEqual([]);
      expect(f.recentPostThemes).toEqual([]);
    });

    it('is pure: same DOM → same output across calls', () => {
      const html = `
        <main>
          <h1>X</h1>
          <p>Engineer | AI | RAG</p>
          <section><h2>About</h2><p>About text</p></section>
          <section><h2>Skills</h2><ul><li><h3>TS</h3></li></ul></section>
        </main>
      `;
      const a = parse(html);
      const b = parse(html);
      expect(a).toEqual(b);
    });

    it('returned strings are trimmed', () => {
      const html = `
        <main>
          <div aria-label="Test Name">
            <h1>   Test Name   </h1>
            <p>  Engineer | AI | RAG  </p>
          </div>
        </main>
      `;
      const f = parse(html);
      expect(f.fullName).toBe(f.fullName.trim());
      expect(f.headline).toBe(f.headline.trim());
      expect(f.fullName).toBe('Test Name');
    });
  });
});
