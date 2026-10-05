/**
 * Wall-clock time in an IANA zone -> the UTC instant, with no date library. WhatsApp exports carry the phone's LOCAL time with no
 * zone, so importing them needs this. Daylight-saving gaps and overlaps are resolved deterministically: a wall time that does not
 * exist (spring forward) maps to the instant just after the gap; one that exists twice (fall back) maps to the FIRST occurrence.
 */

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** What the wall clock in `timeZone` reads at the instant `utcMs`, expressed as if it were UTC (so it can be subtracted). */
function wallAsUtc(utcMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

export function isValidWallTime(wall: WallTime): boolean {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second));
  return (
    date.getUTCFullYear() === wall.year &&
    date.getUTCMonth() === wall.month - 1 &&
    date.getUTCDate() === wall.day &&
    date.getUTCHours() === wall.hour &&
    date.getUTCMinutes() === wall.minute &&
    date.getUTCSeconds() === wall.second
  );
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone).format(0);
    return true;
  } catch {
    return false;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC instant at which the clock in `timeZone` reads `wall`. Throws RangeError for an impossible calendar date. */
export function wallTimeToUtc(wall: WallTime, timeZone: string): Date {
  if (!isValidWallTime(wall)) throw new RangeError(`not a real date: ${JSON.stringify(wall)}`);
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const offsetAt = (ms: number) => wallAsUtc(ms, timeZone) - ms;
  // The offsets in force a day before and a day after: at most one transition lies between them, so every possible answer is one of two.
  const before = offsetAt(asIfUtc - 1.5 * DAY_MS);
  const after = offsetAt(asIfUtc + 1.5 * DAY_MS);
  const matches = [...new Set([before, after])]
    .map((offset) => asIfUtc - offset)
    .filter((candidate) => wallAsUtc(candidate, timeZone) === asIfUtc)
    .sort((a, b) => a - b);
  // Normal time: exactly one match. Fall back (the hour happens twice): two matches, take the first. Spring forward (the hour never
  // happens): none, so shift forward by the gap using the offset that was in force before it.
  return new Date(matches[0] ?? asIfUtc - before);
}
