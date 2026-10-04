import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '@/lib/conversations/cursor';
import { displayName, escapeLike, initials, secondaryLine } from '@/lib/conversations/display';
import { dayKey, formatClock, formatDayLabel, formatFullTimestamp, formatListTime } from '@/lib/conversations/format';
import { groupByDay } from '@/lib/conversations/group';
import { isUuid, listHref, parseListParams, parseThreadParams } from '@/lib/conversations/params';
import { EXPIRING_SOON_MS, describeWindow, formatRemaining, isWindowOpen, windowState } from '@/lib/conversations/window';

const KAMPALA = 'Africa/Kampala'; // UTC+3, no daylight saving
const NOW = new Date('2026-10-04T12:00:00Z'); // Sunday 15:00 in Kampala
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('isWindowOpen / windowState: the 24h window', () => {
  it('is closed at the exact instant it expires, open one millisecond before', () => {
    const expires = new Date(NOW.getTime() + 1);
    expect(isWindowOpen(expires, NOW)).toBe(true);
    expect(isWindowOpen(new Date(NOW.getTime()), NOW)).toBe(false);
    expect(isWindowOpen(new Date(NOW.getTime() - 1), NOW)).toBe(false);
  });

  it('has no window until the customer has written', () => {
    expect(isWindowOpen(null, NOW)).toBe(false);
    expect(isWindowOpen(undefined, NOW)).toBe(false);
    expect(windowState(null, NOW)).toEqual({ kind: 'none' });
  });

  it('is "expiring" only strictly inside the last two hours', () => {
    const at = (ms: number) => windowState(new Date(NOW.getTime() + ms), NOW).kind;
    expect(at(EXPIRING_SOON_MS)).toBe('open');
    expect(at(EXPIRING_SOON_MS - 1)).toBe('expiring');
    expect(at(1)).toBe('expiring');
    expect(at(0)).toBe('closed');
    expect(at(-5 * HOUR)).toBe('closed');
    expect(at(23 * HOUR)).toBe('open');
  });

  it('reports remaining time for open windows and zero for closed ones', () => {
    expect(windowState(new Date(NOW.getTime() + 3 * HOUR), NOW)).toMatchObject({ kind: 'open', remainingMs: 3 * HOUR });
    expect(windowState(new Date(NOW.getTime() - HOUR), NOW)).toMatchObject({ kind: 'closed', remainingMs: 0 });
  });
});

describe('formatRemaining rounds DOWN: a countdown must never promise more time than there is', () => {
  it.each([
    [0, 'under a minute'],
    [59_999, 'under a minute'],
    [MIN, '1m'],
    [45 * MIN + 59_000, '45m'],
    [HOUR, '1h'],
    [3 * HOUR + 20 * MIN, '3h 20m'],
    [23 * HOUR + 59 * MIN + 59_000, '23h 59m'],
  ])('%i ms -> %s', (ms, expected) => {
    expect(formatRemaining(ms)).toBe(expected);
  });
});

describe('describeWindow: plain words for a decision that matters', () => {
  it('says what the owner may send in every state', () => {
    expect(describeWindow({ kind: 'none' })).toMatchObject({ label: 'No window', tone: 'neutral' });
    expect(describeWindow(windowState(new Date(NOW.getTime() + 5 * HOUR), NOW))).toMatchObject({ label: 'Open · 5h left', tone: 'success' });
    expect(describeWindow(windowState(new Date(NOW.getTime() + 40 * MIN), NOW))).toMatchObject({ label: 'Closes in 40m', tone: 'warning' });
    const closed = describeWindow(windowState(new Date(NOW.getTime() - 1), NOW));
    expect(closed).toMatchObject({ label: 'Closed · templates only', tone: 'danger' });
    expect(closed.detail).toContain('template');
  });
});

