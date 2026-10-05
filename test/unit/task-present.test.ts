import { describe, expect, it } from 'vitest';
import { describeDue, dueState, parseLocalDateTime, toLocalInput } from '@/lib/tasks/present';

const TZ = 'Africa/Kampala'; // UTC+3, no daylight saving
const NOW = new Date('2026-10-05T11:30:00Z'); // Monday 14:30 in Kampala

describe('datetime-local values are the OWNER’s wall clock', () => {
  it('converts to the right instant and back', () => {
    const due = parseLocalDateTime('2026-10-06T15:00', TZ);
    expect(due?.toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(toLocalInput(due as Date, TZ)).toBe('2026-10-06T15:00');
  });

  it('is zone-aware: the same wall time is a different instant elsewhere', () => {
    expect(parseLocalDateTime('2026-10-06T15:00', 'Europe/London')?.toISOString()).toBe('2026-10-06T14:00:00.000Z');
    expect(parseLocalDateTime('2026-12-06T15:00', 'Europe/London')?.toISOString()).toBe('2026-12-06T15:00:00.000Z');
  });

  it.each(['', 'tomorrow', '2026-10-06', '2026-10-06T25:00', '2026-02-30T10:00', '2026-10-06 15:00', '2026-10-06T15:00:00', '2026-13-01T10:00'])('rejects %j', (value) => {
    expect(parseLocalDateTime(value, TZ)).toBeNull();
  });
});

describe('dueState', () => {
  it('uses the owner’s calendar day, not UTC’s', () => {
    // 23:30 in Kampala is 20:30Z: still "today" for the owner at 14:30.
    expect(dueState(new Date('2026-10-05T20:30:00Z'), NOW, TZ)).toBe('today');
    // 00:30 Kampala tomorrow is 21:30Z today: UTC says today, the owner says tomorrow.
    expect(dueState(new Date('2026-10-05T21:30:00Z'), NOW, TZ)).toBe('later');
    expect(dueState(new Date('2026-10-05T11:29:59Z'), NOW, TZ)).toBe('overdue');
    expect(dueState(null, NOW, TZ)).toBe('none');
  });
});

describe('describeDue', () => {
  it('says how late, or when', () => {
    expect(describeDue(null, NOW, TZ)).toBe('No time set');
    expect(describeDue(new Date(NOW.getTime() - 5 * 60_000), NOW, TZ)).toBe('Overdue by 5 min');
    expect(describeDue(new Date(NOW.getTime() - 30_000), NOW, TZ)).toBe('Overdue by 1 min');
    expect(describeDue(new Date(NOW.getTime() - 3 * 3_600_000), NOW, TZ)).toBe('Overdue by 3 h');
    expect(describeDue(new Date(NOW.getTime() - 5 * 24 * 3_600_000), NOW, TZ)).toBe('Overdue by 5 days');
    expect(describeDue(new Date('2026-10-05T15:00:00Z'), NOW, TZ)).toBe('Today 18:00');
    expect(describeDue(new Date('2026-10-06T06:00:00Z'), NOW, TZ)).toBe('Tomorrow 09:00');
    expect(describeDue(new Date('2026-10-09T12:00:00Z'), NOW, TZ)).toMatch(/^Fri 9 Oct 15:00$/);
  });
});
