import { z } from 'zod';
import type { QuietHours } from '@/lib/db/schema';

/** The shape stored in `settings.quiet_hours` (JSON: validate what comes out of it). */
export const quietHoursSchema = z.object({ start: z.string(), end: z.string() });

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(value: string): number | null {
  const match = HHMM.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes since local midnight in `timeZone`. */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/**
 * True while the owner's quiet hours are in force (`start` inclusive, `end` exclusive, in the owner's time zone). A window that
 * crosses midnight (22:00 to 07:00) is the normal case. A malformed setting or start == end means "no quiet hours": a notification
 * is never silently swallowed because of a typo.
 */
export function isQuietNow(now: Date, quiet: QuietHours, timeZone: string): boolean {
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === null || end === null || start === end) return false;
  const current = localMinutes(now, timeZone);
  return start < end ? current >= start && current < end : current >= start || current < end;
}
