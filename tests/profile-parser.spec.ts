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

import { parseProfileDom, parseRecentComments } from '../src/profile-parser';

function parse(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return parseProfileDom(doc);
}

function parseComments(html: string, selfHandle: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return parseRecentComments(doc, selfHandle);
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

  // ─── parseRecentComments — anchor strategy (real DOM, 2026) ───────────────
  //
  // Fixtures reproduce the structure snapped via MCP on
  // /in/vasyl-vdovychenko/recent-activity/comments/ : outer activity card,
  // parent post content, `article.comments-comment-entity[data-id=...]`
  // children with author <a href="/in/{handle}"> and <span dir="ltr">.
  describe('parseRecentComments — anchored on article.comments-comment-entity', () => {
    const card = (opts: {
      cardUrn: string;
      postAuthor: { handle: string; name: string };
      postText: string;
      comments: Array<{ id: string; handle: string; text: string; reply?: boolean }>;
    }) => `
      <div data-urn="${opts.cardUrn}">
        <a href="/in/${opts.postAuthor.handle}/">${opts.postAuthor.name}</a>
        <p dir="ltr">${opts.postText}</p>
        ${opts.comments
          .map(
            (c) => `
          <article class="comments-comment-entity ${c.reply ? 'comments-comment-entity--reply' : ''}"
                   data-id="${c.id}">
            <a href="/in/${c.handle}/">User</a>
            <span dir="ltr">${c.text}</span>
            <span>2w</span>
          </article>
        `,
          )
          .join('')}
      </div>
    `;

    it('extracts self comment with comment-URN as id', () => {
      const html = card({
        cardUrn: 'urn:li:activity:7464106554733019136',
        postAuthor: { handle: 'aarthi-ntrjn', name: 'Aarthi N' },
        postText: 'Introducing Argus: command center for CLI sessions...',
        comments: [
          {
            id: 'urn:li:comment:(activity:7461529543384776705,7462169686772727808)',
            handle: 'vasyl-vdovychenko',
            text: 'Half my workday lately is tab-Z\'ing between terminals',
          },
        ],
      });
      const out = parseComments(html, 'vasyl-vdovychenko');
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe('urn:li:comment:(activity:7461529543384776705,7462169686772727808)');
      expect(out[0].text).toContain('tab-Z');
      expect(out[0].originalPostText).toContain('Argus');
      expect(out[0].originalAuthor).toBe('Aarthi N');
    });

    it('keeps multiple self comments on same parent post (different comment URNs)', () => {
      const html = card({
        cardUrn: 'urn:li:activity:7464106554733019136',
        postAuthor: { handle: 'aarthi-ntrjn', name: 'Aarthi N' },
        postText: 'Introducing Argus',
        comments: [
          {
            id: 'urn:li:comment:(activity:74615,74621)',
            handle: 'vasyl-vdovychenko',
            text: 'First comment',
          },
          {
            id: 'urn:li:comment:(activity:74615,74641)',
            handle: 'vasyl-vdovychenko',
            text: 'Reply follow-up',
            reply: true,
          },
        ],
      });
      const out = parseComments(html, 'vasyl-vdovychenko');
      expect(out).toHaveLength(2);
      expect(out.map((c) => c.text)).toEqual(['First comment', 'Reply follow-up']);
      expect(out.map((c) => c.id)).toEqual([
        'urn:li:comment:(activity:74615,74621)',
        'urn:li:comment:(activity:74615,74641)',
      ]);
    });

    it('skips comments authored by others (not selfHandle)', () => {
      const html = card({
        cardUrn: 'urn:li:activity:1',
        postAuthor: { handle: 'aarthi-ntrjn', name: 'Aarthi N' },
        postText: 'A post',
        comments: [
          { id: 'urn:li:comment:(activity:1,A)', handle: 'someone-else', text: 'theirs' },
          { id: 'urn:li:comment:(activity:1,B)', handle: 'vasyl-vdovychenko', text: 'mine' },
        ],
      });
      const out = parseComments(html, 'vasyl-vdovychenko');
      expect(out).toHaveLength(1);
      expect(out[0].text).toBe('mine');
    });

    it('originalAuthor is the post author, not a commenter', () => {
      // If commenter handle is found FIRST in DOM order, the old parser would
      // pick them as originalAuthor. New parser looks outside comment articles.
      const html = `
        <div data-urn="urn:li:activity:1">
          <a href="/in/post-author/">Post Author Name</a>
          <p dir="ltr">Parent post text long enough to be picked</p>
          <article class="comments-comment-entity" data-id="urn:li:comment:(activity:1,A)">
            <a href="/in/some-commenter/">Some Commenter</a>
            <span dir="ltr">their reply</span>
          </article>
          <article class="comments-comment-entity" data-id="urn:li:comment:(activity:1,B)">
            <a href="/in/vasyl-vdovychenko/">Me</a>
            <span dir="ltr">my reply</span>
          </article>
        </div>
      `;
      const out = parseComments(html, 'vasyl-vdovychenko');
      expect(out).toHaveLength(1);
      expect(out[0].originalAuthor).toBe('Post Author Name');
    });

    it('drops cards without comment articles', () => {
      const html = `<div data-urn="urn:li:activity:1"><p dir="ltr">just a post</p></div>`;
      const out = parseComments(html, 'vasyl-vdovychenko');
      expect(out).toHaveLength(0);
    });

    it('matches articles by data-id alone (anchor fallback if class is renamed)', () => {
      // LinkedIn rotates CSS class names; the URN-prefix data-id is stickier.
      // The parser must still find the comment when only data-id matches.
      const html = `
        <div data-urn="urn:li:activity:1">
          <a href="/in/author/">Author</a>
          <p dir="ltr">parent post body</p>
          <article class="some-future-class-name" data-id="urn:li:comment:(activity:1,Z)">
            <a href="/in/vasyl-vdovychenko/">Me</a>
            <span dir="ltr">future-proof comment</span>
          </article>
        </div>
      `;
      const out = parseComments(html, 'vasyl-vdovychenko');
      expect(out).toHaveLength(1);
      expect(out[0].text).toBe('future-proof comment');
    });

    it('extracts bare timestamp from <time> inside the comment article', () => {
      // Real DOM: <time class="comments-comment-meta__data">1w</time>
      // No bullet — pickRelativeTime alone would return ''.
      const html = `
        <div data-urn="urn:li:activity:1">
          <a href="/in/author/">Author</a>
          <p dir="ltr">a parent post</p>
          <article class="comments-comment-entity" data-id="urn:li:comment:(activity:1,A)">
            <a href="/in/vasyl-vdovychenko/">Me</a>
            <span dir="ltr">a comment</span>
            <time class="comments-comment-meta__data">1w</time>
          </article>
        </div>
      `;
      const out = parseComments(html, 'vasyl-vdovychenko');
      expect(out).toHaveLength(1);
      expect(out[0].timestamp).toBe('1w');
    });
  });
});
