import { type WallTime, isValidWallTime } from './zoned-time';

/**
 * Parser for WhatsApp's "Export chat" `.txt` (spec phase 3). Pure: text in, structured messages out. The export has no schema and
 * differs by phone, OS version and language, so the parser is strict about what it accepts and loud about what it had to guess:
 *
 *   Android   `12/03/2024, 14:05 - Amina: Hello`          `3/12/24, 2:05 PM - Amina: Hi`
 *   iOS       `[12/03/2024, 14:05:33] Amina: Hello`       `[3/12/24, 2:05:33 PM] Amina: Hi`
 *
 * Handled: 12 and 24 hour clocks, U+202F (narrow no-break space) before AM/PM, U+200E / U+200F direction marks, a BOM, messages
 * that span lines, system lines, "<Media omitted>" / "image omitted" / "(file attached)" placeholders, deleted messages, and day-first
 * versus month-first dates (decided from the whole file; an all-ambiguous file is reported, not silently guessed). A group export (more
 * than two people) is refused: this system is for one customer per conversation.
 */

export type ExportFormat = 'android' | 'ios';
export type DateOrder = 'dmy' | 'mdy';
export type ParsedKind = 'text' | 'media' | 'deleted';

export interface ParsedMessage {
  author: string;
  wall: WallTime;
  text: string;
  kind: ParsedKind;
}

export interface ParsedExport {
  format: ExportFormat;
  dateOrder: DateOrder;
  /** False when every date was ambiguous (all day-and-month values <= 12) and the order was assumed. */
  dateOrderCertain: boolean;
  messages: ParsedMessage[];
  /** Distinct authors of real (non-system) messages, in order of first appearance. */
  authors: string[];
  systemLines: number;
  warnings: string[];
}

export type ExportParseErrorCode = 'empty' | 'unknown_format' | 'no_messages' | 'group_chat' | 'inconsistent_dates' | 'bad_date';

export class ExportParseError extends Error {
  constructor(
    readonly code: ExportParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExportParseError';
  }
}

export interface ParseOptions {
  /** Used only when the file cannot tell day-first from month-first. Default `dmy` (the owner is in Uganda). */
  assumeDateOrder?: DateOrder;
  /** Forces the order even when the file seems to say otherwise (the owner knows their phone). */
  forceDateOrder?: DateOrder;
}

// ------------------------------------------------------------------------------------------------------ line shapes

const DATE = String.raw`(\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4})`;
const TIME = String.raw`(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)`;
const AMPM = String.raw`(?:\s?([AaPp]\.?\s?[Mm]\.?))?`;
const ANDROID = new RegExp(String.raw`^${DATE},?\s+${TIME}${AMPM}\s+-\s+(.*)$`);
const IOS = new RegExp(String.raw`^\[${DATE},?\s+${TIME}${AMPM}\]\s+(.*)$`);

/** Direction marks and exotic spaces that WhatsApp sprinkles into exports. */
const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;
const EXOTIC_SPACE = /[    ]/g;

const MEDIA_ANDROID = /^<media omitted>$/i;
const MEDIA_ATTACHED = /\(file attached\)$/i;
const MEDIA_IOS = /^(?:image|video|audio|sticker|document|gif|contact card|location|voice call|video call)\s+omitted$|^<attached:\s.*>$/i;
const DELETED = /^(?:you deleted this message|this message was deleted|you deleted a message|this message was deleted\.?)$/i;
const CALL_NOTICE = /^(?:missed (?:voice|video) call|(?:voice|video) call(?:,.*)?|call back|no answer|silenced .*)$/i;

interface RawHeader {
  format: ExportFormat;
  date: string;
  time: string;
  ampm: string | undefined;
  rest: string;
}

