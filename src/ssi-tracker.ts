/**
 * T221 — SSI tracker (popup-side rendering + insight generator).
 *
 * Pure-ish: renderLatest mutates passed-in DOM refs; renderTrend instantiates
 * the injected Chart constructor on the passed-in canvas; getInsight is pure.
 *
 * Chart constructor is injected to keep this module testable without bundling
 * chart.js into the jest jsdom environment.
 */

import type { SsiSnapshot } from './storage-schema';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ─── renderLatest ───────────────────────────────────────────────────────────

export interface LatestRefs {
  total: HTMLElement | null;
  industry: HTMLElement | null;
  network: HTMLElement | null;
  capturedAt: HTMLElement | null;
  components?: {
    establishBrand: HTMLElement | null;
    findRightPeople: HTMLElement | null;
    engageWithInsights: HTMLElement | null;
    buildRelationships: HTMLElement | null;
  };
}

function setText(el: HTMLElement | null | undefined, text: string): void {
  if (el) el.textContent = text;
}

function formatRelativeTime(timestamp: number, now: number): string {
  const diffMs = now - timestamp;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function renderLatest(snapshot: SsiSnapshot | null, refs: LatestRefs): void {
  if (!snapshot) {
    setText(refs.total, '—');
    setText(refs.industry, 'no data');
    setText(refs.network, 'no data');
    setText(refs.capturedAt, '');
    return;
  }
  setText(refs.total, `${snapshot.total}`);
  setText(refs.industry, snapshot.industryRank);
  setText(refs.network, snapshot.networkRank);
  setText(refs.capturedAt, formatRelativeTime(snapshot.capturedAt, Date.now()));
  if (refs.components) {
    setText(refs.components.establishBrand, snapshot.components.establishBrand.toFixed(1));
    setText(refs.components.findRightPeople, snapshot.components.findRightPeople.toFixed(1));
    setText(refs.components.engageWithInsights, snapshot.components.engageWithInsights.toFixed(1));
    setText(refs.components.buildRelationships, snapshot.components.buildRelationships.toFixed(1));
  }
}

// ─── renderTrend ────────────────────────────────────────────────────────────

interface ChartLike {
  destroy: () => void;
  update?: () => void;
}
interface ChartConfig {
  type: 'line';
  data: {
    labels: string[];
    datasets: Array<{
      label: string;
      data: number[];
      borderColor?: string;
      backgroundColor?: string;
      tension?: number;
      fill?: boolean;
    }>;
  };
  options?: Record<string, unknown>;
}
type ChartCtor = new (canvas: HTMLCanvasElement, config: ChartConfig) => ChartLike;

export function renderTrend(
  snapshots: SsiSnapshot[],
  canvas: HTMLCanvasElement,
  Chart: ChartCtor
): ChartLike | null {
  if (snapshots.length === 0) return null;

  const labels = snapshots.map((s) =>
    new Date(s.capturedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  );
  const totalData = snapshots.map((s) => s.total);

  const config: ChartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'SSI total',
          data: totalData,
          borderColor: '#0a66c2',
          backgroundColor: 'rgba(10, 102, 194, 0.15)',
          tension: 0.25,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { min: 0, max: 100, ticks: { stepSize: 20 } },
      },
      plugins: {
        legend: { display: false },
      },
    },
  };

  return new Chart(canvas, config);
}

// ─── getInsight ─────────────────────────────────────────────────────────────

const COMPONENT_LABELS: Record<keyof SsiSnapshot['components'], string> = {
  establishBrand: 'Establish brand',
  findRightPeople: 'Find right people',
  engageWithInsights: 'Engage with insights',
  buildRelationships: 'Build relationships',
};

/**
 * One-sentence actionable insight for the popup chip.
 * Compares latest snapshot against the snapshot from ~7 days ago and surfaces
 * the dominant trend + the component that moved most.
 */
export function getInsight(snapshots: SsiSnapshot[], now: number = Date.now()): string {
  if (snapshots.length === 0) {
    return 'No data yet — click Refresh now to capture your first SSI snapshot.';
  }
  const last = snapshots[snapshots.length - 1];
  const ageDays = Math.floor((now - last.capturedAt) / ONE_DAY_MS);

  if (ageDays > 7) {
    return `Last capture ${ageDays} days ago. Click Refresh now to update your SSI.`;
  }
  if (snapshots.length === 1) {
    return `Baseline captured at ${last.total}/100. Engage daily and check back in a week.`;
  }

  // Find a snapshot from ~7 days back (closest at-or-before that point).
  const weekAgoTarget = now - 6 * ONE_DAY_MS;
  let baseline: SsiSnapshot | null = null;
  for (const s of snapshots) {
    if (s.capturedAt <= weekAgoTarget) baseline = s;
    else break;
  }
  if (!baseline) {
    return `Total ${last.total}/100. Capture more snapshots over the next week to see a trend.`;
  }

  const delta = last.total - baseline.total;
  if (Math.abs(delta) < 2) {
    return `Total flat at ${last.total}/100 over the past week — engage daily to break through.`;
  }

  // Identify component with the biggest move (same sign as total move).
  type Key = keyof SsiSnapshot['components'];
  const keys = Object.keys(last.components) as Key[];
  const componentDeltas: Array<[Key, number]> = keys.map((k) => [
    k,
    last.components[k] - baseline!.components[k],
  ]);
  componentDeltas.sort((a, b) => (delta > 0 ? b[1] - a[1] : a[1] - b[1]));
  const [topKey, topDelta] = componentDeltas[0];
  const topLabel = COMPONENT_LABELS[topKey];

  if (delta > 0) {
    return `Total rose ${delta} points this week to ${last.total}/100. "${topLabel}" led with +${topDelta.toFixed(1)} — keep it up.`;
  }
  return `Total dropped ${Math.abs(delta)} points this week to ${last.total}/100. "${topLabel}" lost ${Math.abs(topDelta).toFixed(1)} — open Engagement Queue to recover.`;
}
