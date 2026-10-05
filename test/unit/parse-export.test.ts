import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ExportParseError, parseWhatsAppExport } from '@/lib/import/parse-export';

const fixture = (name: string) => readFileSync(`test/fixtures/exports/${name}.txt`, 'utf8');
const expectParseError = (text: string, code: string, options = {}) => {
  try {
    parseWhatsAppExport(text, options);
  } catch (error) {
    expect(error).toBeInstanceOf(ExportParseError);
    expect((error as ExportParseError).code).toBe(code);
    return;
  }
  throw new Error(`expected ExportParseError ${code}`);
};

describe('Android, 24-hour, day first', () => {
  const parsed = parseWhatsAppExport(fixture('android-24h'));

  it('finds exactly the right messages: system lines and call notices are not messages', () => {
    expect(parsed.format).toBe('android');
    expect(parsed.messages).toHaveLength(9);
    expect(parsed.systemLines).toBe(2); // the encryption notice and "Missed voice call"
    expect(parsed.authors).toEqual(['Amina Customer', 'Marvin']);
    expect(parsed.messages.map((m) => m.kind)).toEqual(['text', 'text', 'media', 'text', 'text', 'text', 'deleted', 'text', 'text']);
    expect(parsed.messages.map((m) => m.author)).toEqual(['Amina Customer', 'Marvin', 'Amina Customer', 'Amina Customer', 'Amina Customer', 'Marvin', 'Amina Customer', 'Marvin', 'Amina Customer']);
  });

  it('keeps a multi-line message as ONE message with its line breaks', () => {
    expect(parsed.messages[1]?.text).toBe('Hi Amina! Yes we do, UGX 50,000\nCome to the shop on Kampala Road\nor I can deliver tomorrow.');
  });

  it('reads day-first dates (13/03 proves it) and keeps emoji and the wall-clock time', () => {
    expect(parsed.dateOrder).toBe('dmy');
    expect(parsed.dateOrderCertain).toBe(true);
    expect(parsed.messages[0]?.wall).toEqual({ year: 2024, month: 3, day: 12, hour: 9, minute: 15, second: 0 });
    expect(parsed.messages[5]?.text).toBe('Lovely, see you then 🙏');
    expect(parsed.messages[7]?.wall).toEqual({ year: 2024, month: 3, day: 13, hour: 18, minute: 2, second: 0 });
    expect(parsed.messages[8]?.wall.day).toBe(15);
  });

  it('keeps two identical messages in the same minute as two messages', () => {
    expect(parsed.messages.filter((m) => m.text === 'ok')).toHaveLength(2);
  });

  it('flags the placeholder and the deleted message instead of storing them as text', () => {
    expect(parsed.messages[2]).toMatchObject({ kind: 'media', text: '<Media omitted>' });
    expect(parsed.messages[6]).toMatchObject({ kind: 'deleted', text: 'This message was deleted' });
  });
});

describe('Android, 12-hour with U+202F before AM/PM, month first', () => {
  const parsed = parseWhatsAppExport(fixture('android-12h-mdy'));

  it('reads month-first dates because 3/13 cannot be day-first', () => {
    expect(parsed.dateOrder).toBe('mdy');
    expect(parsed.dateOrderCertain).toBe(true);
    expect(parsed.messages).toHaveLength(6);
    expect(parsed.systemLines).toBe(1);
  });

  it('converts 12-hour times correctly, including the 12 AM and 12 PM edge cases', () => {
    const clocks = parsed.messages.map((m) => `${m.wall.month}/${m.wall.day} ${String(m.wall.hour).padStart(2, '0')}:${String(m.wall.minute).padStart(2, '0')}`);
    expect(clocks).toEqual(['3/12 09:15', '3/12 09:17', '3/13 00:05', '3/13 00:30', '3/13 12:10', '3/13 13:45']);
    expect(parsed.messages[0]?.wall.year).toBe(2024);
  });
});

