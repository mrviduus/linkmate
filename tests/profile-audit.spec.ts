/**
 * Profile audit rule engine — pass/fail matrix per check.
 *
 * MVP works on existing IDB UserProfile fields, no parser changes.
 */

import { auditProfile, type AuditCheckId } from '../src/profile-audit';
import type { UserProfile } from '../src/lib/idb';

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    capturedAt: '2026-05-01T00:00:00.000Z',
    profileUrl: 'https://www.linkedin.com/in/vasyl/',
    name: 'Vasyl V.',
    headline: 'Senior engineer',
    location: 'Kyiv, Ukraine',
    connectionsCount: 500,
    followersCount: 600,
    about: 'A'.repeat(120),
    skills: ['TypeScript', 'React', 'Node', 'AWS', 'Postgres'],
    experience: [
      { title: 'Senior engineer', company: 'Acme', dateRange: '2022–present' },
    ],
    education: [{ school: 'KPI', degree: 'BSc', field: 'CS' }],
    certifications: [],
    languages: [],
    recentPosts: [],
    recentComments: [],
    ...overrides,
  };
}

function findCheck(checks: ReturnType<typeof auditProfile>['checks'], id: AuditCheckId) {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`Check ${id} missing`);
  return c;
}

describe('auditProfile — happy path', () => {
  it('all-pass profile reports score 100 and zero failures', () => {
    const report = auditProfile(profile());
    expect(report.passed).toBe(6);
    expect(report.total).toBe(6);
    expect(report.score).toBe(100);
    expect(report.failed).toEqual([]);
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('orders checks consistently and includes every id once', () => {
    const ids = auditProfile(profile()).checks.map((c) => c.id);
    expect(ids).toEqual([
      'currentPosition',
      'education',
      'skills',
      'about',
      'location',
      'connections',
    ]);
  });
});

describe('currentPosition', () => {
  it('fails when experience array empty', () => {
    const r = auditProfile(profile({ experience: [] }));
    expect(findCheck(r.checks, 'currentPosition').status).toBe('fail');
  });
  it('fails when title missing', () => {
    const r = auditProfile(profile({ experience: [{ title: '', company: 'Acme', dateRange: '' }] }));
    expect(findCheck(r.checks, 'currentPosition').status).toBe('fail');
  });
  it('fails when company missing', () => {
    const r = auditProfile(profile({ experience: [{ title: 'Eng', company: '', dateRange: '' }] }));
    expect(findCheck(r.checks, 'currentPosition').status).toBe('fail');
  });
  it('passes when title + company present', () => {
    const r = auditProfile(profile({ experience: [{ title: 'Eng', company: 'X', dateRange: '' }] }));
    const c = findCheck(r.checks, 'currentPosition');
    expect(c.status).toBe('pass');
    expect(c.detail).toContain('Eng');
    expect(c.detail).toContain('X');
  });
});

describe('education', () => {
  it('fails when array empty', () => {
    const r = auditProfile(profile({ education: [] }));
    expect(findCheck(r.checks, 'education').status).toBe('fail');
  });
  it('fails when school is blank', () => {
    const r = auditProfile(profile({ education: [{ school: '   ' }] }));
    expect(findCheck(r.checks, 'education').status).toBe('fail');
  });
  it('passes when at least one school is present', () => {
    const r = auditProfile(profile({ education: [{ school: 'MIT' }] }));
    expect(findCheck(r.checks, 'education').status).toBe('pass');
  });
});

describe('skills', () => {
  it('fails when less than 5 skills', () => {
    const r = auditProfile(profile({ skills: ['a', 'b', 'c'] }));
    const c = findCheck(r.checks, 'skills');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('3/5');
  });
  it('ignores blank entries when counting', () => {
    const r = auditProfile(profile({ skills: ['a', 'b', 'c', '', '  ', 'd'] }));
    expect(findCheck(r.checks, 'skills').status).toBe('fail');
  });
  it('passes at exactly 5', () => {
    const r = auditProfile(profile({ skills: ['a', 'b', 'c', 'd', 'e'] }));
    expect(findCheck(r.checks, 'skills').status).toBe('pass');
  });
});

describe('about', () => {
  it('fails on empty about', () => {
    const r = auditProfile(profile({ about: '' }));
    const c = findCheck(r.checks, 'about');
    expect(c.status).toBe('fail');
    expect(c.detail).toBe('empty');
  });
  it('fails below 50 chars', () => {
    const r = auditProfile(profile({ about: 'hi' }));
    expect(findCheck(r.checks, 'about').status).toBe('fail');
  });
  it('passes at 50 chars exactly', () => {
    const r = auditProfile(profile({ about: 'a'.repeat(50) }));
    expect(findCheck(r.checks, 'about').status).toBe('pass');
  });
});

describe('location', () => {
  it('fails when missing', () => {
    const r = auditProfile(profile({ location: undefined }));
    expect(findCheck(r.checks, 'location').status).toBe('fail');
  });
  it('fails when whitespace-only', () => {
    const r = auditProfile(profile({ location: '   ' }));
    expect(findCheck(r.checks, 'location').status).toBe('fail');
  });
  it('passes when set', () => {
    const r = auditProfile(profile({ location: 'Berlin' }));
    expect(findCheck(r.checks, 'location').status).toBe('pass');
  });
});

describe('connections', () => {
  it('fails below 50', () => {
    const r = auditProfile(profile({ connectionsCount: 12 }));
    const c = findCheck(r.checks, 'connections');
    expect(c.status).toBe('fail');
    expect(c.detail).toBe('12/50');
  });
  it('fails when undefined (treats as 0)', () => {
    const r = auditProfile(profile({ connectionsCount: undefined }));
    expect(findCheck(r.checks, 'connections').status).toBe('fail');
  });
  it('passes at exactly 50', () => {
    const r = auditProfile(profile({ connectionsCount: 50 }));
    expect(findCheck(r.checks, 'connections').status).toBe('pass');
  });
  it('renders 500+ for counts >= 500', () => {
    const r = auditProfile(profile({ connectionsCount: 742 }));
    expect(findCheck(r.checks, 'connections').detail).toBe('500+');
  });
});

describe('aggregate report', () => {
  it('partial fail reports correct score and failed[] in order', () => {
    const r = auditProfile(
      profile({ about: '', skills: ['a'], education: [] })
    );
    expect(r.passed).toBe(3);
    expect(r.total).toBe(6);
    expect(r.score).toBe(50);
    expect(r.failed).toEqual(['education', 'skills', 'about']);
  });

  it('all-fail profile reports score 0', () => {
    const r = auditProfile(
      profile({
        experience: [],
        education: [],
        skills: [],
        about: '',
        location: '',
        connectionsCount: 0,
      })
    );
    expect(r.score).toBe(0);
    expect(r.passed).toBe(0);
  });
});
