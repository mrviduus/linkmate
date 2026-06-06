import { resolveTimestampMs } from '../src/lib/relative-time';

const NOW = 1_700_000_000_000;
const MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000,
  y: 31_536_000_000,
};

describe('resolveTimestampMs', () => {
  it.each([
    ['30s', NOW - 30 * MS.s],
    ['10m', NOW - 10 * MS.m],
    ['5h', NOW - 5 * MS.h],
    ['3d', NOW - 3 * MS.d],
    ['1w', NOW - 1 * MS.w],
    ['7mo', NOW - 7 * MS.mo],
    ['2y', NOW - 2 * MS.y],
  ])('abbreviated "%s"', (raw, expected) => {
    expect(resolveTimestampMs(raw, NOW)).toBe(expected);
  });

  it('distinguishes "m" (minute) from "mo" (month)', () => {
    expect(resolveTimestampMs('5m', NOW)).toBe(NOW - 5 * MS.m);
    expect(resolveTimestampMs('5mo', NOW)).toBe(NOW - 5 * MS.mo);
  });

  it.each([
    ['3 days ago', NOW - 3 * MS.d],
    ['1 week', NOW - 1 * MS.w],
    ['7 months ago', NOW - 7 * MS.mo],
    ['2 years ago', NOW - 2 * MS.y],
    ['15 minutes', NOW - 15 * MS.m],
  ])('word form "%s"', (raw, expected) => {
    expect(resolveTimestampMs(raw, NOW)).toBe(expected);
  });

  it('parses absolute dates', () => {
    expect(resolveTimestampMs('2026-05-05', NOW)).toBe(Date.parse('2026-05-05'));
  });

  it('returns null for empty / unparseable input', () => {
    expect(resolveTimestampMs('', NOW)).toBeNull();
    expect(resolveTimestampMs(null, NOW)).toBeNull();
    expect(resolveTimestampMs(undefined, NOW)).toBeNull();
    expect(resolveTimestampMs('garbage', NOW)).toBeNull();
  });
});
