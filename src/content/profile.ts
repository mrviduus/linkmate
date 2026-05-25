import { findByText, waitFor } from '../lib/selectors';
import { todayISO } from '../lib/storage';
import type { Msg, ProfileAudit } from '../lib/types';

/**
 * LinkedIn profile audit. Runs on any /in/<slug>/ page. Only the *viewer's own*
 * profile is meaningful, but we score whatever is shown; user can ignore on
 * other profiles. Weights tuned to match SSI-relevant signals.
 */

type Check = { key: string; label: string; weight: number; pass: boolean };

function hasBanner(): boolean {
  // Top profile header has a banner image; LinkedIn renders it as a background-image
  // or an <img> with a recognizable URL pattern.
  const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('img'));
  return imgs.some(
    (i) =>
      /profile-displaybackgroundimage/i.test(i.src) ||
      /profile-displaybackgroundimage/i.test(i.alt),
  );
}

function headlineText(): string {
  // The headline lives right under the name in the top card. Use the page <title>
  // as a fallback; LinkedIn page title is "Name - Headline | LinkedIn".
  const top = document.querySelector('main section.artdeco-card, main section');
  if (top) {
    const cands = Array.from(top.querySelectorAll<HTMLElement>('div.text-body-medium, .text-body-medium'));
    for (const c of cands) {
      const t = c.innerText?.trim();
      if (t && t.length > 5 && t.length < 240) return t;
    }
  }
  const m = document.title.match(/^[^-]+-\s*(.+?)\s*\|\s*LinkedIn/);
  return m ? m[1] : '';
}

function aboutText(): string {
  const heading = findByText(document.body, 'h2, h3, div, span', 'About');
  if (!heading) return '';
  // walk up to a section, then collect its text below the heading
  let section: HTMLElement | null = heading;
  for (let i = 0; i < 6 && section; i++, section = section.parentElement) {
    if (section.tagName === 'SECTION') break;
  }
  if (!section) return '';
  const txt = section.innerText?.replace(/^About\s*/i, '').trim() ?? '';
  return txt;
}

function countSection(label: string): number {
  // Each profile section has a heading; count list items below.
  const heading = findByText(document.body, 'h2, h3, span', label);
  if (!heading) return 0;
  let section: HTMLElement | null = heading;
  for (let i = 0; i < 6 && section; i++, section = section.parentElement) {
    if (section.tagName === 'SECTION') break;
  }
  if (!section) return 0;
  return section.querySelectorAll('li').length;
}

function audit(): ProfileAudit {
  const headline = headlineText();
  const about = aboutText();
  const skills = countSection('Skills');
  const featured = countSection('Featured');
  const experience = countSection('Experience');
  const recent = countSection('Activity');

  const checks: Check[] = [
    { key: 'banner', label: 'Custom banner image', weight: 10, pass: hasBanner() },
    { key: 'headline', label: 'Headline length ≥ 60 chars', weight: 15, pass: headline.length >= 60 },
    { key: 'about', label: 'About section ≥ 400 chars', weight: 20, pass: about.length >= 400 },
    { key: 'skills', label: 'At least 10 skills', weight: 15, pass: skills >= 10 },
    { key: 'featured', label: '≥ 3 Featured items', weight: 10, pass: featured >= 3 },
    { key: 'experience', label: '≥ 2 experience entries', weight: 10, pass: experience >= 2 },
    { key: 'activity', label: 'Recent activity visible', weight: 20, pass: recent >= 1 },
  ];

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.filter((c) => c.pass).reduce((s, c) => s + c.weight, 0);
  const score = Math.round((earned / totalWeight) * 100);
  const missing = checks.filter((c) => !c.pass).map((c) => c.label);

  return { score, missing, lastRun: todayISO() };
}

async function run() {
  try {
    // Wait until the top profile card has rendered
    await waitFor(() => document.querySelector('main section'), 10000);
    // Give SPA hydration a beat
    await new Promise((r) => setTimeout(r, 800));
    const result = audit();
    const msg: Msg = { type: 'PROFILE_AUDIT_SAVED', audit: result };
    chrome.runtime.sendMessage(msg, () => {
      if (chrome.runtime.lastError) {
        console.warn('[linkmate] profile audit sendMessage', chrome.runtime.lastError);
        return;
      }
      console.info('[linkmate] profile audit', result);
    });
  } catch (err) {
    console.warn('[linkmate] profile audit failed', err);
  }
}

void run();
