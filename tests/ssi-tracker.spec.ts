/**
 * T220 — SSI tracker spec (popup-side rendering + insight).
 * Drives src/ssi-tracker.ts (T221).
 */

import { renderLatest, renderTrend, getInsight } from '../src/ssi-tracker';
import type { SsiSnapshot } from '../src/storage-schema';

const NOW = 1_700_000_000_000;

function snap(overrides: Partial<SsiSnapshot> = {}, capturedAt = NOW): SsiSnapshot {
  return {
    total: 23,
    components: {
      establishBrand: 6,
      findRightPeople: 5,
      engageWithInsights: 7,
      buildRelationships: 5,
    },
    industryRank: 'Top 75%',
    networkRank: 'Top 88%',
    capturedAt,
    ...overrides,
  };
}

function makeRefs() {
  const container = document.createElement('div');
  container.innerHTML = `
    <span class="total"></span>
    <span class="industry"></span>
    <span class="network"></span>
    <span class="capturedAt"></span>
    <span class="comp-brand"></span>
    <span class="comp-find"></span>
    <span class="comp-engage"></span>
    <span class="comp-build"></span>
  `;
  document.body.appendChild(container);
  return {
    container,
    total: container.querySelector('.total') as HTMLElement,
    industry: container.querySelector('.industry') as HTMLElement,
    network: container.querySelector('.network') as HTMLElement,
    capturedAt: container.querySelector('.capturedAt') as HTMLElement,
    components: {
      establishBrand: container.querySelector('.comp-brand') as HTMLElement,
      findRightPeople: container.querySelector('.comp-find') as HTMLElement,
      engageWithInsights: container.querySelector('.comp-engage') as HTMLElement,
      buildRelationships: container.querySelector('.comp-build') as HTMLElement,
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('renderLatest', () => {
  it('writes total, ranks, capturedAt, and all 4 components into refs', () => {
    const refs = makeRefs();
    renderLatest(snap(), refs);
    expect(refs.total.textContent).toContain('23');
    expect(refs.industry.textContent).toContain('Top 75%');
    expect(refs.network.textContent).toContain('Top 88%');
    expect(refs.capturedAt.textContent).not.toBe('');
    expect(refs.components.establishBrand.textContent).toContain('6');
    expect(refs.components.engageWithInsights.textContent).toContain('7');
  });

  it('renders "no data" state when snapshot is null', () => {
    const refs = makeRefs();
    renderLatest(null, refs);
    expect(refs.total.textContent).toMatch(/—|no data/i);
  });

  it('tolerates partial refs (missing optional elements)', () => {
    const refs = makeRefs();
    expect(() =>
      renderLatest(snap(), { total: refs.total, industry: null, network: null, capturedAt: null }),
    ).not.toThrow();
  });
});

describe('renderTrend', () => {
  it('returns null and does NOT instantiate Chart when snapshots empty', () => {
    const MockChart = jest.fn();
    const canvas = document.createElement('canvas');
    const result = renderTrend([], canvas, MockChart as never);
    expect(result).toBeNull();
    expect(MockChart).not.toHaveBeenCalled();
  });

  it('instantiates Chart with line config for 1 snapshot', () => {
    const instance = { destroy: jest.fn() };
    const MockChart = jest.fn().mockImplementation(() => instance);
    const canvas = document.createElement('canvas');
    const result = renderTrend([snap()], canvas, MockChart as never);
    expect(MockChart).toHaveBeenCalledTimes(1);
    const config = MockChart.mock.calls[0][1];
    expect(config.type).toBe('line');
    expect(result).toBe(instance);
  });

  it('handles 30 snapshots without error', () => {
    const MockChart = jest.fn().mockImplementation(() => ({ destroy: jest.fn() }));
    const snapshots = Array.from({ length: 30 }, (_, i) =>
      snap({ total: 20 + i }, NOW - (30 - i) * 24 * 60 * 60 * 1000),
    );
    const canvas = document.createElement('canvas');
    expect(() => renderTrend(snapshots, canvas, MockChart as never)).not.toThrow();
    const config = MockChart.mock.calls[0][1];
    expect(config.data.labels).toHaveLength(30);
    expect(config.data.datasets[0].data).toHaveLength(30);
  });

  it('handles 90 snapshots (max)', () => {
    const MockChart = jest.fn().mockImplementation(() => ({ destroy: jest.fn() }));
    const snapshots = Array.from({ length: 90 }, (_, i) =>
      snap({ total: 20 + (i % 30) }, NOW - (90 - i) * 24 * 60 * 60 * 1000),
    );
    const canvas = document.createElement('canvas');
    renderTrend(snapshots, canvas, MockChart as never);
    expect(MockChart).toHaveBeenCalledTimes(1);
    const config = MockChart.mock.calls[0][1];
    expect(config.data.datasets[0].data).toHaveLength(90);
  });
});

describe('getInsight', () => {
  it('returns onboarding message for 0 snapshots', () => {
    expect(getInsight([], NOW)).toMatch(/no data|capture/i);
  });

  it('returns baseline message for 1 snapshot', () => {
    expect(getInsight([snap()], NOW)).toMatch(/baseline|first/i);
  });

  it('flags missed-week if last snapshot > 7 days old', () => {
    const old = snap({}, NOW - 10 * 24 * 60 * 60 * 1000);
    const msg = getInsight([old], NOW);
    expect(msg).toMatch(/10|days ago|refresh/i);
  });

  it('flags rising trend (+5 over week)', () => {
    const baseline = snap({ total: 20 }, NOW - 7 * 24 * 60 * 60 * 1000);
    const current = snap({ total: 26 }, NOW);
    const msg = getInsight([baseline, current], NOW);
    expect(msg.toLowerCase()).toMatch(/rose|up|gained/);
  });

  it('flags falling trend (−5 over week)', () => {
    const baseline = snap({ total: 30 }, NOW - 7 * 24 * 60 * 60 * 1000);
    const current = snap({ total: 24 }, NOW);
    const msg = getInsight([baseline, current], NOW);
    expect(msg.toLowerCase()).toMatch(/dropped|down|lost|recover/);
  });

  it('flags flat trend (<2 point change)', () => {
    const baseline = snap({ total: 23 }, NOW - 7 * 24 * 60 * 60 * 1000);
    const current = snap({ total: 24 }, NOW);
    expect(getInsight([baseline, current], NOW).toLowerCase()).toMatch(/flat|steady|same/);
  });

  it('mentions the component that gained most when total rose', () => {
    const baseline = snap(
      {
        total: 20,
        components: {
          establishBrand: 5,
          findRightPeople: 5,
          engageWithInsights: 5,
          buildRelationships: 5,
        },
      },
      NOW - 7 * 24 * 60 * 60 * 1000,
    );
    const current = snap(
      {
        total: 30,
        components: {
          establishBrand: 5,
          findRightPeople: 5,
          engageWithInsights: 15, // gained 10
          buildRelationships: 5,
        },
      },
      NOW,
    );
    const msg = getInsight([baseline, current], NOW);
    expect(msg.toLowerCase()).toMatch(/engage/);
  });
});
