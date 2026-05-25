import { findByText, firstNum, PILLAR_LABELS, waitFor } from '../lib/selectors';
import { todayISO } from '../lib/storage';
import type { Msg, SsiSample } from '../lib/types';

/**
 * SSI page scraper. LinkedIn renders /sales/ssi client-side; we wait for
 * the dial + pillar headings to appear, then read scores via text matching.
 * Numbers shown: total /100 and each pillar /25.
 */

function readTotal(): number | null {
  // Heuristic: the largest standalone integer in the main content area, 0..100.
  const main = document.querySelector('main') ?? document.body;
  const candidates = Array.from(main.querySelectorAll<HTMLElement>('div, span, p'));
  let best: number | null = null;
  for (const el of candidates) {
    const txt = el.innerText?.trim() ?? '';
    if (!/^\d{1,3}(\.\d+)?$/.test(txt)) continue;
    const n = Number(txt);
    if (n >= 0 && n <= 100) {
      if (best === null || n > best) best = n;
    }
  }
  return best;
}

function readPillar(labels: readonly string[]): number | null {
  for (const label of labels) {
    const heading = findByText(document.body, 'h2, h3, h4, section, div', label);
    if (!heading) continue;
    // Search ancestors a few levels up for a "/25" or "X out of 25" pattern.
    let node: HTMLElement | null = heading;
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
      const text = node.innerText ?? '';
      // prefer explicit "X / 25" or "X out of 25"
      const m =
        text.match(/(\d{1,2}(?:\.\d+)?)\s*(?:\/|out of)\s*25/i) ||
        text.match(/score[:\s]+(\d{1,2}(?:\.\d+)?)/i);
      if (m) return Number(m[1]);
    }
    // Fallback: first number in the heading row
    const n = firstNum(heading.innerText);
    if (n !== null && n <= 25) return n;
  }
  return null;
}

async function run() {
  try {
    const total = await waitFor(readTotal, 10000);
    const brand = readPillar(PILLAR_LABELS.brand);
    const finding = readPillar(PILLAR_LABELS.finding);
    const engaging = readPillar(PILLAR_LABELS.engaging);
    const building = readPillar(PILLAR_LABELS.building);

    if (brand === null || finding === null || engaging === null || building === null) {
      console.warn('[linkmate] could not read all SSI pillars', { brand, finding, engaging, building });
      return;
    }

    const sample: SsiSample = {
      date: todayISO(),
      total,
      brand,
      finding,
      engaging,
      building,
    };
    const msg: Msg = { type: 'SSI_SAVED', sample };
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('[linkmate] sendMessage error', chrome.runtime.lastError);
        return;
      }
      console.info('[linkmate] SSI saved', sample, resp);
    });
  } catch (err) {
    console.warn('[linkmate] SSI scrape failed', err);
  }
}

void run();
