import { zonedOffsetMs } from '@/lib/import/zoned-time';

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let found = cache.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', ...options });
    cache.set(key, found);
  }
  return found;
}
const pick = (parts: Intl.DateTimeFormatPart[], type: string) => parts.find((part) => part.type === type)?.value ?? '';

/** `2026-10-05 14:30` in the owner's zone: the stamp on each conversation line. */
export function stampMinute(date: Date, timeZone: string): string {
  const parts = fmt(timeZone, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  return `${pick(parts, 'year')}-${pick(parts, 'month')}-${pick(parts, 'day')} ${pick(parts, 'hour')}:${pick(parts, 'minute')}`;
}

/** `14:30`: the stamp on a new message (its day is today's, said once in `<now>`). */
export function stampClock(date: Date, timeZone: string): string {
  return stampMinute(date, timeZone).slice(11);
}

/** `Monday`. */
export function weekdayName(date: Date, timeZone: string): string {
  return fmt(timeZone, { weekday: 'long' }).format(date);
}

/** `2026-10-05T14:30:00+03:00`: an unambiguous local time with its offset, for `<now>`. */
export function localIso(date: Date, timeZone: string): string {
  const parts = fmt(timeZone, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const offsetMinutes = Math.round(zonedOffsetMs(date, timeZone) / 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${pick(parts, 'year')}-${pick(parts, 'month')}-${pick(parts, 'day')}T${pick(parts, 'hour')}:${pick(parts, 'minute')}:${pick(parts, 'second')}${offset}`;
}
