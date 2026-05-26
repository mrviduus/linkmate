import { weakestPillar, allQuotasHit, type WeeklyProgress } from '../src/cadence';
import type { CadenceTargets } from '../src/storage-schema';

function p(done: number, target: number) {
  return { done, target, pct: target === 0 ? 100 : Math.min(100, Math.round((done / target) * 100)) };
}

const targets: CadenceTargets = { brand: 1, finding: 5, engaging: 3, building: 2 };

describe('cadence.weakestPillar', () => {
  it('picks pillar with lowest pct of target', () => {
    const progress: WeeklyProgress = {
      brand: p(1, 1), // 100%
      finding: p(2, 5), // 40%
      engaging: p(1, 3), // 33%  ← weakest
      building: p(1, 2), // 50%
    };
    expect(weakestPillar(progress)).toBe('engaging');
  });

  it('breaks ties by larger absolute gap', () => {
    const progress: WeeklyProgress = {
      brand: p(0, 0), // 100% (target=0 → trivially met)
      finding: p(0, 10), // 0%, gap 10  ← weakest
      engaging: p(0, 3), // 0%, gap 3
      building: p(0, 2), // 0%, gap 2
    };
    expect(weakestPillar(progress)).toBe('finding');
  });

  it('treats 0-target pillars as met (pct=100)', () => {
    const progress: WeeklyProgress = {
      brand: p(0, 0),
      finding: p(5, 5), // 100%
      engaging: p(2, 3), // 66%  ← weakest
      building: p(2, 2), // 100%
    };
    expect(weakestPillar(progress)).toBe('engaging');
  });
});

describe('cadence.allQuotasHit', () => {
  it('returns true when all positive-target pillars met', () => {
    const progress: WeeklyProgress = {
      brand: p(1, 1),
      finding: p(5, 5),
      engaging: p(3, 3),
      building: p(2, 2),
    };
    expect(allQuotasHit(progress, targets)).toBe(true);
  });

  it('returns false on a single miss', () => {
    const progress: WeeklyProgress = {
      brand: p(1, 1),
      finding: p(5, 5),
      engaging: p(2, 3), // miss
      building: p(2, 2),
    };
    expect(allQuotasHit(progress, targets)).toBe(false);
  });

  it('ignores pillars with 0 target', () => {
    const progress: WeeklyProgress = {
      brand: p(0, 0),
      finding: p(5, 5),
      engaging: p(3, 3),
      building: p(2, 2),
    };
    expect(allQuotasHit(progress, { ...targets, brand: 0 })).toBe(true);
  });

  it('counts done > target as hit (over-achieving)', () => {
    const progress: WeeklyProgress = {
      brand: p(2, 1),
      finding: p(7, 5),
      engaging: p(5, 3),
      building: p(3, 2),
    };
    expect(allQuotasHit(progress, targets)).toBe(true);
  });
});