/** Exotic spaces become plain ones everywhere; direction marks are dropped only in front of the header (inside the message they MEAN something on iOS). */
function normalise(line: string): string {
  return line.replace(EXOTIC_SPACE, ' ').replace(/^[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/, '');
}

function matchHeader(line: string): RawHeader | null {
  const text = normalise(line);
  const ios = IOS.exec(text);
  if (ios) return { format: 'ios', date: ios[1] ?? '', time: ios[2] ?? '', ampm: ios[3], rest: ios[4] ?? '' };
  const android = ANDROID.exec(text);
  if (android) return { format: 'android', date: android[1] ?? '', time: android[2] ?? '', ampm: android[3], rest: android[4] ?? '' };
  return null;
}

function splitAuthor(rest: string): { author: string; text: string } | null {
  const at = rest.indexOf(': ');
  if (at <= 0 || at > 100) return null;
  const author = rest.slice(0, at).replace(INVISIBLE, '').trim();
  if (author === '' || author.includes('\n')) return null;
  return { author, text: rest.slice(at + 2) };
}

// ------------------------------------------------------------------------------------------------------ dates and times

interface DateTriple {
  a: number;
  b: number;
  year: number;
  yearFirst: boolean;
}

function parseDateTriple(raw: string): DateTriple {
  const parts = raw.split(/[/.\-]/).map(Number);
  const [p0 = 0, p1 = 0, p2 = 0] = parts;
  if (raw.split(/[/.\-]/)[0]?.length === 4) return { a: p1, b: p2, year: p0, yearFirst: true };
  return { a: p0, b: p1, year: p2 < 100 ? 2000 + p2 : p2, yearFirst: false };
}

function parseClock(time: string, ampm: string | undefined): { hour: number; minute: number; second: number } | null {
  const [h = '', m = '', s = '0'] = time.split(/[:.]/);
  let hour = Number(h);
  const minute = Number(m);
  const second = Number(s);
  if (ampm !== undefined) {
    const pm = /^p/i.test(ampm.replace(/\s/g, ''));
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (pm ? 12 : 0);
  }
  return hour > 23 || minute > 59 || second > 59 ? null : { hour, minute, second };
}

function decideDateOrder(triples: readonly DateTriple[], options: ParseOptions): { order: DateOrder; certain: boolean; warnings: string[] } {
  if (options.forceDateOrder) return { order: options.forceDateOrder, certain: true, warnings: [] };
  const dayFirstProof = triples.some((t) => !t.yearFirst && t.a > 12);
  const monthFirstProof = triples.some((t) => !t.yearFirst && t.b > 12);
  if (dayFirstProof && monthFirstProof) {
    throw new ExportParseError('inconsistent_dates', 'The dates in this file contradict each other (some have a first number above 12, others a second number above 12). It may be two exports joined together.');
  }
  if (dayFirstProof) return { order: 'dmy', certain: true, warnings: [] };
  if (monthFirstProof) return { order: 'mdy', certain: true, warnings: [] };
  if (triples.every((t) => t.yearFirst)) return { order: 'dmy', certain: true, warnings: [] };
  const assumed = options.assumeDateOrder ?? 'dmy';
  return {
    order: assumed,
    certain: false,
    warnings: [`Every date in this file is ambiguous (day and month are both 12 or less), so ${assumed === 'dmy' ? 'day/month' : 'month/day'} order was ASSUMED. Check a few imported dates; re-run with --date-order dmy|mdy if they are wrong.`],
  };
}

// ------------------------------------------------------------------------------------------------------ the parser

interface Pending {
  header: RawHeader;
  lines: string[];
}

export function parseWhatsAppExport(source: string, options: ParseOptions = {}): ParsedExport {
  const text = source.replace(/^﻿/, '');
  if (text.trim() === '') throw new ExportParseError('empty', 'The file is empty.');

  const entries: Pending[] = [];
  let current: Pending | null = null;
  const formats = new Set<ExportFormat>();
  for (const line of text.split(/\r\n|\n|\r/)) {
    const header = matchHeader(line);
    if (header) {
      formats.add(header.format);
      current = { header, lines: [header.rest] };
      entries.push(current);
    } else if (current) {
      current.lines.push(line.replace(EXOTIC_SPACE, ' '));
    }
    // Lines before the first header (a stray title) are ignored.
  }
  if (entries.length === 0) throw new ExportParseError('unknown_format', 'This does not look like a WhatsApp "Export chat" text file: no line starts with a date and time.');
  if (formats.size > 1) throw new ExportParseError('unknown_format', 'This file mixes the Android and iOS formats; export the chat again from one phone.');
  const format: ExportFormat = formats.has('ios') ? 'ios' : 'android';

  const triples = entries.map((entry) => parseDateTriple(entry.header.date));
  const { order, certain, warnings } = decideDateOrder(triples, options);

  const messages: ParsedMessage[] = [];
  const authors: string[] = [];
  let systemLines = 0;

  entries.forEach((entry, index) => {
    const triple = triples[index];
    const clock = parseClock(entry.header.time, entry.header.ampm);
    if (!triple || !clock) throw new ExportParseError('bad_date', `Could not read the time "${entry.header.time}${entry.header.ampm ?? ''}" on a line of the file.`);
    const day = triple.yearFirst ? triple.b : order === 'dmy' ? triple.a : triple.b;
    const month = triple.yearFirst ? triple.a : order === 'dmy' ? triple.b : triple.a;
    const wall: WallTime = { year: triple.year, month, day, ...clock };
    if (!isValidWallTime(wall)) throw new ExportParseError('bad_date', `"${entry.header.date}" is not a real date in ${order === 'dmy' ? 'day/month' : 'month/day'} order.`);

    const joined = entry.lines.join('\n');
    const split = splitAuthor(joined.replace(/^[‎‏]+/, ''));
    if (!split) {
      systemLines += 1;
      return;
    }
    // iOS marks system notices and attachments with a leading direction mark inside the message part.
    const marked = /^[‎‏]/.test(split.text);
    const body = split.text.replace(INVISIBLE, '').replace(/[ \t]+$/g, '').replace(/\s+$/, '');
    const bare = body.trim();

    if (CALL_NOTICE.test(bare) || (marked && /end-to-end encrypted|created (?:group|this group)|added you|changed (?:the )?(?:subject|group)|security code changed|joined using/i.test(bare))) {
      systemLines += 1;
      return;
    }
    let kind: ParsedKind = 'text';
    if (MEDIA_ANDROID.test(bare) || MEDIA_IOS.test(bare) || MEDIA_ATTACHED.test(bare)) kind = 'media';
    else if (DELETED.test(bare)) kind = 'deleted';
    else if (bare === '') {
      systemLines += 1;
      return;
    }

    if (!authors.includes(split.author)) authors.push(split.author);
    messages.push({ author: split.author, wall, text: kind === 'text' ? body : bare, kind });
  });

  if (messages.length === 0) throw new ExportParseError('no_messages', 'The file has dates but no messages from people (only system lines).');
  if (authors.length > 2) {
    throw new ExportParseError('group_chat', `This looks like a group chat (${authors.length} different senders: ${authors.slice(0, 4).join(', ')}${authors.length > 4 ? ', ...' : ''}). Only one-to-one customer chats can be imported.`);
  }
  if (authors.length === 1) warnings.push(`Only one person wrote in this file (${authors[0] ?? ''}). Nothing can be learned from a one-sided chat.`);

  return { format, dateOrder: order, dateOrderCertain: certain, messages, authors, systemLines, warnings };
}