describe('owner-timezone formatting', () => {
  it('puts the day boundary at the OWNER’s midnight, not UTC’s', () => {
    expect(dayKey(new Date('2026-10-04T20:59:59Z'), KAMPALA)).toBe('2026-10-04'); // 23:59:59 in Kampala
    expect(dayKey(new Date('2026-10-04T21:00:00Z'), KAMPALA)).toBe('2026-10-05'); // 00:00:00 in Kampala
    expect(dayKey(new Date('2026-10-04T21:00:00Z'), 'UTC')).toBe('2026-10-04');
  });

  it('formats a 24-hour clock in the zone', () => {
    expect(formatClock(new Date('2026-10-04T11:05:00Z'), KAMPALA)).toBe('14:05');
    expect(formatClock(new Date('2026-10-04T21:00:00Z'), KAMPALA)).toBe('00:00');
    expect(formatClock(new Date('2026-10-04T11:05:00Z'), 'America/New_York')).toBe('07:05');
  });

  it('labels days relative to the owner’s today', () => {
    const label = (iso: string) => formatDayLabel(new Date(iso), NOW, KAMPALA);
    expect(label('2026-10-04T05:00:00Z')).toBe('Today');
    expect(label('2026-10-03T20:59:00Z')).toBe('Yesterday'); // 23:59 Oct 3 in Kampala
    expect(label('2026-10-03T21:00:00Z')).toBe('Today'); // 00:00 on Oct 4 in Kampala: today already
    expect(label('2026-10-01T10:00:00Z')).toBe('Thursday');
    expect(label('2026-09-20T10:00:00Z')).toBe('Sun 20 Sept');
    expect(label('2025-12-31T10:00:00Z')).toBe('31 Dec 2025');
  });

  it('formats list times compactly', () => {
    const list = (iso: string) => formatListTime(new Date(iso), NOW, KAMPALA);
    expect(list('2026-10-04T08:30:00Z')).toBe('11:30');
    expect(list('2026-10-03T10:00:00Z')).toBe('Yesterday');
    expect(list('2026-10-01T10:00:00Z')).toBe('Thu');
    expect(list('2026-08-15T10:00:00Z')).toBe('15 Aug');
    expect(list('2025-08-15T10:00:00Z')).toBe('15 Aug 2025');
  });

  it('formats a full timestamp for tooltips', () => {
    expect(formatFullTimestamp(new Date('2026-10-04T07:46:40Z'), KAMPALA)).toBe('4 Oct 2026, 10:46');
  });
});

describe('cursor', () => {
  const id = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

  it('round-trips, including the null sort key', () => {
    expect(decodeCursor(encodeCursor({ t: '2026-10-04T07:46:40.000Z', id }))).toEqual({ t: '2026-10-04T07:46:40.000Z', id });
    expect(decodeCursor(encodeCursor({ t: null, id }))).toEqual({ t: null, id });
  });

  it.each([null, undefined, '', 'not base64 !!', 'e30', Buffer.from('{"t":"yesterday","id":"x"}').toString('base64url'), Buffer.from('[]').toString('base64url'), 'a'.repeat(500)])(
    'treats %s as no cursor instead of failing: it comes from the URL',
    (raw) => {
      expect(decodeCursor(raw as string | null | undefined)).toBeNull();
    },
  );

  it('rejects a cursor with a non-UUID id (nothing the owner types can reach the query)', () => {
    expect(decodeCursor(Buffer.from(JSON.stringify({ t: null, id: "1' OR '1'='1" })).toString('base64url'))).toBeNull();
  });
});

