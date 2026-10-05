import { describe, expect, it } from 'vitest';
import { isValidTimeZone, isValidWallTime, wallTimeToUtc } from '@/lib/import/zoned-time';

const wall = (year: number, month: number, day: number, hour: number, minute: number, second = 0) => ({ year, month, day, hour, minute, second });
const iso = (w: ReturnType<typeof wall>, tz: string) => wallTimeToUtc(w, tz).toISOString();

describe('wallTimeToUtc', () => {
  it('Kampala is UTC+3 all year (the owner’s zone)', () => {
    expect(iso(wall(2024, 3, 12, 9, 15), 'Africa/Kampala')).toBe('2024-03-12T06:15:00.000Z');
    expect(iso(wall(2024, 12, 31, 23, 59, 59), 'Africa/Kampala')).toBe('2024-12-31T20:59:59.000Z');
    expect(iso(wall(2024, 1, 1, 0, 0), 'Africa/Kampala')).toBe('2023-12-31T21:00:00.000Z');
  });

  it('follows daylight saving: London in winter and summer', () => {
    expect(iso(wall(2024, 1, 15, 12, 0), 'Europe/London')).toBe('2024-01-15T12:00:00.000Z');
    expect(iso(wall(2024, 7, 15, 12, 0), 'Europe/London')).toBe('2024-07-15T11:00:00.000Z');
  });

  it('spring forward: a wall time that never happened moves forward by the gap (01:30 does not exist on 31 Mar 2024 in London)', () => {
    expect(iso(wall(2024, 3, 31, 1, 30), 'Europe/London')).toBe('2024-03-31T01:30:00.000Z'); // reads 02:30 BST
    expect(iso(wall(2024, 3, 31, 2, 30), 'Europe/London')).toBe('2024-03-31T01:30:00.000Z');
    expect(iso(wall(2024, 3, 31, 0, 59), 'Europe/London')).toBe('2024-03-31T00:59:00.000Z');
  });

  it('fall back: a wall time that happens twice is the FIRST occurrence (01:30 on 27 Oct 2024 in London)', () => {
    expect(iso(wall(2024, 10, 27, 1, 30), 'Europe/London')).toBe('2024-10-27T00:30:00.000Z'); // BST, before the clocks went back
    expect(iso(wall(2024, 10, 27, 2, 30), 'Europe/London')).toBe('2024-10-27T02:30:00.000Z'); // GMT
  });

  it('works for half-hour and 45-minute offsets and the southern hemisphere', () => {
    expect(iso(wall(2024, 6, 1, 12, 0), 'Asia/Kolkata')).toBe('2024-06-01T06:30:00.000Z');
    expect(iso(wall(2024, 6, 1, 12, 0), 'Asia/Kathmandu')).toBe('2024-06-01T06:15:00.000Z');
    expect(iso(wall(2024, 1, 15, 12, 0), 'Australia/Sydney')).toBe('2024-01-15T01:00:00.000Z');
    expect(iso(wall(2024, 7, 15, 12, 0), 'Australia/Sydney')).toBe('2024-07-15T02:00:00.000Z');
  });

  it('rejects an impossible calendar date instead of rolling it over', () => {
    expect(() => wallTimeToUtc(wall(2024, 2, 30, 10, 0), 'Africa/Kampala')).toThrow(RangeError);
    expect(() => wallTimeToUtc(wall(2023, 2, 29, 10, 0), 'Africa/Kampala')).toThrow(RangeError);
    expect(iso(wall(2024, 2, 29, 10, 0), 'Africa/Kampala')).toBe('2024-02-29T07:00:00.000Z');
    expect(() => wallTimeToUtc(wall(2024, 1, 1, 24, 0), 'Africa/Kampala')).toThrow(RangeError);
  });

  it('validates calendar dates and zone names', () => {
    expect(isValidWallTime(wall(2024, 4, 31, 0, 0))).toBe(false);
    expect(isValidWallTime(wall(2024, 4, 30, 23, 59, 59))).toBe(true);
    expect(isValidTimeZone('Africa/Kampala')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
