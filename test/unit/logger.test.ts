import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS, maskPhone } from '@/lib/logger';

describe('maskPhone', () => {
  it('keeps only the last four characters', () => {
    expect(maskPhone('+256700123456')).toBe('****3456');
    expect(maskPhone('256 700 123 456')).toBe('****3456');
  });

  it('fully masks short values', () => {
    expect(maskPhone('1234')).toBe('****');
    expect(maskPhone('')).toBe('****');
  });

  it('never returns more than four original characters', () => {
    expect(maskPhone('+256700123456')).not.toContain('2567');
  });
});

describe('log redaction', () => {
  function capture(): { logger: pino.Logger; lines: () => string } {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, stream);
    return { logger, lines: () => chunks.join('') };
  }

  it('redacts tokens, message bodies and phone numbers at top level and one level deep', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        token: 'tok-secret',
        accessToken: 'access-secret',
        body: 'hello customer text',
        phone_e164: '+256700123456',
        wa_id: '256700123456',
        message: { content: 'private message body', text: 'more private text' },
        headers: { authorization: 'Bearer abc' },
      },
      'event',
    );
    const out = lines();
    for (const leaked of [
      'tok-secret',
      'access-secret',
      'hello customer text',
      '+256700123456',
      '256700123456',
      'private message body',
      'more private text',
      'Bearer abc',
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('[redacted]');
  });

  it('keeps non-sensitive fields', () => {
    const { logger, lines } = capture();
    logger.info({ conversationId: 'abc', status: 'sent' }, 'ok');
    expect(lines()).toContain('"conversationId":"abc"');
  });
});
