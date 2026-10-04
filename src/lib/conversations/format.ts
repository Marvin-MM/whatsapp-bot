/**
 * Date formatting for the dashboard, always in the OWNER's time zone (OWNER_TIMEZONE), never the server's or the browser's:
 * "today", a day separator and a clock time must mean what the owner means by them. Pure, so it is testable with fixed dates.
 */

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let found = cache.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat('en-GB', { timeZone, ...options });
    cache.set(key, found);
  }
  return found;
}

/** `2026-10-04`: the calendar day of an instant in the owner's zone. Used to group messages under day separators. */
export function dayKey(date: Date, timeZone: string): string {
  const parts = formatter(timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** `14:05` (24-hour). */
export function formatClock(date: Date, timeZone: string): string {
  return formatter(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** Whole days between two calendar days in the owner's zone (not 24h blocks: midnight is what matters). */
function calendarDaysBetween(earlier: Date, later: Date, timeZone: string): number {
  const toUtcDay = (date: Date) => {
    const [year = 0, month = 1, day = 1] = dayKey(date, timeZone).split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtcDay(later) - toUtcDay(earlier)) / 86_400_000);
}

const dayMonth: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
const sameYear = (a: Date, b: Date, timeZone: string) => dayKey(a, timeZone).slice(0, 4) === dayKey(b, timeZone).slice(0, 4);

/** The separator above a day's messages: "Today", "Yesterday", "Mon 29 Sep", "29 Sep 2025". */
export function formatDayLabel(date: Date, now: Date, timeZone: string): string {
  const days = calendarDaysBetween(date, now, timeZone);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return formatter(timeZone, { weekday: 'long' }).format(date);
  return formatter(timeZone, sameYear(date, now, timeZone) ? { weekday: 'short', ...dayMonth } : { ...dayMonth, year: 'numeric' }).format(date);
}

/** The compact time in a conversation list row: a clock time today, otherwise "Yesterday", a weekday, or a date. */
export function formatListTime(date: Date, now: Date, timeZone: string): string {
  const days = calendarDaysBetween(date, now, timeZone);
  if (days === 0) return formatClock(date, timeZone);
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return formatter(timeZone, { weekday: 'short' }).format(date);
  return formatter(timeZone, sameYear(date, now, timeZone) ? dayMonth : { ...dayMonth, year: 'numeric' }).format(date);
}

/** "4 Oct 2026, 10:46": the full instant, for tooltips and screen readers. */
export function formatFullTimestamp(date: Date, timeZone: string): string {
  return formatter(timeZone, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}
