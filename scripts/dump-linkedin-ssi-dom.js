/**
 * scripts/dump-linkedin-ssi-dom.js
 *
 * Paste into DevTools Console while on linkedin.com/sales/ssi.
 * Dumps real selectors + sample text so we can update ssi-parser.ts against
 * live 2026 DOM (Bug Report 2026-05-15: "Could not locate .ssi-score-table__
 * current-ssi-score").
 *
 * Captures: candidate selectors that contain numeric content, plus the full
 * text of likely score containers. NO PII — just numbers and structural class
 * names. Auto-copies JSON to clipboard.
 */

(() => {
  const out = {
    capturedAt: new Date().toISOString(),
    url: location.href,
    candidates: {},
    rawText: {},
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

  // 1. Total score candidates
  inspectSelectors('total', [
    '.ssi-score-table__current-ssi-score',
    '.ssi-score-summary__current-score',
    '.ssi-page-container .text-display-1',
    '[data-test-id="ssi-current-score"]',
    'main .text-display-1',
  ]);

  // 2. Component cards candidates
  inspectSelectors('componentCards', [
    '.ssi-component-card',
    '.ssi-component',
    '[data-test-id^="ssi-component"]',
    'main section',
    'main article',
  ]);

  // 3. Industry/network rank candidates
  inspectSelectors('ranks', [
    '.ssi-ranking-statement',
    '.ssi-ranking',
    'main p',
  ]);

  // 4. Raw text of main + page — for the text-pattern fallback diagnosis
  out.rawText.main = trim(document.querySelector('main')?.textContent, 2000);
  out.rawText.body = trim(document.body?.textContent, 2000);

  // 5. Detailed scan for elements containing the canonical component titles
  out.componentDetail = {};
  const titles = [
    'Establish your professional brand',
    'Find the right people',
    'Engage with insights',
    'Build relationships',
  ];
  for (const title of titles) {
    const matches = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const txt = el.textContent ?? '';
      if (txt.includes(title) && txt.length < 200) {
        matches.push({
          tag: el.tagName.toLowerCase(),
          className: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
          text: trim(txt, 150),
        });
        if (matches.length >= 3) break;
      }
    }
    out.componentDetail[title] = matches;
  }

  // 6. Big-number scan — find all elements with just a number that could be the total
  out.bigNumbers = [];
  const numEls = document.querySelectorAll('div, span');
  for (const el of numEls) {
    const txt = (el.textContent ?? '').trim();
    if (/^\d{1,3}$/.test(txt) && parseInt(txt, 10) >= 0 && parseInt(txt, 10) <= 100) {
      out.bigNumbers.push({
        tag: el.tagName.toLowerCase(),
        className: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
        text: txt,
      });
      if (out.bigNumbers.length >= 10) break;
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('ReplyMate SSI page DOM snapshot');
  console.log('Copy the JSON below and paste into the ReplyMate chat:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(JSON.stringify(out, null, 2));

  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(JSON.stringify(out, null, 2));
      console.log('✅ Snapshot also copied to clipboard.');
    }
  } catch {
    // No permission — user reads from console.
  }
  return out;
})();
