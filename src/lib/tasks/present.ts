import { formatClock, formatDayLabel } from '@/lib/conversations/format';
import { stampMinute } from '@/lib/ai/prompts/format';
import { type WallTime, isValidWallTime, wallTimeToUtc } from '@/lib/import/zoned-time';

/** Wording and time handling for tasks, pure so it is testable without rendering. */

export const TASK_TYPE_LABEL = { request: 'Customer asked', followup: 'I promised', reminder: 'Reminder' } as const;
export type TaskType = keyof typeof TASK_TYPE_LABEL;

/** `<input type="datetime-local">` speaks "2026-10-05T15:00", with no zone: it is always the OWNER's wall clock. */
export const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function parseLocalDateTime(value: string, timeZone: string): Date | null {
  const match = LOCAL_DATETIME.exec(value);
  if (!match) return null;
  const wall: WallTime = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), second: 0 };
  return isValidWallTime(wall) ? wallTimeToUtc(wall, timeZone) : null;
}

/** The value to put back in a datetime-local box for an instant: the owner's wall clock, minute precision. */
export function toLocalInput(date: Date, timeZone: string): string {
  return stampMinute(date, timeZone).replace(' ', 'T');
}

export type DueState = 'none' | 'overdue' | 'today' | 'later';

const HOUR_MS = 3_600_000;

export function dueState(dueAt: Date | null, now: Date, timeZone: string): DueState {
  if (dueAt === null) return 'none';
  if (dueAt.getTime() < now.getTime()) return 'overdue';
  return stampMinute(dueAt, timeZone).slice(0, 10) === stampMinute(now, timeZone).slice(0, 10) ? 'today' : 'later';
}

/** "Overdue by 3 h", "Today 15:00", "Tomorrow 09:00", "Fri 9 Oct, 15:00", "No time set". */
export function describeDue(dueAt: Date | null, now: Date, timeZone: string): string {
  if (dueAt === null) return 'No time set';
  const late = now.getTime() - dueAt.getTime();
  if (late > 0) {
    if (late < HOUR_MS) return `Overdue by ${Math.max(1, Math.round(late / 60_000))} min`;
    if (late < 48 * HOUR_MS) return `Overdue by ${Math.round(late / HOUR_MS)} h`;
    return `Overdue by ${Math.round(late / (24 * HOUR_MS))} days`;
  }
  // formatDayLabel speaks about the past ("Yesterday"); for a due date the next day is "Tomorrow".
  const tomorrow = stampMinute(new Date(now.getTime() + 24 * HOUR_MS), timeZone).slice(0, 10) === stampMinute(dueAt, timeZone).slice(0, 10);
  return `${tomorrow ? 'Tomorrow' : formatDayLabel(dueAt, now, timeZone)} ${formatClock(dueAt, timeZone)}`;
}
