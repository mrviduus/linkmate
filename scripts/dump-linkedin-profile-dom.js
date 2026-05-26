/**
 * scripts/dump-linkedin-profile-dom.js
 *
 * Paste this entire file into DevTools Console while on your OWN LinkedIn
 * profile page (linkedin.com/in/{your-handle}). It dumps the selectors that
 * actually exist for headline, About, skills, and recent activity in 2026,
 * so we can update profile-parser.ts against real DOM instead of synthetic
 * fixture guesses.
 *
 * The script logs JSON to console. Copy-paste back to the ReplyMate repo
 * issue / chat. NO data leaves your browser unless you copy + paste it.
 *
 * What it captures:
 *   - Candidate selectors that contained text matching common patterns
 *   - First 200 chars of the text content under each match
 *   - For skills + activity: every list-item-like child with its first 80 chars
 *
 * What it does NOT capture:
 *   - Profile photo URLs, contact info, connection details, message contents,
 *     anything from the right rail (recommendations, ads, etc.)
 */

(() => {
  const out = {
    capturedAt: new Date().toISOString(),
    url: location.href,
    candidates: {},
  };

  function trim(text, max = 200) {
    if (!text) return '';
    return text.trim().replace(/\s+/g, ' ').slice(0, max);
  }

  function inspectSelectors(label, selectors) {
    out.candidates[label] = [];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length === 0) continue;
        out.candidates[label].push({
          selector: sel,
          count: els.length,
          firstText: trim(els[0]?.textContent),
        });
      } catch {
        // invalid selector — ignore
      }
    }
  }

  // 1. Name candidates
  inspectSelectors('fullName', [
    '.text-heading-xlarge',
    'h1.text-heading-xlarge',
    '.pv-text-details__left-panel h1',
    '.pv-top-card h1',
    'main h1',
  ]);

  // 2. Headline candidates
  inspectSelectors('headline', [
    '.text-body-medium.break-words',
    '.pv-text-details__left-panel .text-body-medium',
    '.pv-top-card .text-body-medium',
    '.ph5 .text-body-medium',
    'main .text-body-medium',
  ]);

  // 3. About section candidates
  inspectSelectors('about', [
    '#about',
    'section[data-section="summary"]',
    'section.summary',
    '#about + div',
    '#about ~ div .inline-show-more-text',
    '.pv-shared-text-with-see-more',
    'div.display-flex.ph5.pv3 .inline-show-more-text',
  ]);

  // 4. Skills section candidates
  inspectSelectors('skills', [
    '#skills',
    'section[data-section="skills"]',
    '#skills ~ div .pvs-entity',
    '#skills ~ div .pvs-list__paged-list-item',
    'div[data-view-name="profile-card"]',
  ]);

  // 5. Activity / recent posts candidates
  inspectSelectors('activity', [
    '#content_collections',
    'section[data-section="posts"]',
    '#content_collections ~ div .feed-shared-update-v2',
    'section.artdeco-card .update-components-text',
  ]);

  // Detailed skill extraction (try multiple paths)
  out.skillsDetail = [];
  const skillContainers = [
    document.querySelector('#skills')?.parentElement,
    document.querySelector('section[data-section="skills"]'),
    document.querySelector('#skills')?.nextElementSibling,
  ].filter(Boolean);
  for (const container of skillContainers) {
    const items = container.querySelectorAll('li, .pvs-entity, .pvs-list__paged-list-item');
    out.skillsDetail.push({
      containerTag: container.tagName.toLowerCase(),
      containerId: container.id || null,
      childCount: items.length,
      firstFive: Array.from(items)
        .slice(0, 5)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          className: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
          text: trim(el.textContent, 80),
        })),
    });
    if (out.skillsDetail.length >= 3) break;
  }

  // Headline detail (where exactly does the headline string live?)
  const myHeadlineCandidates = document.querySelectorAll('.text-body-medium');
  out.headlineDetail = Array.from(myHeadlineCandidates)
    .slice(0, 5)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      className: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
      text: trim(el.textContent, 120),
    }));

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('ReplyMate DOM snapshot (Bug #1 — parser selector fix)');
  console.log('Copy the JSON below and paste into the ReplyMate chat / issue:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(JSON.stringify(out, null, 2));

  // Also copy automatically to clipboard if available
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(JSON.stringify(out, null, 2));
      console.log('✅ Snapshot also copied to clipboard.');
    }
  } catch {
    // No permission — user reads it from console.
  }
  return out;
})();
