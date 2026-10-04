import { dayKey, formatDayLabel } from './format';

export type ThreadRow<T> = { kind: 'day'; key: string; label: string } | { kind: 'message'; key: string; message: T };

/**
 * Interleaves day separators into a chronological list of messages: one separator above the first message of each calendar
 * day, where "day" means the OWNER's day (their timezone), not UTC's. Pure, so the boundaries are unit-tested.
 */
export function groupByDay<T extends { id: string; occurredAt: Date }>(messages: readonly T[], now: Date, timeZone: string): ThreadRow<T>[] {
  const rows: ThreadRow<T>[] = [];
  let previousDay = '';
  for (const message of messages) {
    const day = dayKey(message.occurredAt, timeZone);
    if (day !== previousDay) {
      rows.push({ kind: 'day', key: `day-${day}`, label: formatDayLabel(message.occurredAt, now, timeZone) });
      previousDay = day;
    }
    rows.push({ kind: 'message', key: message.id, message });
  }
  return rows;
}