describe('displayName and friends', () => {
  const contact = { displayName: null, username: null, phoneE164: null, bsuid: null };

  it('prefers a name, then a handle, then a number, and never shows a blank', () => {
    expect(displayName({ ...contact, displayName: ' Amina ', username: 'amina_u', phoneE164: '+256700123456' })).toBe('Amina');
    expect(displayName({ ...contact, username: 'amina_u', phoneE164: '+256700123456' })).toBe('@amina_u');
    expect(displayName({ ...contact, phoneE164: '+256700123456' })).toBe('+256700123456');
    expect(displayName({ ...contact, bsuid: 'UG.123' })).toBe('Unknown customer');
    expect(displayName({ ...contact, displayName: '   ', phoneE164: '+256700123456' })).toBe('+256700123456');
  });

  it('shows the identifiers the name does not already say', () => {
    expect(secondaryLine({ ...contact, displayName: 'Amina', username: 'amina_u', phoneE164: '+256700123456' })).toBe('+256700123456 · @amina_u');
    expect(secondaryLine({ ...contact, phoneE164: '+256700123456' })).toBeNull();
    expect(secondaryLine({ ...contact, username: 'kato_k' })).toBeNull();
  });

  it('makes initials', () => {
    expect(initials('Amina Customer')).toBe('AC');
    expect(initials('Amina')).toBe('AM');
    expect(initials('@kato_k')).toBe('KA');
    expect(initials('+256700123456')).toBe('25');
    expect(initials('')).toBe('?');
  });

  it('escapes LIKE wildcards so a search for "50%" means those characters', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(escapeLike('plain')).toBe('plain');
  });
});

describe('groupByDay: separators at the owner’s midnight', () => {
  const message = (id: string, iso: string) => ({ id, occurredAt: new Date(iso) });

  it('puts one separator above each calendar day, in the owner’s zone', () => {
    const rows = groupByDay(
      [
        message('a', '2026-10-02T10:00:00Z'),
        message('b', '2026-10-03T20:59:00Z'), // 23:59 on Oct 3 in Kampala
        message('c', '2026-10-03T21:00:00Z'), // 00:00 on Oct 4 in Kampala: a new day, though still Oct 3 in UTC
        message('d', '2026-10-04T08:00:00Z'),
      ],
      NOW,
      KAMPALA,
    );
    expect(rows.map((row) => (row.kind === 'day' ? `# ${row.label}` : row.message.id))).toEqual(['# Friday', 'a', '# Yesterday', 'b', '# Today', 'c', 'd']);
  });

  it('is empty for no messages and does not mutate its input', () => {
    expect(groupByDay([], NOW, KAMPALA)).toEqual([]);
    const input = [message('a', '2026-10-04T08:00:00Z')];
    groupByDay(input, NOW, KAMPALA);
    expect(input).toHaveLength(1);
  });
});

describe('URL parameters never throw', () => {
  it('parses list parameters, falling back on anything invalid', () => {
    expect(parseListParams({})).toEqual({ filter: 'all', q: '', cursor: null });
    expect(parseListParams({ filter: 'needs_reply', q: '  amina  ', cursor: 'abc' })).toEqual({ filter: 'needs_reply', q: 'amina', cursor: 'abc' });
    expect(parseListParams({ filter: 'bogus' })).toMatchObject({ filter: 'all' });
    expect(parseListParams({ filter: ['waiting', 'resolved'] })).toMatchObject({ filter: 'waiting' }); // ?filter=a&filter=b
    expect(parseListParams({ q: 'x'.repeat(500) })).toMatchObject({ q: '' }); // over the cap: dropped, not truncated into something else
    expect(parseListParams({ cursor: 'y'.repeat(500) })).toMatchObject({ cursor: null });
  });

  it('parses the thread cursor and refuses an absurd one', () => {
    expect(parseThreadParams({ before: 'abc' })).toEqual({ before: 'abc' });
    expect(parseThreadParams({})).toEqual({ before: null });
    expect(parseThreadParams({ before: 'z'.repeat(401) })).toEqual({ before: null });
  });

  it('recognises UUIDs only', () => {
    expect(isUuid('0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee')).toBe(true);
    for (const value of ['', '1', "' OR 1=1 --", '../etc/passwd', '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee/x']) expect(isUuid(value)).toBe(false);
  });

  it('builds clean list links that keep only what differs from the defaults', () => {
    expect(listHref({})).toBe('/conversations');
    expect(listHref({ filter: 'all', q: '', cursor: null })).toBe('/conversations');
    expect(listHref({ filter: 'resolved' })).toBe('/conversations?filter=resolved');
    expect(listHref({ q: 'a b&c', cursor: 'x' })).toBe('/conversations?q=a+b%26c&cursor=x');
  });
});