describe('iOS', () => {
  it('24-hour: bracketed header, LRM marks, attachments and a deleted message, a continuation line', () => {
    const parsed = parseWhatsAppExport(fixture('ios-24h'));
    expect(parsed.format).toBe('ios');
    expect(parsed.messages).toHaveLength(8);
    expect(parsed.systemLines).toBe(1);
    expect(parsed.messages.map((m) => m.kind)).toEqual(['text', 'text', 'media', 'media', 'text', 'deleted', 'text', 'text']);
    expect(parsed.messages[0]?.wall).toEqual({ year: 2024, month: 3, day: 12, hour: 9, minute: 15, second: 10 });
    expect(parsed.messages[7]?.text).toBe('Welcome\nand see you soon');
    expect(parsed.messages.every((m) => !/[‎‏]/.test(m.text + m.author))).toBe(true);
  });

  it('12-hour with seconds and U+202F, month first', () => {
    const parsed = parseWhatsAppExport(fixture('ios-12h'));
    expect(parsed.dateOrder).toBe('mdy');
    expect(parsed.messages.map((m) => [m.wall.hour, m.wall.minute, m.wall.second])).toEqual([[9, 15, 10], [9, 17, 44], [13, 15, 10]]);
  });
});

describe('what it refuses, and what it reports', () => {
  it('refuses a group chat (more than two people)', () => expectParseError(fixture('group'), 'group_chat'));
  it('refuses an empty file and a file that is not a chat', () => {
    expectParseError('', 'empty');
    expectParseError('   \n\n', 'empty');
    expectParseError('just some notes\nnot a chat', 'unknown_format');
  });
  it('refuses a file whose dates contradict each other (two exports joined)', () => expectParseError(fixture('contradictory'), 'inconsistent_dates'));
  it('refuses a file with only system lines', () => expectParseError('12/03/2024, 09:14 - Messages and calls are end-to-end encrypted.\n', 'no_messages'));
  it('refuses a real-looking line with an impossible date', () => expectParseError('31/02/2024, 09:14 - Amina: hi\n01/03/2024, 09:15 - Marvin: hello\n', 'bad_date'));

  it('REPORTS an all-ambiguous file instead of silently guessing, and lets the owner force the order', () => {
    const parsed = parseWhatsAppExport(fixture('ambiguous'));
    expect(parsed.dateOrder).toBe('dmy');
    expect(parsed.dateOrderCertain).toBe(false);
    expect(parsed.warnings.join(' ')).toMatch(/ambiguous/i);
    expect(parsed.messages[0]?.wall).toMatchObject({ month: 2, day: 1 });

    const forced = parseWhatsAppExport(fixture('ambiguous'), { forceDateOrder: 'mdy' });
    expect(forced.dateOrderCertain).toBe(true);
    expect(forced.messages[0]?.wall).toMatchObject({ month: 1, day: 2 });
    expect(parseWhatsAppExport(fixture('ambiguous'), { assumeDateOrder: 'mdy' }).messages[0]?.wall).toMatchObject({ month: 1, day: 2 });
  });

  it('warns about a one-sided chat', () => {
    const parsed = parseWhatsAppExport('12/03/2024, 09:15 - Amina: hi\n12/03/2024, 09:16 - Amina: anyone?\n');
    expect(parsed.warnings.join(' ')).toMatch(/one person/i);
  });

  it('accepts ISO-style dates (year first) and a BOM and CRLF line endings', () => {
    const parsed = parseWhatsAppExport('﻿2024-03-12, 09:15 - Amina: hi\r\n2024-03-12, 09:16 - Marvin: hello\r\n');
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]?.wall).toMatchObject({ year: 2024, month: 3, day: 12 });
  });

  it('treats a phone-number author like any other author', () => {
    expect(parseWhatsAppExport(fixture('phone-author')).authors).toEqual(['+256 700 123 456', 'Marvin']);
  });

  it('does not mistake a colon inside a message for an author separator', () => {
    const parsed = parseWhatsAppExport('12/03/2024, 09:15 - Amina: Price list: dress 50k, bag 30k\n12/03/2024, 09:16 - Marvin: ok: thanks\n');
    expect(parsed.messages[0]).toMatchObject({ author: 'Amina', text: 'Price list: dress 50k, bag 30k' });
  });

  it('never invents a message from a stray title line before the first header', () => {
    const parsed = parseWhatsAppExport('WhatsApp Chat with Amina\n12/03/2024, 09:15 - Amina: hi\n12/03/2024, 09:16 - Marvin: hello\n');
    expect(parsed.messages).toHaveLength(2);
  });
});
