import { describe, expect, it } from 'vitest';
import { addDays, buildRange } from '@/lib/metrics/analytics';

describe('addDays (calendar arithmetic, never instants)', () => {
  it.each([
    ['2026-10-05', 1, '2026-10-06'],
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2028-03-01', -1, '2028-02-29'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-10-05', -29, '2026-09-06'],
    ['2026-10-05', 0, '2026-10-05'],
  ])('%s %+d -> %s', (day, delta, expected) => {
    expect(addDays(day, delta)).toBe(expected);
  });
});

describe('buildRange', () => {
  it('is N local days ending today, oldest first, starting at local midnight', () => {
    const range = buildRange(new Date('2026-10-05T11:30:00Z'), 7, 'Africa/Kampala');
    expect(range.dates).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
    expect(range.since.toISOString()).toBe('2026-09-28T21:00:00.000Z'); // 00:00 on the 29th in Kampala (UTC+3)
    expect(range.until.toISOString()).toBe('2026-10-05T11:30:00.000Z');
  });

  it('"today" is the OWNER’s today: at 22:30 UTC it is already tomorrow in Kampala', () => {
    const range = buildRange(new Date('2026-10-05T22:30:00Z'), 7, 'Africa/Kampala');
    expect(range.dates.at(-1)).toBe('2026-10-06');
  });

  it('has 30 and 90 day ranges', () => {
    expect(buildRange(new Date('2026-10-05T11:30:00Z'), 30, 'Africa/Kampala').dates).toHaveLength(30);
    const ninety = buildRange(new Date('2026-10-05T11:30:00Z'), 90, 'Africa/Kampala');
    expect(ninety.dates).toHaveLength(90);
    expect(new Set(ninety.dates).size).toBe(90);
  });

  it('survives daylight saving: the range across the autumn change in London has every calendar day once, and starts at the right midnight', () => {
    // Clocks go back on Sunday 25 October 2026: that day has 25 hours.
    const range = buildRange(new Date('2026-10-27T12:00:00Z'), 7, 'Europe/London');
    expect(range.dates).toEqual(['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
    expect(range.since.toISOString()).toBe('2026-10-20T23:00:00.000Z'); // midnight on the 21st, still British Summer Time (UTC+1)
    const startsOnChangeDay = buildRange(new Date('2026-10-31T12:00:00Z'), 7, 'Europe/London');
    expect(startsOnChangeDay.dates[0]).toBe('2026-10-25');
    expect(startsOnChangeDay.since.toISOString()).toBe('2026-10-24T23:00:00.000Z'); // midnight on the 25th: BST until 02:00 that day (a 25-hour day)
    const winter = buildRange(new Date('2026-11-05T12:00:00Z'), 7, 'Europe/London');
    expect(winter.since.toISOString()).toBe('2026-10-30T00:00:00.000Z'); // midnight on the 30th: GMT (UTC+0)
  });
});
