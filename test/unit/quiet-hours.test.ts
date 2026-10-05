import { describe, expect, it } from 'vitest';
import { isQuietNow, localMinutes } from '@/lib/notify/quiet-hours';

const KAMPALA = 'Africa/Kampala'; // UTC+3, no daylight saving
const at = (hhmmUtc: string) => new Date(`2026-10-05T${hhmmUtc}:00Z`);

describe('localMinutes', () => {
  it('reads the clock in the OWNER zone, not UTC', () => {
    expect(localMinutes(at('19:30'), KAMPALA)).toBe(22 * 60 + 30);
    expect(localMinutes(at('21:05'), KAMPALA)).toBe(0 * 60 + 5); // crossed midnight locally
  });
});

describe('isQuietNow', () => {
  const night = { start: '22:00', end: '07:00' };

  it.each([
    ['19:00', true], // 22:00 local: start is inclusive
    ['18:59', false], // 21:59 local
    ['20:30', true], // 23:30 local
    ['21:30', true], // 00:30 local (after midnight)
    ['03:59', true], // 06:59 local
    ['04:00', false], // 07:00 local: end is exclusive
    ['12:00', false],
  ])('a window across midnight (22:00-07:00 in Kampala) at %s UTC -> quiet: %s', (utc, quiet) => {
    expect(isQuietNow(at(utc), night, KAMPALA)).toBe(quiet);
  });

  it('handles a same-day window', () => {
    expect(isQuietNow(at('10:00'), { start: '12:00', end: '14:00' }, KAMPALA)).toBe(true); // 13:00 local
    expect(isQuietNow(at('12:00'), { start: '12:00', end: '14:00' }, KAMPALA)).toBe(false); // 15:00 local
  });

  it('a malformed or empty window is NOT quiet: a typo never swallows a notification', () => {
    for (const quiet of [{ start: '25:00', end: '07:00' }, { start: 'late', end: 'early' }, { start: '22:00', end: '22:00' }, { start: '', end: '' }]) {
      expect(isQuietNow(at('20:00'), quiet, KAMPALA)).toBe(false);
    }
  });
});
